# Template

```bash
bun create blueshed/simple my-app
cd my-app
bun run db   # start postgres
bun run dev  # start server
```

`bun create` copies the files, installs dependencies, and runs `setup.ts` which replaces
the `myapp` placeholder with your project name throughout.

## Upgrading infrastructure

```
/upgrade
```

A Claude skill that fetches the latest `server-core.ts`, `session.ts`, and `signals.ts` from
the upstream repo, explains what changed and why, and applies selectively with your approval.
Your app code is never touched.

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
| `init_db/00_extensions.sql` | Token crypto — update database name |
| `init_db/01_schema.sql` | Auth tables + your domain tables |
| `init_db/02_auth.sql` | Auth functions — **do not edit** unless you need custom auth |
| `init_db/03_functions.sql` | Your doc functions and mutations |
| `init_db/04_seed.sql` | Dev seed data |

## Pattern

Each postgres function is either:
- **Pre-auth** (called via `POST /auth` before login): `login`, `register`, `accept_invite`
- **Authed** (called via WebSocket, first arg is always `user_id` injected by server): everything else

Documents are opened by the client (`openDoc("thing_doc", id)`) and closed when no longer needed.
Mutations emit `pg_notify('change', ...)` with a `targets` array. The server fans out to every
client that has a matching doc open. The client merges the delta into the open signal.

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
