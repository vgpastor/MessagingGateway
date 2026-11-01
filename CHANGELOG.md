# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Registro de mensajes con `accountSeq`**: cada mensaje entrante guardado lleva un número contiguo por cuenta, con deduplicación por id de WhatsApp. `GET /api/v1/messages?accountId=&afterAccountSeq=` lee lo que sigue a un cursor y devuelve `nextAfterAccountSeq`, `lastAccountSeq` y `firstAccountSeq`, para ponerse al día sin perder mensajes. Los sobres añaden `seq`, `accountSeq`, `sentAt` y, en el remitente, `phone` y `lid`.
- **Medios en disco**: la entrada se descarga a `MEDIA_DIR` con tamaño máximo (`MEDIA_MAX_BYTES`) y reintentos, y se sirve con `GET /api/v1/media/:id` (200, 202 mientras se descarga, 410 si se omitió o caducó).
- **Retención**: `MEDIA_RETENTION_DAYS` (30 por defecto) y `MESSAGE_RETENTION_DAYS` (opcional: con 0, el valor por defecto, nunca se borra un mensaje).
- **`READ_API_KEY`**: clave de solo lectura para los mensajes, los medios y el flujo de eventos por WebSocket.
- **`conversations`** en cada cuenta (`accounts.yaml` y `POST /api/v1/accounts`): limita qué conversaciones entrantes se guardan.
- **Métricas Prometheus** en `/metrics`, solo con la clave de administración.
- **Alertas de cuenta caída** en `ALERT_WEBHOOK_URL`: `auth_expired` al momento y `disconnected` tras 15 minutos, reintentadas hasta un 2xx y repetidas cada 6 horas. Los webhooks de las cuentas pueden suscribirse a `connection.update`.
- **WebSocket**: autenticación por cabecera o subprotocolo (`umg.<clave>`) y ping cada 30 s, que corta a quien no responde.
- **SDK**: `messages.after()`, `messages.media()`, `timeoutMs` en el cliente REST, reconexión con espera creciente y vigilancia del latido. El paquete se puede cargar con `require()` desde CommonJS.

### Changed

- **Rompe, al actualizar el SDK de 0.3.x a 0.4.0:**
  - Los campos de `gateway` y `channelDetails.platform` pasan a ser opcionales, en los tipos manuales y en los generados: un mensaje guardado conserva la forma de la versión que lo escribió. Hay que contemplar `undefined`.
  - Las funciones generadas devuelven `{ data, status, headers }`, como ya decían sus tipos, y no el cuerpo a secas. Un cuerpo binario llega como `Blob`, no como texto corrupto.
  - `HealthStatus.status` deja de incluir `error`, y `qr` puede ser `null` con la clave de lectura.
  - Las peticiones REST caducan a los 30 s por defecto (`timeoutMs`).
  - `engines` pasa a `>=20.19 <21 || >=22.12`, lo que necesita `require(esm)`.
  - La autenticación del WebSocket exige un gateway de esta versión: uno anterior rechaza el handshake con `4401`.
- **Rompe, en el gateway:**
  - La media entrante ya no viaja en base64 dentro del sobre: se descarga con `media.url` cuando `media.status` es `ready`.
  - `/metrics` exige la clave de administración.
  - `?token=` en el WebSocket queda obsoleto, porque las URL acaban en los logs. Sigue funcionando.
- **`/health` informa de verdad**, pero solo del estado general: `degraded` si una cuenta no suspendida no está `active` o ha perdido la conexión. Es público, así que no nombra cuentas; el detalle está en `GET /api/v1/accounts`.
- **`GET /api/v1/accounts/:id` solo lee**: ya no abre conexiones.
- **El primer arranque aplica las migraciones `postgres/002_message_log` y `sqlite/003_message_log`**, que reescriben la tabla de mensajes y pueden tardar. Se aplican sin límite de tiempo.

### Fixed

- **Suspender una cuenta cierra su socket**, sin `logout` y conservando la sesión en disco, y reactivarla reconecta sin QR nuevo. Antes una cuenta ya conectada seguía recibiendo mensajes. Ninguna señal de conexión ni comprobación de salud saca a una cuenta de `suspended`.
- **Una conexión caída ya no se confunde con una sesión perdida**, y la reconexión usa espera creciente con jitter, sin tope de intentos; solo se detiene con una sesión perdida, una desconexión deliberada o un reset.
- **Una cuenta creada en caliente recibe sus eventos sin reiniciar**, reactivar una cuenta suspendida la conecta, y borrar una cuenta cierra su socket y su sesión.
- **Ningún mensaje se pierde si el almacén lo rechaza**: se entrega en directo, sin `accountSeq`, y se guarda en el siguiente arranque, de modo que puede llegar dos veces: hay que deduplicar por `id`. Los webhooks ya no frenan la cola de entrada y caducan a los 10 s.
- **Postgres**: cada consulta tiene un límite de 30 s, para que un insert colgado no retenga la cola de la cuenta; una transacción abierta e inactiva termina a los 60 s, para que una partición de red no retenga el contador de la cuenta; y un insert fallido descarta su conexión. La retención dispone de 15 minutos por consulta.
- **Filas de versiones anteriores**: ya no bloquean la lectura del registro, y el historial en base64 queda fuera de las lecturas. Toda lectura limita el tamaño de la página.
- **Apagado**: termina limpio en 10 s y sin `logout`, de modo que el siguiente arranque retoma las sesiones.
- **Un fallo al guardar credenciales o un handler que lanza** ya no terminan el proceso.
- **OpenAPI y SDK**: `POST /api/v1/accounts` declara `conversations`, el SDK deja de prometer `accounts` en `/health` y `sdk-build` corre por fin las pruebas del SDK en CI.

