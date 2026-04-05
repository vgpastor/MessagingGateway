# Unified Messaging Gateway - Architecture

## 1. Vision

A unified messaging platform that abstracts away provider-specific complexity, enabling:

- **Send and receive** messages across any channel (WhatsApp, Telegram, Instagram, Email, SMS) through a single API
- **Cross-platform interactions**: a poll created on WhatsApp can be answered from Telegram; a conversation can span multiple channels
- **Real-time streaming**: clients subscribe to events via WebSocket, webhooks, or SSE
- **Provider agnostic**: adding a new provider (e.g. Instagram, Discord, Slack) means implementing a single adapter interface — zero changes to core logic
- **Multi-tenant**: multiple accounts per channel, each with their own credentials, webhooks, and routing rules

The system is **event-driven at every layer**: provider events flow inward through the integration layer, get normalized by core, and fan out through the connection layer to any number of subscribers.

---

## 2. Bounded Contexts (Domains)

```
┌──────────────────────────────────────────────────────────────┐
│                     CONNECTIONS DOMAIN                        │
│  How the outside world talks to and listens from the gateway │
│                                                               │
│  WebSocket Server  ·  Webhook Forwarder  ·  REST API          │
│  SSE (future)      ·  Webhook Receivers  ·  gRPC (future)     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                        ┌──────┴──────┐
                        │  EVENT BUS  │
                        └──────┬──────┘
                               │
┌──────────────────────────────┴───────────────────────────────┐
│                        CORE DOMAIN                            │
│  Business logic that is transport- and provider-agnostic      │
│                                                               │
│  Accounts  ·  Routing  ·  Conversations  ·  Envelopes         │
│  Interactions (polls, reactions)  ·  Cross-platform bridges    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                        ┌──────┴──────┐
                        │  EVENT BUS  │
                        └──────┬──────┘
                               │
┌──────────────────────────────┴───────────────────────────────┐
│                    INTEGRATIONS DOMAIN                         │
│  Provider-specific adapters that speak each platform's API    │
│                                                               │
│  Baileys  ·  wwebjs  ·  Meta Cloud API  ·  Telegram Bot API  │
│  Brevo    ·  SES     ·  Twilio          ·  MessageBird        │
│  Instagram Graph API  ·  Discord (future) ·  Slack (future)   │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Core Domain

Owns all business logic. No knowledge of HTTP, WebSocket, Baileys, or any provider. Speaks only in domain events and ports.

| Concept | Responsibility |
|---------|---------------|
| **Account** | A configured channel+provider instance (e.g. "PatrolTech WhatsApp via Baileys"). Status lifecycle, identity, credentials reference. |
| **Envelope** | The normalized message format. Every inbound/outbound message is an `Envelope` regardless of origin. |
| **Conversation** | A thread of envelopes between participants. Can span multiple channels via bridges. |
| **Router** | Resolves which account should handle an outbound message based on routing criteria (channel, owner, tags, rules). |
| **Interaction** | An abstraction over provider-specific features: polls, reactions, read receipts, typing indicators. Normalized into a common model, then adapted per provider. |
| **Bridge** | Links a conversation across channels. E.g. a WhatsApp group bridged to a Telegram group — messages flow both ways. |

### 2.2 Integrations Domain

One adapter per provider. Each adapter implements a set of ports defined by core:

| Port | What it does |
|------|-------------|
| `MessagingAdapter` | Send messages (text, media, location, contacts, etc.) |
| `ConnectionAdapter` | Manage persistent connections (Baileys WebSocket, Telegram long-poll) |
| `InboundAdapter` | Parse raw provider payloads into normalized channel events |
| `HealthAdapter` | Check if credentials/connection are valid |
| `InteractionAdapter` | Create/read polls, reactions, read receipts per provider capability |
| `MediaAdapter` | Download/upload media from/to provider storage |

Adding a new provider = implement whichever ports it supports. Register in the adapter registry. Done.

### 2.3 Connections Domain

Handles all external I/O transports. Knows nothing about WhatsApp or Telegram — only speaks `Envelope` and domain events.

| Component | Direction | Protocol |
|-----------|-----------|----------|
| **REST API** | in/out | HTTP |
| **WebSocket Server** | in/out | WS (bidirectional, real-time) |
| **Webhook Forwarder** | out | HTTP POST to customer URLs |
| **Webhook Receivers** | in | HTTP POST from providers (wwebjs, Telegram, etc.) |
| **SSE** (future) | out | Server-Sent Events (unidirectional) |

---

## 3. Event Bus

The backbone of the system. All communication between domains flows through typed events.

### 3.1 Design

```typescript
interface DomainEvent<T = unknown> {
  id: string;                    // Unique event ID (uuid)
  type: string;                  // Event type key
  timestamp: Date;
  source: string;                // Who emitted: 'baileys', 'api', 'router', etc.
  accountId?: string;            // Related account (if applicable)
  data: T;                       // Event-specific payload
}

