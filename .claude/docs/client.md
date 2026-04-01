# Client (`lib/session.ts` + `@blueshed/railroad`)

Zero-dependency browser client. No framework, no bundler — Bun serves TypeScript directly from `index.html`.

## Session (`lib/session.ts`)

### Auth Lifecycle

```typescript
import { auth, getToken, logout, refreshAccessToken, TOKEN_KEY, REFRESH_KEY, EXPIRES_KEY } from "./lib/session";

// TOKEN_KEY — namespaced sessionStorage key (e.g. "myapp:token", set via RUNTIME_TOKEN_KEY in .env)
// REFRESH_KEY — TOKEN_KEY + ":refresh"
// EXPIRES_KEY — TOKEN_KEY + ":expires"

await auth("login", [email, password]);    // POST /auth, stores token + refreshToken + expiresIn
await auth("register", [name, email, pw]); // same for register

getToken();              // returns stored access token or null
refreshAccessToken();    // exchanges refresh token for new access token (returns token or null)
logout();                // revokes refresh tokens server-side, clears all stored tokens, navigates to "/"
```

### `auth(fn, args)`

HTTP POST to `/auth` for pre-auth calls (login, register, refresh_token). Stores the access token, refresh token, and expiry in `sessionStorage`. Returns `{ token, profile }`.

### `refreshAccessToken()`

Calls `refresh_token` via `/auth` using the stored refresh token. On success, stores the new access token, refresh token, and expiry. Returns the new token or `null` on failure. Refresh tokens are single-use (rotation) — the old one is revoked server-side.

### Session Singleton

There is **one WebSocket per app**, shared by all components. Never call `connect()` directly from a component.

```typescript
import { initSession, getSession, clearSession } from "./lib/session";

// In app.tsx — once after login:
const session = initSession(token);

// In any component:
const { api, status, profile, openDoc, closeDoc } = getSession();

// On logout:
clearSession();
```

`getSession()` throws if called before `initSession()`. Gate component mounting behind the session being ready (see Boot Sequence below).

### Boot Sequence

Components must not mount until the WebSocket is open **and** the profile has arrived. Wire this in `app.tsx` using a `sessionReady` signal:

```typescript
import { signal, effect } from "@blueshed/railroad";
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

**Token expiry**: the client schedules a refresh 5 minutes before the access token expires. On successful refresh, the WebSocket continues uninterrupted. If the refresh fails (e.g. refresh token expired after 7 days), the user is redirected to login.

**Token errors**: close code `4001` (invalid token) or `1006` before profile arrives triggers a refresh attempt first. If the refresh succeeds, reconnects with the new token. If it fails, clears all stored tokens and navigates to `/`.

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

## Signals (`@blueshed/railroad`)

Reactive primitives from the `@blueshed/railroad` package.

### `signal<T>(initial)`

```typescript
const count = signal(0);
count.get()                  // read (tracked inside effects)
count.set(1)                 // write
count.peek()                 // read without tracking
count.update(n => n + 1)     // set via transform
count.mutate(v => v.items.push(x))  // structuredClone, mutate in place, notify
count.patch({ name: "new" }) // shallow merge for object signals
count.map(n => `Count: ${n}`)       // derive a new signal
```

`.mutate(fn)` deep-clones the value, passes the clone to `fn`, then sets the result. Use it for in-place array/object mutations without manual spreading.

`.patch(partial)` shallow-merges `partial` onto the current value — shorthand for `s.set({ ...s.peek(), ...partial })`.

`.map(fn)` derives a new signal — like `computed()` but called on the source signal. Ideal for reactive attributes and keyed list item content: `item.map(i => i.name)`.

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

### Dispose Scopes

Manage cleanup for effects and computed signals created inside a component:

```typescript
import { pushDisposeScope, popDisposeScope } from "@blueshed/railroad";

pushDisposeScope();
// ... create effects, computed signals ...
const dispose = popDisposeScope();
// later:
dispose();  // cleans up everything created in the scope
```

The router uses dispose scopes automatically — route handlers are wrapped in a scope that cleans up when the route changes. You rarely need these directly, but they're available for advanced patterns.

### Routing

```typescript
routes(app, {
  "/":           () => <Home />,
  "/thing/:id":  ({ id }, params$) => <AppThing id={Number(id)} params$={params$} />,
  "/status":     async () => { const s = await loadData(); return <Status data={s} />; },
  "*":           () => <NotFound />,
});

navigate("/home");           // set location.hash
route("/thing/:id").get()   // { id: "42" } or null
```

Handlers receive `(params, params$)` — a plain object for destructuring plus a `Signal` that updates when params change within the same pattern (e.g. `/thing/1` → `/thing/2` updates `params$` without teardown).

Async handlers return `Promise<Node>` — the router waits for the promise before mounting.

The `routes()` call wraps all handlers in an `effect`. Any signal read inside a handler (e.g. `sessionReady.get()`) becomes a reactive dependency — the router re-runs automatically when it changes.

### Shared (Dependency Injection)

Typed provide/inject for sharing values across components without prop-threading:

```typescript
import { key, provide, inject, tryInject } from "@blueshed/railroad";

const STORE = key<MyStore>("store");
provide(STORE, createStore());     // in app.tsx or home component
const store = inject(STORE);       // anywhere — throws if not provided
const maybe = tryInject(STORE);    // returns undefined if not provided
```

### Logger

Colored, timestamped, level-gated console output for server-side code:

```typescript
import { createLogger, setLogLevel, loggedRequest } from "@blueshed/railroad";

