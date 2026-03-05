# Development Experience Report: Todo with Tags

Built using the **Simple** framework (`bun create blueshed/simple`) with the model-to-implement workflow. This report captures what an AI agent (Claude Opus 4.6) experienced building a full-stack reactive todo app from requirements to verified deployment.

## Overview

| Phase | Time (approx) | Commands/Actions |
|-------|---------------|-----------------|
| Modeling (`/model-app`) | ~2 min | 30+ `bun model` CLI calls |
| Implementation (`/implement`) | ~5 min | 7 files written/edited |
| Integration tests | ~1 min | 21 tests, all passed first run |
| UX verification (Playwright MCP) | ~2 min | Login, add task, change status, filter, tag, untag |
| Checklist updates | ~1 min | 12 checks marked `[AU]` |

**Final result:** 3 tables, 2 doc functions, 6 mutations, 2 enrichment helpers, 1 component, 21 tests, 12/12 checklist checks verified.

---

## Phase 1: Modeling

### What worked

**The decomposition order is excellent.** The prescribed sequence — stories → entities → relations → documents → expansions → methods → publish → checklists — prevents the common mistake of jumping to implementation details before understanding the domain. Each step builds on the previous one, and the CLI enforces referential integrity (you can't reference an entity that doesn't exist).

**Coalescing upsert by natural key is powerful.** Saving a story with the same `actor` + `action` updates it rather than creating a duplicate. This made iterative refinement painless — I could add story links in a second pass without worrying about duplicate records. The same applies to adding fields to entities, checks to checklists, etc.

**Inline children reduce round-trips.** Being able to save an entity with its fields and methods in one call, or a document with its expansion tree, keeps the modeling flow tight. For example:

```bash
bun model save document '{"name":"TodoDoc","entity":"Task","collection":true,
  "expansions":[{"name":"task_tags","entity":"TaskTag","foreign_key":"task_id",
    "expansions":[{"name":"tag","entity":"Tag","foreign_key":"tag_id","belongs_to":true}]}]}'
```

This single command defined the entire document shape including nested belongs-to. Without inline children, this would have been 3 separate commands.

**The Account entity convention is clear.** The instruction to model `Account` as a stand-in for the existing `user` table, with `/implement` mapping it back, eliminates ambiguity about auth integration.

**Checklists add real value.** Defining DENIED checks during modeling (before any code exists) forces you to think about permission boundaries early. The `depends_on` mechanism creates sequenced test scenarios that map directly to integration tests later.

### What was complex

**Choosing the right document granularity.** The todo app needed two documents: `TodoDoc` (collection of tasks with tags) and `TagList` (collection of tags for the picker). This wasn't immediately obvious — the initial instinct was one document. The realization that the tag picker needs its own subscription came from thinking about the UI, not the domain model. The skill instructions don't explicitly guide this "one document per screen concern" decision, though the principle "documents are screens" hints at it.

**Understanding change targets.** The spec's `Changes` section is computed automatically from the expansion tree, but mapping it to notify payloads requires understanding the merge protocol. For example:

```
TaskTag changes: `TodoDoc(task_id)` → `task_tags`
```

This compact notation means: "When a TaskTag is upserted/removed, notify clients with `todo_doc` open (doc_id 0), using collection path `todo_doc.task_tags` and `parent_ids: [task_id]`." Getting from that notation to the correct `pg_notify` call requires understanding the collection document merge logic (the root key IS the collection, so the path starts with `todo_doc`).

**The permission path DSL for join tables.** For `tag_task` and `untag_task`, the permission isn't a simple `@user_id` on the entity (TaskTag has no user_id). The permission check must traverse: look up the Task by task_id, verify its user_id matches. The permission path DSL (`@task_id->task.user_id`) didn't end up in the model for TaskTag because it's a create-only operation where the row doesn't exist yet. Instead, the permission logic was hand-coded in the mutation function. This gap between the model's permission paths and create-time ownership verification could be documented more explicitly.

