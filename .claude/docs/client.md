# Client (`lib/session.ts` + `lib/signals.ts`)

Zero-dependency browser client. No framework, no bundler — Bun serves TypeScript directly from `index.html`.

## Session (`lib/session.ts`)

### Auth Lifecycle

```typescript
import { auth, getToken, logout, TOKEN_KEY } from "./lib/session";

// TOKEN_KEY — namespaced sessionStorage key (e.g. "myapp:token", substituted by setup.ts)

await auth("login", [email, password]);    // POST /auth, stores token in sessionStorage
await auth("register", [name, email, pw]); // same for register

getToken();   // returns stored token or null
logout();     // clears token, navigates to "/"
```

### `auth(fn, args)`

HTTP POST to `/auth` for pre-auth calls (login, register). Stores the token in `sessionStorage` and returns `{ token, profile }`.

### Session Singleton

There is **one WebSocket per app**, shared by all components. Never call `connect()` directly from a component.

```typescript
import { initSession, getSession, clearSession } from "./lib/session";

// In app.ts — once after login:
const session = initSession(token);

// In any component:
const { api, status, profile, openDoc, closeDoc } = getSession();

// On logout:
clearSession();
```

`getSession()` throws if called before `initSession()`. Gate component mounting behind the session being ready (see Boot Sequence below).

### Boot Sequence

Components must not mount until the WebSocket is open **and** the profile has arrived. Wire this in `app.ts` using a `sessionReady` signal:

```typescript
import { signal, effect } from "./lib/signals";
import { initSession, clearSession, getToken } from "./lib/session";

const sessionReady = signal(false);

function bootSession(token: string): void {
  clearSession();
  sessionReady.set(false);
  const session = initSession(token);
  let fired = false;
  effect(() => {
    if (session.profile.get() && !fired) {
      fired = true;
      sessionReady.set(true);
    }
  });
}

// In the route handler, gate on sessionReady:
function authRoute(mount: () => void): void {
  if (!sessionReady.get()) {
    if (!getToken()) { location.hash = "/"; return; }
    app.innerHTML = `<p>Connecting…</p>`;
    return;
  }
  mount();
}
```

Because `sessionReady.get()` is read inside the `routes()` effect, the router automatically re-renders when the session becomes ready — no manual wiring needed.

Call `bootSession(token)` immediately on load if a stored token exists, so that reloading at a deep route works without redirecting home first:

```typescript
const existingToken = getToken();
if (existingToken) bootSession(existingToken);

routes(app, {
  "/":     () => { /* mount login */ },
  "/home": () => authRoute(() => { /* mount home */ }),
  "/thing/:id": () => authRoute(() => { /* mount thing */ }),
});
```

### `connect(token)` internals

Establishes a WebSocket session. Returns:

```typescript
{
  api:        Proxy            // call any postgres function: api.save_thing(1, "name")
  status:     Signal<string>   // "connected" | "connecting..." | "disconnected"
  profile:    Signal<unknown>  // your profileFn result, null until received
  openDoc:    (fn, id, data, opts?) => Signal  // subscribe to a document
  closeDoc:   (fn, id) => void           // unsubscribe
  docCursor:  (fn, id) => Signal<string | null>  // current cursor for a doc
  docHasMore: (fn, id) => Signal<boolean>        // whether more pages exist
  loadMore:   (fn, id, limit?) => Promise        // fetch next page
}
```

**Send queue**: messages sent before the WebSocket is open are buffered and flushed in `onopen`. This means `openDoc` can be called immediately in `connectedCallback` without waiting.

**Reconnect**: exponential backoff on close, max 30s.

**Token errors**: close code `4001` (invalid token) or `1006` before profile arrives clears the stored token and navigates to `/` instead of retrying.

### `openDoc(fn, id, data, opts?)`

```typescript
const doc = openDoc("thing_doc", id, null);
// doc.get() === null until the server sends the initial op:"set" response
// then reflects live updates as notifies arrive

closeDoc("thing_doc", id);  // stop receiving updates — call in disconnectedCallback
```