interface EventBus {
  emit<T>(event: DomainEvent<T>): Promise<void>;
  on<T>(type: string, handler: (event: DomainEvent<T>) => Promise<void>): void;
  off(type: string, handler: Function): void;
}
```

In-process implementation (TypeScript EventEmitter). No external broker needed for single-instance deployments. Can be swapped for Redis Pub/Sub or NATS for horizontal scaling.

### 3.2 Event Catalog

#### Inbound (Integration → Core → Connections)

| Event | Payload | Emitted by | Consumed by |
|-------|---------|-----------|-------------|
| `message.inbound` | `Envelope` | Integration adapters | WebhookForwarder, WebSocketBroadcaster, PersistenceSubscriber |
| `message.status` | `{messageId, status, timestamp}` | Integration adapters | WebhookForwarder, WebSocketBroadcaster |
| `connection.update` | `{accountId, status, qr?}` | Integration adapters | WebSocketBroadcaster, AccountManager |

#### Outbound (Connections → Core → Integration)

| Event | Payload | Emitted by | Consumed by |
|-------|---------|-----------|-------------|
| `message.send.request` | `SendCommand` | REST API, WebSocket | MessageRouter |
| `message.outbound` | `Envelope` | MessageRouter | PersistenceSubscriber |
| `message.send.success` | `{messageId, accountId, ...}` | MessageRouter | WebhookForwarder, WebSocketBroadcaster |
| `message.send.failure` | `{error, accountId, ...}` | MessageRouter | WebhookForwarder, WebSocketBroadcaster |

#### Account lifecycle

| Event | Payload | Emitted by | Consumed by |
|-------|---------|-----------|-------------|
| `account.created` | `Account` | AccountManager | HealthChecker, ConnectionManager |
| `account.updated` | `Account` | AccountManager | HealthChecker |
| `account.deleted` | `{accountId}` | AccountManager | ConnectionManager, WebhookForwarder |
| `account.health.changed` | `{accountId, old, new}` | HealthChecker | WebSocketBroadcaster |

#### Interactions (future)

| Event | Payload | Emitted by | Consumed by |
|-------|---------|-----------|-------------|
| `interaction.poll.created` | `Poll` | REST API / Integration | Bridge, WebSocketBroadcaster |
| `interaction.poll.vote` | `{pollId, voter, option}` | Integration adapter | Bridge, Core aggregation |
| `interaction.reaction` | `{messageId, emoji, from}` | Integration adapter | Bridge, WebSocketBroadcaster |
| `interaction.typing` | `{conversationId, from}` | Integration adapter | WebSocketBroadcaster |

---

## 4. Ports & Interfaces (Extensibility)

All interfaces live in Core. Implementations live in Integrations or Connections.

### 4.1 Integration Ports

```typescript
// Every provider implements some or all of these

interface MessagingAdapter {
  readonly providerId: string;
  send(msg: OutboundMessage): Promise<SendResult>;
  getStatus(messageId: string): Promise<MessageStatus>;
  markAsRead(messageId: string): Promise<void>;
}

