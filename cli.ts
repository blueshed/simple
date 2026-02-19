import postgres from "postgres";
import { database_url } from "./server-core";

const sql = postgres(database_url);
const [fn, ...args] = process.argv.slice(2);

if (!fn || fn === "-h" || fn === "--help") {
  if (fn === "-h" || fn === "--help") {
    const rows = await sql`
      SELECT p.proname AS name,
             array_to_string(p.proargnames, ', ') AS params
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind = 'f'
         AND p.proargnames[1] IS NOT NULL
         AND p.proargnames[1] LIKE 'p_%'
       ORDER BY p.proname`;
    console.log("available functions:\n");
    for (const r of rows) console.log(`  ${r.name}(${r.params})`);
    console.log("");
  }
  console.log("usage: bun run api <fn> [args...]");
  console.log(
    "       use name=value to skip positional args (e.g. p_lat=51.5)",
  );
  await sql.end();
  process.exit(0);
}

function parseValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Check if any arg uses name=value syntax
const hasNamed = args.some((a) => a.includes("="));

let parsed: unknown[];

if (hasNamed) {
  // Look up param names for this function
  const [meta] = await sql`
    SELECT p.proargnames AS names
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ${fn}
     LIMIT 1`;
  if (!meta) {
    console.error(`unknown function: ${fn}`);
    await sql.end();
    process.exit(1);
  }
  const names: string[] = meta.names;
  parsed = new Array(names.length).fill(null);

  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      console.error(`mixed positional and named args not supported: ${arg}`);
      await sql.end();
      process.exit(1);
    }
    const name = arg.slice(0, eq);
    const value = parseValue(arg.slice(eq + 1));
    const idx = names.indexOf(name);
    if (idx === -1) {
      console.error(`unknown param: ${name}  (expected: ${names.join(", ")})`);
      await sql.end();
      process.exit(1);
    }
    parsed[idx] = value;
  }
} else {
  parsed = args.map(parseValue);
}

const ph = parsed.map((_, i) => `$${i + 1}`).join(", ");
try {
  const [row] = await sql.unsafe(
    `SELECT ${fn}(${ph}) AS result`,
    parsed as any[],
  );
  console.log(JSON.stringify(row.result, null, 2));
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
} finally {
  await sql.end();
}
