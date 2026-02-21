# Database

Postgres is the source of truth. Schema, functions, permissions, and notifications all live in SQL. The server is a thin relay — it never validates business rules.

## Init Scripts

Files in `init_db/` run in alphabetical order on first container boot:

| File | Purpose |
|------|---------|
| `00_extensions.sql` | pgcrypto, token secret, `_make_token`, `_verify_token` |
| `01_schema.sql` | Auth tables + your domain tables |
| `02_auth.sql` | `profile_doc`, `register`, `login`, `accept_invite` |
| `03_functions.sql` | Your doc functions and mutations |
| `04_seed.sql` | Dev seed data |

## Auth Functions

Pre-auth — called via `POST /auth`, no `user_id` parameter.

**`register(name, email, password)`** — creates user, returns `{ token, profile }`

**`login(email, password)`** — verifies credentials, returns `{ token, profile }`

**`accept_invite(name, email, password, key)`** — joins via invite, returns `{ token, profile }`

### Token Mechanism

`_make_token(user_id)` / `_verify_token(token)` — symmetric encryption via `pgp_sym_encrypt`. The secret is a database-level GUC (`app.token_secret`). Both functions are private (`_` prefix — blocked by the server).

## Doc Functions

Doc functions compose entities into document shapes for the client. Convention:

```sql
CREATE OR REPLACE FUNCTION thing_doc(p_user_id INT, p_thing_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
-- permission check, then:
SELECT jsonb_build_object(
    'thing', jsonb_build_object(
        'id', t.id, 'name', t.name,
        'items', COALESCE((SELECT jsonb_agg(...) FROM item WHERE thing_id = t.id), '[]')
    )
) FROM thing t WHERE t.id = p_thing_id;
$$;
```

Root entity nested under its name. Collections use `jsonb_agg()`, defaulting to `'[]'::jsonb`.

## Cursor-Aware Doc Functions

For documents marked as `cursor` or `stream` in the model, the doc function accepts optional `p_cursor` and `p_limit` parameters. It returns `{ data, cursor, hasMore }` instead of the raw doc shape.

```sql
CREATE OR REPLACE FUNCTION post_feed(
    p_user_id INT,
    p_cursor TEXT DEFAULT NULL,
    p_limit INT DEFAULT 25
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_items JSONB;
    v_last_id INT;
    v_has_more BOOLEAN;
BEGIN
    -- Keyset pagination: use cursor as the last-seen id
    SELECT jsonb_agg(row_to_json(sub)), MIN(sub.id)
    INTO v_items, v_last_id
    FROM (
        SELECT p.id, p.title, p.created_at
        FROM post p
        WHERE (p_cursor IS NULL OR p.id < p_cursor::int)
        ORDER BY p.id DESC
        LIMIT p_limit + 1  -- fetch one extra to detect hasMore
    ) sub;

    -- Check if there are more items beyond this page
    v_has_more := jsonb_array_length(COALESCE(v_items, '[]')) > p_limit;
    IF v_has_more THEN
        v_items := v_items - (jsonb_array_length(v_items) - 1);  -- trim the extra
    END IF;

    RETURN jsonb_build_object(
        'data', jsonb_build_object('post_feed', COALESCE(v_items, '[]')),
        'cursor', CASE WHEN v_has_more THEN v_last_id::text ELSE NULL END,
        'hasMore', v_has_more
    );
END;
$$;
```

**Key conventions:**
- `p_cursor` is `TEXT` (opaque to the client) — encode whatever pagination key you need
- `p_limit` has a sensible default (e.g. 25)
- When `p_cursor IS NULL`, return the first page
- Fetch `p_limit + 1` rows, trim the extra, set `hasMore` accordingly
- The `data` field contains the same shape as a non-cursor doc function would return
- The `cursor` field is `NULL` when there are no more pages
- Use keyset pagination (WHERE id < cursor) not OFFSET — it's O(1) not O(n)

When called without cursor/limit (existing `open` without opts), the server calls the function with just `(user_id)` or `(user_id, doc_id)` — the DEFAULT values handle it. To support both modes, ensure the function returns the raw doc shape when `p_cursor IS NULL AND p_limit IS NULL`:

```sql
-- Dual-mode: returns full doc or paginated
IF p_limit IS NULL THEN
    -- Full load (legacy select mode)
    RETURN jsonb_build_object('post_feed', (SELECT jsonb_agg(...) FROM post));
END IF;
-- Paginated load
...
```

## Save/Remove Pattern

```sql
-- Upsert: p_id NULL → INSERT, set → UPDATE
save_thing(p_user_id INT, p_id INT DEFAULT NULL, p_name TEXT DEFAULT NULL, ...)

-- Delete
remove_thing(p_user_id INT, p_thing_id INT)
```

Both follow the same four-step body:

1. **Resolve** — look up the entity and its owner
2. **Permission** — check the caller is authorised (e.g. via membership)
3. **Mutate** — INSERT / UPDATE / DELETE
4. **Notify** — `pg_notify('change', ...)` with targets

## Notification Payload

```sql
PERFORM pg_notify('change', jsonb_build_object(
    'fn',      'save_thing',
    'op',      'upsert',                      -- or 'remove'
    'data',    v_data,                        -- or jsonb_build_object('id', v_id) for remove
    'targets', jsonb_build_array(
        jsonb_build_object(
            'doc',        'thing_doc',
            'collection', 'things',           -- null if root entity changed
            'doc_id',     v_parent_id
        )
    )
)::text);
```

### Notify data shape

The merge replaces the **entire item** in the collection array by `id`. So the data must match the shape that the document's expansion tree produces — including any nested objects (belongs-to joins, child arrays).

- **Root entity update** (`collection: null`): `row_to_json(v_row)::jsonb` is fine — fields are spread onto the existing root.
- **Collection item upsert**: build enriched data matching the doc shape. Use `row_to_json(v_row)::jsonb || jsonb_build_object('author', ..., 'children', ...)` to include nested objects the doc function returns.
- **Remove**: `jsonb_build_object('id', v_id)` — only the id is needed.

For nested collections, use a dotted path and include `parent_ids` — an array with one
ancestor id per intermediate segment (all but the last):

```sql
-- two-level: things.items — one intermediate segment
jsonb_build_object(
    'doc',        'thing_doc',
    'collection', 'things.items',
    'doc_id',     v_thing_doc_id,
    'parent_ids', jsonb_build_array(v_thing_id)
)

-- three-level: things.items.parts — two intermediate segments
jsonb_build_object(
    'doc',        'thing_doc',
    'collection', 'things.items.parts',
    'doc_id',     v_thing_doc_id,
    'parent_ids', jsonb_build_array(v_thing_id, v_item_id)
)
```

The server fans out each target to every client that has that document open.
