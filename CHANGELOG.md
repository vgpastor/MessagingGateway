# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-05

### Added

- **Message persistence** — full bidirectional storage of inbound and outbound messages
  - SQLite (default, zero config) and PostgreSQL drivers
  - Lazy-loaded drivers: `better-sqlite3` or `pg` only required when enabled
  - Configurable via `STORAGE_ENABLED`, `STORAGE_DRIVER`, `DATABASE_URL`, `DATABASE_PATH`
- **Migration system** — numbered SQL scripts per driver with checksum tracking
  - `MigrationRunner` with `MigrationAdapter` port (SQLite + PostgreSQL adapters)
  - Idempotent: safe to run multiple times, tracks applied migrations in `_migrations` table
  - FTS delete trigger (`002_fts_delete_trigger.sql`) prevents orphaned search entries
- **Full-text search** — search across stored messages
  - SQLite: FTS5 virtual table with content sync triggers
  - PostgreSQL: `tsvector` + GIN index with `plainto_tsquery`
  - `GET /api/v1/messages/search?q=keyword` endpoint
- **Analytics & statistics** — aggregated message metrics
  - `GET /api/v1/messages/analytics` — stats by channel, direction, content type, hourly distribution
  - `GET /api/v1/messages/stats` — simple count with filters
  - `GET /api/v1/messages/export` — CSV or JSON bulk export
- **Conversation context** — AI-ready conversation history
  - `GET /api/v1/conversations/:id/context` — chronological messages with participant info
  - `format=openai` maps direction to `user`/`assistant` roles
  - `format=raw` returns full `UnifiedEnvelope` objects
- **Message query API** — filter and paginate stored messages
  - `GET /api/v1/messages` — filter by account, channel, conversation, direction, date range
  - `GET /api/v1/messages/:id` — retrieve single message by ID
- **WhatsApp LID resolution** — bidirectional conversation tracking
  - Resolves WhatsApp Logical IDs (`@lid`) to phone-based JIDs using Baileys `signalRepository`
  - Preserves original LID and resolved JID in `channelDetails` for future use
  - Applies `jidNormalizedUser()` to strip device suffixes (e.g., `:0`)
- **Outbound message persistence** — stores sent messages with full envelope metadata
  - `MessageRouterService` emits `MESSAGE_OUTBOUND` event after successful send
  - Uses `remoteJid` from provider response when available for accurate `conversationId`
  - Sender identity resolved from account identity (phone number, bot ID, etc.)
- **Media download at inbound** — Baileys provider downloads media inline
  - `downloadBaileysMedia()` extracts and base64-encodes media from WAMessage
  - Non-blocking: continues without media on download failure
  - Populates `content.media.base64` and `content.media.filename` on the envelope
- **Docker compose profiles** for testing: `sqlite` (port 3201) and `postgres` (port 3202)
- **SDK v0.3.0** — full type exports for persistence and analytics
  - Exports all core messaging types (`UnifiedEnvelope`, `MessageContent`, `ContactRef`, etc.)
  - Exports account and webhook types (`Account`, `WebhookConfig`, `CreateAccountInput`, etc.)
  - Exports persistence types (`MessageQuery`, `MessageQueryResult`, `MessageStats`, `ConversationContext`, `ConversationMessage`, `ConversationContextOptions`)
  - `MessagesApi` sub-client: `query()`, `search()`, `analytics()`, `export()`, `conversationContext()`
- **n8n nodes v0.2.0** — message persistence operations
  - Query: filter stored messages by account, conversation, direction, content type, date range
  - Search: full-text search across stored messages
  - Analytics: aggregated message statistics
  - Export: bulk export messages as CSV or JSON
  - Conversation Context: AI-ready conversation history with OpenAI/raw format support

### Changed

