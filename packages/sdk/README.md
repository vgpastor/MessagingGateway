# @messaging-gateway/sdk

TypeScript SDK for [Unified Messaging Gateway](https://github.com/vgpastor/MessagingGateway).

## Install

```bash
npm install @messaging-gateway/sdk
```

## Compatibility

- **Node.js** `>=20.19 <21 || >=22.12`: CommonJS consumers load the ESM build through `require(esm)`.
- **Gateway:** SDK 0.4.x requires a gateway release with header/subprotocol WebSocket auth,
  `afterAccountSeq` and the server heartbeat (the release that ships with this SDK). Against an
  older gateway the WebSocket handshake is rejected with `4401`: the client emits `error` and does not retry.

### Upgrading from 0.3.x

- The fields of `gateway` and `channelDetails.platform` are optional, in the manual types and the generated
  ones: a stored message keeps the shape of the version that wrote it. Handle them being `undefined`.
- The generated functions answer `{ data, status, headers }`, as their types always said, instead of the
  bare body. A binary body is a `Blob`.
- `client.health()` no longer has the status `error`.
- REST requests time out after 30 s: set `timeoutMs` if you need longer.
- Node.js 20 below 20.19 and 21 are out.

## REST Client

```typescript
import { MessagingGatewayClient } from '@messaging-gateway/sdk';

const client = new MessagingGatewayClient({
  baseUrl: 'http://localhost:3123',
  apiKey: 'your-api-key',
  timeoutMs: 30_000, // for each request, reading the body included (default: 30 s)
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

An error status throws a `GatewayApiError` with `statusCode`, `code` and `message`. A request that
takes longer than `timeoutMs` rejects with a `TimeoutError`.

### Keys

`apiKey` is the gateway's `API_KEY`, which can do everything, or its optional `READ_API_KEY`, which
can only read stored messages and media and listen to events: `client.messages.query`, `get`, `after`,
`media`, `search`, `analytics` and `export`, and `MessagingGatewayEvents`. Anything else answers `403`,
including `client.messages.conversationContext` and `client.getMessageStatus`. With the read key
`send` fails and `connection.update` carries `qr: null`.

### Generated client

Every endpoint also has a typed function generated from the OpenAPI spec. They share one configuration:

```typescript
import { configure, getApiV1Messages } from '@messaging-gateway/sdk';

configure({ baseUrl: 'http://localhost:3123', apiKey: 'your-api-key' });

const { data, status, headers } = await getApiV1Messages({ accountId: 'my-whatsapp', limit: '20' });
```

`data` is the parsed JSON, the text of a `text/*` body, or a `Blob` for anything else. An error status
throws (with `statusCode`, `code` and the body in `response`) instead of being returned, even when the
generated type lists it: those types only know the errors a route documents.

`configure()` holds one configuration for the whole process, and the last call wins. For several gateways or
keys, use one `MessagingGatewayClient` each, or pass the key for a single call:
`getApiV1Messages(params, { headers: { 'X-API-Key': 'other-key' } })`. Requests time out after 30 s, reading
the body included, with a `TimeoutError`: set `timeoutMs` in `configure()` if you need longer.

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

events.on('message.sent', ({ result, replyTo }) => {
  console.log(`Sent: ${result.messageId}`, replyTo);
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

// Change the account filter while connected. It survives reconnects.
events.subscribe(['another-account', 'my-whatsapp']); // replaces the filter; [] means every account
events.unsubscribe(['my-whatsapp']);                  // removing the last one also means every account

// Disconnect
events.disconnect();
```

After a close with `4401` the gateway refused the API key, so the client emits `error` and does not reconnect,
whatever `autoReconnect` says, until you call `connect()` again.

`subscribe()` and `unsubscribe()` throw when the socket is not connected, and then nothing changes:
call them again on `connected`, or set `accounts` in the config.

In a browser the key travels as a WebSocket subprotocol, which cannot hold every character: a key with
`/` or `=`, as standard base64 has, makes `connect()` throw a `SyntaxError`. Use hex or base64url keys.
Node sends it in a header and has no such limit.

## Message Queries & Analytics

When `STORAGE_ENABLED=true`, query stored messages via the REST client:

```typescript
// Query messages with filters (up to 500 per page)
const result = await client.messages.query({
  conversationId: '34600000001@s.whatsapp.net',
  limit: 20,
});

// Full-text search
const search = await client.messages.search('order refund', { accountId: 'my-whatsapp' });

// Analytics
const stats = await client.messages.analytics({ since: '2026-04-01T00:00:00Z' });

// Export, up to 1000 per call: use offset for the rest
const csv = await client.messages.export({ format: 'csv', limit: 1000, offset: 0 });

// AI-ready conversation context
const context = await client.messages.conversationContext('34600000001@s.whatsapp.net', {
  format: 'openai',
  limit: 50,
});
// context.messages: [{ role: 'user', content: '...', ... }, { role: 'assistant', ... }]
```

## Consuming Messages Without Losing Any

Events are not stored for you: whatever arrives while you are disconnected is only in the log. Every
stored inbound message has an `accountSeq`, contiguous per account. Keep the last one you processed and
read what follows it with `client.messages.after` when you connect, reconnect or see a gap:

```typescript
let cursor = await loadCursor();         // the last accountSeq you processed; yours to persist
const processed = await loadProcessed(); // a Set of ids; persist it too: a duplicate can come after a restart

async function handle(envelope: UnifiedEnvelope) {
  if (!processed.has(envelope.id)) {
    processed.add(envelope.id);
    await yourLogic(envelope);
  }
  if (envelope.accountSeq !== undefined) cursor = Math.max(cursor, envelope.accountSeq);
  await saveProgress(cursor, envelope.id);
}

async function catchUp() {
  let after: number | null = cursor;
  while (after !== null) {
    const page = await client.messages.after('my-whatsapp', after);
    for (const envelope of page.messages) await handle(envelope);
    after = page.nextAfterAccountSeq;
  }
}

events.on('connected', () => void catchUp());
events.on('message.inbound', (envelope) => {
  const gap = envelope.accountSeq !== undefined && envelope.accountSeq > cursor + 1;
  void (gap ? catchUp() : handle(envelope));
});
```

- **Deduplicate by `id`.** The same message can reach you twice, live and when catching up. A message
  the gateway could not store is still delivered live, without `accountSeq`, and is stored at the next
  start: it then comes again, with the same `id` and now with an `accountSeq`.
- `page.lastAccountSeq` is where to start to get only what comes from now on.
- A cursor below `page.firstAccountSeq` means retention removed the messages in between: that jump is
  not a loss to report.
- `after` returns inbound messages only, up to 500 per page (its default).

## Media

Media in an inbound message is stored by the gateway, and its `media.status` says how that went.
`client.messages.media` downloads it (the read key can too):

```typescript
const media = await client.messages.media(envelope.id);

switch (media.status) {
  case 'ready':
    await writeFile('file.bin', Buffer.from(media.data)); // media.data: ArrayBuffer; media.mimeType
    break;
  case 'pending':
    // Still downloading: try again later
    break;
  case 'skipped':
  case 'expired':
    // It will never be there. media.skipReason: 'too_large' | 'download_failed'
    break;
}
```

A message with no media throws a `GatewayApiError` with status 404.

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
  MessagesAfterResult,
  MediaDownload,
  MessageStats,
  ConversationContext,
  ConversationMessage,
  ConversationContextOptions,
} from '@messaging-gateway/sdk';
```

## License

MIT
