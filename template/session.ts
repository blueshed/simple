import { signal, type Signal } from "./signals";

type ServerEvent = { type: string; [key: string]: unknown };
type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

export function connect(token: string) {
  const status = signal<string>("connecting...");
  const profile = signal<unknown>(null);
  const docs = new Map<string, Signal<unknown>>();
  const pending = new Map<string, Pending>();
  let id = 0;
  let ws: WebSocket;
  let delay = 1000;

  function open() {
    ws = new WebSocket(
      `ws://${location.host}/ws?token=${encodeURIComponent(token)}`,
    );
    status.set("connecting...");
    ws.onopen = () => {
      status.set("connected");
      delay = 1000;
    };
    ws.onclose = () => {
      status.set("disconnected");
      for (const p of pending.values()) p.reject(new Error("disconnected"));
      pending.clear();
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
    const { doc, doc_id, collection, parent_id, op, data } = msg as any;
    const key = `${doc}:${doc_id}`;
    const s = docs.get(key);
    if (!s || !data) return;

    const current = s.peek() as any;
    // doc structure: { <rootKey>: { ...fields, <collection>[] } }
    const rootKey = Object.keys(current)[0];
    const root = current[rootKey] as any;

    if (!collection) {
      // root entity changed — merge fields
      s.set({ [rootKey]: { ...root, ...data } });
      return;
    }

    // collection may be a dotted path e.g. "packages.allocations"
    // parent_id identifies the item in the first segment that owns the nested array
    const [segment, nested] = collection.split(".");

    if (!nested) {
      // single-level collection
      const arr = root?.[segment] as any[];
      if (!arr) return;
      splice(arr, data, op);
    } else {
      // two-level path: find parent in segment[], then upsert/remove in its nested[]
      const parentArr = root?.[segment] as any[];
      if (!parentArr) return;
      const parent = parentArr.find((item: any) => item.id === parent_id);
      if (!parent) return;
      const arr = parent[nested] as any[];
      if (!arr) return;
      splice(arr, data, op);
    }

    s.set({ ...current });
  }

  function openDoc(fn: string, docId: number, data: unknown): Signal<unknown> {
    const key = `${fn}:${docId}`;
    const s = signal<unknown>(data);
    docs.set(key, s);
    ws.send(JSON.stringify({ type: "open", fn, args: [docId] }));
    return s;
  }

  function closeDoc(fn: string, docId: number): void {
    const key = `${fn}:${docId}`;
    docs.delete(key);
    ws.send(JSON.stringify({ type: "close", fn, args: [docId] }));
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
            ws.send(JSON.stringify({ id: rid, fn, args }));
          }),
    },
  );

  return { api, status, profile, openDoc, closeDoc };
}

export type Session = ReturnType<typeof connect>;

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
  return { token: body.data.token, profile: body.data.profile };
}
