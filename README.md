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
- **Message persistence**: Store all inbound and outbound messages (SQLite or PostgreSQL)
- **Full-text search**: Search across stored messages (FTS5 / TSVECTOR)
- **Analytics**: Message statistics by channel, direction, content type, hourly distribution
- **Conversation context**: AI-ready conversation history (`format=openai` or `format=raw`)
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
| `STORAGE_ENABLED` | `false` | Enable message persistence |
| `STORAGE_DRIVER` | `sqlite` | Storage backend: `sqlite` or `postgres` |
| `DATABASE_PATH` | `data/messages.db` | SQLite database file path |
| `DATABASE_URL` | _(none)_ | PostgreSQL connection URL (required when driver=postgres) |
| `METRICS_ENABLED` | `true` | Enable Prometheus metrics at `/metrics` |

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

The full, always-current contract lives in the OpenAPI spec ([`openapi.json`](./openapi.json)); when `SWAGGER_ENABLED=true` it is also served interactively at `GET /docs`. The tables below summarise it.

**System** (no auth)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check (returns status, version, uptime) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/openapi.json` | OpenAPI 3 specification |

**Accounts** (auth required)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/accounts` | List all accounts |
| `GET` | `/api/v1/accounts/:id` | Get account (includes QR code while connecting) |
| `POST` | `/api/v1/accounts` | Create account |
| `PUT` | `/api/v1/accounts/:id` | Update account |
| `DELETE` | `/api/v1/accounts/:id` | Delete account |
| `POST` | `/api/v1/accounts/:id/connect` | Initiate connection (generates QR) — self-auth providers |
| `POST` | `/api/v1/accounts/:id/pair` | Request a pairing code instead of a QR — self-auth providers |
| `POST` | `/api/v1/accounts/:id/disconnect` | Disconnect the socket (keeps stored credentials) |
| `POST` | `/api/v1/accounts/:id/reset` | Clear the stored session and reconnect for a fresh QR — use when auth is expired and the account is stuck reconnecting without emitting a QR |
| `GET` | `/api/v1/accounts/:id/health` | Per-account connection health |

**Groups** (auth required)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/accounts/:id/groups` | List groups the account participates in |
| `GET` | `/api/v1/accounts/:id/groups/:groupId` | Get a single group's metadata |

**Messages** (auth required)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/messages/send` | Send a message |
| `GET` | `/api/v1/messages/:id/status` | Delivery status of a sent message |
| `POST` | `/api/v1/messages/:id/read` | Mark a message as read |
| `GET` | `/api/v1/messages` | Query stored messages with filters † |
| `GET` | `/api/v1/messages/:id` | Get a stored message by ID † |
| `GET` | `/api/v1/messages/search?q=` | Full-text search across messages † |
| `GET` | `/api/v1/messages/stats` | Message count with filters † |
| `GET` | `/api/v1/messages/analytics` | Aggregated statistics (by channel, direction, hourly) † |
| `GET` | `/api/v1/messages/export` | Export messages as CSV or JSON † |
| `GET` | `/api/v1/conversations/:id/context` | AI-ready conversation history † |

† Requires message persistence (`STORAGE_ENABLED=true`); otherwise these routes are not registered.

**Webhook configuration** (auth required) — forward events to your systems

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/webhooks` | List all configured webhooks |
| `GET` | `/api/v1/accounts/:id/webhooks` | List an account's webhooks |
| `POST` | `/api/v1/accounts/:id/webhooks` | Add a webhook to an account |
| `PUT` | `/api/v1/webhooks/:webhookId` | Update a webhook |
| `DELETE` | `/api/v1/webhooks/:webhookId` | Delete a webhook |
| `DELETE` | `/api/v1/accounts/:id/webhooks` | Remove all of an account's webhooks |

> The older singular `GET/PUT/DELETE /api/v1/accounts/:id/webhook` endpoints still work for backwards compatibility but are deprecated and hidden from the OpenAPI spec — prefer the plural `…/webhooks` routes above.

**Inbound provider callbacks** (verified by provider signature/token, not the API key) — where cloud providers POST incoming events

| Method | Endpoint | Provider |
|---|---|---|
| `POST` | `/webhooks/whatsapp/:accountId/inbound` · `/status` | WhatsApp Cloud API |
| `POST` | `/webhooks/telegram/:accountId/update` | Telegram |
| `POST` | `/webhooks/email/:accountId/inbound` | Email |
| `POST` | `/webhooks/sms/:accountId/inbound` · `/status` | SMS |

**Real-time** 

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `WS` | `/ws/events` | Token (query param) | Real-time event stream |

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

Add one or more webhooks per account to forward events to your systems:

```bash
# Add a webhook to an account
curl -X POST http://localhost:3123/api/v1/accounts/my-whatsapp/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{"url": "https://n8n.example.com/webhook/whatsapp", "secret": "my-secret"}'

