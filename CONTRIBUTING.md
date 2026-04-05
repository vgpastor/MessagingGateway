# Contributing to Unified Messaging Gateway

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/vgpastor/MessagingGateway.git
cd MessagingGateway
npm install
npm test
npm run lint
npm run build
```

## Project Structure

```
src/
  core/              # Domain logic & ports (accounts, messaging, routing, auth, persistence ports)
    persistence/     #   Message store ports (CRUD, search, analytics, history), AI context service
  integrations/      # Provider adapters: Baileys, wwebjs, Telegram, Brevo, etc.
  connections/       # I/O transports: REST API, WebSocket, webhooks
    api/             #   All Fastify controllers (messages, accounts, send, groups, etc.)
  persistence/       # Storage adapters: SQLite, PostgreSQL, migration system
  infrastructure/    # Framework: Fastify server, env config, metrics
packages/
  sdk/               # @messaging-gateway/sdk TypeScript client library
tests/
  unit/              # Unit tests (adapters, core, infrastructure, persistence)
  integration/       # Integration tests (API, SQLite store, persistence flow)
```

**Import rules:**
- `core/` must NOT import from `integrations/`, `connections/`, `persistence/`, or `infrastructure/`
- `integrations/` and `connections/` can import from `core/`
- `persistence/` adapters import from `core/persistence/` (ports) — never the reverse
- `infrastructure/` wires everything together

## Adding a New Provider

1. Create `src/integrations/<channel>/<provider>/`
2. Implement adapters (messaging, health, inbound, connection)
3. Export a `ProviderBundle` from `index.ts`
4. Register in `src/index.ts`
5. Add tests in `tests/unit/adapters/`

## Code Style

- TypeScript strict mode, ESM modules
- Vitest for testing
- No `any` types, use `unknown`
- Conventional Commits for messages

## PR Process

1. Fork and branch: `git checkout -b feat/my-feature`
2. Make changes
3. Run: `npm run lint && npm test`
4. Push and open PR against `main`

## Commit Convention

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructuring
- `docs:` documentation
- `test:` test changes

## Reporting Issues

Use the GitHub issue templates for bugs and feature requests.
