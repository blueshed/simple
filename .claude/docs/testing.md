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

## Integration Tests — `test/server.test.ts`

End-to-end tests for the HTTP auth endpoint against a **disposable** postgres container. Tests run against the actual database functions — no mocks.

### How it works

The test suite spins up its own isolated environment:

1. **Disposable postgres** — `test/compose.yml` starts a postgres container on port **5433** (not 5432, so it won't clash with your dev database). It mounts `init_db/00–03` SQL files but **not** `04_seed.sql` — the database starts empty.
2. **Dedicated test server** — `bun server.ts` is spawned on port **3001** with `DATABASE_URL` pointing at the test database.
3. **Tests create their own data** — register calls create users from scratch, so tests don't depend on seed data.
4. **Teardown** — the server is killed and the postgres container is removed with `docker compose down -v`, leaving no state behind.

```
test/
├── compose.yml         # disposable postgres on port 5433
└── server.test.ts      # integration tests
```

### compose.yml

The test compose file mounts your schema and function SQL files but deliberately **does not mount `04_seed.sql`**. The database starts completely empty — tests register their own users and create all data through the API. This ensures tests validate the actual functions rather than relying on pre-existing rows:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: myapp          # must match init_db/00_extensions.sql
    ports:
      - "5433:5432"
    volumes:
      - ../init_db/00_extensions.sql:/docker-entrypoint-initdb.d/00_extensions.sql:ro
      - ../init_db/01_schema.sql:/docker-entrypoint-initdb.d/01_schema.sql:ro
      - ../init_db/02_auth.sql:/docker-entrypoint-initdb.d/02_auth.sql:ro
      - ../init_db/03_functions.sql:/docker-entrypoint-initdb.d/03_functions.sql:ro
      # 04_seed.sql is NOT mounted — tests create their own data via the API
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d myapp"]
      interval: 2s
      timeout: 5s
      retries: 10
```

> **Database name**: `setup.ts` replaces `myapp` with your project name in `compose.yml`, `init_db/00_extensions.sql`, `test/compose.yml`, and `test/server.test.ts`. If you rename your database manually, update all four places — `POSTGRES_DB` in both compose files, the `ALTER DATABASE` in `00_extensions.sql`, and the `DB_URL` in the test file must all match.

### Setup / Teardown

```typescript
const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const DB_URL = "postgres://postgres:secret@localhost:5433/myapp";
const COMPOSE_FILE = `${import.meta.dir}/compose.yml`;

let server: Subprocess;

beforeAll(async () => {
  // Destroy any leftover container, start fresh
  await Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "down", "-v"], {
    stdout: "pipe", stderr: "pipe",
  }).exited;
  await Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "up", "-d", "--wait"], {
    stdout: "inherit", stderr: "inherit",
  }).exited;

  // Start test server pointed at the disposable DB
  server = Bun.spawn(["bun", "server.ts"], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL },
    stdout: "pipe", stderr: "pipe",
  });

  // Wait for server to accept requests
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fn: "login", args: ["x", "x"] }),
      });
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
}, 60_000);

afterAll(async () => {
  server?.kill();
  await Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "down", "-v"], {
    stdout: "pipe", stderr: "pipe",
  }).exited;
});
```

### Helper

**`authCall(fn, ...args)`** — calls `POST /auth` and returns `data` on success, throws on failure:

```typescript
async function authCall(fn: string, ...args: unknown[]): Promise<any> {
  const res = await fetch(`${BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}
```

### Default tests

The template ships with register and login tests for two users:

| Block | Tests | What it proves |
|-------|-------|----------------|
| **Register** | Alice, Bob, duplicate email | `register()` creates users, returns token + profile; unique constraint works |
| **Login** | Alice, Bob, wrong password, unknown email | `login()` authenticates correctly; bad credentials are rejected |

### Extending the tests

Tests run sequentially within each `describe` block, so earlier tests can set up state for later ones. Store tokens and IDs in module-level variables.

#### Adding a WebSocket helper

When your app has authed functions (called over WebSocket), add the `ws()` helper:

```typescript
const WS_BASE = `ws://localhost:${PORT}`;
const openSockets: WebSocket[] = [];

type Client = {
  messages: any[];
  call: (fn: string, ...args: unknown[]) => Promise<any>;
  send: (type: string, fn: string, args?: unknown[]) => void;
  close: () => void;
};

function ws(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${WS_BASE}/ws?token=${encodeURIComponent(token)}`
    );
    const messages: any[] = [];
    let id = 0;
    const pending = new Map<string, {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
    }>();

    openSockets.push(socket);

    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type) {
        messages.push(msg);
        if (msg.type === "profile" && messages.length === 1)
          resolve({ messages, call, send, close });
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

Then close all sockets in `afterAll`:

```typescript
afterAll(async () => {
  for (const s of openSockets) s.close();
  server?.kill();
  // ... docker compose down
});
```

#### Testing authed functions

Each test opens its own connection and closes it in `finally`:

```typescript
describe("My doc function", () => {
  test("returns expected shape", async () => {
    const client = await ws(aliceToken);
    try {
      const result = await client.call("my_doc", someId);
      expect(result.my_doc.name).toBe("expected");
    } finally {
      client.close();
    }
  });
});
```

#### Testing mutations with notifications

Open a doc subscription before mutating, then check for notify messages:

```typescript
test("save_thing notifies clients with doc open", async () => {
  const client = await ws(aliceToken);
  try {
    client.send("open", "thing_doc", [thingId]);
    await Bun.sleep(100);  // let server register the subscription

    const before = client.messages.length;
    await client.call("save_thing", thingId, null, "Updated");
    await Bun.sleep(300);  // let notify propagate

    const notifications = client.messages
      .slice(before)
      .filter(m => m.type === "notify" && m.doc === "thing_doc");
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0].op).toBe("upsert");
  } finally {
    client.close();
  }
});
```

#### Testing permissions

Verify that unauthorised users get errors:

```typescript
test("Bob cannot access Alice's data", async () => {
  const bob = await ws(bobToken);
  try {
    await expect(bob.call("alice_only_fn", someId)).rejects.toThrow();
  } finally {
    bob.close();
  }
});
```

### What to test

As you add features, cover these areas:

- **Each preAuth function** — register, login, and any custom ones (e.g. `accept_invite`)
- **Each doc function** — returns the right shape with expected collections
- **Each mutation** — creates/updates/removes correctly, emits notify to subscribed clients
- **Permissions** — unauthorised users are rejected for every write operation
- **Server guards** — `_` prefix functions blocked over WS, preAuth functions rejected over WS

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

### Key rules

- **Snapshot, don't screenshot** — use `browser_snapshot` to read the accessibility tree. It's faster and gives you text content to verify against. Use `browser_take_screenshot` only when you need to verify visual layout.
- **Wait for updates** — after a mutation, use `browser_wait_for` with the expected text before snapshotting. The reactive merge cycle needs a moment to update the DOM.
- **One actor at a time** — log out or clear the session between actors to avoid cross-contamination.
- **Use seed identities** — all actors must exist in `init_db/04_seed.sql` with known passwords.
