import axios from 'axios';
import crypto from 'crypto';

/**
 * Webhook Manager: Handles webhook registration and delivery
 */
export class WebhookManager {
  private webhooks: Map<string, Webhook> = new Map();

  /**
   * Register a webhook
   */
  register(webhook: Omit<Webhook, 'id' | 'createdAt'>): Webhook {
    const id = crypto.randomUUID();
    const fullWebhook: Webhook = {
      ...webhook,
      id,
      createdAt: Date.now(),
    };
    this.webhooks.set(id, fullWebhook);
    return fullWebhook;
  }

  /**
   * Get webhook by ID
   */
  get(id: string): Webhook | null {
    return this.webhooks.get(id) || null;
  }

  /**
   * List all webhooks
   */
  list(): Webhook[] {
    return Array.from(this.webhooks.values());
  }

  /**
   * Delete webhook
   */
  delete(id: string): boolean {
    return this.webhooks.delete(id);
  }

  /**
   * Trigger webhook for event
   */
  async trigger(event: string, payload: unknown): Promise<void> {
    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      webhook => webhook.enabled && webhook.events.includes(event)
    );

    for (const webhook of matchingWebhooks) {
      try {
        const signature = this.generateSignature(JSON.stringify(payload), webhook.secret);
        
        await axios.post(webhook.url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            'X-Webhook-Signature': signature,
            'X-Webhook-Id': webhook.id,
          },
          timeout: 10000,
        });
      } catch (error) {
        console.error(`Failed to deliver webhook ${webhook.id}:`, error);
        // In production, would retry with exponential backoff
      }
    }
  }

  /**
   * Generate HMAC signature for webhook payload
   */
  private generateSignature(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  enabled: boolean;
  createdAt: number;
}

