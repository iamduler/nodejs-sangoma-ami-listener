import { createClient } from 'ami-io';
import { config } from './config';
import { logger } from './logger';
import { webhookSender, WebhookPayload } from './webhook';
import { formatLocalTimestamp } from './utils';

export class AMIListener {
  private client: any | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private isShuttingDown: boolean = false;

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

  private createClient(): any {
    return createClient({
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

      // Build raw AMI Originate action string
      const lines = [
        'Action: Originate',
        `Channel: ${channel}`,
        `Context: ${context}`,
        `Exten: ${exten}`,
        `Priority: ${priority}`,
        `Timeout: ${timeout}`,
        'Async: true',
        `CallerID: ${extension}`,
        '', // AMI message terminator (empty line)
        '',
      ];

      const rawAction = lines.join('\r\n');

      // Send Originate action via AMI
      this.client.send(rawAction);

      logger.info('Click2call originate sent to AMI', {
        extension,
        phoneNumber: cleanPhoneNumber,
        channel,
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
