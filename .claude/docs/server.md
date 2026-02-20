# Server (`server-core.ts`)

A thin real-time relay between web clients and postgres. The server does not validate business rules — postgres handles all permission checks, type coercion, and mutation logic.

## Configuration

`createServer(config)` — called from your `server.ts`:

```typescript
createServer({
  preAuth:    string[];   // functions callable without a token (e.g. ["login", "register"])
  profileFn:  string;    // postgres function called on connect: profileFn(user_id)
  index:      Response;  // the HTML bundle to serve at /
  port?:      number;    // default: process.env.PORT || 3000
  databaseUrl?: string;  // default: DATABASE_URL env, or postgres://postgres:secret@localhost:5432/myapp (substituted by setup.ts)
})
```

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
