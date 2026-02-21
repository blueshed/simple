import { signal, type Signal } from "./signals";

type ServerEvent = { type: string; [key: string]: unknown };
type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

type DocEntry = {
  signal: Signal<unknown>;
  cursor: Signal<string | null>;
  hasMore: Signal<boolean>;
};

export type OpenDocOpts = {
  cursor?: string | null;
  limit?: number;
  stream?: boolean;
};

export function connect(token: string) {
  const status = signal<string>("connecting...");
  const profile = signal<unknown>(null);
  const docs = new Map<string, DocEntry>();
  const pending = new Map<string, Pending>();
  let id = 0;
  let ws: WebSocket;
  let delay = 1000;
  const queue: string[] = [];

  function send(msg: object) {
    const str = JSON.stringify(msg);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    } else {
      queue.push(str);
    }
  }

  function open() {
    ws = new WebSocket(
      `ws://${location.host}/ws?token=${encodeURIComponent(token)}`,
    );
    status.set("connecting...");
    ws.onopen = () => {
      status.set("connected");
      delay = 1000;
      while (queue.length) ws.send(queue.shift()!);
    };
    ws.onclose = (e) => {
      status.set("disconnected");
      for (const p of pending.values()) p.reject(new Error("disconnected"));
      pending.clear();
      // 4001 = invalid token — clear storage and go to login instead of retrying
      // 1006 before profile arrives = connection failed before auth completed
      if (e.code === 4001 || (!profile.peek() && e.code === 1006)) {
        sessionStorage.removeItem(TOKEN_KEY);
        location.hash = "/";
        return;
      }
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "profile") {
        profile.set(msg.data);
        return;
      }
      if (msg.type === "notify") {
        merge(msg);
        return;
      }
      if (msg.type === "error") {
        // A doc open failed (e.g. permission denied) — set the signal to an error sentinel
        // so the component can render a meaningful message instead of loading forever.
        const key = `${msg.fn}:${msg.doc_id}`;
        const entry = docs.get(key);
        if (entry) entry.signal.set({ _error: msg.error });
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    };
  }
  open();

  function splice(arr: any[], data: any, op: string) {
    const idx = arr.findIndex((item: any) => item.id === data.id);
    if (op === "remove") {
      if (idx !== -1) arr.splice(idx, 1);
    } else {
      if (idx !== -1) arr[idx] = data;
      else arr.push(data);
    }
  }

  function merge(msg: ServerEvent) {
    const { doc, doc_id, collection, parent_ids, op, data } = msg as any;
    const key = `${doc}:${doc_id}`;
    const entry = docs.get(key);
    if (!entry || !data) return;

    const s = entry.signal;

    // Update cursor tracking if present in the message
    if ("cursor" in msg) entry.cursor.set(msg.cursor as string | null);
    if ("hasMore" in msg) entry.hasMore.set(!!msg.hasMore);

    // Full document load (initial open response)
    if (op === "set") {
      s.set(data);
      return;
    }

    // Append: push items onto a collection array (used by cursor/stream)
    if (op === "append") {
      const current = s.peek() as any;
      if (!current) {
        s.set(data);
        return;
      }
      // data is the same shape as the doc — merge each collection array
      const rootKey = Object.keys(current)[0];
      if (Array.isArray(data)) {
        // data is a raw array for collection docs
        const arr = current[rootKey];
        if (Array.isArray(arr)) {
          // Dedup by id — skip items already present
          const existing = new Set(arr.map((item: any) => item.id));
          for (const item of data) {
            if (!existing.has(item.id)) arr.push(item);
          }
          s.set({ ...current });
        }
      } else if (typeof data === "object") {
        // data is a doc shape — merge each array property
        const root = current[rootKey];
        if (root && typeof root === "object") {
          for (const [k, v] of Object.entries(data)) {
            if (Array.isArray(v) && Array.isArray(root[k])) {
              const existing = new Set(root[k].map((item: any) => item.id));
              for (const item of v as any[]) {
                if (!existing.has(item.id)) root[k].push(item);
              }
            }
          }
          s.set({ ...current });
        } else {
          // Collection doc root — data keys match root keys
          for (const [k, v] of Object.entries(data)) {
            if (Array.isArray(v) && Array.isArray(current[k])) {
              const existing = new Set(current[k].map((item: any) => item.id));
              for (const item of v as any[]) {
                if (!existing.has(item.id)) current[k].push(item);
              }
            }
          }
          s.set({ ...current });
        }
      }
      return;
    }

    const current = s.peek() as any;
    if (!current) return;
    // doc structure: { <rootKey>: { ...fields, <collection>[] } }
    const rootKey = Object.keys(current)[0];
    const root = current[rootKey] as any;

    if (!collection) {
      if (op === "remove") {
        // root entity deleted — signal to components to navigate away
        s.set({ _removed: true });
      } else {
        // root entity changed — merge fields
        s.set({ [rootKey]: { ...root, ...data } });
      }
      return;
    }

    // collection is a dotted path e.g. "packages.allocations.options"
    // parent_ids is an array with one id per intermediate segment (all but the last)
    const segments = collection.split(".");

    // For collection docs (path starts with root key, e.g. "posts" in {posts:[...]}),
    // navigate from the doc itself. For entity docs, navigate from the root entity.
    const start = segments[0] === rootKey ? current : root;

    if (segments.length === 1) {
      const arr = start?.[segments[0]] as any[];
      if (!arr) return;
      splice(arr, data, op);
    } else {
      const ids: number[] = parent_ids ?? [];
      let node: any = start;
      for (let i = 0; i < segments.length - 1; i++) {
        const arr = node?.[segments[i]] as any[];
        if (!arr) return;
        node = arr.find((item: any) => item.id === ids[i]);
        if (!node) return;
      }
      const arr = node?.[segments[segments.length - 1]] as any[];
      if (!arr) return;
      splice(arr, data, op);
    }

    s.set({ ...current });
  }

  function openDoc(fn: string, docId: number, data: unknown, opts?: OpenDocOpts): Signal<unknown> {
    const key = `${fn}:${docId}`;
    const s = signal<unknown>(data);
    const cursorSig = signal<string | null>(null);
    const hasMoreSig = signal<boolean>(false);
    docs.set(key, { signal: s, cursor: cursorSig, hasMore: hasMoreSig });
    const msg: any = { type: "open", fn, args: [docId] };
    if (opts?.cursor !== undefined) msg.cursor = opts.cursor;
    if (opts?.limit !== undefined) msg.limit = opts.limit;
    if (opts?.stream) msg.stream = true;
    send(msg);
    return s;
  }

  function closeDoc(fn: string, docId: number): void {
    const key = `${fn}:${docId}`;
    docs.delete(key);
    send({ type: "close", fn, args: [docId] });
  }

  function docCursor(fn: string, docId: number): Signal<string | null> {
    const entry = docs.get(`${fn}:${docId}`);
    return entry ? entry.cursor : signal<string | null>(null);
  }

  function docHasMore(fn: string, docId: number): Signal<boolean> {
    const entry = docs.get(`${fn}:${docId}`);
    return entry ? entry.hasMore : signal<boolean>(false);
  }

  function loadMore(fn: string, docId: number, limit?: number): Promise<unknown> {
    const entry = docs.get(`${fn}:${docId}`);
    const cur = entry?.cursor.peek();
    if (!cur) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const rid = String(++id);
      pending.set(rid, {
        resolve: (result: any) => {
          // Cursor-aware result: { data, cursor, hasMore }
          if (result && typeof result === "object" && "hasMore" in result) {
            if (entry) {
              entry.cursor.set(result.cursor ?? null);
              entry.hasMore.set(!!result.hasMore);
            }
            // Merge data into the existing signal as append
            merge({
              type: "notify",
              doc: fn,
              doc_id: docId,
              op: "append",
              data: result.data,
            });
            resolve(result);
          } else {
            resolve(result);
          }
        },
        reject,
      });
      send({ type: "fetch", id: rid, fn, args: [docId], cursor: cur, limit: limit ?? null });
    });
  }

  const api = new Proxy(
    {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
    {
      get:
        (_, fn: string) =>
        (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            const rid = String(++id);
            pending.set(rid, { resolve, reject });
            send({ id: rid, fn, args });
          }),
    },
  );

  return { api, status, profile, openDoc, closeDoc, docCursor, docHasMore, loadMore, docs };
}

export type Session = ReturnType<typeof connect>;

// Module-level singleton — created once after login, shared by all components.
let _session: Session | null = null;

export function initSession(token: string): Session {
  _session = connect(token);
  return _session;
}

export function getSession(): Session {
  if (!_session) throw new Error("Session not initialised");
  return _session;
}

export function clearSession(): void {
  _session = null;
}

// Token key namespaced by app name (substituted by setup.ts)
export const TOKEN_KEY = "myapp:token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export async function auth(
  fn: string,
  args: unknown[],
): Promise<{ token: string; profile: unknown }> {
  const res = await fetch("/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  sessionStorage.setItem(TOKEN_KEY, body.data.token);
  return { token: body.data.token, profile: body.data.profile };
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  location.hash = "/";
}
