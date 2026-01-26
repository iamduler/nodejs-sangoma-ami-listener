import * as ami from 'ami-io';
import { config } from './config';
import { logger } from './logger';
import { webhookSender, WebhookPayload } from './webhook';
import { formatLocalTimestamp } from './utils';

interface PendingEvent {
  event: any;
  timestamp: number;
  timeout: NodeJS.Timeout;
}

export class AMIListener {
  private client: any | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private isShuttingDown: boolean = false;
  private pendingHangups: Map<string, PendingEvent> = new Map();
  private pendingBridgeEnters: Map<string, PendingEvent> = new Map();
  private readonly eventMergeTimeout = 2000; // 2 seconds to wait for second event

  /**
   * Check if event should be processed based on channel name
   * Only process events with channel that does NOT start with "Local/" or "Macro/"
   */
  private shouldProcessEvent(event: any): boolean {
    const channel = event.Channel || event.channel;
    const uniqueid = event.Uniqueid || event.uniqueid;
    
    if (!channel) return false;

    // Skip events with channel starting with "Local/" or "Macro/"
    if (channel.startsWith('Local/') || channel.startsWith('Macro/')) {
      logger.debug(`Skipping event by channel (Local/Macro channel)`, { uniqueid, channel });
      return false;
    }
    
    if (event.event == 'DialBegin') {
      const destChannel = event.DestChannel || event.destchannel;

      // Skip events with destchannel starting with "Local/" or "Macro/"
      if (destChannel.startsWith('Local/') || destChannel.startsWith('Macro/')) {
        logger.debug(`Skipping DialBegin event by destination channel (Local/Macro channel)`, { uniqueid, channel, destChannel });
        return false;
      }
    }
    else {
      if (event.exten === 's') {
        logger.debug(`Skipping event by extension (start extension)`, { uniqueid, channel, exten: event.exten });
        return false;
      }
      
      if (event.exten === 'h') {
        logger.debug(`Skipping event by extension (hangup extension)`, { uniqueid, channel, exten: event.exten });
        return false;
      }
    }

    return true;
  }

  /**
   * Remove incomingData from event object before sending to webhook
   */
  private sanitizeEvent(event: any): any {
    const sanitized = { ...event };
    delete sanitized.incomingData;

    // Add timestamp
    if (!sanitized.timestamp) {
      sanitized.timestamp = formatLocalTimestamp();
    }

    return sanitized;
  }

  /**
   * Merge two Hangup events with the same linkedid into one event
   * Keeps the first event and adds calleridnum (from internal) and destcalleridnum (from trunk)
   */
  private mergeHangupEvents(event1: any, event2: any): any {
    // Determine which is caller (extension/internal) and which is callee (external/trunk)
    const event1Context = (event1.context || event1.Context || '').toLowerCase();
    const event2Context = (event2.context || event2.Context || '').toLowerCase();
    
    const event1IsInternal = event1Context.includes('internal');
    const event2IsInternal = event2Context.includes('internal');
    
    // Determine caller and callee events
    let callerEvent, calleeEvent, firstEvent;
    if (event1IsInternal && !event2IsInternal) {
      // Event1 is internal (caller), Event2 is external (callee)
      callerEvent = event1;
      calleeEvent = event2;
      firstEvent = event1; // Use first event as base
    } else if (!event1IsInternal && event2IsInternal) {
      // Event1 is external (callee), Event2 is internal (caller)
      callerEvent = event2;
      calleeEvent = event1;
      firstEvent = event1; // Use first event as base
    } else {
      // Both same type or unclear, use order
      callerEvent = event1IsInternal ? event1 : event2;
      calleeEvent = event1IsInternal ? event2 : event1;
      firstEvent = event1; // Use first event as base
    }

    // Get calleridnum from internal event (caller)
    const calleridnum = callerEvent.calleridnum || callerEvent.CallerIDNum || '';
    // Get calleridnum from trunk event (callee/destination)
    const destcalleridnum = calleeEvent.calleridnum || calleeEvent.CallerIDNum || '';

    // Create merged event: keep first event and add calleridnum and destcalleridnum
    const merged: any = {
      ...firstEvent,
      // Add calleridnum from internal event
      calleridnum: calleridnum,
      CallerIDNum: calleridnum,
      // Add destcalleridnum from trunk event (destination number)
      destcalleridnum: destcalleridnum,
      DestCallerIDNum: destcalleridnum,
    };

    return merged;
  }

