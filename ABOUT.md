# Simple

A minimal full-stack pattern: postgres owns everything, the server routes, the client merges.

```bash
bun create blueshed/simple my-app
cd my-app
bun run db   # start postgres in docker
bun run dev  # start server
```

## Pattern

- **Postgres is the application** — schema, permissions, business logic, and notifications all live in SQL
- **Server is a relay** — ~100 lines; verifies tokens, calls functions, fans out notifications
- **Client merges deltas** — open a document, get live updates via `pg_notify`, no re-fetch

```
Client                    Server                  Postgres
  │                          │                       │
  │  POST /auth login(...)   │                       │
  │─────────────────────────→│  SELECT login(...)    │
  │                          │──────────────────────→│
  │  { token, profile }      │                       │
  │←─────────────────────────│                       │
  │                          │                       │
  │  WS open thing_doc(1)    │                       │
  │─────────────────────────→│  subscribe            │
  │                          │                       │
  │  api.save_thing(...)     │  SELECT save_thing()  │
  │─────────────────────────→│──────────────────────→│── permission check
  │  { ok, data: id }        │                       │── mutate
  │←─────────────────────────│                       │── pg_notify
  │                          │← LISTEN 'change'      │
  │  { type:"notify", data } │── fan out to docs     │
  │←─────────────────────────│                       │
```

## Infrastructure files (do not edit)

| File | Role |
|------|------|
| `server-core.ts` | WebSocket relay, postgres fan-out, HTTP /auth |
| `session.ts` | WebSocket client, doc subscriptions, delta merging |
| `signals.ts` | Reactive primitives, hash routing |

## Your files

| File | What you write |
|------|---------------|
| `server.ts` | Entry point — configure `preAuth`, `profileFn` |
| `init_db/01_schema.sql` | Your domain tables |
| `init_db/03_functions.sql` | Your doc functions and mutations |
| `components/` | Your web components |

## Upgrading

```
/upgrade
```

A Claude skill that fetches the latest infrastructure files from this repo, explains what changed, and applies with your approval.

## Docs

- [Server](.claude/docs/server.md) — WebSocket protocol, fan-out, guards
- [Client](.claude/docs/client.md) — session, signals, doc subscriptions, merging
- [Database](.claude/docs/database.md) — SQL conventions, notify payload, save/remove pattern
- [CSS](.claude/docs/css.md) — token system, theming, component conventions
- [Testing](.claude/docs/testing.md) — unit and integration test patterns
