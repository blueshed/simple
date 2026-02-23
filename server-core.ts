import postgres from "postgres";
import type { ServerWebSocket } from "bun";

export const database_url =
  process.env.DATABASE_URL ?? `postgres://postgres:secret@localhost:5432/myapp`;

type WS = ServerWebSocket<{ user_id: number; docs: Set<string> }>;

export function createServer(config: {
  preAuth: string[];
  profileFn: string;
  index: Response;
  port?: number;
  databaseUrl?: string;
  routes?: Record<string, any>;
}) {
  const sql = postgres(config.databaseUrl ?? database_url);
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
        parent_ids: target.parent_ids ?? null,
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
          return Response.json(
            { ok: false, error: "bad json" },
            { status: 400 },
          );
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
          return Response.json({ ok: true, data: row!.result });
        } catch (e: any) {
          return Response.json(
            { ok: false, error: e.message },
            { status: 400 },
          );
        }
      },
      ...config.routes,
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
          const user_id = row!.user_id;
          if (server.upgrade(req, { data: { user_id, docs: new Set() } }))
            return;
          return new Response("upgrade failed", { status: 500 });
        } catch {
          return new Response("invalid token", { status: 401 });
        }
      },
    },
    websocket: {
      idleTimeout: 30, // Heroku closes at 55s; Bun auto-pings before this
      sendPings: true,
      async open(ws) {
        clients.push(ws);
        const [row] = await sql.unsafe(
          `SELECT ${config.profileFn}($1::int) AS result`,
          [ws.data.user_id],
        );
        ws.send(JSON.stringify({ type: "profile", data: row!.result }));
      },
      close(ws) {
        const i = clients.indexOf(ws);
        if (i !== -1) clients.splice(i, 1);
      },
      async message(ws, raw) {
        let msg: {
          type?: string;
          id: string;
          fn: string;
          args: unknown[];
          cursor?: string | null;
          limit?: number;
          stream?: boolean;
        };
        try {
          msg = JSON.parse(raw as string);
        } catch {
          ws.send(JSON.stringify({ id: null, ok: false, error: "bad json" }));
          return;
        }

        // Guard: block private functions and preAuth functions on the WebSocket
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

        // Handle open/close doc subscription messages
        if (msg.type === "open") {
          const docId = msg.args?.[0];
          ws.data.docs.add(`${msg.fn}:${docId}`);
          // Call the doc function and send the initial data
          // doc_id 0 = collection doc (no entity id arg), otherwise pass it
          const baseArgs: unknown[] = docId
            ? [ws.data.user_id, docId]
            : [ws.data.user_id];
          // Cursor/limit: append when provided (cursor-aware doc functions accept these)
          const hasCursor = msg.cursor !== undefined || msg.limit !== undefined;
          const callArgs = hasCursor
            ? [...baseArgs, msg.cursor ?? null, msg.limit ?? null]
            : baseArgs;
          const ph = callArgs
            .map((_: unknown, i: number) => `$${i + 1}`)
            .join(", ");
          try {
            const [row] = await sql.unsafe(
              `SELECT ${msg.fn}(${ph}) AS result`,
              callArgs as any[],
            );
            const result = row!.result;
            // Cursor-aware functions return { data, cursor, hasMore }
            // Non-cursor functions return the doc shape directly
            if (
              hasCursor &&
              result &&
              typeof result === "object" &&
              "hasMore" in result
            ) {
              ws.send(
                JSON.stringify({
                  type: "notify",
                  doc: msg.fn,
                  doc_id: docId,
                  op: "set",
                  data: result.data,
                  cursor: result.cursor ?? null,
                  hasMore: result.hasMore ?? false,
                }),
              );
              // Streaming: keep sending pages until exhausted
              if (msg.stream && result.hasMore && result.cursor) {
                let cur = result.cursor;
                while (cur && ws.data.docs.has(`${msg.fn}:${docId}`)) {
                  const nextArgs = [...baseArgs, cur, msg.limit ?? null];
                  const nph = nextArgs
                    .map((_: unknown, i: number) => `$${i + 1}`)
                    .join(", ");
                  const [next] = await sql.unsafe(
                    `SELECT ${msg.fn}(${nph}) AS result`,
                    nextArgs as any[],
                  );
                  const nr = next!.result;
                  if (!nr || !("hasMore" in nr)) break;
                  ws.send(
                    JSON.stringify({
                      type: "notify",
                      doc: msg.fn,
                      doc_id: docId,
                      op: "append",
                      data: nr.data,
                      cursor: nr.cursor ?? null,
                      hasMore: nr.hasMore ?? false,
                    }),
                  );
                  if (!nr.hasMore) break;
                  cur = nr.cursor;
                }
              }
            } else {
              ws.send(
                JSON.stringify({
                  type: "notify",
                  doc: msg.fn,
                  doc_id: docId,
                  op: "set",
                  data: result,
                }),
              );
            }
          } catch (e: any) {
            ws.send(
              JSON.stringify({
                type: "error",
                fn: msg.fn,
                doc_id: docId,
                error: e.message,
              }),
            );
          }
          return;
        }
        if (msg.type === "close") {
          ws.data.docs.delete(`${msg.fn}:${msg.args?.[0]}`);
          return;
        }

        // Fetch: request a page without subscribing (for loadMore)
        if (msg.type === "fetch") {
          const docId = msg.args?.[0];
          const baseArgs: unknown[] = docId
            ? [ws.data.user_id, docId]
            : [ws.data.user_id];
          const callArgs = [...baseArgs, msg.cursor ?? null, msg.limit ?? null];
          const ph = callArgs
            .map((_: unknown, i: number) => `$${i + 1}`)
            .join(", ");
          try {
            const [row] = await sql.unsafe(
              `SELECT ${msg.fn}(${ph}) AS result`,
              callArgs as any[],
            );
            ws.send(
              JSON.stringify({ id: msg.id, ok: true, data: row!.result }),
            );
          } catch (e: any) {
            ws.send(
              JSON.stringify({ id: msg.id, ok: false, error: e.message }),
            );
          }
          return;
        }

        const args = [ws.data.user_id, ...msg.args];
        const ph = args.map((_, i) => `$${i + 1}`).join(", ");
        try {
          const [row] = await sql.unsafe(
            `SELECT ${msg.fn}(${ph}) AS result`,
            args as any[],
          );
          ws.send(JSON.stringify({ id: msg.id, ok: true, data: row!.result }));
        } catch (e: any) {
          ws.send(JSON.stringify({ id: msg.id, ok: false, error: e.message }));
        }
      },
    },
  });

  console.log(`listening on http://localhost:${server.port}`);
  return server;
}
