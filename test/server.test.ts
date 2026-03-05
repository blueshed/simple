import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const DB_URL = "postgres://postgres:secret@localhost:5433/myapp";
const COMPOSE_FILE = `${import.meta.dir}/compose.yml`;

let server: Subprocess;

// Tokens
let aliceToken: string;
let bobToken: string;

// ─── Helpers ───────────────────────────────────────────────────────────────

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

/** Open authenticated WS, wait for profile, return { ws, profile, messages queue, next() } */
function openWS(token: string): Promise<{
  ws: WebSocket;
  profile: any;
  next: (timeout?: number) => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const queue: any[] = [];
    let waiting: ((msg: any) => void) | null = null;

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (!queue.length && !waiting) {
        // First message is profile — resolve the connection
        resolve({
          ws,
          profile: msg,
          next: (timeout = 5000) =>
            new Promise((res, rej) => {
              if (queue.length) return res(queue.shift());
              waiting = res;
              setTimeout(() => { waiting = null; rej(new Error("timeout")); }, timeout);
            }),
          close: () => ws.close(),
        });
        return;
      }
      if (waiting) { const cb = waiting; waiting = null; cb(msg); }
      else queue.push(msg);
    };
    ws.onerror = reject;
    setTimeout(() => reject(new Error("ws connect timeout")), 5000);
  });
}

/** Send a WS function call and await the response */
async function wsCall(
  conn: { ws: WebSocket; next: (timeout?: number) => Promise<any> },
  fn: string,
  args: unknown[],
  id?: string,
): Promise<any> {
  const callId = id ?? Math.random().toString(36).slice(2);
  conn.ws.send(JSON.stringify({ id: callId, fn, args }));
  const msg = await conn.next();
  if (!msg.ok) throw new Error(msg.error);
  return msg.data;
}

/** Send open doc and await initial notify */
async function wsOpen(
  conn: { ws: WebSocket; next: (timeout?: number) => Promise<any> },
  fn: string,
  docId: number | string,
): Promise<any> {
  conn.ws.send(JSON.stringify({ type: "open", fn, args: [docId] }));
  return conn.next();
}

/** Send close doc */
function wsClose(
  conn: { ws: WebSocket },
  fn: string,
  docId: number | string,
): void {
  conn.ws.send(JSON.stringify({ type: "close", fn, args: [docId] }));
}

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  // Start isolated test database (fresh, no seed data)
  await Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "down", "-v"], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  await Bun.spawn(
    ["docker", "compose", "-f", COMPOSE_FILE, "up", "-d", "--wait"],
    { stdout: "inherit", stderr: "inherit" },
  ).exited;

  // Start test server pointing at test DB on port 5433
  server = Bun.spawn(["bun", "server.ts"], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
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
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
});

// ═══════════════════════════════════════════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════════════════════════════════════════

