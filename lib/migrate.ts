import postgres from "postgres";
import { database_url } from "./server-core";

const MIGRATIONS_DIR = `${import.meta.dir}/../migrations`;

const sql = postgres(database_url);

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `;
}

function parse(content: string): { up: string; down: string } {
  const downIdx = content.indexOf("\n-- down\n");
  if (downIdx === -1) {
    const altIdx = content.indexOf("\n-- down");
    if (altIdx === -1) {
      return { up: content.replace(/^-- up\n?/, "").trim(), down: "" };
    }
    const up = content.slice(0, altIdx).replace(/^-- up\n?/, "").trim();
    const down = content.slice(altIdx).replace(/^[\n]*-- down\n?/, "").trim();
    return { up, down };
  }
  const up = content.slice(0, downIdx).replace(/^-- up\n?/, "").trim();
  const down = content.slice(downIdx + 1).replace(/^-- down\n?/, "").trim();
  return { up, down };
}

async function getMigrationFiles(): Promise<string[]> {
  const glob = new Bun.Glob("*.sql");
  const files: string[] = [];
  for await (const f of glob.scan(MIGRATIONS_DIR)) files.push(f);
  return files.sort();
}

async function getApplied(): Promise<Set<string>> {
  const rows = await sql`SELECT name FROM _migrations ORDER BY name`;
  return new Set(rows.map((r) => r.name));
}

async function applyUp(name: string, upSql: string) {
  await sql.begin(async (tx: any) => {
    await tx.unsafe(upSql);
    await tx`INSERT INTO _migrations (name) VALUES (${name})`;
  });
  console.log(`  applied: ${name}`);
}

async function applyDown(name: string, downSql: string) {
  if (!downSql) {
    console.error(`  no -- down section in ${name}, cannot rollback`);
    process.exit(1);
  }
  await sql.begin(async (tx: any) => {
    await tx.unsafe(downSql);
    await tx`DELETE FROM _migrations WHERE name = ${name}`;
  });
  console.log(`  rolled back: ${name}`);
}

async function status() {
  const files = await getMigrationFiles();
  const applied = await getApplied();
  if (files.length === 0) {
    console.log("no migrations");
    return;
  }
  for (const f of files) {
    const mark = applied.has(f) ? "[x]" : "[ ]";
    console.log(`  ${mark} ${f}`);
  }
}

async function up(all: boolean) {
  const files = await getMigrationFiles();
  const applied = await getApplied();
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log("nothing to apply");
    return;
  }
  const toApply = all ? pending : [pending[0]!];
  for (const name of toApply) {
    const content = await Bun.file(`${MIGRATIONS_DIR}/${name}`).text();
    const { up: upSql } = parse(content);
    try {
      await applyUp(name, upSql);
    } catch (e: any) {
      console.error(`  failed: ${name} — ${e.message}`);
      process.exit(1);
    }
  }
}

async function down() {
  const applied = await getApplied();
  if (applied.size === 0) {
    console.log("nothing to roll back");
    return;
  }
  const sorted = [...applied].sort();
  const last = sorted[sorted.length - 1]!;
  const content = await Bun.file(`${MIGRATIONS_DIR}/${last}`).text();
  const { down: downSql } = parse(content);
  try {
    await applyDown(last, downSql);
  } catch (e: any) {
    console.error(`  failed: ${last} — ${e.message}`);
    process.exit(1);
  }
}

// CLI
await ensureTable();

const cmd = process.argv[2];

switch (cmd) {
  case "status":
    await status();
    break;
  case "down":
    await down();
    break;
  case "up":
    await up(false);
    break;
  default:
    await up(true);
    break;
}

await sql.end();
