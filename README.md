# Simple

A minimal full-stack pattern: postgres owns everything, the server routes, the client merges.

```bash
bun create blueshed/simple my-app
cd my-app
bun run db   # start postgres
bun run dev  # start server
```

`bun create` copies the files, installs dependencies, and runs `setup.ts` which replaces
the `myapp` placeholder with your project name throughout.

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

## Files

| File | What to do |
|------|------------|
| `server-core.ts` | Generic WebSocket relay — **do not edit** |
| `session.ts` | Generic WebSocket client — **do not edit** |
| `signals.ts` | Generic reactive primitives — **do not edit** |
| `server.ts` | Your app entry point — configure `preAuth`, `profileFn` |
| `app.ts` | Your client routing — add/rename routes |
| `index.html` | HTML shell — update title |
| `styles.css` | CSS tokens — customise colours/fonts |
| `components/app-login.ts` | Login/register form — adapt to your register() signature |
| `components/app-home.ts` | Authenticated shell — add your doc calls and UI |
| `cli.ts` | Generic DB function caller — `bun run api <fn> [args]` |
| `setup.ts` | Post-create substitution — runs once then self-deletes |
| `init_db/00_extensions.sql` | Token crypto — update database name |
| `init_db/01_schema.sql` | Auth tables + your domain tables |
| `init_db/02_auth.sql` | Auth functions — **do not edit** unless you need custom auth |
| `init_db/03_functions.sql` | Your doc functions and mutations |
| `init_db/04_seed.sql` | Dev seed data |

## Notify payload shape

```sql
PERFORM pg_notify('change', jsonb_build_object(
    'fn',      'save_thing',
    'op',      'upsert',          -- or 'remove'
    'data',    row_to_json(v_row)::jsonb,   -- or jsonb_build_object('id', v_id) for remove
    'targets', jsonb_build_array(
        jsonb_build_object('doc', 'thing_doc', 'collection', 'things', 'doc_id', v_parent_id)
        -- for nested: add 'parent_id', v_parent_id and use 'collection', 'parent.children'
    )
)::text);
```

## Upgrading infrastructure

```
/upgrade
```

A Claude skill that fetches the latest `server-core.ts`, `session.ts`, and `signals.ts` from
the upstream repo, explains what changed and why, and applies selectively with your approval.
Your app code is never touched.

## Docs

- [Server](.claude/docs/server.md) — WebSocket protocol, fan-out, guards
- [Client](.claude/docs/client.md) — session, signals, doc subscriptions, merging
- [Database](.claude/docs/database.md) — SQL conventions, notify payload, save/remove pattern
- [CSS](.claude/docs/css.md) — token system, theming, component conventions
- [Testing](.claude/docs/testing.md) — unit and integration test patterns
