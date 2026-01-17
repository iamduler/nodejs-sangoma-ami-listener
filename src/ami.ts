import { createClient } from 'ami-io';
import { config } from './config';
import { logger } from './logger';
import { webhookSender, WebhookPayload } from './webhook';
import { formatLocalTimestamp } from './utils';

interface CallState {
  uniqueid: string;
  channel: string;
  callerIdNum?: string;
  callerIdName?: string;
  connectedLineNum?: string;
  connectedLineName?: string;
  context?: string;
  extension?: string;
  state?: string;
  bridgeId?: string;
  recording?: {
    started: boolean;
    file?: string;
  };
}

export class AMIListener {
  private client: any | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private isShuttingDown: boolean = false;
  private callStates: Map<string, CallState> = new Map();

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
    } catch (error: any) {
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
      
      switch (eventName) {
        case 'Newchannel':
          this.handleNewchannel(event);
          break;
        case 'DialBegin':
          this.handleDialBegin(event);
          break;
        case 'BridgeEnter':
          this.handleBridgeEnter(event);
          break;
        case 'MixMonitorStart':
          this.handleMixMonitorStart(event);
          break;
        case 'MixMonitorStop':
          this.handleMixMonitorStop(event);
          break;
        case 'Hangup':
          this.handleHangup(event);
          break;
        default:
          // Ignore other events
          break;
      }
    });
  }

  private handleNewchannel(event: any): void {
    try {
      const uniqueid = event.Uniqueid || event.uniqueid;
      const channel = event.Channel || event.channel;

      if (!uniqueid || !channel) {
        return;
      }

      const callState: CallState = {
        uniqueid,
        channel,
        callerIdNum: event.CallerIDNum || event.calleridnum,
        callerIdName: event.CallerIDName || event.calleridname,
        context: event.Context || event.context,
        extension: event.Exten || event.exten,
        state: event.ChannelState || event.channelstate,
      };

      this.callStates.set(uniqueid, callState);

      logger.debug('Newchannel event received', { uniqueid, channel });

      const payload: WebhookPayload = {
        event: 'call.start',
        uniqueid,
        timestamp: formatLocalTimestamp(),
        data: {
          channel,
          callerIdNum: callState.callerIdNum,
          callerIdName: callState.callerIdName,
          context: callState.context,
          extension: callState.extension,
          state: callState.state,
        },
      };

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send call.start webhook', { error: error.message, uniqueid });
      });
    } catch (error: any) {
      logger.error('Error processing Newchannel event', { error: error.message });
    }
  }

  private handleDialBegin(event: any): void {
    try {
      const uniqueid = event.Uniqueid || event.uniqueid;
      const channel = event.Channel || event.channel;
      const destination = event.Destination || event.destination;

      if (!uniqueid || !channel) {
        return;
      }

      logger.debug('DialBegin event received', { uniqueid, channel, destination });

      const payload: WebhookPayload = {
        event: 'call.ringing',
        uniqueid,
        timestamp: formatLocalTimestamp(),
        data: {
          channel,
          destination,
          callerIdNum: event.CallerIDNum || event.calleridnum,
          callerIdName: event.CallerIDName || event.calleridname,
        },
      };

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send call.ringing webhook', { error: error.message, uniqueid });
      });
    } catch (error: any) {
      logger.error('Error processing DialBegin event', { error: error.message });
    }
  }

  private handleBridgeEnter(event: any): void {
    try {
      const uniqueid = event.Uniqueid || event.uniqueid;
      const channel = event.Channel || event.channel;
      const bridgeUniqueid = event.BridgeUniqueid || event.bridgeuniqueid;

      if (!uniqueid || !channel) {
        return;
      }

      const callState = this.callStates.get(uniqueid);
      if (callState) {
        callState.bridgeId = bridgeUniqueid;
      }

      logger.debug('BridgeEnter event received', { uniqueid, channel, bridgeUniqueid });

      const payload: WebhookPayload = {
        event: 'call.answered',
        uniqueid,
        timestamp: formatLocalTimestamp(),
        data: {
          channel,
          bridgeUniqueid,
          callerIdNum: event.CallerIDNum || event.calleridnum,
          callerIdName: event.CallerIDName || event.calleridname,
          connectedLineNum: event.ConnectedLineNum || event.connectedlinenum,
          connectedLineName: event.ConnectedLineName || event.connectedlinename,
        },
      };

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send call.answered webhook', { error: error.message, uniqueid });
      });
    } catch (error: any) {
      logger.error('Error processing BridgeEnter event', { error: error.message });
    }
  }

  private handleMixMonitorStart(event: any): void {
    try {
      const uniqueid = event.Uniqueid || event.uniqueid;
      const channel = event.Channel || event.channel;
      const file = event.File || event.file;

      if (!uniqueid || !channel) {
        return;
      }

      const callState = this.callStates.get(uniqueid);
      if (callState) {
        callState.recording = {
          started: true,
          file,
        };
      }

      logger.debug('MixMonitorStart event received', { uniqueid, channel, file });

      const payload: WebhookPayload = {
        event: 'call.recording_started',
        uniqueid,
        timestamp: formatLocalTimestamp(),
        data: {
          channel,
          file,
        },
      };

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send call.recording_started webhook', { error: error.message, uniqueid });
      });
    } catch (error: any) {
      logger.error('Error processing MixMonitorStart event', { error: error.message });
    }
  }

  private handleMixMonitorStop(event: any): void {
    try {
      const uniqueid = event.Uniqueid || event.uniqueid;
      const channel = event.Channel || event.channel;
      const file = event.File || event.file;

      if (!uniqueid || !channel) {
        return;
      }

      const callState = this.callStates.get(uniqueid);
      if (callState && callState.recording) {
        callState.recording.started = false;
        callState.recording.file = file;
      }

      logger.debug('MixMonitorStop event received', { uniqueid, channel, file });

      const payload: WebhookPayload = {
        event: 'call.recording_stopped',
        uniqueid,
        timestamp: formatLocalTimestamp(),
        data: {
          channel,
          file,
        },
      };

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send call.recording_stopped webhook', { error: error.message, uniqueid });
      });
    } catch (error: any) {
      logger.error('Error processing MixMonitorStop event', { error: error.message });
    }
  }

  private handleHangup(event: any): void {
    try {
      const uniqueid = event.Uniqueid || event.uniqueid;
      const channel = event.Channel || event.channel;
      const cause = event.Cause || event.cause;
      const causeTxt = event.CauseTxt || event.causetxt;

      if (!uniqueid || !channel) {
        return;
      }

      const callState = this.callStates.get(uniqueid);

      logger.debug('Hangup event received', { uniqueid, channel, cause, causeTxt });

      const payload: WebhookPayload = {
        event: 'call.ended',
        uniqueid,
        timestamp: formatLocalTimestamp(),
        data: {
          channel,
          cause,
          causeTxt,
          duration: event.Duration || event.duration,
          callerIdNum: callState?.callerIdNum || event.CallerIDNum || event.calleridnum,
          callerIdName: callState?.callerIdName || event.CallerIDName || event.calleridname,
          recording: callState?.recording,
        },
      };

      webhookSender.send(payload).catch((error) => {
        logger.error('Failed to send call.ended webhook', { error: error.message, uniqueid });
      });

      // Clean up call state
      this.callStates.delete(uniqueid);
    } catch (error: any) {
      logger.error('Error processing Hangup event', { error: error.message });
    }
  }

  async start(): Promise<void> {
    logger.info('Starting AMI Listener');
    await this.connect();
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
      } catch (error: any) {
        logger.error('Error disconnecting from AMI', { error: error.message });
      }
      this.client = null;
    }
  }
}

export const amiListener = new AMIListener();
