# Testing

Two test files using Bun's native test runner (`bun:test`). No additional test dependencies.

## Running

```bash
bun test                          # all tests
bun test signals.test.ts          # unit tests only
bun test server.test.ts           # integration tests only
```

## Unit Tests — `signals.test.ts`

Tests the reactive primitives and routing helpers in `signals.ts`. Pure in-memory, no I/O.

| Block | What it covers |
|-------|----------------|
| `signal` | get, set, update, peek, dedup |
| `computed` | derivation, chaining |
| `effect` | re-run, cleanup, dispose, stale deps |
| `batch` | deferred flush, nesting |
| `matchRoute` | static paths, params, URI decoding |
| `effect depth limit` | infinite loop detection |

`signals.ts` is infrastructure — copy `signals.test.ts` verbatim from any simple-based project. It tests the generic reactive layer, not your app.

## Integration Tests — `server.test.ts`

End-to-end tests for the HTTP and WebSocket server against a real postgres database.

### Setup

`beforeAll` (60s timeout):

1. Runs `bun run db` to nuke and rebuild the database with seed data
2. Spawns a **dedicated test server** on a different port (`Bun.spawn` with `PORT=3001`)
3. Retries login until the server is ready
4. Obtains tokens for test users

`afterAll` closes all WebSocket connections and kills the test server.

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;

const openSockets: WebSocket[] = [];
let server: Subprocess;

beforeAll(async () => {
  // Rebuild the database
  await Bun.spawn(["bun", "run", "db"], { stdout: "inherit", stderr: "inherit" }).exited;

  // Start a dedicated test server
  server = Bun.spawn(["bun", "server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    try {
      const { token } = await login("alice@example.com", "password");
      if (token) break;
    } catch {
      await Bun.sleep(500);
    }
  }
}, 60_000);

afterAll(() => {
  for (const ws of openSockets) ws.close();
  server?.kill();
});
```

### Helpers

**`ws(token)`** — opens a WebSocket, waits for the initial profile message, returns:
- `messages[]` — all server-pushed events (profile, notify)
- `call(fn, ...args)` — sends `{ id, fn, args }`, returns Promise resolved/rejected by response
- `send(type, fn, args?)` — fire-and-forget: use for `"open"` / `"close"` doc subscriptions
- `close()` — tears down the connection

```typescript
type Client = {
  messages: any[];
  call: (fn: string, ...args: unknown[]) => Promise<any>;
  send: (type: string, fn: string, args?: unknown[]) => void;
  close: () => void;
};

function ws(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const messages: any[] = [];
    let id = 0;
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    openSockets.push(socket);

    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type) {
        messages.push(msg);
        if (msg.type === "profile" && messages.length === 1) resolve({ messages, call, send, close });
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    };

    socket.onerror = () => reject(new Error("ws error"));
    socket.onclose = () => {
      for (const p of pending.values()) p.reject(new Error("socket closed"));
      pending.clear();
    };

    function call(fn: string, ...args: unknown[]): Promise<any> {
      return new Promise((res, rej) => {
        const rid = String(++id);
        pending.set(rid, { resolve: res, reject: rej });
        socket.send(JSON.stringify({ id: rid, fn, args }));
      });
    }
    function send(type: string, fn: string, args: unknown[] = []) {
      socket.send(JSON.stringify({ type, fn, args }));
    }
    function close() {
      socket.close();
      const idx = openSockets.indexOf(socket);
      if (idx !== -1) openSockets.splice(idx, 1);
    }
  });
}
```

**`login(email, password)`** — `POST /auth` wrapper returning `{ token, data }`.

```typescript
async function login(email: string, password: string): Promise<{ token: string; data: any }> {
  const res = await fetch(`${BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn: "login", args: [email, password] }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return { token: json.data.token, data: json.data };
}
```

### Test Blocks

| Block | Tests | What it proves |
|-------|-------|----------------|
| **POST /auth** | valid login, wrong password, register, non-preAuth fn rejection, wrong method, bad JSON | Auth endpoint routing and error responses |
| **WebSocket connection** | valid token gets profile, invalid/missing token rejected | Token verification and upgrade flow |
| **Server guards** | `_make_token`/`_verify_token` blocked, `login`/`register` via WS blocked | `_` prefix guard and preAuth guard |
| **Doc functions** | your `thing_doc` returns full document, not-found raises | Read-model document composition |
| **Mutations + notifications** | saving an entity notifies clients with matching doc open | Document-aware fan-out routing |
| **Permission checks** | unauthorised user cannot mutate | Write permission enforcement |

### Seed Data

Tests rely on `init_db/04_seed.sql`. The template seeds one user:

```sql
SELECT register('Alice', 'alice@example.com', 'password');
```

Add more users and domain rows to your seed file as your app grows. Tests should use the seed identities (email + password) — never hardcode user IDs since `SERIAL` values depend on insertion order.

### Adding Tests

Each test opens its own `ws()` connection and closes it in a `finally` block:

```typescript
test("save_thing notifies clients", async () => {
  const { token } = await login("alice@example.com", "password");
  const alice = await ws(token);
  try {
    // Open a doc subscription before mutating
    alice.send("open", "thing_doc", [1]);
    await Bun.sleep(50);  // let server register the subscription

    const before = alice.messages.length;
    await alice.call("save_thing", 1, null, "My thing", "desc");
    await Bun.sleep(200);

    const notify = alice.messages.slice(before).find(m => m.type === "notify");
    expect(notify).toBeDefined();
    expect(notify.collection).toBe("things");
    expect(notify.doc).toBe("thing_doc");
  } finally {
    alice.close();
  }
});
```

The `send()` helper is fire-and-forget — sleep briefly after opening a doc to let the server register the subscription before mutating.

For nested collections (`"things.items"`), check that `notify.parent_id` is set and `notify.collection` uses the dotted path.

## What to test

- **Auth endpoint**: correct functions accepted, wrong password rejected, register works
- **Token guard**: invalid token on WS upgrade is rejected
- **Server guards**: `_` prefix functions blocked, preAuth functions rejected over WS
- **Each doc function**: returns the right shape, not-found raises
- **Each mutation**: emits notify to clients that have the doc open, NOT to clients without it
- **Each permission**: write operations from unauthorised user raise an exception