- **Architecture refactoring (DDD/SOLID/Clean Code)**
  - `MessageStorePort` segregated into `MessageStorePort` (CRUD), `MessageSearchPort` (FTS), `MessageAnalyticsPort` (stats), `ConversationHistoryPort` (raw history) — Interface Segregation Principle
  - `FullMessageStorePort` composite interface for full-featured store implementations
  - `ConversationContextService` extracts AI formatting from stores to application service — eliminates duplication between SQLite and PostgreSQL
  - Port moved from `src/persistence/` to `src/core/persistence/` (domain layer)
  - Controller moved from `src/persistence/` to `src/connections/api/` (transport layer)
  - Shared utilities moved to `src/core/persistence/message-store.utils.ts`
  - OpenAI role vocabulary (`user`/`assistant`/`system`) removed from domain port — lives only in `ConversationContextService`
- **Store initialization** — fail-fast instead of silent degradation
  - `requireDb()` / `requirePool()` throw `Error` if store not initialized
  - Replaces silent `if (!db) return empty` guards in every method
- **Migration orchestration** — moved from `store.init()` to factory
  - `init()` now only handles connection setup
  - `runMigrations()` is a separate method called by the factory
  - Single Responsibility Principle: stores don't know about migration adapters
- **Migration runner** — typed logger, removed non-null assertions
  - Extracted `MigrationLogger` interface, field typed as non-optional
  - `this.logger` instead of `this.logger!` throughout
- **Migration path resolution** — fail-fast on missing directory
  - `resolveMigrationScriptsDir()` throws with all probed paths instead of silent fallback
- **`parseJsonColumn` / `parseJsonColumnRequired`** — now generic with type parameters
  - `parseJsonColumn<T>(): T | undefined` instead of returning `any`
- **CSV export** — removed `as any` cast, uses discriminated union narrowing
  - Named constants `DEFAULT_EXPORT_LIMIT` (1000) and `DEFAULT_QUERY_LIMIT` (50)
- **Group name cache** — key includes `accountId` to prevent cross-account contamination
- **`MessageResult`** — added `remoteJid?: string` for provider-returned JID
- **`MessageRouterService`** — `eventBus` passed as typed parameter instead of non-null assertion
- **`SqliteMigrationAdapter`** — typed `Database.Database` instead of `any`
- **`resolve-scripts-dir`** — removed ESM-incompatible `require.main` fallback

### Fixed

- WhatsApp inbound DMs used LID-based `conversationId` (`@lid`) while outbound used phone-based JID — now both resolve to the same phone-based JID
- Phone JID with device suffix (e.g., `34600000099:0@s.whatsapp.net`) normalized to `34600000099@s.whatsapp.net`
- Docker `conflict type:replaced` error when multiple gateways compete for same WhatsApp session
- `Content-Length` mismatch with emoji in JSON payloads

## [0.2.5] - 2026-03-28

### Added

- Conversation context endpoint for AI consumption
- Search and analytics endpoints (FTS5, stats, export)
- UTC enforcement in persistence layer

## [0.2.4] - 2026-03-25

### Added

- Telegram Bot API provider (send, inbound, content mapper)
- Groups API (list groups, group info, participants)
- Prometheus metrics (`GET /metrics`)

## [0.2.3] - 2026-03-20

### Added

- SQLite persistence plugin (optional)
- Full-text search with FTS5

## [0.2.2] - 2026-03-15

### Added

- WebSocket bidirectional event streaming
- Webhook filters (include/exclude/fromMe per account)
- Multi-webhook per account support

## [0.2.1] - 2026-03-10

### Added

- TypeScript SDK (`@messaging-gateway/sdk`)
- CI/CD: Docker GHCR + Docker Hub + npm OIDC publishing
- Version-driven releases (package.json = source of truth)

## [0.2.0] - 2026-03-05

### Added

- Event-driven architecture with EventBus
- Provider registry with bundle-based registration
- Standardized content model (13 message types)
- API key authentication (mandatory in production)
- Logger abstraction (Pino, structured JSON)

## [0.1.0] - 2026-02-20

### Added

- Initial release
- WhatsApp support via Baileys and wwebjs-api
- REST API for sending messages
- Account management via YAML configuration
- Docker support with health checks
