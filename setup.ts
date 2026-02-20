// Runs once after `bun create` copies the template.
// Replaces the placeholder "myapp" with the actual project name.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const name = pkg.name as string; // bun create sets this to basename(destination)

if (name === "myapp") {
  console.log("ℹ  Project name is 'myapp' — skipping substitution.");
  console.log("   Run: bun setup.ts  after renaming if needed.\n");
  process.exit(0);
}

const files = [
  "compose.yml",
  "package.json",
  "server-core.ts",
  "init_db/00_extensions.sql",
  "session.ts",
];

for (const path of files) {
  const before = readFileSync(path, "utf8");
  const after = before.replace(/myapp/g, name);
  if (before !== after) {
    writeFileSync(path, after);
    console.log(`✓ ${path}`);
  }
}

// Update title in index.html to be the name in title case
const title = name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const html = readFileSync("index.html", "utf8");
writeFileSync("index.html", html.replace("My App", title));
console.log(`✓ index.html  (title → "${title}")`);

// Create model.db as an empty file before Docker can mount it as a directory
if (!existsSync("model.db")) {
  writeFileSync("model.db", "");
  console.log(`✓ model.db  (created for Easy volume mount)`);
}

// Self-delete — this script is only needed once after bun create
unlinkSync("setup.ts");
console.log(`✓ setup.ts  (deleted)`);

console.log(`\nReady. Next steps:`);
console.log(`  bun run up   # start postgres, easy, plantuml`);
console.log(`  bun run dev  # start server`);