### What didn't work

**Batch checklist updates via `&&` chaining were fragile.** When updating 12 checks to `confirmed:3`, chaining with `&&` caused a cascade failure when one intermediate `bun model` call failed (likely a transient Docker exec issue). Running each command individually was reliable. The CLI could benefit from a bulk update mode for checks.

---

## Phase 2: Implementation

### What worked

**The reference docs are comprehensive and consistent.** Having `.claude/docs/database.md`, `server.md`, `client.md`, `css.md`, and `testing.md` meant every implementation question had a documented answer. The save/remove four-step pattern (resolve → permission → mutate → notify), the doc function conventions, the component lifecycle pattern — all were clear and unambiguous.

**The enrichment helper pattern scales well.** When a collection document has nested expansions (tasks with task_tags containing tag objects), every mutation that upserts into that collection must include the nested shape. Extracting `_enrich_task()` and `_enrich_task_tag()` as SQL functions eliminated duplication:

```sql
-- Used by save_task:
v_data := _enrich_task(v_row);

-- Used by tag_task:
v_data := _enrich_task_tag(v_row);
```

Without helpers, each mutation would duplicate the subquery logic. The `_` prefix convention (blocking client access) is a clean solution.

**The reactive update model works as advertised.** After implementing `save_task`, the UI updated instantly without any re-fetch logic. The chain `mutation → pg_notify → server fan-out → merge into signal → effect re-runs → DOM patch` is invisible to the component author. The component just reads `doc.get()` in an effect and patches DOM nodes.

**21 integration tests passed on the first run.** The test helper pattern (`ws()` for WebSocket clients, `login()` for auth) from the testing docs was copy-paste ready. Each test is self-contained: opens a connection, performs operations, asserts, closes. The `send("open", ...)` + `Bun.sleep(100)` pattern for doc subscriptions before mutation is slightly ceremony-heavy but reliable.

**The spec-to-code mapping is nearly mechanical.** Given the spec, writing SQL was almost a translation exercise:
- Entity fields → `CREATE TABLE` columns
- Document + expansions → doc function with `jsonb_agg` / `jsonb_build_object` subqueries
- Method + publishes + permission → mutation function following the four-step pattern
- Change targets → `pg_notify` payload

An experienced developer (or AI) can do this transformation reliably because the patterns are rigid.

### What required careful attention

**Collection documents use doc_id 0.** This is a critical distinction from entity documents. The client calls `openDoc("todo_doc", 0, null)`, the server calls `todo_doc(user_id)` (no second arg), and notifications use `doc_id: 0`. Missing this causes silent failures — the server can't match notifications to subscriptions. The docs explain it, but it's easy to confuse with entity documents where doc_id is the entity's primary key.

**Nested collection notify paths need `parent_ids`.** For `tag_task`, the notify target is:

```sql
jsonb_build_object(
    'doc', 'todo_doc',
    'collection', 'todo_doc.task_tags',
    'doc_id', 0,
    'parent_ids', jsonb_build_array(p_task_id)
)
```

The `parent_ids` array has one entry per intermediate path segment. For `todo_doc.task_tags`, there's one intermediate segment (`todo_doc` — the task array), so `parent_ids` has one entry (the task_id). The merge logic walks the path: find the task in `todo_doc[]` by `parent_ids[0]`, then upsert/remove in its `task_tags[]` by `id`. Getting this wrong means silent merge failures.

**Component reconciliation is verbose but necessary.** The reconcile-by-id pattern (tracking `prevIds`, querying `[data-id="..."]`, appending new nodes, removing stale nodes) is ~40 lines per list. This is the price of atomic DOM updates — you can't use `innerHTML` inside effects without destroying scroll position, focus, and event listeners. The pattern is correct and performant, but it's the most boilerplate-heavy part of the codebase. A small reconciliation helper could reduce this.