  /**
   * Merge two BridgeEnter events with the same linkedid into one event
   * Keeps the first event and adds calleridnum (from internal) and destcalleridnum (from trunk)
   */
  private mergeBridgeEnterEvents(event1: any, event2: any): any {
    // Determine which is caller (extension/internal) and which is callee (external/trunk)
    const event1Context = (event1.context || event1.Context || '').toLowerCase();
    const event2Context = (event2.context || event2.Context || '').toLowerCase();
    
    const event1IsInternal = event1Context.includes('internal');
    const event2IsInternal = event2Context.includes('internal');
    
    // Determine caller and callee events
    let callerEvent, calleeEvent, firstEvent;
    if (event1IsInternal && !event2IsInternal) {
      // Event1 is internal (caller), Event2 is external (callee)
      callerEvent = event1;
      calleeEvent = event2;
      firstEvent = event1; // Use first event as base
    } else if (!event1IsInternal && event2IsInternal) {
      // Event1 is external (callee), Event2 is internal (caller)
      callerEvent = event2;
      calleeEvent = event1;
      firstEvent = event1; // Use first event as base
    } else {
      // Both same type or unclear, use order
      callerEvent = event1IsInternal ? event1 : event2;
      calleeEvent = event1IsInternal ? event2 : event1;
      firstEvent = event1; // Use first event as base
    }

    // Get calleridnum from internal event (caller)
    const calleridnum = callerEvent.calleridnum || callerEvent.CallerIDNum || '';
    // Get calleridnum from trunk event (callee/destination)
    const destcalleridnum = calleeEvent.calleridnum || calleeEvent.CallerIDNum || '';

    // Create merged event: keep first event and add calleridnum and destcalleridnum
    const merged: any = {
      ...firstEvent,
      // Add calleridnum from internal event
      calleridnum: calleridnum,
      CallerIDNum: calleridnum,
      // Add destcalleridnum from trunk event (destination number)
      destcalleridnum: destcalleridnum,
      DestCallerIDNum: destcalleridnum,
    };

    return merged;
  }

