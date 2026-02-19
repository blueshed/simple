---
name: upgrade
description: Checks the upstream blueshed/simple repo for updates to the infrastructure files (server-core.ts, session.ts, signals.ts) and applies them selectively. Use when the user asks to upgrade, check for updates, or sync infrastructure.
allowed-tools: Read, Bash, Edit, Write
---

Fetch the upstream versions of the three managed infrastructure files and compare them to the local versions.

## Managed files

- `server-core.ts` — WebSocket relay and postgres fan-out
- `session.ts` — WebSocket client, doc subscriptions, merge logic
- `signals.ts` — reactive primitives, routing

These files are owned by the upstream template. The user's app code (`server.ts`, `app.ts`, `components/`, `init_db/`) is never touched.

## Process

For each managed file:

1. Fetch the upstream version:
   `https://raw.githubusercontent.com/blueshed/simple/refs/heads/main/<file>`

2. Read the local version with the Read tool.

3. If identical — report it as up to date and move on.

4. If different — read both versions carefully and explain:
   - What changed (not just which lines — what the change *means*)
   - Whether it's a bug fix, new capability, or breaking change
   - Whether the user's app code in `server.ts` needs any adjustment to use it

5. Ask the user whether to apply the update.

6. If yes — write the upstream version to the local file exactly as fetched.

## Tone

Be specific about what changed and why it matters. Don't just show a raw diff — explain it in plain language so the user can make an informed decision about each file.