const log = createLogger("[app]");
log.info("started");       // 12:34:56.789 INFO  [app] started
log.debug("tick");         // only shown when level is "debug"
setLogLevel("debug");      // "error" | "warn" | "info" | "debug"

// Wrap a route handler with access logging:
const handler = loggedRequest("[api]", myHandler);
```

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

## TSX Components

App code lives in `components/` as `.tsx` files. Components are functions that return JSX nodes. Railroad's JSX runtime handles reactive updates automatically via signals.

### Pattern: entity document

```tsx
import { getSession } from "../lib/session";
import { when, list, signal, navigate } from "@blueshed/railroad";

export function AppThing({ id }: { id: number }) {
  const { api, status, openDoc, closeDoc } = getSession();
  const doc = openDoc("thing_doc", id, null);

  return (
    <div ref={() => () => closeDoc("thing_doc", id)}>
      {when(
        () => {
          const d = doc.get() as any;
          return d && !d._error && !d._removed ? d : null;
        },
        () => {
          const d = doc.get() as any;
          const thing = d.thing_doc;
          return (
            <>
              <header>
                <h1>{() => (doc.get() as any)?.thing_doc?.name ?? ""}</h1>
                <span>{status}</span>
              </header>
              {list(
                signal(thing.items ?? []),
                (item: any) => item.id,
                (item) => <li>{item.map((i: any) => i.title)}</li>,
              )}
              <form onsubmit={async (e: Event) => {
                e.preventDefault();
                const input = (e.target as HTMLFormElement).elements.namedItem("title") as HTMLInputElement;
                const title = input.value.trim();
                if (!title) return;
                input.value = "";
                await api.save_item(null, id, title);
              }}>
                <input name="title" placeholder="New item\u2026" />
                <button>Add</button>
              </form>
            </>
          );
        },
        () => {
          const d = doc.get() as any;
          if (d?._removed) { navigate("/home"); return <></>; }
          if (d?._error) return <p style="color:var(--danger)">{d._error}</p>;
          return <p>Loading\u2026</p>;
        },
      )}
    </div>
  );
}
```

### Pattern: collection document

```tsx
import { getSession } from "../lib/session";
import { when, list, computed } from "@blueshed/railroad";

export function AppThingList() {
  const { openDoc, closeDoc } = getSession();
  const doc = openDoc("thing_list", 0, null);
  const items = computed(() => {
    const d = doc.get() as any;
    return d?.thing_list ?? [];
  });

  return (
    <div ref={() => () => closeDoc("thing_list", 0)}>
      <ul>
        {list(items, (i: any) => i.id, (item) => (
          <li>
            <a href={item.map((i: any) => `#/thing/${i.id}`)}>
              {item.map((i: any) => i.name)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Pattern: paginated collection (infinite scroll)

```tsx
import { getSession } from "../lib/session";
import { computed, list, when } from "@blueshed/railroad";

export function AppFeed() {
  const { openDoc, closeDoc, docHasMore, loadMore } = getSession();
  const doc = openDoc("post_feed", 0, null, { limit: 25 });
  const hasMore = docHasMore("post_feed", 0);
  const posts = computed(() => {
    const d = doc.get() as any;
    return d?.posts ?? [];
  });

  let sentinel: HTMLElement;

  const observer = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting && hasMore.peek()) {
      loadMore("post_feed", 0, 25);
    }
  });

  return (
    <div ref={(el: HTMLElement) => {
      // observe sentinel once mounted
      queueMicrotask(() => {
        if (sentinel) observer.observe(sentinel);
      });
      return () => { observer.disconnect(); closeDoc("post_feed", 0); };
    }}>
      <ul>
        {list(posts, (p: any) => p.id, (post) => (
          <li>{post.map((p: any) => p.title)}</li>
        ))}
      </ul>
      {when(hasMore, () => (
        <div ref={(el: HTMLElement) => { sentinel = el; }}>Loading more\u2026</div>
      ))}
    </div>
  );
}
```

### Key rules

- Components are **functions** returning JSX — no custom elements or lifecycle hooks
- Use `{() => expr}` for reactive text that depends on signals (function children)
- Use `.map(fn)` on signals for derived values in keyed list items and attributes
- Use `when(signal, truthy, falsy)` for conditional rendering
- Use `list(signal, keyFn, render)` for keyed lists — render receives `Signal<T>`, `Signal<number>`
- Use `list(signal, render)` for index-based lists — render receives raw `T`
- Use `ref={(el) => () => cleanup()}` for cleanup (the returned function runs on dispose)
- Always call `getSession()` — never `connect(token)` directly
- Always handle null/error states with `when()` before accessing doc fields
- `openDoc` is safe to call immediately — messages are queued until WS is open
- **Never re-fetch a document after mutation** — the notify/merge handles it

### Anti-patterns

1. **No React.** No useState, useEffect, hooks, lifecycle methods, or react imports.
2. **No `.get()` in JSX children.** `{count}` or `{() => count.get() + 1}` — never `{count.get()}`.
3. **No shared DOM nodes across `when()` branches.** Create nodes fresh inside each branch.
4. **No `transition-all` in CSS** near layout boundaries. Use specific properties.
