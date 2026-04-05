---
name: agentic
description: Manage tasks, memories, and flags in an Easy model database. Use when the user wants to track implementation work, save project context, or set status flags. Triggered by mentions of tasks, memories, flags, or project tracking.
allowed-tools: Read, Bash
---

# Agentic Context — Tasks, Memories & Flags

Manage implementation state alongside the domain model using `bun model save/delete/list`.

## Tasks

A dependency DAG of implementation work. Status: `pending` (default), `in_progress`, `done`, `blocked`.

```bash
# Create tasks
bun model save task '{"name":"auth","description":"Add JWT middleware","status":"in_progress"}'

# Task with dependencies (by name)
bun model save task '{"name":"api-tests","description":"Integration tests","status":"pending","depends_on":[{"name":"auth"}]}'

# Multiple dependencies
bun model save task '{"name":"deploy","status":"blocked","depends_on":[{"name":"auth"},{"name":"api-tests"}]}'

# Update status
bun model save task '{"name":"auth","status":"done"}'

# List tasks
bun model list task

# Delete
bun model delete task '{"name":"auth"}'
```

**Status values:**
- `pending` — not started, waiting for dependencies
- `in_progress` — actively being worked on
- `done` — completed
- `blocked` — cannot proceed (dependencies incomplete or external blocker)

**Dependencies** are declared as `depends_on` children with `{"name":"task_name"}`. Circular dependencies are rejected.

The site shows tasks as a DAG in the Tasks view (graph layout with dependency edges).

## Memories

Persistent context stored as tag+content pairs. Use tags to organise by category.

```bash
# Save memories with tags
bun model save memory '{"tag":"architecture","content":"PostFeed uses cursor-based pagination"}'
bun model save memory '{"tag":"decision","content":"Tags use slugs for URL-safe identifiers"}'
bun model save memory '{"tag":"convention","content":"Permission paths use @ prefix for owner checks"}'
bun model save memory '{"tag":"todo","content":"Add full-text search on Post.title and Post.body"}'

# List all memories (grouped by tag)
bun model list memory

# Delete
bun model delete memory '{"tag":"todo","content":"Add full-text search on Post.title and Post.body"}'
```

**Common tags:** `architecture`, `decision`, `convention`, `todo`, `context`, `constraint`.

Natural key is `tag` + `content` — no duplicates within a tag.

The site shows memories in the Memories view, grouped by tag.

## Flags

Named status indicators for project health. Status: `pass`, `fail`, `unknown` (default).

```bash
# Set flags
bun model save flag '{"name":"db-migrations","status":"pass"}'
bun model save flag '{"name":"api-tests","status":"fail"}'
bun model save flag '{"name":"lint","status":"unknown"}'

# Optional: attach a command for automated checking
bun model save flag '{"name":"typecheck","cmd":"bun run tsc --noEmit","status":"pass"}'

# List flags
bun model list flag

# Delete
bun model delete flag '{"name":"lint"}'
```

Flags appear in the top-right corner of the Tasks view in the site.

## Workflow

A typical workflow when starting implementation:

1. Read the model: `bun model list`
2. Create tasks from the stories/entities: break work into implementation steps
3. Set dependencies between tasks to establish order
4. Save architectural decisions and conventions as memories
5. Set flags for key health checks (migrations, tests, lint)
6. Update task status as work progresses
7. View the DAG and flags on the site at `http://localhost:8080/#/graph`
8. View memories at `http://localhost:8080/#/memories`