### Security

- Los logs ya no llevan claves ni tokens en las URL, y de un webhook solo registran el host.

## [0.5.1] - 2026-09-05

### Fixed

- **Una cuenta revinculada con `POST /:id/reset` dejaba de entregar mensajes.** Los handlers de entrada vivían dentro de `SocketEntry`, y `clearSession()` borra esa entrada del mapa de sockets; la reconexión posterior creaba una entrada nueva con la lista de handlers vacía, y sólo `wireEvents` (que corre al arrancar el proceso) volvía a registrarlos. El síntoma en el log era `messages.upsert received ... "handlers":0`: los mensajes llegaban de WhatsApp y no los procesaba nadie — ni se guardaban ni se reenviaban al webhook — hasta reiniciar el contenedor. Las suscripciones pasan a vivir en el propio manager, indexadas por cuenta, así que sobreviven a reconexiones y resets.
- **Suscribirse antes del primer `connect()` ya no se pierde en silencio.** `onMessage` / `onConnectionUpdate` descartaban el handler si aún no existía socket, así que un mensaje que llegase entre `connect()` y `wireEvents()` se perdía. Registrar ya no depende de que haya socket abierto.

## [0.5.0] - 2026-09-05

### Changed

- **Baileys actualizado** de `^7.0.0-rc13` a `^7.0.0-rc14`.
- Dependencias de runtime al día: `fastify` 5.12.3, `@fastify/cors` 11.3.0, `@fastify/swagger` 9.8.1, `@fastify/websocket` 11.3.0, `@fastify/swagger-ui` 6.1.1, `better-sqlite3` 13.0.3 (migrado a N-API), `pg` 8.23.0, `zod` 4.5.4, `yaml` 2.9.0, `dotenv` 17.4.2.
- Herramientas de desarrollo al día: `typescript` 7.0.2, `vitest` 5.0.0, `orval` 8.28.1, `tsx` 4.23.13, `@types/node` 26, `@types/pg` 8.23.1, `@types/better-sqlite3` 9.6.0.
- **El paquete pasa a ESM** (`"type": "module"`). Baileys 7 es ESM puro, así que la build CJS anterior sólo funcionaba gracias al `require(esm)` de Node 22, y `npm run dev` (tsx) ni siquiera arrancaba: su resolver CJS falla con `ERR_PACKAGE_PATH_NOT_EXPORTED` sobre `whatsapp-rust-bridge`, una dependencia ESM-only de Baileys. Con ESM nativo, `npm run dev`, `npm start` y los tests van por el mismo camino de módulos. Incluye `scripts/fix-generated-imports.js` reescrito con `import` / `import.meta.url` y `build:copy-migrations` con `--input-type=module`.
- `vitest.config.ts` renombrado a `vitest.config.mts` para que Vite lo cargue como ESM nativo (elimina el aviso de `configLoader: 'native'`).
- SDK regenerado con orval 8: los alias auxiliares `*FiltersInclude/ExcludeAnyOfItem` desaparecen y su unión (`boolean | number | string`) queda embebida. Sin cambios funcionales ni en el contrato HTTP.

### Fixed

- **`npm run dev` vuelve a arrancar.** Estaba roto desde Baileys 7 (rc9), no sólo en rc14. Ver el punto de ESM arriba.

### Removed

- **Soporte de Node 20** (EOL). `engines` pasa a `>=22` y la matriz de CI a `[22, 24]`, porque `vitest` 5 exige `^22.12`, `better-sqlite3` 13 exige `>=22` y `orval` 8 exige `>=22.18`. La imagen Docker ya usaba `node:22-alpine`.

### Security

- `npm audit` pasa de 22 vulnerabilidades (2 críticas, 17 altas) a 0.

## [0.4.1] - 2026-07-13

### Added

- **`POST /api/v1/accounts/:id/reset`** — clears the stored session/credentials and reconnects so a fresh QR is generated. Use when the stored auth is expired and the account is stuck looping between `connecting` and `disconnected` without emitting a QR (previously only recoverable by deleting `data/baileys-auth/<id>` over SSH). Poll `GET /api/v1/accounts/:id` for the new QR. Only supported by self-auth (managed) providers; returns `400 RESET_NOT_SUPPORTED` otherwise. Backed by a new optional `clearSession` capability on `ConnectionManagerPort`, implemented by the Baileys adapter.

### Security

- The Baileys `clearSession` delete is confined to the managed auth root, so a free-form `authDir` in `providerConfig` (e.g. `../../..`) can no longer trigger an arbitrary recursive delete via the reset endpoint.

## [0.4.0] - 2026-06-15

### Fixed

- **WhatsApp device linking** — new QR / pairing-code links were rejected by WhatsApp (`Connection Failure` → `401 loggedOut`) while existing sessions kept working. Baileys now advertises the live WhatsApp Web version via `fetchLatestBaileysVersion()` (fetched once and cached per process), falling back to a pinned version only if the fetch fails. The previous hardcoded version became outdated and blocked new links.
- **`waVersion` override ignored** — `parseBaileysConfig` dropped the `waVersion` field, so per-account overrides in `accounts.yaml` never took effect. It is now parsed and validated.

### Changed

- Upgraded `@whiskeysockets/baileys` from `^7.0.0-rc.9` to `^7.0.0-rc13`.
- Added a configurable `qrTimeoutMs` (default `60000`) controlling the Baileys QR / pairing window.

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
