# Simple

You describe your app. Claude builds it. Postgres runs it.

Simple is a full-stack template designed for building apps with AI. You tell Claude what you want, watch the domain model take shape in real time, then let Claude implement the whole thing — schema, server functions, UI components, tests. You review and use the running app.

## Get started

```bash
bun create blueshed/simple my-app
cd my-app
bun run up    # start postgres + model server
bun run dev   # start app server
```

`bun create` copies the template, installs dependencies, and prompts you for your app and database name.

## Build your app

Open [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in your project directory. That's your workspace — you talk, Claude builds.

**1. Model your domain** — tell Claude `/model-app` and describe what you're building:

> /model-app todo with tags and tasks of pending, active or done

Claude creates stories, entities, documents, and methods. While you talk, browse http://localhost:8080 to see the domain model update in real time — entity diagrams, document graphs, and implementation checklists.

**2. Export the spec** — when the model looks right:
```bash
bun model export > spec.md
```

**3. Implement** — tell Claude `/implement`. It reads `spec.md` and builds the full app: database schema, SQL functions, TypeScript components, seed data. The dev server is already running — open your browser and use what Claude just built.

**4. Iterate** — found something to change? Go back to `/model-app`, update the model, re-export, and `/implement` again. Or just ask Claude to make changes directly.

## How it works

Simple follows one pattern: **postgres owns everything, the server routes, the client merges**.

- **Postgres is the application** — schema, permissions, business logic, and real-time notifications all live in SQL functions
- **Server is a relay** — verifies tokens, calls functions, fans out change notifications over WebSocket
- **Client merges deltas** — open a document, get live updates via `pg_notify`, no polling or re-fetching

```
Client                    Server                  Postgres
  │                          │                       │
  │  POST /auth login(...)   │                       │
  │─────────────────────────→│  SELECT login(...)    │
  │                          │──────────────────────→│
  │  { token, profile }      │                       │
  │←─────────────────────────│                       │
  │                          │                       │
  │  WS open thing_doc(1)    │                       │
  │─────────────────────────→│  subscribe            │
  │                          │                       │
  │  api.save_thing(...)     │  SELECT save_thing()  │
  │─────────────────────────→│──────────────────────→│── permission check
  │  { ok, data: id }        │                       │── mutate
  │←─────────────────────────│                       │── pg_notify
  │                          │← LISTEN 'change'      │
  │  { type:"notify", data } │── fan out to docs     │
  │←─────────────────────────│                       │
```

## Learn more

Detailed reference for when you're deeper in:

- [Server](.claude/docs/server.md) — WebSocket protocol, fan-out, guards
- [Client](.claude/docs/client.md) — session, signals, doc subscriptions, merging
- [Database](.claude/docs/database.md) — SQL conventions, notify payload, save/remove pattern
- [CSS](.claude/docs/css.md) — token system, theming, component conventions
- [Testing](.claude/docs/testing.md) — unit and integration test patterns
- [Easy](https://github.com/blueshed/easy) — the domain modeling tool behind `/model-app`
