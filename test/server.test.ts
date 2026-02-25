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
