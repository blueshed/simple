# Simple

A minimal full-stack pattern: postgres owns everything, the server routes, the client merges.

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
    'data',    v_data,                      -- enriched to match doc shape; jsonb_build_object('id', v_id) for remove
    'targets', jsonb_build_array(
        jsonb_build_object('doc', 'thing_doc', 'collection', 'things', 'doc_id', v_parent_id)
        -- for nested: add 'parent_ids', jsonb_build_array(v_parent_id) and use 'collection', 'parent.children'
        -- for deeper nesting: 'parent_ids', jsonb_build_array(v_grandparent_id, v_parent_id)
    )
)::text);
```

## Reference

Read these for detailed implementation guidance:
- `.claude/docs/server.md` — WebSocket protocol, fan-out, guards
- `.claude/docs/client.md` — session, signals, doc subscriptions, merging
- `.claude/docs/database.md` — SQL conventions, notify payload, save/remove pattern

## Skills

- `/add-easy` — add the [Easy](https://github.com/blueshed/easy) domain modeling tool to this project
- `/implement` — read `spec.md` and build the full app: schema, doc functions, mutations, components
- `/upgrade` — fetch the latest infrastructure files from upstream

### Design-to-build workflow

1. `/add-easy` to enable the modeling tool
2. Model your domain with Easy (`bun model ...`)
3. Browse the model site at http://localhost:8080 to validate
4. Export: `bun model export-spec > spec.md`
5. `/implement` to build the app from the spec
