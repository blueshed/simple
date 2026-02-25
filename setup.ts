// Runs once after `bun create` copies the template.
// Replaces the placeholder "myapp" with the actual project name.

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, rmSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const name = pkg.name as string; // bun create sets this to basename(destination)

// Write .env (always, even for template dev)
writeFileSync(".env", [
  `DATABASE_URL=postgres://postgres:secret@localhost:5432/${name}`,
  `RUNTIME_TOKEN_KEY=${name}:token`,
  `RUNTIME_CLAUDE=false`,
  "",
].join("\n"));
console.log(`✓ .env`);

if (name === "myapp") {
  console.log("ℹ  Project name is 'myapp' — skipping remaining substitution.");
  process.exit(0);
}

const files = [
  "compose.yml",
  "package.json",
  "init_db/00_extensions.sql",
  "test/compose.yml",
  "test/server.test.ts",
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

// Ensure model.db is a file — Docker creates it as a directory if it doesn't exist
if (existsSync("model.db") && statSync("model.db").isDirectory()) {
  rmSync("model.db", { recursive: true });
}
if (!existsSync("model.db")) {
  writeFileSync("model.db", "");
  console.log(`✓ model.db  (created for Easy volume mount)`);
}

// Un-ignore model.db and spec.md so the user's project tracks them
const gitignore = readFileSync(".gitignore", "utf8");
const cleaned = gitignore.replace(/^model\.db\n?/m, "").replace(/^spec\.md\n?/m, "");
if (cleaned !== gitignore) {
  writeFileSync(".gitignore", cleaned);
  console.log(`✓ .gitignore  (model.db and spec.md now tracked)`);
}

// Self-delete — this script is only needed once after bun create
unlinkSync("setup.ts");
console.log(`✓ setup.ts  (deleted)`);

console.log(`\n✨ ${name} created (simple v${pkg.simple})`);
console.log(`\nNext steps:`);
console.log(`  bun run up   # start postgres, easy, plantuml`);
console.log(`  bun run dev  # start server`);