interface ConnectionAdapter {
  readonly providerId: string;
  connect(accountId: string, config: ProviderConfig): Promise<void>;
  disconnect(accountId: string): Promise<void>;
  getStatus(accountId: string): ConnectionStatus;
  getAuthChallenge(accountId: string): AuthChallenge | undefined;  // QR, pairing code, etc.
}

interface InboundAdapter<TRaw = unknown> {
  readonly providerId: string;
  parse(raw: TRaw): ChannelEvent;
  toEnvelope(event: ChannelEvent, account: Account): Envelope;
  validateSignature?(request: RawRequest): boolean;
}

interface HealthAdapter {
  readonly providerId: string;
  validate(account: Account): Promise<HealthResult>;
}

interface InteractionAdapter {
  readonly providerId: string;
  readonly capabilities: InteractionCapability[];  // ['poll', 'reaction', 'typing', 'read_receipt']
  createPoll?(conversationId: string, poll: PollDefinition): Promise<string>;
  sendReaction?(messageId: string, emoji: string): Promise<void>;
  sendTyping?(conversationId: string): Promise<void>;
}

interface MediaAdapter {
  readonly providerId: string;
  download(mediaRef: MediaReference): Promise<MediaContent>;
  upload?(content: MediaContent): Promise<MediaReference>;
}
```

### 4.2 Provider Registry

```typescript
interface ProviderRegistry {
  register(provider: ProviderBundle): void;
  getMessaging(providerId: string): MessagingAdapter;
  getConnection(providerId: string): ConnectionAdapter | undefined;
  getInbound(providerId: string): InboundAdapter;
  getHealth(providerId: string): HealthAdapter;
  getInteraction(providerId: string): InteractionAdapter | undefined;
  getMedia(providerId: string): MediaAdapter | undefined;
  listProviders(): ProviderInfo[];
}

// A provider registers all its adapters as a bundle
interface ProviderBundle {
  id: string;                                    // 'baileys', 'telegram-bot-api', etc.
  channel: ChannelType;                          // 'whatsapp', 'telegram', etc.
  displayName: string;
  messaging: MessagingAdapterFactory;
  connection?: ConnectionAdapterFactory;         // Only for stateful providers
  inbound: InboundAdapterFactory;
  health: HealthAdapterFactory;
  interaction?: InteractionAdapterFactory;
  media?: MediaAdapterFactory;
}
```

### 4.3 Adding a new provider (example: Instagram)

```typescript
// src/integrations/instagram/index.ts
export const instagramProvider: ProviderBundle = {
  id: 'instagram-graph-api',
  channel: 'instagram',
  displayName: 'Instagram Graph API',
  messaging: (account) => new InstagramMessagingAdapter(account),
  inbound: () => new InstagramInboundAdapter(),
  health: () => new InstagramHealthAdapter(),
  interaction: (account) => new InstagramInteractionAdapter(account),  // stories, reactions
  media: (account) => new InstagramMediaAdapter(account),
};

// src/index.ts (bootstrap)
providerRegistry.register(instagramProvider);
```

Zero changes to core, connections, or any other provider.

---

## 5. Main Flows

### 5.1 Inbound Message

```
Provider (WhatsApp)
  │
  ▼
InboundAdapter.parse(rawPayload)         ← Integrations domain
  │ returns ChannelEvent
  ▼
InboundAdapter.toEnvelope(event, account) ← Integrations domain
  │ returns Envelope
  ▼
EventBus.emit('message.inbound', envelope) ← Core domain
  │
  ├──▶ WebhookForwarder.handle(envelope)   ← Connections domain
  │      HTTP POST to customer webhook URL
  │
  ├──▶ WebSocketBroadcaster.handle(envelope) ← Connections domain
  │      Push to subscribed WS clients
  │
  └──▶ ConversationTracker.handle(envelope)  ← Core domain (future)
         Update conversation thread
