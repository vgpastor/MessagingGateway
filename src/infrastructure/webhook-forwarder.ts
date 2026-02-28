import { createHmac } from 'node:crypto';
import type { UnifiedEnvelope } from '../domain/messaging/unified-envelope.js';

export class WebhookForwarder {
  constructor(
    private readonly callbackUrl: string | undefined,
    private readonly secret: string | undefined,
  ) {}

  async forward(envelope: UnifiedEnvelope): Promise<void> {
    if (!this.callbackUrl) {
      return;
    }

    const payload = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-UMG-Event': 'message.inbound',
      'X-UMG-Channel': envelope.channel,
      'X-UMG-Account': envelope.accountId,
    };

    if (this.secret) {
      const signature = createHmac('sha256', this.secret)
        .update(payload)
        .digest('hex');
      headers['X-UMG-Signature'] = `sha256=${signature}`;
    }

    const response = await fetch(this.callbackUrl, {
      method: 'POST',
      headers,
      body: payload,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(
        `Webhook forwarding failed: HTTP ${response.status} - ${text}`,
      );
    }
  }
}
