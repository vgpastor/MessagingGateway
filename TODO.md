# TODO — Messaging Gateway Roadmap

## 🔴 Priority: High

### Rate limiting enforcement
The `rateLimit` config field exists on accounts but is never enforced.
Add `@fastify/rate-limit` for global API protection.
Add per-account rate limiting in `MessageRouterService` using the account's `rateLimit.maxPerMinute`.

## 🟡 Priority: Medium

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
- [x] Prometheus metrics (GET /metrics)
- [x] Groups API (list groups, group info, participants)
- [x] Telegram Bot API provider (send, inbound, content mapper)
- [x] Search & analytics (FTS5, stats, CSV/JSON export)
- [x] 205+ tests