**Enriched notify data must match the doc shape exactly.** When `save_task` notifies, the data must include `task_tags` with nested `tag` objects — because the merge replaces the entire item by id. If you send `row_to_json(v_row)` without enrichment, the task's tags disappear from the UI until the next full doc load. This is the most likely source of subtle bugs in a Simple app.

### Design decisions made during implementation

**Client-side filtering vs. multiple documents.** The spec has one `TodoDoc` collection. Rather than creating separate documents per status (which would mean 3 subscriptions and 3 sets of notifications), I implemented client-side filtering with buttons. All tasks are loaded once; the filter just controls which DOM nodes are visible. This is simpler, faster, and scales fine for a personal todo list. For thousands of tasks, cursor-mode pagination with server-side filtering would be better.

**Status as TEXT with CHECK constraint.** The three statuses (pending/active/done) are enforced at the database level via `CHECK (status IN ('pending', 'active', 'done'))`. This prevents invalid states without requiring an enum type (which needs migrations to extend).

**Status cycling on click.** Rather than a dropdown, clicking the status icon cycles through states: pending (○) → active (▶) → done (✓) → pending. This is fewer clicks for the common case (advancing a task forward) and still allows resetting.

---

## Phase 3: Testing

### What worked

**API tests mapped directly to checklist checks.** Each checklist check (owner CAN save, other_user DENIED save, etc.) became a test case. The 1:1 mapping made test coverage obvious and complete.

**The `ws()` helper is well-designed.** Separating `call()` (request/response, Promise-based) from `send()` (fire-and-forget, for doc subscriptions) reflects the actual WebSocket protocol cleanly. The `messages[]` array captures all server-pushed events for assertion.

**Notification fan-out is testable.** Opening a doc subscription, mutating, then checking `messages[]` for notify events proves the full reactive pipeline works end-to-end without a browser.

### What required care

**Test isolation with seed data.** Tests run against seed data, so mutations in one test affect others. The "owner can save their task" test changed task #1's title to "Buy groceries updated", which persisted. Later when browsing the app, the title showed "Notified title" (from the notification test). For a real project, each test should create its own data and clean up, or the database should be reset between test blocks.

**Sleep-based synchronization.** The pattern `send("open", ...); await Bun.sleep(100);` before mutating is necessary because doc subscription is asynchronous. Without the sleep, the mutation might fire before the server registers the subscription, and the test misses the notification. The 100ms sleep is a heuristic — on a slow machine, it might not be enough. A more robust approach would be to wait for the initial `op: "set"` message before mutating.

### UX testing via Playwright MCP

**Playwright MCP snapshots are excellent for verification.** The accessibility tree snapshot gives structured, assertable content without parsing HTML. Confirming that "Call the dentist" appeared in the list, that status icons changed, and that tag chips appeared/disappeared was straightforward from snapshots.

**The `host.docker.internal` convention works.** Since Playwright runs inside Docker, using `http://host.docker.internal:3000` to reach the host's dev server was reliable after confirming with `curl` first.

---

## Post-Deployment Bug: Stale Closure in Status Cycling

After all tests passed and UX verification looked good, a bug was found in production use: clicking a task's status button to advance from pending → active worked, but clicking again to advance from active → done did nothing (it cycled back to active).

**Root cause:** The click handler was created once when the `<li>` element was first built, capturing `task.status` from the loop variable's closure. When the effect re-ran after a status change, it updated the button's visual appearance (icon, CSS class) but did not re-attach the event listener. The old closure still held the original status value, so the "next" calculation was always based on the first status the task had when the DOM node was created.

```typescript
// BUG: task.status is captured once, never updated
li.querySelector(".task-status-btn")!.addEventListener("click", () => {
    const next = task.status === "pending" ? "active" : ...;
    api.save_task(task.id, null, next);
});
```

**Fix:** Store the current status as a `data-status` attribute on the `<li>` (updated in the effect alongside the visual changes), and read it from the DOM in the click handler:

```typescript
// FIX: read current status from DOM, not closure
li.querySelector(".task-status-btn")!.addEventListener("click", () => {
    const current = li!.getAttribute("data-status")!;
    const next = current === "pending" ? "active" : ...;
    api.save_task(task.id, null, next);
});
```

**Why it matters for the framework:** This is a direct consequence of the "wire event listeners once, update DOM in effects" pattern. The pattern is correct — you should NOT re-attach listeners inside effects. But it creates a trap: any data the listener needs must either live on the DOM (data attributes) or in a mutable reference that the effect updates. The reference docs warn against replacing innerHTML and re-attaching listeners in effects, but don't explicitly warn about stale closures in the listeners themselves. This is the most likely class of bug an AI or developer will introduce when following the pattern.

**Recommendation:** The client docs should add a callout:

> **Closure trap:** Event listeners wired in `connectedCallback` capture variables from their creation scope. If an effect updates data that a listener depends on, store the current value as a `data-*` attribute and read it in the handler. Never rely on loop variables or object references that the effect will replace.

This bug was not caught by integration tests (which test the API layer, not click interactions) or by the initial UX walkthrough (which only tested one status transition). It required a second click on the same button to manifest.

## Summary of Friction Points

| Issue | Severity | Suggestion |
|-------|----------|------------|
| Stale closures in event listeners wired outside effects | **High** | Add explicit warning in client docs about reading mutable state from DOM, not closures |
| Nested notify paths (`parent_ids`) require deep understanding of merge protocol | Medium | Add a visual diagram or step-by-step trace of how a nested notify is merged |
| Component list reconciliation is verbose (~40 lines per list) | Low | Consider a small `reconcile(container, items, keyFn, createFn, updateFn)` utility |
| Enrichment duplication risk (every mutation must build full doc shape) | Medium | The `_enrich_*` helper pattern solves it, but it's not mentioned until the implementation skill |
| `doc_id: 0` for collections vs entity id for entity docs | Medium | Add a prominent callout box in the database docs |
| Test data pollution across test cases | Low | Recommend create-and-cleanup pattern in testing docs |
| Permission paths don't cover create-time ownership checks | Low | Document that create mutations verify ownership via FK lookups, not the permission path DSL |
| Batch CLI operations are fragile via shell chaining | Low | Add `bun model bulk-update check --checklist "X" --confirmed 3` or similar |

## Summary of Strengths

| Strength | Impact |
|----------|--------|
| Decomposition order prevents premature implementation | High — keeps modeling focused |
| Spec export creates a clean contract between model and code | High — mechanical translation |
| Reactive pipeline (notify → merge → effect) is invisible to components | High — no manual refresh logic |
| Coalescing upsert by natural key enables iterative refinement | Medium — no fear of duplicates |
| Reference docs are comprehensive and internally consistent | High — every question has an answer |
| Checklist-driven testing ensures complete coverage | High — no guessing what to test |
| `_` prefix convention blocks internal functions from client | Medium — simple and effective |
| Integration test helpers (`ws()`, `login()`) are ready-made | Medium — fast test authoring |

## Conclusion

The Simple framework's model-to-implement workflow is remarkably effective for CRUD-with-realtime apps. The modeling phase forces rigorous domain decomposition before any code is written. The implementation phase is largely mechanical — translating a well-structured spec into SQL and components following documented patterns. The testing phase maps directly to modeled checklists, ensuring complete coverage.

The main complexity lives in the notify/merge protocol for nested collections. Once understood, it's consistent and predictable, but it has the steepest learning curve in the framework. The component reconciliation pattern is correct but verbose — it's the main area where a small abstraction could reduce boilerplate without sacrificing the atomic-update philosophy.

For an AI agent, this workflow is near-ideal: structured input (spec.md), rigid patterns (four-step mutations, doc function conventions), clear verification (tests + checklists). The framework minimizes ambiguity and maximizes mechanical transformation — exactly the conditions where AI code generation is most reliable.
