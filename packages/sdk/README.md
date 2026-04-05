# @messaging-gateway/sdk

TypeScript SDK for [Unified Messaging Gateway](https://github.com/vgpastor/MessagingGateway).

## Install

```bash
npm install @messaging-gateway/sdk
```

## REST Client

```typescript
import { MessagingGatewayClient } from '@messaging-gateway/sdk';

const client = new MessagingGatewayClient({
  baseUrl: 'http://localhost:3123',
  apiKey: 'your-api-key', // optional in dev mode
});

// Send a message
const result = await client.send({
  from: 'my-whatsapp',
  to: '+34600000001',
  content: { type: 'text', body: 'Hello!' },
});

// Accounts
const accounts = await client.accounts.list();
const account = await client.accounts.get('my-whatsapp');
await client.accounts.connect('my-whatsapp');

// Webhooks
await client.webhooks.set('my-whatsapp', {
  url: 'https://n8n.example.com/webhook/wa',
  secret: 'hmac-secret',
});

// Health
const health = await client.health();
```

## WebSocket Events

```typescript
import { MessagingGatewayEvents } from '@messaging-gateway/sdk';

const events = new MessagingGatewayEvents({
  baseUrl: 'http://localhost:3123',
  apiKey: 'your-api-key',
  accounts: ['my-whatsapp'], // filter by account (optional)
  autoReconnect: true,       // reconnect on disconnect (default: true)
});

events.on('message.inbound', (envelope) => {
  console.log(`From: ${envelope.sender.displayName}`);
  console.log(`Type: ${envelope.content.type}`);
  if (envelope.content.type === 'text') {
    console.log(`Body: ${envelope.content.body}`);
  }
});

events.on('connection.update', (data) => {
  console.log(`${data.accountId}: ${data.status}`);
  if (data.qr) console.log('QR:', data.qr);
});

events.on('message.sent', (result) => {
  console.log(`Sent: ${result.messageId}`);
});

events.on('disconnected', (code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`);
});

// Connect
events.connect();

// Send via WebSocket
const correlationId = await events.send({
  from: 'my-whatsapp',
  to: '+34600000001',
  content: { type: 'text', body: 'Hello via WS!' },
});

// Subscribe/unsubscribe dynamically
events.subscribe(['another-account']);
events.unsubscribe(['my-whatsapp']);

// Disconnect
events.disconnect();
```

## Message Queries & Analytics

When `STORAGE_ENABLED=true`, query stored messages via the REST client:

```typescript
// Query messages with filters
const result = await client.get('/api/v1/messages', {
  params: { conversationId: '34600000001@s.whatsapp.net', limit: 20 },
});

// Full-text search
const search = await client.get('/api/v1/messages/search', {
  params: { q: 'order refund', accountId: 'my-whatsapp' },
});

// Analytics
const stats = await client.get('/api/v1/messages/analytics', {
  params: { since: '2026-04-01T00:00:00Z' },
});

// AI-ready conversation context
const context = await client.get('/api/v1/conversations/34600000001@s.whatsapp.net/context', {
  params: { format: 'openai', limit: 50 },
});
// context.messages: [{ role: 'user', content: '...', ... }, { role: 'assistant', ... }]
```

## Types

All types are exported for TypeScript consumers:

```typescript
import type {
  // Core messaging
  UnifiedEnvelope,
  MessageContent,
  TextContent,
  ImageContent,
  SendMessageCommand,
  // Accounts & webhooks
  Account,
  WebhookConfig,
  // Persistence & analytics (requires STORAGE_ENABLED)
  MessageQuery,
  MessageQueryResult,
  MessageStats,
  ConversationContext,
  ConversationMessage,
  ConversationContextOptions,
} from '@messaging-gateway/sdk';
```

## License

MIT