describe("Register", () => {
  test("register Alice", async () => {
    const data = await authCall("register", "Alice", "alice@example.com", "password");
    aliceToken = data.token;
    expect(data.token).toBeString();
    expect(data.profile.name).toBe("Alice");
    expect(data.profile.email).toBe("alice@example.com");
  });

  test("register Bob", async () => {
    const data = await authCall("register", "Bob", "bob@example.com", "password");
    bobToken = data.token;
    expect(data.token).toBeString();
    expect(data.profile.name).toBe("Bob");
    expect(data.profile.email).toBe("bob@example.com");
  });

  test("duplicate email rejected", async () => {
    await expect(
      authCall("register", "Alice2", "alice@example.com", "password"),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════

describe("Login", () => {
  test("Alice logs in with correct password", async () => {
    const data = await authCall("login", "alice@example.com", "password");
    expect(data.token).toBeString();
    expect(data.profile.name).toBe("Alice");
    expect(data.profile.email).toBe("alice@example.com");
  });

  test("Bob logs in with correct password", async () => {
    const data = await authCall("login", "bob@example.com", "password");
    expect(data.token).toBeString();
    expect(data.profile.name).toBe("Bob");
    expect(data.profile.email).toBe("bob@example.com");
  });

  test("wrong password rejected", async () => {
    await expect(
      authCall("login", "alice@example.com", "wrong"),
    ).rejects.toThrow("invalid");
  });

  test("unknown email rejected", async () => {
    await expect(
      authCall("login", "nobody@example.com", "password"),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN EXPIRY & REFRESH
// ═══════════════════════════════════════════════════════════════════════════

describe("Token Expiry & Refresh", () => {
  test("login returns refreshToken and expiresIn", async () => {
    const data = await authCall("login", "alice@example.com", "password");
    expect(data.token).toBeString();
    expect(data.refreshToken).toBeString();
    expect(data.expiresIn).toBe(3600);
  });

  test("register returns refreshToken and expiresIn", async () => {
    const data = await authCall("register", "Charlie", "charlie@example.com", "password");
    expect(data.token).toBeString();
    expect(data.refreshToken).toBeString();
    expect(data.expiresIn).toBe(3600);
  });

  test("refresh_token returns new token pair", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    const refreshed = await authCall("refresh_token", login.refreshToken);
    expect(refreshed.token).toBeString();
    expect(refreshed.refreshToken).toBeString();
    expect(refreshed.expiresIn).toBe(3600);
    // New tokens should be different
    expect(refreshed.token).not.toBe(login.token);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
  });

  test("refresh_token is single-use (rotation)", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    // First use should succeed
    await authCall("refresh_token", login.refreshToken);
    // Second use of the same refresh token should fail (already revoked)
    await expect(
      authCall("refresh_token", login.refreshToken),
    ).rejects.toThrow("invalid or expired refresh token");
  });

  test("invalid refresh token rejected", async () => {
    await expect(
      authCall("refresh_token", "not-a-real-token"),
    ).rejects.toThrow("invalid or expired refresh token");
  });

  test("WebSocket connects with valid token", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(login.token)}`);
    const msg = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.onerror = reject;
      setTimeout(() => reject(new Error("timeout")), 5000);
    });
    expect(msg.type).toBe("profile");
    expect(msg.data.profile.name).toBe("Alice");
    ws.close();
  });

  test("WebSocket rejects invalid token", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=garbage`);
    const code = await new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
      ws.onopen = () => resolve(-1); // should not open
      setTimeout(() => resolve(-2), 5000);
    });
    // WebSocket upgrade fails with HTTP 401 — browser sees code 1006
    expect(code).not.toBe(-1);
  });

  test("revoke_refresh_tokens invalidates all tokens for user", async () => {
    const login1 = await authCall("login", "alice@example.com", "password");
    const login2 = await authCall("login", "alice@example.com", "password");

    // Revoke via WebSocket
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(login1.token)}`);
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve(); // wait for profile
    });
    const revokeResult = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({ id: "1", fn: "revoke_refresh_tokens", args: [] }));
    });
    expect(revokeResult.ok).toBe(true);
    ws.close();

    // Both refresh tokens should now fail
    await expect(
      authCall("refresh_token", login1.refreshToken),
    ).rejects.toThrow("invalid or expired refresh token");
    await expect(
      authCall("refresh_token", login2.refreshToken),
    ).rejects.toThrow("invalid or expired refresh token");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET PROTOCOL GUARDS
// ═══════════════════════════════════════════════════════════════════════════

describe("WebSocket Guards", () => {
  test("blocks _ prefixed functions", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    const conn = await openWS(login.token);
    conn.ws.send(JSON.stringify({ id: "1", fn: "_verify_token", args: ["x"] }));
    const msg = await conn.next();
    expect(msg.ok).toBe(false);
    expect(msg.error).toBe("not allowed");
    conn.close();
  });

  test("blocks preAuth functions on WebSocket", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    const conn = await openWS(login.token);
    conn.ws.send(JSON.stringify({ id: "1", fn: "login", args: ["a@b.com", "pw"] }));
    const msg = await conn.next();
    expect(msg.ok).toBe(false);
    expect(msg.error).toBe("use /auth endpoint");
    conn.close();
  });

  test("blocks refresh_token on WebSocket", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    const conn = await openWS(login.token);
    conn.ws.send(JSON.stringify({ id: "1", fn: "refresh_token", args: ["x"] }));
    const msg = await conn.next();
    expect(msg.ok).toBe(false);
    expect(msg.error).toBe("use /auth endpoint");
    conn.close();
  });

  test("rejects bad JSON", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    const conn = await openWS(login.token);
    conn.ws.send("not json at all");
    const msg = await conn.next();
    expect(msg.ok).toBe(false);
    expect(msg.error).toBe("bad json");
    conn.close();
  });

  test("/auth rejects non-preAuth functions", async () => {
    const res = await fetch(`${BASE}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fn: "save_thing", args: [] }),
    });
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("not allowed");
  });

  test("/auth rejects GET", async () => {
    const res = await fetch(`${BASE}/auth`);
    expect(res.status).toBe(405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET FUNCTION CALLS & DOC LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe("WebSocket Function Calls", () => {
  let aliceConn: Awaited<ReturnType<typeof openWS>>;
  let thingId: number;

  test("connect and receive profile", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    aliceConn = await openWS(login.token);
    expect(aliceConn.profile.type).toBe("profile");
    expect(aliceConn.profile.data.profile.name).toBe("Alice");
  });

  test("save_thing creates a thing", async () => {
    const result = await wsCall(aliceConn, "save_thing", [null, "Test Thing"]);
    expect(result.id).toBeNumber();
    expect(result.name).toBe("Test Thing");
    thingId = result.id;
  });

  test("save_thing updates a thing", async () => {
    const result = await wsCall(aliceConn, "save_thing", [thingId, "Renamed Thing"]);
    expect(result.name).toBe("Renamed Thing");
    expect(result.version).toBe(2);
  });

  test("version conflict detected", async () => {
    // version is now 2, try to update with version 1
    await expect(
      wsCall(aliceConn, "save_thing", [thingId, "Bad Update", 1]),
    ).rejects.toThrow("version conflict");
  });

  test("open thing_doc returns initial data", async () => {
    const msg = await wsOpen(aliceConn, "thing_doc", thingId);
    expect(msg.type).toBe("notify");
    expect(msg.op).toBe("set");
    expect(msg.data.thing.name).toBe("Renamed Thing");
    expect(msg.data.thing.items).toEqual([]);
  });

  test("open thing_list returns collection", async () => {
    const msg = await wsOpen(aliceConn, "thing_list", 0);
    expect(msg.type).toBe("notify");
    expect(msg.op).toBe("set");
    expect(msg.data.thing_list.length).toBeGreaterThanOrEqual(1);
    const found = msg.data.thing_list.find((t: any) => t.id === thingId);
    expect(found.name).toBe("Renamed Thing");
  });

  test("permission denied on other user's thing_doc", async () => {
    const bobLogin = await authCall("login", "bob@example.com", "password");
    const bobConn = await openWS(bobLogin.token);
    const msg = await wsOpen(bobConn, "thing_doc", thingId);
    expect(msg.type).toBe("error");
    expect(msg.error).toContain("permission denied");
    bobConn.close();
  });

  test("close doc unsubscribes", async () => {
    wsClose(aliceConn, "thing_doc", thingId);
    wsClose(aliceConn, "thing_list", 0);
    // Cleanup
    aliceConn.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION FAN-OUT
// ═══════════════════════════════════════════════════════════════════════════

describe("Notification Fan-Out", () => {
  let aliceConn: Awaited<ReturnType<typeof openWS>>;
  let thingId: number;

  test("setup: create thing and open doc on two connections", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    aliceConn = await openWS(login.token);

    // Create a thing to work with
    const result = await wsCall(aliceConn, "save_thing", [null, "Fanout Thing"]);
    thingId = result.id;
  });

  test("subscriber receives notify on mutation", async () => {
    // Open a second connection (same user) subscribed to thing_doc
    const login2 = await authCall("login", "alice@example.com", "password");
    const conn2 = await openWS(login2.token);

    // Subscribe conn2 to thing_doc
    const initial = await wsOpen(conn2, "thing_doc", thingId);
    expect(initial.data.thing.name).toBe("Fanout Thing");

    // Mutate via conn1
    await wsCall(aliceConn, "save_thing", [thingId, "Updated Name"]);

    // conn2 should receive the notify
    const notify = await conn2.next();
    expect(notify.type).toBe("notify");
    expect(notify.op).toBe("upsert");
    expect(notify.doc).toBe("thing_doc");
    expect(notify.doc_id).toBe(thingId);
    expect(notify.data.name).toBe("Updated Name");

    conn2.close();
  });

  test("non-subscriber does NOT receive notify", async () => {
    // Open a connection that does NOT subscribe to the doc
    const login3 = await authCall("login", "alice@example.com", "password");
    const conn3 = await openWS(login3.token);

    // Mutate
    await wsCall(aliceConn, "save_thing", [thingId, "Silent Update"]);

    // conn3 should NOT receive anything (timeout expected)
    await expect(conn3.next(500)).rejects.toThrow("timeout");

    conn3.close();
  });

  test("thing_list subscriber receives upsert on save_thing", async () => {
    const login4 = await authCall("login", "alice@example.com", "password");
    const conn4 = await openWS(login4.token);

    // Subscribe to thing_list
    const initial = await wsOpen(conn4, "thing_list", 0);
    expect(initial.data.thing_list).toBeArray();

    // Mutate
    await wsCall(aliceConn, "save_thing", [thingId, "List Update"]);

    // Should get upsert notify on thing_list collection
    const notify = await conn4.next();
    expect(notify.type).toBe("notify");
    expect(notify.doc).toBe("thing_list");
    expect(notify.collection).toBe("thing_list");
    expect(notify.op).toBe("upsert");

    conn4.close();
  });

  test("remove_thing sends remove notify to subscribers", async () => {
    // Create a throwaway thing
    const result = await wsCall(aliceConn, "save_thing", [null, "Delete Me"]);
    const deleteId = result.id;

    const login5 = await authCall("login", "alice@example.com", "password");
    const conn5 = await openWS(login5.token);

    // Subscribe to thing_doc for the new thing
    await wsOpen(conn5, "thing_doc", deleteId);

    // Also subscribe to thing_list
    await wsOpen(conn5, "thing_list", 0);

    // Remove the thing
    await wsCall(aliceConn, "remove_thing", [deleteId]);

    // Should receive two notifies: one for thing_list, one for thing_doc
    const notifies: any[] = [];
    notifies.push(await conn5.next());
    notifies.push(await conn5.next());

    const listNotify = notifies.find((n) => n.doc === "thing_list");
    const docNotify = notifies.find((n) => n.doc === "thing_doc");

    expect(listNotify).toBeDefined();
    expect(listNotify.op).toBe("remove");
    expect(listNotify.data.id).toBe(deleteId);

    expect(docNotify).toBeDefined();
    expect(docNotify.op).toBe("remove");
    expect(docNotify.data.id).toBe(deleteId);

    conn5.close();
  });

  test("cleanup", () => {
    aliceConn.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NESTED COLLECTION NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("Nested Collection Notifications", () => {
  let aliceConn: Awaited<ReturnType<typeof openWS>>;
  let thingId: number;

  test("setup: create thing", async () => {
    const login = await authCall("login", "alice@example.com", "password");
    aliceConn = await openWS(login.token);
    const result = await wsCall(aliceConn, "save_thing", [null, "Nested Thing"]);
    thingId = result.id;
  });

  test("save_item sends nested collection notify", async () => {
    // Subscribe to thing_doc
    const login2 = await authCall("login", "alice@example.com", "password");
    const conn2 = await openWS(login2.token);
    const initial = await wsOpen(conn2, "thing_doc", thingId);
    expect(initial.data.thing.items).toEqual([]);

    // Add an item via conn1
    const item = await wsCall(aliceConn, "save_item", [null, thingId, "Item 1"]);
    expect(item.title).toBe("Item 1");

    // conn2 should receive a nested collection notify
    const notify = await conn2.next();
    expect(notify.type).toBe("notify");
    expect(notify.doc).toBe("thing_doc");
    expect(notify.doc_id).toBe(thingId);
    expect(notify.collection).toBe("thing.items");
    expect(notify.op).toBe("upsert");
    expect(notify.data.title).toBe("Item 1");

    conn2.close();
  });

  test("remove_item sends nested collection remove notify", async () => {
    // Add an item first
    const item = await wsCall(aliceConn, "save_item", [null, thingId, "Delete Item"]);
    const itemId = item.id;

    // Subscribe
    const login3 = await authCall("login", "alice@example.com", "password");
    const conn3 = await openWS(login3.token);
    await wsOpen(conn3, "thing_doc", thingId);

    // Remove the item
    await wsCall(aliceConn, "remove_item", [itemId]);

    const notify = await conn3.next();
    expect(notify.type).toBe("notify");
    expect(notify.collection).toBe("thing.items");
    expect(notify.op).toBe("remove");
    expect(notify.data.id).toBe(itemId);

    conn3.close();
  });

  test("cleanup", () => {
    aliceConn.close();
  });
});