```

### 5.2 Outbound Message (API)

```
Client
  │ POST /api/v1/messages/send  OR  WS {action: 'send'}
  ▼
EventBus.emit('message.send.request', command)  ← Connections domain
  │
  ▼
MessageRouter.handle(command)                    ← Core domain
  │ resolves account by routing criteria
  │ gets MessagingAdapter from ProviderRegistry
  ▼
MessagingAdapter.send(outboundMessage)           ← Integrations domain
  │ returns SendResult
  ▼
EventBus.emit('message.send.success', result)    ← Core domain
  │
  ├──▶ WebhookForwarder (optional notification)
  └──▶ WebSocketBroadcaster (real-time confirmation)
```

### 5.3 Cross-Platform Bridge (future)

```
User A sends "Hello" on WhatsApp group
  │
  ▼
message.inbound (WhatsApp envelope)
  │
  ▼
BridgeService checks: is this conversation bridged?
  │ Yes → bridge to Telegram group "Team Chat"
  ▼
EventBus.emit('message.send.request', {
  from: telegramAccountId,
  to: telegramGroupId,
  content: { type: 'text', body: '[User A via WhatsApp]: Hello' },
  metadata: { bridgedFrom: whatsAppEnvelope.id }
})
  │
  ▼
MessageRouter → TelegramAdapter.send()
```

### 5.4 Cross-Platform Poll (future)

```
API creates poll: "Where should we eat?"
  │ options: ["Pizza", "Sushi", "Tacos"]
  │ targets: [whatsAppGroupId, telegramGroupId]
  ▼
Core creates Poll entity with unique ID
  │
  ├──▶ WhatsApp InteractionAdapter.createPoll()  → native WA poll
  └──▶ Telegram InteractionAdapter.createPoll()   → native TG poll
         (each stores mapping: pollId ↔ providerPollId)

User votes "Pizza" on Telegram
  │
  ▼
interaction.poll.vote {pollId, voter: "tg:user123", option: "Pizza"}
  │
  ▼
Core aggregates votes across all channels
  │ total: Pizza=3 (2 WA + 1 TG), Sushi=1 (WA), Tacos=0
  ▼
EventBus.emit('interaction.poll.updated', aggregatedResults)
  │
  ├──▶ WebSocketBroadcaster → real-time results to dashboard
  └──▶ (optional) push updated results back to each channel
