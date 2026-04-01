# AGENTS.md — Project Rules for Unified Messaging Gateway

## Build & Quality Commands

- **Type check**: `npm run lint` (runs `tsc --noEmit`)
- **Tests**: `npm test` (runs `vitest run`, 100% must pass)
- **Build**: `npm run build` (runs `tsc`, outputs to `dist/`)
- **Dev**: `npm run dev` (tsx watch mode)

## Pre-commit Checklist

Before every commit, always run all three in order:

1. `npm run lint` — must pass with zero errors
2. `npm test` — all tests must pass
3. `npm run build` — must compile cleanly

Never commit code that fails any of these steps.

## Architecture Rules

- **DDD / Hexagonal architecture**:
  - `src/core/` — domain logic (accounts, messaging, routing, auth)
  - `src/integrations/` — provider adapters (Baileys, wwebjs, Telegram, etc.)
  - `src/connections/` — I/O transports (REST API, WebSocket, webhooks)
  - `src/infrastructure/` — framework config (Fastify server, env config, persistence)
- Never import from `integrations/` or `infrastructure/` inside `core/`
- All provider integrations go through adapter interfaces defined in core
- Use `UnifiedEnvelope` as the canonical message format across all channels

## TypeScript Strict Rules

- `strict: true` is enabled — never disable it
- `noUncheckedIndexedAccess: true` — always handle `undefined` when accessing arrays/records by index
- `noImplicitReturns: true` — all code paths must return
- All imports use `.js` extensions (NodeNext module resolution)
- Use `type` imports for type-only imports (`import type { ... }`)

## Testing Rules

- Tests live in `tests/` (excluded from tsconfig build via `exclude`)
- Unit tests: `tests/unit/`
- Integration tests: `tests/integration/`
- Test framework: Vitest with `globals: true`
- Never use real credentials in tests — use dummy/mock values
- When adding a new feature, add corresponding tests
- **No timing-dependent assertions**: never assert that two sequential timestamps differ without using `vi.useFakeTimers()`. CI machines can execute operations within the same millisecond, causing flaky failures
- Use `vi.useFakeTimers()` + `vi.setSystemTime()` when tests depend on time advancing between operations

## Webhook Forwarding

- All inbound webhook endpoints (inbound messages AND status updates) MUST forward events through `WebhookForwarder`
- Use `webhookForwarder.forward(envelope)` for `UnifiedEnvelope` payloads
- Use `webhookForwarder.forwardRaw(accountId, payload, eventType, channel)` for non-envelope payloads (status events, etc.)
- Never add a webhook endpoint that only logs without forwarding

## Docker

- Multi-stage Dockerfile: deps → build → production
- `.dockerignore` excludes tests, .github, docs — keep it updated
- `data/` directory is the writable volume for runtime state (accounts config, webhook configs, Baileys auth)
- Accounts are managed via the API and persisted to `data/accounts.yaml`

## File Conventions

- Environment: `.env.local` (gitignored), `.env.example` (committed)
- `config/` directory is gitignored — no config files are committed
- `data/` directory is gitignored — runtime state only (Docker volume)
- Never commit `.env.local` or files containing real secrets/credentials
