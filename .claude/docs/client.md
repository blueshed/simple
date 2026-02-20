# Client (`session.ts` + `signals.ts`)

Zero-dependency browser client. No framework, no bundler — Bun serves TypeScript directly from `index.html`.

## Session (`session.ts`)

### Auth Lifecycle

```typescript
import { auth, getToken, logout, TOKEN_KEY } from "./session";

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
import { initSession, getSession, clearSession } from "./session";

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
import { signal, effect } from "./signals";
import { initSession, clearSession, getToken } from "./session";

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
  api:      Proxy            // call any postgres function: api.save_thing(1, "name")
  status:   Signal<string>  // "connected" | "connecting..." | "disconnected"
  profile:  Signal<unknown> // your profileFn result, null until received
  openDoc:  (fn, id, data) => Signal  // subscribe to a document
  closeDoc: (fn, id) => void          // unsubscribe
}
```

**Send queue**: messages sent before the WebSocket is open are buffered and flushed in `onopen`. This means `openDoc` can be called immediately in `connectedCallback` without waiting.

**Reconnect**: exponential backoff on close, max 30s.

**Token errors**: close code `4001` (invalid token) or `1006` before profile arrives clears the stored token and navigates to `/` instead of retrying.

### `openDoc(fn, id, data)`

```typescript
const doc = openDoc("thing_doc", id, null);
// doc.get() === null until the server sends the initial op:"set" response
// then reflects live updates as notifies arrive

closeDoc("thing_doc", id);  // stop receiving updates — call in disconnectedCallback
```

The server sends `{ type: "notify", op: "set", data: <full doc> }` immediately on open. The client sets the signal directly from that — no initial fetch needed.

### `_error` sentinel

If a doc open fails (e.g. permission denied), the server sends `{ type: "error", fn, doc_id, error }`. The client sets the signal to `{ _error: "permission denied" }`. Components must check for this before accessing doc fields:

```typescript
const d = doc.get() as any;
if (!d) return;
if (d._error) {
  content.innerHTML = `<p style="color:var(--danger)">${d._error}</p>`;
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
3. `collection === null` — root entity changed: spread new fields onto root
4. `collection = "things"` — find item in array by `id`, splice or upsert
5. `collection = "a.b.c"` — walk each intermediate segment using `parent_ids[i]`, then splice or upsert in the final array. `parent_ids` has one entry per intermediate segment (all but the last).

For collection documents (where the root key IS the collection, e.g. `{posts: [...]}` with `collection: "posts"`), the merge navigates from the doc root. For entity documents (e.g. `{post: {..., post_tags: []}}` with `collection: "post_tags"`), it navigates from the root entity.

**Important**: collection upserts replace the entire item by `id`. The notify data must include nested objects (belongs-to joins, child arrays) matching the doc shape — `row_to_json(v_row)` alone loses them. See `.claude/docs/database.md` for the data shape guidance.

## Signals (`signals.ts`)

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

## Web Components

App code lives in `components/`. Each component is a custom element using `connectedCallback` and `disconnectedCallback` to wire and clean up effects.

Pattern:

```typescript
import { getSession } from "../session";
import { effect } from "../signals";

class MyThing extends HTMLElement {
  private disposers: (() => void)[] = [];

  connectedCallback() {
    const id = Number(this.getAttribute("id"));
    const { api, status, openDoc } = getSession();

    this.innerHTML = `
      <div id="conn-status"></div>
      <div id="content"><p>Loading…</p></div>
    `;

    // Effect 1: connection status
    this.disposers.push(effect(() => {
      const el = this.querySelector("#conn-status");
      if (el) el.textContent = status.get() ?? "connected";
    }));

    // Effect 2: doc render
    const doc = openDoc("thing_doc", id, null);
    this.disposers.push(effect(() => {
      const d = doc.get() as any;
      if (!d) return;
      if (d._error) {
        this.querySelector("#content")!.innerHTML =
          `<p style="color:var(--danger)">${d._error}</p>`;
        return;
      }
      const thing = d.thing_doc;
      this.querySelector("#content")!.innerHTML = `<p>${thing.name}</p>`;
    }));
  }

  disconnectedCallback() {
    this.disposers.forEach(d => d());
    this.disposers = [];
    getSession().closeDoc("thing_doc", Number(this.getAttribute("id")));
  }
}
customElements.define("my-thing", MyThing);
```

Key rules:
- Always call `getSession()` — never `connect(token)` directly
- Always handle `!d` (null, pre-arrival) and `d._error` before accessing doc fields
- Always call `closeDoc` in `disconnectedCallback`
- `openDoc` is safe to call immediately — messages are queued until WS is open
