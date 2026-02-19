import postgres from "postgres";
import type { ServerWebSocket } from "bun";
import pkg from "./package.json";

type WS = ServerWebSocket<{ user_id: number; docs: Set<string> }>;

export function createServer(config: {
  preAuth: string[];
  profileFn: string;
  index: Response;
  port?: number;
  databaseUrl?: string;
}) {
  const sql = postgres(
    config.databaseUrl ??
    process.env.DATABASE_URL ??
    `postgres://postgres:secret@localhost:5432/${pkg.name}`,
  );
  const clients: WS[] = [];
  const preAuth = new Set(config.preAuth);

  sql.listen("change", (payload) => {
    const { targets, ...rest } = JSON.parse(payload);

    // Fan-out: for each target, send to every client with that document open.
    const sends: { ws: WS; msg: string }[] = [];

    for (const target of targets ?? []) {
      const key = `${target.doc}:${target.doc_id}`;
      const msg = JSON.stringify({
        type: "notify",
        doc: target.doc,
        doc_id: target.doc_id,
        collection: target.collection,
        parent_id: target.parent_id ?? null,
        ...rest,
      });
      for (const ws of clients) {
        if (ws.data.docs.has(key)) sends.push({ ws, msg });
      }
    }

    for (const { ws, msg } of sends) ws.send(msg);
  });

  const server = Bun.serve<{ user_id: number; docs: Set<string> }>({
    port: config.port ?? (Number(process.env.PORT) || 3000),
    routes: {
      "/": config.index,
      "/auth": async (req: Request) => {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        let body: { fn: string; args: unknown[] };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "bad json" }, { status: 400 });
        }
        if (!preAuth.has(body.fn))
          return Response.json(
            { ok: false, error: "not allowed" },
            { status: 403 },
          );
        const ph = body.args
          .map((_: unknown, i: number) => `$${i + 1}`)
          .join(", ");
        try {
          const [row] = await sql.unsafe(
            `SELECT ${body.fn}(${ph}) AS result`,
            body.args as any[],
          );
          return Response.json({ ok: true, data: row.result });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 400 });
        }
      },
      "/ws": async (
        req: Request,
        server: {
          upgrade(
            req: Request,
            opts?: { data?: { user_id: number; docs: Set<string> } },
          ): boolean;
        },
      ) => {
        const token = new URL(req.url).searchParams.get("token");
        if (!token) return new Response("missing token", { status: 401 });
        try {
          const [row] = await sql`SELECT _verify_token(${token}) AS user_id`;
          const user_id = row.user_id;
          if (server.upgrade(req, { data: { user_id, docs: new Set() } })) return;
          return new Response("upgrade failed", { status: 500 });
        } catch {
          return new Response("invalid token", { status: 401 });
        }
      },
    },
    websocket: {
      async open(ws) {
        clients.push(ws);
        const [row] = await sql.unsafe(
          `SELECT ${config.profileFn}($1::int) AS result`,
          [ws.data.user_id],
        );
        ws.send(JSON.stringify({ type: "profile", data: row.result }));
      },
      close(ws) {
        const i = clients.indexOf(ws);
        if (i !== -1) clients.splice(i, 1);
      },
      async message(ws, raw) {
        let msg: { type?: string; id: string; fn: string; args: unknown[] };
        try {
          msg = JSON.parse(raw as string);
        } catch {
          ws.send(JSON.stringify({ id: null, ok: false, error: "bad json" }));
          return;
        }

        // Handle open/close doc subscription messages
        if (msg.type === "open") {
          ws.data.docs.add(`${msg.fn}:${msg.args?.[0]}`);
          return;
        }
        if (msg.type === "close") {
          ws.data.docs.delete(`${msg.fn}:${msg.args?.[0]}`);
          return;
        }

        if (msg.fn.startsWith("_")) {
          ws.send(
            JSON.stringify({ id: msg.id, ok: false, error: "not allowed" }),
          );
          return;
        }

        if (preAuth.has(msg.fn)) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              ok: false,
              error: "use /auth endpoint",
            }),
          );
          return;
        }

        const args = [ws.data.user_id, ...msg.args];
        const ph = args.map((_, i) => `$${i + 1}`).join(", ");
        try {
          const [row] = await sql.unsafe(
            `SELECT ${msg.fn}(${ph}) AS result`,
            args as any[],
          );
          ws.send(JSON.stringify({ id: msg.id, ok: true, data: row.result }));
        } catch (e: any) {
          ws.send(JSON.stringify({ id: msg.id, ok: false, error: e.message }));
        }
      },
    },
  });

  console.log(`listening on http://localhost:${server.port}`);
  return server;
}
