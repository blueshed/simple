# Server (`lib/server-core.ts`)

A thin real-time relay between web clients and postgres. The server does not validate business rules — postgres handles all permission checks, type coercion, and mutation logic.

## Configuration

`createServer(config)` — called from your `server.ts`:

```typescript
createServer({
  preAuth:    string[];   // functions callable without a token (e.g. ["login", "register"])
  profileFn:  string;    // postgres function called on connect: profileFn(user_id)
  index:      Response;  // the HTML bundle to serve at /
  port?:      number;    // default: process.env.PORT || 3000
  databaseUrl?: string;  // default: DATABASE_URL from .env
  routes?:    Record<string, (req: Request) => Response | Promise<Response>>;  // custom HTTP routes
})
```

### Custom routes

Pass additional HTTP routes via the `routes` config. They are spread into the Bun route map alongside the built-in `/`, `/auth`, and `/ws` routes.

```typescript
import { claudeHelperRoute } from "./lib/claude-helper";

const preAuth = ["login", "register"];

createServer({
  preAuth,
  profileFn: "profile_doc",
  index: index as unknown as Response,
  routes: {
    ...(process.env.RUNTIME_CLAUDE === "true" && {
      "/claude.js": claudeHelperRoute({ preAuth }),
    }),
  },
});
```

The claude helper is gated on `RUNTIME_CLAUDE=true` on both server and client. The client check requires `bunfig.toml` to inline `RUNTIME_*` env vars at serve time:

```toml
[serve.static]
env = "RUNTIME_*"
```

Start with: `RUNTIME_CLAUDE=true bun run dev`

## Architecture

```
Client (browser)
  │
  ├─ POST /auth ──────────→ preAuth functions (login, register, ...)
  │                          returns { token, ...profile }
  │
  └─ WS /ws?token=... ───→ authenticated session
       ├─ send { id, fn, args }              →  SELECT fn(user_id, ...args) AS result
       │                                        →  { id, ok, data }
       ├─ send { type:"open",  fn, args:[id] }  →  subscribe to doc notifications
       ├─ send { type:"open",  ..., cursor, limit, stream }  →  paginated/streaming subscribe
       ├─ send { type:"fetch", fn, args:[id], cursor, limit }  →  load next page (no subscribe)
       ├─ send { type:"close", fn, args:[id] }  →  unsubscribe
       └─ receive { type, ... }              ←  server-pushed events
```

## WebSocket Protocol

### Connection

Client connects to `ws://{host}/ws?token={token}`. The server verifies the token via `_verify_token(token)`, upgrades the connection storing `{ user_id, docs: Set<string> }`, then sends the profile:

```json
{ "type": "profile", "data": { "id": 1, "name": "Alice", ... } }
```

### Function Call

```json
{ "id": "abc", "fn": "save_thing", "args": [42, null, "My Thing"] }
```

`user_id` is **not** in args — the server prepends it. Response:

```json
{ "id": "abc", "ok": true,  "data": 42 }
{ "id": "abc", "ok": false, "error": "permission denied" }
```

### Doc Subscription

```json
{ "type": "open",  "fn": "thing_doc", "args": [1] }
{ "type": "close", "fn": "thing_doc", "args": [1] }
```

On `open`, the server:
1. Tracks `"${fn}:${args[0]}"` in `ws.data.docs`
2. Calls the doc function (`fn(user_id)` for collections where `args[0]` is `0`, or `fn(user_id, doc_id)` for entity docs)
3. Sends the result back as an initial load:

```json
{ "type": "notify", "doc": "thing_doc", "doc_id": 1, "op": "set", "data": { "thing": { ... } } }
```

If the doc function raises an error, the server sends an error sentinel instead:

```json
{ "type": "error", "fn": "thing_doc", "doc_id": 1, "error": "permission denied" }
```

The client handles `op: "set"` by replacing the signal value directly, and error messages by setting `{ _error: "..." }` on the signal.

### Cursor/Stream Open

Open accepts optional `cursor`, `limit`, and `stream` fields for paginated documents:

```json
{ "type": "open", "fn": "post_feed", "args": [0], "cursor": null, "limit": 25 }
```

When `cursor` or `limit` is present, the server calls `fn(user_id, doc_id, cursor, limit)`. The doc function must return `{ data, cursor, hasMore }`:

```json
{ "type": "notify", "doc": "post_feed", "doc_id": 0, "op": "set", "data": { ... }, "cursor": "abc", "hasMore": true }
```

If `stream: true`, the server loops after the first page, sending subsequent pages as `op: "append"` until exhausted or the client closes the doc:

```json
{ "type": "notify", "doc": "post_feed", "doc_id": 0, "op": "append", "data": { ... }, "cursor": "def", "hasMore": true }
{ "type": "notify", "doc": "post_feed", "doc_id": 0, "op": "append", "data": { ... }, "cursor": null, "hasMore": false }
```

### Fetch (Load More)

Fetch requests a page without subscribing — used for explicit "load more":

```json
{ "type": "fetch", "id": "abc", "fn": "post_feed", "args": [0], "cursor": "abc", "limit": 25 }
```

Response uses the standard `id`/`ok`/`data` format:

```json
{ "id": "abc", "ok": true, "data": { "data": [...], "cursor": "def", "hasMore": true } }
```

### Push Events

```json
{ "type": "notify", "fn": "save_thing", "op": "upsert", "doc": "thing_doc", "doc_id": 1, "collection": "things", "data": { ... } }
```

For nested collections the payload also carries `parent_ids` — an array of ancestor ids,
one per intermediate path segment:

```json
{ "type": "notify", ..., "collection": "things.items", "parent_ids": [42], "data": { ... } }
```

## Notification Fan-Out

```typescript
sql.listen("change", (payload) => {
  const { targets, ...rest } = JSON.parse(payload);
  for (const target of targets ?? []) {
    const key = `${target.doc}:${target.doc_id}`;
    const msg = JSON.stringify({ type: "notify", ...target, ...rest });
    for (const ws of clients) {
      if (ws.data.docs.has(key)) ws.send(msg);
    }
  }
});
```

Subscription is the sole gate — any client with a doc open receives all events for that doc.

## Guards

- Functions starting with `_` are blocked (internal, e.g. `_verify_token`)
- `preAuth` functions must use `POST /auth`, not WebSocket
- All inputs go through parameterized queries (`$1, $2, ...`)