The server sends `{ type: "notify", op: "set", data: <full doc> }` immediately on open. The client sets the signal directly from that — no initial fetch needed.

#### Cursor/stream options

For paginated documents, pass an options object:

```typescript
// Cursor mode — loads first page, use loadMore() for subsequent pages
const doc = openDoc("post_feed", 0, null, { limit: 25 });

// Stream mode — server auto-sends all pages as op:"append" after the first
const doc = openDoc("post_feed", 0, null, { limit: 25, stream: true });
```

#### `docCursor(fn, id)` / `docHasMore(fn, id)`

Reactive signals tracking pagination state for an open doc:

```typescript
const { openDoc, docCursor, docHasMore, loadMore } = getSession();

const doc = openDoc("post_feed", 0, null, { limit: 25 });
const cursor = docCursor("post_feed", 0);
const hasMore = docHasMore("post_feed", 0);

// In an effect:
if (hasMore.get()) {
  showLoadMoreButton();
}
```

#### `loadMore(fn, id, limit?)`

Fetches the next page using the stored cursor. Returns a promise with `{ data, cursor, hasMore }`. The data is automatically merged into the existing doc signal via `op: "append"`.

```typescript
const btn = this.querySelector("#load-more")!;
btn.addEventListener("click", () => loadMore("post_feed", 0, 25));
```

### `_error` sentinel

If a doc open fails (e.g. permission denied), the server sends `{ type: "error", fn, doc_id, error }`. The client sets the signal to `{ _error: "permission denied" }`. Components must check for this before accessing doc fields:

```typescript
const d = doc.get() as any;
if (!d) return;
if (d._error) {
  content.innerHTML = `<p style="color:var(--danger)">${d._error}</p>`;
  return;
}
if (d._removed) {
  // Root entity was deleted — navigate away
  location.hash = "/home";
  return;
}
const thing = d.thing_doc;
```

### `api` proxy

```typescript
api.save_thing(42, null, "My Thing")
// sends: { id, fn: "save_thing", args: [42, null, "My Thing"] }
// returns: Promise resolving to server response
```

Any property access on `api` returns a function. Names are validated by postgres at call time.

### Document Merging

When a `notify` event arrives, `merge()` routes it to the matching signal:

1. Look up `"${doc}:${doc_id}"` — skip if not open
2. `op === "set"` — full doc received on open: `s.set(data)` directly
3. `op === "append"` — cursor/stream page: push items onto collection arrays, dedup by `id`
4. `collection === null` — root entity changed: spread new fields onto root
5. `collection = "things"` — find item in array by `id`, splice or upsert
6. `collection = "a.b.c"` — walk each intermediate segment using `parent_ids[i]`, then splice or upsert in the final array. `parent_ids` has one entry per intermediate segment (all but the last).

For collection documents (where the root key IS the collection, e.g. `{posts: [...]}` with `collection: "posts"`), the merge navigates from the doc root. For entity documents (e.g. `{post: {..., post_tags: []}}` with `collection: "post_tags"`), it navigates from the root entity.

**Important**: collection upserts replace the entire item by `id`. The notify data must include nested objects (belongs-to joins, child arrays) matching the doc shape — `row_to_json(v_row)` alone loses them. See `.claude/docs/database.md` for the data shape guidance.

#### `op: "append"` (cursor/stream)

Used by cursor pagination and streaming. The data has the same shape as the doc (matching the `op: "set"` shape). Items are pushed onto collection arrays, skipping duplicates by `id`. This handles:
- Streaming pages arriving after the initial load
- `loadMore()` responses merged back into the signal
- Notifications for items that might overlap with a pending page load

## Signals (`lib/signals.ts`)

Custom reactive primitives — no external dependencies.

### `signal<T>(initial)`

```typescript
const count = signal(0);
count.get()           // read (tracked inside effects)
count.set(1)          // write
count.peek()          // read without tracking
count.update(n => n + 1)
```