# List an account's webhooks
curl -H "X-API-Key: your-key" http://localhost:3123/api/v1/accounts/my-whatsapp/webhooks
```

Webhook headers: `X-UMG-Event`, `X-UMG-Account`, `X-UMG-Channel`, `X-UMG-Signature` (HMAC-SHA256).

### Message Persistence

Enable message storage to query, search, and analyze your messaging history:

```bash
# .env.local
STORAGE_ENABLED=true
STORAGE_DRIVER=sqlite          # or postgres
DATABASE_PATH=data/messages.db # SQLite only
DATABASE_URL=postgres://user:pass@localhost:5432/messaging # PostgreSQL only
```

#### Query messages

```bash
# List messages with filters
curl -H "X-API-Key: your-key" \
  "http://localhost:3123/api/v1/messages?conversationId=34600000001@s.whatsapp.net&limit=20"

# Full-text search
curl -H "X-API-Key: your-key" \
  "http://localhost:3123/api/v1/messages/search?q=order+refund"

# Analytics
curl -H "X-API-Key: your-key" \
  "http://localhost:3123/api/v1/messages/analytics?since=2026-04-01T00:00:00Z"

# Export to CSV
curl -H "X-API-Key: your-key" \
  "http://localhost:3123/api/v1/messages/export?format=csv" -o messages.csv
```

#### AI-ready conversation context

```bash
# Get conversation history formatted for LLMs
curl -H "X-API-Key: your-key" \
  "http://localhost:3123/api/v1/conversations/34600000001@s.whatsapp.net/context?format=openai&limit=50"
```

Response:

```json
{
  "conversationId": "34600000001@s.whatsapp.net",
  "participantCount": 2,
  "participants": [
    { "id": "34600000001@s.whatsapp.net", "name": "Customer", "messageCount": 5 },
    { "id": "+34600000002", "name": "Agent", "messageCount": 3 }
  ],
  "totalMessages": 8,
  "messages": [
    { "role": "user", "name": "Customer", "content": "Hi, I need help", "timestamp": "2026-04-05T10:00:00Z", "type": "text", "id": "msg_001" },
    { "role": "assistant", "name": "Agent", "content": "Sure, how can I help?", "timestamp": "2026-04-05T10:01:00Z", "type": "text", "id": "msg_002" }
  ]
}
```

#### PostgreSQL with Docker Compose

The included `docker-compose.yml` provides a `postgres` profile for testing:

```bash
docker compose --profile postgres up -d
# Gateway with PostgreSQL on port 3202
```

## Using with n8n

### Option 1: Webhook Trigger (recommended)

1. In n8n, create a **Webhook** node
2. Set the gateway webhook to point to your n8n webhook URL
3. Every inbound message triggers your n8n workflow

### Option 2: Docker Compose with n8n

See [docker-compose.example.yml](docker-compose.example.yml) for a ready-to-use setup with both services.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design, and [CHANGELOG.md](CHANGELOG.md) for version history.

```
src/
├── core/              # Domain logic & ports
│   ├── accounts/      #   Account identity, connection manager port
│   ├── messaging/     #   Content model, unified envelope, routing
│   ├── persistence/   #   Message store ports (CRUD, search, analytics, history)
│   └── ...            #   Auth, events, filters, groups, logger
├── integrations/      # Provider adapters (Baileys, wwebjs, Telegram, etc.)
├── connections/       # I/O transports (REST API, WebSocket, webhooks)
├── persistence/       # Storage adapters (SQLite, PostgreSQL, migrations)
└── infrastructure/    # Framework config (Fastify, env, metrics)
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
npm test           # Run all tests (vitest, 241+ tests)
npm run lint       # Type check (tsc --noEmit)
```

## Releases

Releases are **version-driven** — just bump the version in `package.json` and merge to main:

```bash
# Gateway release (Docker + GitHub Release)
# Edit package.json → "version": "0.2.0" → commit → merge to main
# → Automatically builds and pushes Docker image + creates GitHub Release

# SDK release (npm)
# Edit packages/sdk/package.json → "version": "0.2.0" → commit → merge to main
# → Automatically publishes to npm
```

```bash
docker pull vgpastor/messaging-gateway:latest
npm install @messaging-gateway/sdk
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and how to add new providers.

## License

[MIT](LICENSE)
