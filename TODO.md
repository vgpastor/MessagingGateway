# TODO — Messaging Gateway Roadmap

## 🔴 Priority: High

### Rate limiting enforcement
The `rateLimit` config field exists on accounts but is never enforced.
Add `@fastify/rate-limit` for global API protection.
Add per-account rate limiting in `MessageRouterService` using the account's `rateLimit.maxPerMinute`.

## 🟡 Priority: Medium (in progress)

### Metrics & observability
Prometheus metrics endpoint (`GET /metrics`):
- `umg_messages_total{direction, channel, account, status}`
- `umg_webhook_forward_duration_seconds{account, url}`
- `umg_ws_clients_connected`
- `umg_baileys_connection_status{account}`

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

### Message search & analytics
Extends the storage plugin:
- Full-text search across message history
- Per-group/per-contact message stats
- Export to CSV/JSON
- Dashboard-ready API

## 🟢 Priority: Low (nice to have)

### n8n community nodes
Separate repo: `vgpastor/n8n-nodes-messaging-gateway`
- Trigger node: receives inbound messages (webhook-based)
- Action node: send message, manage accounts, configure webhooks
- Uses `@messaging-gateway/sdk` as dependency
- Published to npm as `n8n-nodes-messaging-gateway`

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
- [x] Logger abstraction (Pino, structured JSON)
- [x] SocketManagerPort + BaileysSocketManager injection
- [x] Persistence plugin (SQLite, optional)
- [x] 205 tests
