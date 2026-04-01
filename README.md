# Unified Messaging Gateway

[![CI](https://github.com/vgpastor/MessagingGateway/actions/workflows/ci.yml/badge.svg)](https://github.com/vgpastor/MessagingGateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?logo=docker)](https://ghcr.io/vgpastor/messaginggateway)
[![npm](https://img.shields.io/npm/v/@messaging-gateway/sdk?logo=npm)](https://www.npmjs.com/package/@messaging-gateway/sdk)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js)](https://nodejs.org/)

A single API to send and receive messages across **WhatsApp**, **Telegram**, **Email**, and **SMS**. Connect multiple accounts, receive events in real-time via WebSocket, and forward everything to your automation tools.

**Key highlights:**
- One API to rule all messaging channels
- Real-time events via WebSocket
- Webhook forwarding to n8n, Make, or any HTTP endpoint
- TypeScript SDK included (`@messaging-gateway/sdk`)
- Docker-first, zero config to start

## Quickstart

### Using the published Docker image (recommended)

```bash
docker run -d --name messaging-gateway \
  -p 3123:3000 \
  -v $(pwd)/data:/app/data \
  -e API_KEY=your-secret-key \
  ghcr.io/vgpastor/messaginggateway:latest
```

### From source

```bash
git clone https://github.com/vgpastor/MessagingGateway.git
cd MessagingGateway
cp accounts.yaml.example data/accounts.yaml
docker compose up -d

# 2. Connect WhatsApp (scan QR)
curl -X POST http://localhost:3123/api/v1/accounts/my-whatsapp/connect
# Check QR: curl http://localhost:3123/api/v1/accounts/my-whatsapp

# 3. Send a message
curl -X POST http://localhost:3123/api/v1/messages/send \
  -H "Content-Type: application/json" \
  -d '{"from":"my-whatsapp","to":"+34600000001","content":{"type":"text","body":"Hello!"}}'
```

## Features

- **Multi-channel**: WhatsApp (Baileys, wwebjs-api), Telegram, Email (Brevo), SMS (Twilio, MessageBird)
- **Unified API**: One endpoint to send, one format for all inbound messages
- **Real-time**: WebSocket server for live events (messages, connection status, QR codes)
- **Webhooks**: Forward events to any URL (n8n, Make, custom backend)
- **Event-driven**: Internal EventBus decouples all components
- **Provider agnostic**: Add new providers by implementing a single ProviderBundle
- **Auth**: API key authentication for REST and WebSocket
- **Docker ready**: Single container, all config in a mounted volume

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Internal server port |
| `HOST_PORT` | `3123` | Docker host port mapping |
| `API_KEY` | _(none)_ | API key for auth. Empty = dev mode (no auth) |
| `WEBHOOK_CALLBACK_URL` | _(none)_ | Global webhook URL for forwarding events |
| `WEBHOOK_CALLBACK_SECRET` | _(none)_ | HMAC secret for webhook signatures |
| `ACCOUNTS_CONFIG_PATH` | `data/accounts.yaml` | Path to accounts config file |
| `HEALTH_CHECK_INTERVAL_MS` | `300000` | Health check interval (ms) |
| `CORS_ORIGIN` | `*` in dev | Allowed CORS origin in production |
| `SWAGGER_ENABLED` | `false` | Enable Swagger UI in production |

Create a `.env.local` file to override defaults:

```bash
API_KEY=your-secret-key
WEBHOOK_CALLBACK_URL=https://n8n.yourdomain.com/webhook/messaging
WEBHOOK_CALLBACK_SECRET=your-webhook-secret
```

### Accounts (data/accounts.yaml)

See [accounts.yaml.example](accounts.yaml.example) for the full format.

```yaml
accounts:
  - id: my-whatsapp
    alias: "My WhatsApp"
    channel: whatsapp
    provider: baileys
    identity:
      phoneNumber: "+34600000001"
    metadata:
      owner: my-org
      environment: production
      tags: [whatsapp, main]
```

## API Reference

### Authentication

When `API_KEY` is set, all `/api/v1/*` endpoints require authentication:

```bash
# Via header
curl -H "X-API-Key: your-key" http://localhost:3123/api/v1/accounts

# Via Bearer token
curl -H "Authorization: Bearer your-key" http://localhost:3123/api/v1/accounts
```

### Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check |
| `GET` | `/api/v1/accounts` | Yes | List all accounts |
| `GET` | `/api/v1/accounts/:id` | Yes | Get account (includes QR code if connecting) |
| `POST` | `/api/v1/accounts` | Yes | Create account |
| `PUT` | `/api/v1/accounts/:id` | Yes | Update account |
| `DELETE` | `/api/v1/accounts/:id` | Yes | Delete account |
| `POST` | `/api/v1/accounts/:id/connect` | Yes | Initiate connection (generates QR) |
| `POST` | `/api/v1/accounts/:id/disconnect` | Yes | Disconnect |
| `POST` | `/api/v1/messages/send` | Yes | Send a message |
| `GET` | `/api/v1/accounts/:id/webhook` | Yes | Get webhook config |
| `PUT` | `/api/v1/accounts/:id/webhook` | Yes | Set webhook config |
| `DELETE` | `/api/v1/accounts/:id/webhook` | Yes | Remove webhook config |
| `WS` | `/ws/events` | Token | Real-time event stream |

### Send a Message

```bash
curl -X POST http://localhost:3123/api/v1/messages/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "from": "my-whatsapp",
    "to": "+34600000001",
    "content": {
      "type": "text",
      "body": "Hello from the gateway!"
    }
  }'
```

**Content types**: `text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contact`, `reaction`, `poll`

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3123/ws/events?token=your-key&accounts=my-whatsapp');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.event, msg.data);
  // event: "message.inbound" | "connection.update" | "message.sent"
};

// Send a message via WebSocket
ws.send(JSON.stringify({
  action: 'send',
  data: { from: 'my-whatsapp', to: '+34600000001', content: { type: 'text', body: 'Hello!' } }
}));
```

### Inbound Message Format (Unified Envelope)

Every inbound message, regardless of platform, arrives in this standardized format:

```json
{
  "id": "msg_abc123",
  "accountId": "my-whatsapp",
  "channel": "whatsapp",
  "direction": "inbound",
  "timestamp": "2026-04-01T12:00:00.000Z",
  "conversationId": "34600000001@s.whatsapp.net",
  "sender": { "id": "34600000001@s.whatsapp.net", "displayName": "John" },
  "recipient": { "id": "+34600000002" },
  "content": {
    "type": "text",
    "body": "Hello!"
  },
  "context": {
    "quotedMessageId": "prev-msg-id",
    "quotedPreview": "Previous message text",
    "isForwarded": false
  },
  "channelDetails": {
    "platform": "whatsapp",
    "messageId": "WAMID123",
    "isGroup": false,
    "isBusinessAccount": true
  },
  "gateway": {
    "receivedAt": "2026-04-01T12:00:00.000Z",
    "adapterId": "baileys",
    "account": { "id": "my-whatsapp", "alias": "My WhatsApp", "owner": "my-org", "tags": ["whatsapp"] }
  }
}
```

### Webhooks

Configure a global webhook or per-account webhooks to forward events:

```bash
# Per-account webhook
curl -X PUT http://localhost:3123/api/v1/accounts/my-whatsapp/webhook \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{"url": "https://n8n.example.com/webhook/whatsapp", "secret": "my-secret"}'
```

Webhook headers: `X-UMG-Event`, `X-UMG-Account`, `X-UMG-Channel`, `X-UMG-Signature` (HMAC-SHA256).

## Using with n8n

### Option 1: Webhook Trigger (recommended)

1. In n8n, create a **Webhook** node
2. Set the gateway webhook to point to your n8n webhook URL
3. Every inbound message triggers your n8n workflow

### Option 2: Docker Compose with n8n

See [docker-compose.example.yml](docker-compose.example.yml) for a ready-to-use setup with both services.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

```
src/
├── core/           # Domain logic (accounts, messaging, routing, auth)
├── integrations/   # Provider adapters (Baileys, wwebjs, Telegram, etc.)
├── connections/    # I/O transports (REST API, WebSocket, webhooks)
└── infrastructure/ # Framework config (Fastify, env, persistence)
```

## SDK

The TypeScript SDK provides typed clients for REST and WebSocket:

```bash
npm install @messaging-gateway/sdk
```

```typescript
import { MessagingGatewayClient, MessagingGatewayEvents } from '@messaging-gateway/sdk';

// REST
const client = new MessagingGatewayClient({ baseUrl: 'http://localhost:3123', apiKey: 'key' });
await client.send({ from: 'wa-1', to: '+34...', content: { type: 'text', body: 'Hi' } });

// WebSocket (real-time events)
const events = new MessagingGatewayEvents({ baseUrl: 'http://localhost:3123', apiKey: 'key' });
events.on('message.inbound', (envelope) => console.log(envelope.content));
events.connect();
```

See [packages/sdk/README.md](packages/sdk/README.md) for full documentation.

## Development

```bash
npm install
npm run build      # TypeScript -> dist/
npm test           # Run all tests (vitest)
npm run lint       # Type check (tsc --noEmit)
```

## Releases

**Docker image** is published to [GitHub Container Registry](https://ghcr.io/vgpastor/messaginggateway) on every version tag (`v*`):
```bash
docker pull ghcr.io/vgpastor/messaginggateway:latest
docker pull ghcr.io/vgpastor/messaginggateway:1.0.0
```

**SDK** is published to [npm](https://www.npmjs.com/package/@messaging-gateway/sdk) on SDK version tags (`sdk-v*`):
```bash
npm install @messaging-gateway/sdk
```

To create a release:
```bash
# Gateway release
git tag v1.0.0
git push origin v1.0.0

# SDK release
git tag sdk-v0.1.0
git push origin sdk-v0.1.0
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and how to add new providers.

## License

[MIT](LICENSE)