### `effect(fn)`

Runs immediately, re-runs when dependencies change:

```typescript
const dispose = effect(() => {
  el.textContent = name.get();
  return () => { /* cleanup */ };
});
dispose();  // stop
```

### `computed(fn)`

Derived signal:

```typescript
const full = computed(() => `${first.get()} ${last.get()}`);
```

### `batch(fn)`

Defers effect notifications until the block completes:

```typescript
batch(() => { a.set(1); b.set(2); });  // effects run once
```

### Routing

```typescript
routes(app, {
  "/":     () => { /* mount login component */ },
  "/home": () => { /* mount home component */ },
});

navigate("/home");           // set location.hash
route("/thing/:id").get()   // { id: "42" } or null
```

The `routes()` call wraps all handlers in an `effect`. Any signal read inside a handler (e.g. `sessionReady.get()`) becomes a reactive dependency — the router re-runs automatically when it changes.

## Reactive Update Philosophy

Simple's architecture is designed for **atomic, targeted updates** — not brute-force re-renders:

```
mutation → pg_notify → merge into signal → effect re-runs → patch specific DOM nodes
```

When a mutation fires, the server sends only the changed data. The client merges it into the existing document signal (splice one item in an array, spread fields onto the root). The signal triggers effects, which should update **only the DOM nodes that changed**.

### Why this matters

- A user renames a room → the notify carries `{id: 5, name: "New Name"}` → merge spreads it onto the root → the effect updates the `<h1>` text. The message list, the member list, the input form — none of them re-render. They aren't touched.
- A new message arrives → the notify carries the message object → merge pushes it into the `messages` array → the effect appends one `<div>` to the list. Existing messages stay in the DOM untouched.

### Rules

1. **Never re-fetch after a mutation.** The notify/merge cycle handles it. Calling `closeDoc` + `openDoc` to "refresh" defeats the entire architecture.
2. **Never replace large DOM trees in effects.** An effect that sets `innerHTML` on a container destroys and recreates every child node — losing scroll position, focus, input state, and event listeners. Instead, patch individual elements: set `.textContent`, toggle classes, append/remove single nodes.
3. **Build the static shell once** in `connectedCallback`. Wire event listeners once. Effects only touch the parts that change when data changes.
4. **Use `batch()`** when setting multiple signals — effects run once at the end, not once per signal.

## Web Components

App code lives in `components/`. Each component is a custom element using `connectedCallback` and `disconnectedCallback` to wire and clean up effects.

### Pattern: entity document

```typescript
import { getSession } from "../lib/session";
import { effect } from "../lib/signals";

class AppThing extends HTMLElement {
  private disposers: (() => void)[] = [];

  connectedCallback() {
    const id = Number(this.getAttribute("thing-id"));
    const { api, status, openDoc } = getSession();

    // 1. Build the static shell ONCE — elements, forms, event listeners
    this.innerHTML = `
      <header>
        <h1 id="name"></h1>
        <span id="conn-status"></span>
      </header>
      <ul id="items"></ul>
      <form id="add-form"><input name="title" placeholder="New item…" /><button>Add</button></form>
    `;

    this.querySelector("#add-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = this.querySelector<HTMLInputElement>("input[name=title]")!;
      const title = input.value.trim();
      if (!title) return;
      input.value = "";
      await api.save_item(null, id, title);
      // No DOM update here — the notify/merge cycle handles it
    });

    // 2. Small, focused effects that patch individual DOM nodes

    this.disposers.push(effect(() => {
      this.querySelector("#conn-status")!.textContent = status.get() ?? "";
    }));

    const doc = openDoc("thing_doc", id, null);

    // 3. Render effect — update only what changed
    let prevItemIds: number[] = [];
    this.disposers.push(effect(() => {
      const d = doc.get() as any;
      if (!d) return;
      if (d._error) {
        this.querySelector("#name")!.textContent = "";
        this.querySelector("#items")!.innerHTML =
          `<li style="color:var(--danger)">${d._error}</li>`;
        return;
      }
      if (d._removed) { location.hash = "/home"; return; }

      const thing = d.thing_doc;

      // Patch the name — just set textContent, don't rebuild the header
      this.querySelector("#name")!.textContent = thing.name;

      // Patch the list — reconcile by id, don't replace innerHTML
      const ul = this.querySelector("#items")!;
      const currentIds = (thing.items ?? []).map((i: any) => i.id);

      // Remove items no longer present
      for (const id of prevItemIds) {
        if (!currentIds.includes(id)) ul.querySelector(`[data-id="${id}"]`)?.remove();
      }

      // Add or update items
      for (const item of thing.items ?? []) {
        let li = ul.querySelector(`[data-id="${item.id}"]`) as HTMLElement | null;
        if (!li) {
          li = document.createElement("li");
          li.setAttribute("data-id", String(item.id));
          ul.appendChild(li);
        }
        li.textContent = item.title;
      }

      prevItemIds = currentIds;
    }));
  }

  disconnectedCallback() {
    this.disposers.forEach(d => d());
    this.disposers = [];
    getSession().closeDoc("thing_doc", Number(this.getAttribute("thing-id")));
  }
}
customElements.define("app-thing", AppThing);
```

