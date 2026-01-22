import { config } from './config';
import { logger } from './logger';

export interface WebhookPayload {
  [key: string]: any;
}

interface RetryState {
  attempt: number;
  delay: number;
}

export class WebhookSender {
  private deliveredIds: Set<string> = new Set();
  private readonly maxCacheSize = 10000;

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateDelay(attempt: number): number {
    const delay = config.webhook.retryInitialDelay * Math.pow(config.webhook.retryMultiplier, attempt - 1);
    return Math.min(delay, config.webhook.retryMaxDelay);
  }

  private async sendRequest(payload: WebhookPayload): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.webhook.timeout);

    try {
      const response = await fetch(config.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AMI-Listener/1.0.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn('Webhook request failed with non-OK status', {
          status: response.status,
          statusText: response.statusText,
          uniqueid: payload.uniqueid,
        });
        return false;
      }

      return true;
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        logger.warn('Webhook request timed out', {
          uniqueid: payload.uniqueid,
          timeout: config.webhook.timeout,
        });
      } else {
        logger.error('Webhook request failed', {
          error: error.message,
          uniqueid: payload.uniqueid,
        });
      }

      return false;
    }
  }

  private cleanupCache(): void {
    if (this.deliveredIds.size > this.maxCacheSize) {
      const entriesToRemove = this.deliveredIds.size - this.maxCacheSize;
      const entries = Array.from(this.deliveredIds);
      for (let i = 0; i < entriesToRemove; i++) {
        this.deliveredIds.delete(entries[i]);
      }
    }
  }

  async send(payload: WebhookPayload): Promise<void> {
    const idempotencyKey = `${payload.event}:${payload.uniqueid}`;

    // Check idempotency
    if (this.deliveredIds.has(idempotencyKey)) {
      logger.debug('Skipping duplicate webhook', {
        event: payload.event,
        uniqueid: payload.uniqueid,
      });
      return;
    }

    let state: RetryState = {
      attempt: 0,
      delay: 0,
    };

    while (state.attempt < config.webhook.retryMaxAttempts) {
      state.attempt++;

      logger.debug('Sending webhook', {
        event: payload.event,
        uniqueid: payload.uniqueid,
        attempt: state.attempt,
        maxAttempts: config.webhook.retryMaxAttempts,
      });

      const success = await this.sendRequest(payload);

      if (success) {
        this.deliveredIds.add(idempotencyKey);
        this.cleanupCache();

        logger.info('Webhook delivered successfully', {
          event: payload.event,
          uniqueid: payload.uniqueid,
          attempt: state.attempt,
        });

        return;
      }

      if (state.attempt < config.webhook.retryMaxAttempts) {
        state.delay = this.calculateDelay(state.attempt);

        logger.warn('Webhook delivery failed, retrying', {
          event: payload.event,
          uniqueid: payload.uniqueid,
          attempt: state.attempt,
          nextRetryIn: state.delay,
        });

        await this.sleep(state.delay);
      }
    }

    // All retries exhausted
    logger.error('Webhook delivery failed after all retries', {
      event: payload.event,
      uniqueid: payload.uniqueid,
      attempts: state.attempt,
    });
  }
}

export const webhookSender = new WebhookSender();
