// Runs once after `bun create` copies the template.
// Replaces the placeholder "myapp" with the actual project name.

import { readFileSync, writeFileSync, unlinkSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const name = pkg.name as string; // bun create sets this to basename(destination)

if (name === "myapp") {
  console.log("ℹ  Project name is 'myapp' — skipping substitution.");
  console.log("   Run: bun setup.ts  after renaming if needed.\n");
  process.exit(0);
}

const files = [
  { path: "compose.yml",                  from: /myapp/g },
  { path: "init_db/00_extensions.sql",    from: /myapp/g },
  { path: "session.ts",                   from: /myapp/g },
];

for (const { path, from } of files) {
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, name);
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

// Self-delete — this script is only needed once after bun create
unlinkSync("setup.ts");
console.log(`✓ setup.ts  (deleted)`);

console.log(`\nReady. Next steps:`);
console.log(`  bun run db   # start postgres`);
console.log(`  bun run dev  # start server`);