```

---

## 6. Connection Layer Detail

### 6.1 WebSocket Server

**Endpoint**: `GET /ws/events` (HTTP upgrade to WebSocket)

**Authentication**: Token-based via query param or first message:
```
ws://localhost:3123/ws/events?token=<api-key>
```

**Client → Server messages**:
```json
{"action": "subscribe", "accounts": ["wab-vgpastor", "wa-test"]}
{"action": "unsubscribe", "accounts": ["wa-test"]}
{"action": "send", "data": {"from": "wab-vgpastor", "to": "+34...", "content": {"type": "text", "body": "Hello"}}}
{"action": "ping"}
```

**Server → Client messages**:
```json
{"event": "message.inbound", "timestamp": "...", "data": {...Envelope}}
{"event": "message.sent", "timestamp": "...", "data": {...SendResult}}
{"event": "connection.update", "timestamp": "...", "data": {"accountId": "...", "status": "connected"}}
{"event": "pong"}
```

**WebSocketBroadcaster**:
- Maintains `Map<accountId, Set<WebSocket>>` + global subscribers
- Subscribes to event bus events
- Filters and pushes to relevant WS clients
- Handles client disconnection cleanup

### 6.2 Webhook Forwarder (existing, enhanced)

Same as current but driven by event bus subscriptions instead of direct calls:

```typescript
class WebhookForwarder {
  constructor(eventBus: EventBus, configRepo: WebhookConfigRepository, globalUrl?, globalSecret?) {
    eventBus.on('message.inbound', (e) => this.forward(e.data, 'message.inbound'));
    eventBus.on('message.send.success', (e) => this.forward(e.data, 'message.sent'));
    eventBus.on('message.status', (e) => this.forward(e.data, 'message.status'));
  }
}
```

### 6.3 REST API (existing, unchanged)

Current endpoints remain. The send controller emits `message.send.request` instead of calling the router directly.

---

## 7. Directory Structure (Target)

```
src/
├── core/                                  # CORE DOMAIN
│   ├── event-bus.ts                       # EventBus implementation
│   ├── events.ts                          # All event type definitions
│   ├── accounts/
│   │   ├── account.entity.ts
│   │   ├── account.repository.ts          # Port (interface)
│   │   ├── account-identity.ts
│   │   └── connection-manager.port.ts     # Port (interface)
│   ├── messaging/
│   │   ├── envelope.ts                    # UnifiedEnvelope
│   │   ├── outbound-message.ts
│   │   ├── send-result.ts
│   │   ├── channel.types.ts
│   │   └── ports/
│   │       ├── messaging.adapter.ts       # Port: send messages
│   │       ├── inbound.adapter.ts         # Port: parse inbound
│   │       ├── health.adapter.ts          # Port: validate credentials
│   │       ├── interaction.adapter.ts     # Port: polls, reactions
│   │       └── media.adapter.ts           # Port: media up/download
│   ├── persistence/                       # Message storage ports & services
│   │   ├── message-store.port.ts          # Segregated ports: CRUD, Search, Analytics, History
│   │   ├── message-store.utils.ts         # Shared utilities (toUTC, formatContentForAI, etc.)
│   │   └── conversation-context.service.ts # Application service: raw history → AI format
│   ├── routing/
│   │   ├── message-router.service.ts      # Subscribes to message.send.request
│   │   └── routing-rules.ts
│   ├── conversations/                     # Future: conversation tracking
│   │   └── conversation.entity.ts
│   ├── interactions/                      # Future: polls, reactions
│   │   ├── poll.entity.ts
│   │   └── reaction.entity.ts
│   ├── bridges/                           # Future: cross-platform bridges
│   │   └── bridge.service.ts
│   └── errors.ts
│
├── integrations/                          # INTEGRATIONS DOMAIN
│   ├── provider-registry.ts               # Registry of all provider bundles
│   ├── whatsapp/
│   │   ├── whatsapp.events.ts             # Shared WhatsApp event types
│   │   ├── baileys/
│   │   │   ├── index.ts                   # ProviderBundle export
│   │   │   ├── baileys.messaging.ts
│   │   │   ├── baileys.connection.ts
│   │   │   ├── baileys.inbound.ts
│   │   │   ├── baileys.health.ts
│   │   │   ├── baileys.mapper.ts
│   │   │   └── baileys-socket.manager.ts
│   │   └── wwebjs-api/
│   │       ├── index.ts                   # ProviderBundle export
│   │       ├── wwebjs.messaging.ts
│   │       ├── wwebjs.inbound.ts
│   │       ├── wwebjs.health.ts
│   │       └── wwebjs.mapper.ts
│   ├── telegram/
│   │   └── bot-api/
│   │       ├── index.ts
│   │       └── telegram.health.ts
│   ├── email/
│   │   └── brevo/
│   │       ├── index.ts
│   │       └── brevo.health.ts
│   └── sms/
│       ├── twilio/
│       └── messagebird/
│
├── connections/                            # CONNECTIONS DOMAIN
│   ├── ws/
│   │   ├── websocket-broadcaster.ts       # Subscribes to events → pushes to WS clients
│   │   └── websocket.controller.ts        # GET /ws/events route
│   ├── webhooks/
│   │   ├── webhook-forwarder.ts           # Subscribes to events → HTTP POST
│   │   ├── webhook-config.entity.ts
│   │   ├── webhook-config.repository.ts
│   │   └── file-webhook-config.store.ts
│   └── api/
│       ├── schemas.ts
│       ├── accounts.controller.ts
│       ├── send.controller.ts
│       ├── messages.controller.ts         # Query, search, analytics, export, context
│       ├── health.controller.ts
│       ├── metrics.controller.ts          # Prometheus metrics
│       ├── groups.controller.ts           # Group listing and metadata
│       ├── status.controller.ts           # Provider connection status
│       ├── webhook-config.controller.ts
│       └── inbound/
│           ├── whatsapp.inbound.controller.ts
│           ├── telegram.inbound.controller.ts
│           ├── email.inbound.controller.ts
│           └── sms.inbound.controller.ts
│
├── persistence/                           # Storage adapters (infra layer)
│   ├── sqlite-message-store.ts            # SQLite adapter (better-sqlite3)
│   ├── postgres-message-store.ts          # PostgreSQL adapter (pg)
│   ├── message-store.factory.ts           # Driver selection + lifecycle orchestration
│   ├── persistence-subscriber.ts          # EventBus listener → store.save()
│   └── migrations/
│       ├── migration-runner.ts            # Generic runner: load scripts → apply pending
│       ├── migration.port.ts              # Adapter interface for DB-specific ops
│       ├── resolve-scripts-dir.ts         # Probe dist/src/nearby paths
│       ├── adapters/
│       │   ├── sqlite-migration.adapter.ts
│       │   └── postgres-migration.adapter.ts
│       └── scripts/
│           ├── sqlite/                    # 001_initial_schema.sql, 002_fts_delete_trigger.sql
│           └── postgres/                  # 001_initial_schema.sql
│
├── infrastructure/                        # Pure infra (framework, config)
│   ├── server.ts                          # Fastify setup
│   ├── config/
│   │   ├── env.config.ts
│   │   ├── accounts.loader.ts
│   │   ├── accounts.schema.ts
│   │   └── in-memory-account.repository.ts
│   ├── credential-validator.ts
│   ├── health-check-scheduler.ts
│   ├── logger/
│   │   └── pino-logger.ts
│   └── metrics/
│       └── prometheus.ts
│
└── index.ts                               # Bootstrap: wire EventBus, register providers, start
```

---

## 8. Implementation Phases

### Phase 1: Event Bus + Domain Reorganization
- Create `EventBus` and event types
- Reorganize directories: `domain/` → `core/`, `adapters/` → `integrations/`
- Create `connections/` and move controllers + webhook forwarder
- Wire event bus: Baileys emits → WebhookForwarder subscribes
- All existing tests pass, webhooks work identically

### Phase 2: Provider Registry
- Create `ProviderBundle` interface and `ProviderRegistry`
- Refactor Baileys and wwebjs into bundle format
- Bootstrap uses registry instead of hardcoded provider setup
- Remove provider-specific logic from `index.ts`

### Phase 3: WebSocket Server
- Install `@fastify/websocket`
- Create `WebSocketBroadcaster` (subscribes to event bus)
- Create WS controller with subscribe/send actions
- Test: wscat receives events when WhatsApp message arrives

### Phase 4: Bidirectional WebSocket
- Handle `send` action from WS clients
- Emit `message.send.request` to event bus
- Return confirmation to WS client

### Phase 5: Interaction Adapters (polls, reactions)
- Define `InteractionAdapter` port
- Implement for Baileys (WhatsApp polls, reactions)
- API endpoints for creating/reading interactions

### Phase 6: Conversations & Bridges
- Conversation entity and tracking
- Bridge service for cross-platform message routing
- Bridge configuration API

---

## 9. Design Principles

1. **Events over direct calls**: Domains communicate only through the event bus
2. **Ports over implementations**: Core defines interfaces, integrations implement them
3. **Bundle registration**: New providers are a single `ProviderBundle` — no scattered registrations
4. **Capability-based**: Not all providers support all features. `InteractionAdapter.capabilities` declares what's available
5. **Envelope normalization**: Every message, regardless of origin, becomes an `Envelope` before entering core
6. **Transport agnostic**: Core doesn't know if a message came from REST, WebSocket, or a bridge
7. **Horizontal scalability path**: EventBus interface can be swapped from in-process to Redis/NATS without changing domain code