  /**
   * Handle Hangup event - merge events with same linkedid before sending to webhook
   */
  private handleHangupEvent(event: any): void {
    const linkedid = event.linkedid || event.Linkedid;
    
    if (!linkedid) {
      // No linkedid, send immediately
      logger.warn('Hangup event without linkedid, sending immediately', {
        uniqueid: event.uniqueid || event.Uniqueid,
      });
      const payload: WebhookPayload = this.sanitizeEvent(event);
      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send Hangup webhook', { error: error.message });
      });
      return;
    }

    const existing = this.pendingHangups.get(linkedid);

    if (existing) {
      // Found matching Hangup event, merge and send
      clearTimeout(existing.timeout);
      this.pendingHangups.delete(linkedid);

      logger.debug('Merging Hangup events with same linkedid', {
        linkedid,
        uniqueid1: existing.event.uniqueid || existing.event.Uniqueid,
        uniqueid2: event.uniqueid || event.Uniqueid,
      });

      const merged = this.mergeHangupEvents(existing.event, event);
      const payload: WebhookPayload = this.sanitizeEvent(merged);

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send merged Hangup webhook', { 
          error: error.message, 
          linkedid 
        });
      });
    } else {
      // First Hangup event for this linkedid, store and wait
      const timeout = setTimeout(() => {
        this.pendingHangups.delete(linkedid);
        
        logger.warn('Hangup merge timeout - sending single event', {
          linkedid,
          uniqueid: event.uniqueid || event.Uniqueid,
        });

        const payload: WebhookPayload = this.sanitizeEvent(event);
        webhookSender.send(payload).catch((error) => {
          logger.error('Failed to send Hangup webhook after timeout', { 
            error: error.message,
            linkedid 
          });
        });
      }, this.eventMergeTimeout);

      this.pendingHangups.set(linkedid, {
        event,
        timestamp: Date.now(),
        timeout,
      });

      logger.debug('Storing Hangup event, waiting for merge', {
        linkedid,
        uniqueid: event.uniqueid || event.Uniqueid,
      });
    }
  }

  /**
   * Handle BridgeEnter event - merge events with same linkedid before sending to webhook
   */
  private handleBridgeEnterEvent(event: any): void {
    const linkedid = event.linkedid || event.Linkedid;
    
    if (!linkedid) {
      // No linkedid, send immediately
      logger.warn('BridgeEnter event without linkedid, sending immediately', {
        uniqueid: event.uniqueid || event.Uniqueid,
      });
      const payload: WebhookPayload = this.sanitizeEvent(event);
      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send BridgeEnter webhook', { error: error.message });
      });
      return;
    }

    const existing = this.pendingBridgeEnters.get(linkedid);

    if (existing) {
      // Found matching BridgeEnter event, merge and send
      clearTimeout(existing.timeout);
      this.pendingBridgeEnters.delete(linkedid);

      logger.debug('Merging BridgeEnter events with same linkedid', {
        linkedid,
        uniqueid1: existing.event.uniqueid || existing.event.Uniqueid,
        uniqueid2: event.uniqueid || event.Uniqueid,
      });

      const merged = this.mergeBridgeEnterEvents(existing.event, event);
      const payload: WebhookPayload = this.sanitizeEvent(merged);

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send merged BridgeEnter webhook', { 
          error: error.message, 
          linkedid 
        });
      });
    } else {
      // First BridgeEnter event for this linkedid, store and wait
      const timeout = setTimeout(() => {
        this.pendingBridgeEnters.delete(linkedid);
        
        logger.warn('BridgeEnter merge timeout - sending single event', {
          linkedid,
          uniqueid: event.uniqueid || event.Uniqueid,
        });

        const payload: WebhookPayload = this.sanitizeEvent(event);
        webhookSender.send(payload).catch((error) => {
          logger.error('Failed to send BridgeEnter webhook after timeout', { 
            error: error.message,
            linkedid 
          });
        });
      }, this.eventMergeTimeout);

      this.pendingBridgeEnters.set(linkedid, {
        event,
        timestamp: Date.now(),
        timeout,
      });

      logger.debug('Storing BridgeEnter event, waiting for merge', {
        linkedid,
        uniqueid: event.uniqueid || event.Uniqueid,
      });
    }
  }

  private createClient(): any {
    return ami.createClient({
      host: config.ami.host,
      port: config.ami.port,
      login: config.ami.username,
      password: config.ami.secret,
      encoding: 'ascii',
    });
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      logger.info('Connecting to AMI', {
        host: config.ami.host,
        port: config.ami.port,
        username: config.ami.username,
      });

      this.client = this.createClient();

      this.client.on('connectionRefused', () => {
        logger.error('AMI connection refused');
        this.scheduleReconnect();
      });

      this.client.on('incorrectLogin', () => {
        logger.error('AMI incorrect login credentials');
        this.scheduleReconnect();
      });

      this.client.on('incorrectServer', () => {
        logger.error('AMI incorrect server response');
        this.scheduleReconnect();
      });

      this.client.on('connect', () => {
        logger.info('Connected to AMI');
        this.reconnectAttempts = 0;
      });

      this.client.on('disconnect', () => {
        logger.warn('Disconnected from AMI');
        this.client = null;
        this.scheduleReconnect();
      });

      this.setupEventHandlers();
      
      // Connect with auto-reconnect disabled (we handle it manually)
      this.client.connect(false, 0);

      logger.info('AMI connection initiated');
    } 
    catch (error: any) {
      logger.error('Failed to connect to AMI', { error: error.message });
      this.client = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (config.ami.reconnectMaxAttempts > 0 && this.reconnectAttempts >= config.ami.reconnectMaxAttempts) {
      logger.error('Max reconnection attempts reached', {
        attempts: this.reconnectAttempts,
        maxAttempts: config.ami.reconnectMaxAttempts,
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = config.ami.reconnectInterval;

    logger.info('Scheduling reconnection', {
      attempt: this.reconnectAttempts,
      delay,
      maxAttempts: config.ami.reconnectMaxAttempts === -1 ? 'unlimited' : config.ami.reconnectMaxAttempts,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private setupEventHandlers(): void {
    if (!this.client) {
      return;
    }

    // Listen to all events and filter
    this.client.on('event', (event: any) => {
      const eventName = event.event || event.Event;
      
      // Ignore events: Newchannel, MixMonitorStart, MixMonitorStop (not supported)
      const validEvents = ['DialBegin', 'BridgeEnter', 'Hangup'];

      if (!validEvents.includes(eventName)) {
        return;
      }

      try {
        const uniqueid = event.Uniqueid || event.uniqueid;
        const channel = event.Channel || event.channel;
  
        if (!uniqueid || !channel) {
          return;
        }
  
        if (!this.shouldProcessEvent(event)) {
          return;
        }
  
        logger.debug(`${eventName} event received`, { uniqueid, channel });
  
        // Special handling for Hangup events - merge events with same linkedid
        if (eventName === 'Hangup') {
          this.handleHangupEvent(event);
          return;
        }
  
        // Special handling for BridgeEnter events - merge events with same linkedid
        if (eventName === 'BridgeEnter') {
          this.handleBridgeEnterEvent(event);
          return;
        }
  
        // For other events, send immediately
        const payload: WebhookPayload = this.sanitizeEvent(event);
  
        webhookSender.send(payload).catch((error) => {
          logger.error(`Failed to send ${eventName} webhook`, { error: error.message, uniqueid });
        });
      } 
      catch (error: any) {
        logger.error(`Error processing ${eventName} event`, { error: error.message });
      }
    });
  }

  async start(): Promise<void> {
    logger.info('Starting AMI Listener');
    await this.connect();
  }

  /**
   * Execute click2call: originate a call from extension to phone number
   * @param extension - Extension number to call from
   * @param phoneNumber - Phone number to call to
   * @returns Promise with result of the originate action
   */
  async click2call(extension: string, phoneNumber: string): Promise<{ success: boolean; message: string; actionId?: string }> {
    if (!this.client) {
      return {
        success: false,
        message: 'AMI client is not connected',
      };
    }

    try {
      // Validate inputs
      if (!extension || !phoneNumber) {
        return {
          success: false,
          message: 'Extension and phone number are required',
        };
      }

      // Clean phone number (remove spaces, dashes, etc.)
      const cleanPhoneNumber = phoneNumber.replace(/[\s\-\(\)]/g, '');

      // Build originate action
      // Format: Local/{extension}@from-internal/n -> {phoneNumber}@from-internal
      // This will first call the extension, then when answered, dial the phone number
      const channel = `Local/${extension}@from-internal/n`;
      const context = 'from-internal';
      const exten = phoneNumber;
      const priority = 1;
      const timeout = 30000; // 30 seconds timeout

      logger.info('Initiating click2call', {
        extension,
        phoneNumber: cleanPhoneNumber,
        channel,
      });

      // Build raw AMI Originate action string (according to AMI protocol)
      const lines = [
        'Action: Originate',
        `Channel: ${channel}`,
        `Context: ${context}`,
        `Exten: ${exten}`,
        `Priority: ${priority}`,
        `Timeout: ${timeout}`,
        `CallerID: ${extension}`,
        '', // empty line terminator
        '',
      ];
      const rawAction = lines.join('\r\n');

      // Simple wrapper so ami-io can call action.format()
      class RawAction {
        private payload: string;
        constructor(payload: string) {
          this.payload = payload;
        }
        format() {
          return this.payload;
        }
      }

      const action = new RawAction(rawAction);

      // Send Originate action via AMI with callback.
      // ami-io send() requires (action, callback) signature.
      await new Promise<void>((resolve, reject) => {
        this.client!.send(action, (err: any, res: any) => {
          if (err) {
            logger.error('Click2call send error', {
              error: err.message || err,
              extension,
              phoneNumber: cleanPhoneNumber,
            });
            return reject(err);
          }

          logger.info('Click2call originate sent to AMI', {
            extension,
            phoneNumber: cleanPhoneNumber,
            channel,
            response: res,
          });

          resolve();
        });
      });

      return {
        success: true,
        message: 'Call originate request sent to AMI',
      };
    } catch (error: any) {
      logger.error('Error initiating click2call', {
        error: error.message,
        extension,
        phoneNumber,
      });

      return {
        success: false,
        message: error.message || 'Unknown error occurred',
      };
    }
  }

  /**
   * Get AMI client instance (for external use)
   */
  getClient(): any | null {
    return this.client;
  }

  async stop(): Promise<void> {
    logger.info('Stopping AMI Listener');
    this.isShuttingDown = true;

    // Clear all pending Hangup events
    for (const [linkedid, pending] of this.pendingHangups.entries()) {
      clearTimeout(pending.timeout);
      logger.debug('Clearing pending Hangup event on shutdown', { linkedid });
    }
    this.pendingHangups.clear();

    // Clear all pending BridgeEnter events
    for (const [linkedid, pending] of this.pendingBridgeEnters.entries()) {
      clearTimeout(pending.timeout);
      logger.debug('Clearing pending BridgeEnter event on shutdown', { linkedid });
    }
    this.pendingBridgeEnters.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      try {
        this.client.disconnect();
        logger.info('AMI connection closed');
      } 
      catch (error: any) {
        logger.error('Error disconnecting from AMI', { error: error.message });
      }
      this.client = null;
    }
  }
}

export const amiListener = new AMIListener();
