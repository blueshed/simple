// Claude Helper — optional route that serves `/claude.js` for browser automation.
//
// When loaded by the client, it exposes `window.claude` with:
//   claude.api.<fn>(...)   — call any authed postgres function (user_id auto-injected)
//   claude.state()         — snapshot of all open doc signals as plain JSON
//   claude.openDoc(fn, id) — subscribe to a document
//   claude.closeDoc(fn, id)— unsubscribe
//   claude.navigate(path)  — change route via location.hash
//   claude.route()         — get current route
//   claude.help            — text summary of available functions and conventions
//   claude.functions        — array of { name, params } for all public functions
//
// The route introspects pg_proc to discover public functions, strips p_user_id
// from signatures, and excludes preAuth functions (login, register, etc.).
//
// Gated on RUNTIME_CLAUDE=true — both server (route registration) and client
// (script loading) check this env var. The client-side check requires
// bunfig.toml to inline RUNTIME_* env vars at serve time:
//
//   [serve.static]
//   env = "RUNTIME_*"
//
// Usage:
//   RUNTIME_CLAUDE=true bun run dev

import postgres from "postgres";
import { database_url } from "./server-core";

export function claudeHelperRoute(config: {
  preAuth: string[];
  databaseUrl?: string;
}) {
  const sql = postgres(config.databaseUrl ?? database_url);

  return async () => {
    const rows = await sql`
      SELECT p.proname AS name,
             p.proargnames AS arg_names
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind = 'f'
         AND p.proargnames[1] IS NOT NULL
         AND p.proargnames[1] LIKE 'p_%'
         AND left(p.proname, 1) != '_'
       ORDER BY p.proname`;

    const apiLines: string[] = [];
    const fnList: { name: string; params: string }[] = [];
    for (const r of rows) {
      if (config.preAuth.includes(r.name)) continue;
      const args: string[] = (r.arg_names as string[])
        .filter((a: string) => a !== "p_user_id")
        .map((a: string) => a.replace(/^p_/, ""));
      apiLines.push(`  claude.api.${r.name}(${args.join(", ")})`);
      fnList.push({ name: r.name, params: args.join(", ") });
    }

    const functions = JSON.stringify(fnList);
    const helpText = [
      "=== window.claude — API helper ===",
      "",
      "IMPORTANT: The server auto-injects user_id. Never pass it.",
      "",
      "Call functions via claude.api.<name>(...).then(r => r)",
      "All calls return Promises. Results are JSON.",
      "",
      "Available functions:",
      ...apiLines,
      "",
      "Conventions:",
      "- For save_* functions: pass null for id to CREATE, or a number to UPDATE",
      "- For remove_* functions: pass the id to delete",
      "",
      "Read current state:",
      "  claude.state()  — returns all open doc data as plain JSON",
      "  Look inside the state to find entity ids, names, etc.",
      "",
      "Navigation:",
      "  claude.navigate('/path')  — change route",
      "  claude.route()            — get current route",
    ].join("\\n");

    return new Response(`(function() {
  var s = window.__session;
  if (!s) return;
  var fns = ${functions};
  window.claude = {
    api: s.api,
    functions: fns,
    help: "${helpText}",
    state: function() {
      var out = {};
      s.docs.forEach(function(entry, key) { out[key] = entry.signal.peek(); });
      return out;
    },
    openDoc: s.openDoc,
    closeDoc: s.closeDoc,
    navigate: function(path) { location.hash = path; },
    route: function() { return location.hash.slice(1) || '/'; }
  };
})();`, { headers: { "Content-Type": "application/javascript" } });
  };
}
