# TODO — Messaging Gateway Roadmap

## 🔴 Priority: High

### Logger abstraction
Replace all `console.log/error/warn` with a gateway-owned logger wrapper.
Not tied to Fastify — a standalone `Logger` port in `core/` with a Pino implementation in `infrastructure/`.
All layers use `Logger.info()`, `Logger.error()`, etc. Output is structured JSON in production, pretty in dev.

### BaileysSocketManager injection
Extract from module-level singleton to injectable dependency.
Pass via constructor in BaileysAdapter, BaileysConnectionManager, BaileysHealthChecker.
Makes Baileys fully testable without side effects.

### Rate limiting enforcement
The `rateLimit` config field exists on accounts but is never enforced.
Add `@fastify/rate-limit` for global API protection.
Add per-account rate limiting in `MessageRouterService` using the account's `rateLimit.maxPerMinute`.

## 🟡 Priority: Medium

### Storage plugin (new domain: `persistence/`)
Optional plugin that stores messages in a database (SQLite default, Postgres for scale).
- New domain: `src/persistence/` with its own EventBus subscriber
- Activated via env var `STORAGE_ENABLED=true` + `DATABASE_URL`
- Subscribes to `message.inbound` and `message.send.success` events
- Provides query API: `GET /api/v1/messages?accountId=&from=&to=&since=&until=`
- Tied to metrics: message counts, per-group stats, response times
- Zero impact when disabled — the EventBus subscriber simply isn't registered

### Metrics & observability
Prometheus metrics endpoint (`GET /metrics`):
- `umg_messages_total{direction, channel, account, status}`
- `umg_webhook_forward_duration_seconds{account, url}`
- `umg_ws_clients_connected`
- `umg_baileys_connection_status{account}`
Depends on the Logger abstraction for structured correlation.
Can share storage with the persistence plugin for historical stats.

### Telegram Bot API provider
Implement full Telegram adapter:
- `messaging`: sendMessage, sendPhoto, sendDocument, sendLocation
- `inbound`: parse Telegram Bot API webhook updates
- `health`: validate bot token via `getMe`
- `connection`: long-polling or webhook registration
The stubs already exist in `src/integrations/telegram/bot-api/`.

### Groups API
New endpoints for group management:
- `GET /api/v1/accounts/:id/groups` — list all groups
- `GET /api/v1/accounts/:id/groups/:groupId` — group info + members
- `POST /api/v1/accounts/:id/groups/:groupId/send` — send to group
Requires Baileys `groupMetadata` and `groupFetchAllParticipating`.

## 🟢 Priority: Low (nice to have)

### n8n community nodes
Separate repo: `vgpastor/n8n-nodes-messaging-gateway`
- Trigger node: receives inbound messages (webhook-based)
- Action node: send message, manage accounts, configure webhooks
- Uses `@messaging-gateway/sdk` as dependency
- Published to npm as `n8n-nodes-messaging-gateway`

### Message search & analytics
Extends the storage plugin:
- Full-text search across message history
- Per-group/per-contact message stats
- Export to CSV/JSON
- Dashboard-ready API

### Email provider (Brevo full implementation)
Complete the Brevo adapter:
- `messaging`: send transactional emails
- `inbound`: parse Brevo inbound webhook
- Currently only has health checker stub

### SMS providers (Twilio/MessageBird full implementation)
Complete SMS adapters:
- `messaging`: send SMS
- `inbound`: parse delivery receipts and inbound SMS
- Currently only have health checker stubs

## ✅ Completed

- [x] Event-driven architecture with EventBus
- [x] 3-domain DDD (core/integrations/connections)
- [x] ProviderRegistry with bundle-based registration
- [x] WebSocket server (bidirectional)
- [x] Multi-webhook per account
- [x] Webhook filters (include/exclude/fromMe)
- [x] Standardized content model (13 message types)
- [x] Media download at inbound time (Baileys)
- [x] API key authentication (mandatory)
- [x] TypeScript SDK (@messaging-gateway/sdk)
- [x] CI/CD: Docker GHCR + Docker Hub + npm OIDC
- [x] Version-driven releases (package.json = source of truth)
- [x] Zero DDD cross-layer violations
- [x] 205 tests