### Pattern: collection document

For list views, the same reconciliation approach applies — append new items, update changed items, remove deleted items:

```typescript
const doc = openDoc("thing_list", 0, null);
let prevIds: number[] = [];

this.disposers.push(effect(() => {
  const d = doc.get() as any;
  if (!d) return;

  const ul = this.querySelector("#list")!;
  const items = d.thing_list ?? [];
  const currentIds = items.map((i: any) => i.id);

  // Remove
  for (const id of prevIds) {
    if (!currentIds.includes(id)) ul.querySelector(`[data-id="${id}"]`)?.remove();
  }

  // Add or update
  for (const item of items) {
    let li = ul.querySelector(`[data-id="${item.id}"]`) as HTMLElement | null;
    if (!li) {
      li = document.createElement("li");
      li.setAttribute("data-id", String(item.id));
      li.innerHTML = `<a></a>`;
      ul.appendChild(li);
    }
    const a = li.querySelector("a")!;
    if (a.textContent !== item.name) a.textContent = item.name;
    if (a.getAttribute("href") !== `#/thing/${item.id}`) a.setAttribute("href", `#/thing/${item.id}`);
  }

  prevIds = currentIds;
}));
```

### Pattern: paginated collection (infinite scroll)

```typescript
const { openDoc, docHasMore, loadMore } = getSession();

const doc = openDoc("post_feed", 0, null, { limit: 25 });
const hasMore = docHasMore("post_feed", 0);

// Build shell with sentinel element
this.innerHTML = `<ul id="posts"></ul><div id="sentinel"></div>`;

// Intersection observer triggers loadMore when sentinel is visible
const sentinel = this.querySelector("#sentinel")!;
const observer = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && hasMore.peek()) {
    loadMore("post_feed", 0, 25);
  }
});
observer.observe(sentinel);

// Effect renders items (same reconciliation as collection doc)
this.disposers.push(effect(() => {
  const d = doc.get() as any;
  if (!d) return;
  const ul = this.querySelector("#posts")!;
  // ... reconcile items ...
}));

// Show/hide sentinel based on hasMore
this.disposers.push(effect(() => {
  sentinel.style.display = hasMore.get() ? "block" : "none";
}));
```

### Key rules

- Always call `getSession()` — never `connect(token)` directly
- Always handle `!d` (null, pre-arrival) and `d._error` before accessing doc fields
- Always call `closeDoc` in `disconnectedCallback`
- `openDoc` is safe to call immediately — messages are queued until WS is open
- **Never re-fetch a document after mutation** — the notify/merge handles it
- **Never replace innerHTML of a container in an effect** — patch individual nodes instead
- **Wire event listeners once** in `connectedCallback`, not inside effects
