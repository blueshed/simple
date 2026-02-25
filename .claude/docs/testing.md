# Testing

Two test files using Bun's native test runner (`bun:test`). No additional test dependencies.

## Running

```bash
bun test                          # all tests
bun test signals.test.ts          # unit tests only
bun test server.test.ts           # integration tests only
```

## Unit Tests — `signals.test.ts`

Tests the reactive primitives and routing helpers in `lib/signals.ts`. Pure in-memory, no I/O.

| Block | What it covers |
|-------|----------------|
| `signal` | get, set, update, peek, dedup |
| `computed` | derivation, chaining |
| `effect` | re-run, cleanup, dispose, stale deps |
| `batch` | deferred flush, nesting |
| `matchRoute` | static paths, params, URI decoding |
| `effect depth limit` | infinite loop detection |

`lib/signals.ts` is infrastructure — copy `signals.test.ts` verbatim from any simple-based project. It tests the generic reactive layer, not your app.

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

## UX Tests — Playwright MCP

When Playwright MCP tools are available, verify each checklist scenario in the browser. This earns `confirmed:2` (UX tested) — combined with API tests, checks become `confirmed:3` (both).

### Prerequisites

- The dev server is already running (the user starts it)
- Playwright MCP uses `http://host.docker.internal:<port>` to reach the host machine — `localhost` does not work from inside Docker
- Seed data must be loaded (`bun run db`) so test actors can log in

### Approach

Walk through each check from `bun model list check` as a browser flow:

1. **Navigate** to the app: `browser_navigate` to `http://host.docker.internal:3000`
2. **Log in** as the check's actor — find the login form, fill email/password, submit
3. **Take a snapshot** with `browser_snapshot` to read the page structure (prefer snapshots over screenshots for verifying content)
4. **Perform the action** — navigate to the right page, fill forms, click buttons
5. **Verify the result**:
   - For `action: "can"` checks — confirm the action succeeded (new item appears, field updated, navigation changed)
   - For `action: "denied"` checks — confirm the action is blocked (error message shown, button disabled, or action not available in the UI)
6. **Mark confirmed** — update the check with `confirmed:3` (or `confirmed:2` if only UX-testing without prior API tests)

### Flow pattern

For each actor in the checklists:

```
1. Navigate to app
2. Log in as actor (email + password from seed data)
3. Snapshot to confirm login succeeded
4. For each check by this actor:
   a. Navigate to the relevant page
   b. Perform the action (or verify it's not available for denied checks)
   c. Snapshot to verify the outcome
5. Log out or navigate away before switching actors
```

### Key rules

- **Snapshot, don't screenshot** — use `browser_snapshot` to read the accessibility tree. It's faster and gives you text content to verify against. Use `browser_take_screenshot` only when you need to verify visual layout.
- **Wait for updates** — after a mutation, use `browser_wait_for` with the expected text before snapshotting. The reactive merge cycle needs a moment to update the DOM.
- **One actor at a time** — log out or clear the session between actors to avoid cross-contamination.
- **Use seed identities** — all actors must exist in `init_db/04_seed.sql` with known passwords. The seed should include users for each actor role in the checklists.
