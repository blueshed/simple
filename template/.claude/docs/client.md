# Client (`session.ts` + `signals.ts`)

Zero-dependency browser client. No framework, no bundler — Bun serves TypeScript directly from `index.html`.

## Session (`session.ts`)

### `auth(fn, args)`

HTTP POST to `/auth` for pre-auth calls (login, register). Returns the server response data.

### `connect(token)`

Establishes a WebSocket session. Returns:

```typescript
{
  api:      Proxy                          // call any postgres function: api.save_thing(1, "name")
  status:   Signal<string>                // "connected" | "connecting" | "disconnected"
  profile:  Signal<unknown>              // your profileFn result
  openDoc:  (fn, id, data) => Signal     // subscribe to a document
  closeDoc: (fn, id) => void             // unsubscribe
}
```

Reconnects automatically on disconnect (exponential backoff, max 30s).

### `openDoc(fn, id, data)`

```typescript
const data = await api.thing_doc(1);
const doc = openDoc("thing_doc", 1, data);  // Signal — live updates
// doc.get() always reflects the latest server state

closeDoc("thing_doc", 1);  // stop receiving updates
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
2. `collection === null` — root entity changed: spread new fields onto root
3. `collection = "things"` — find item in array by `id`, splice or upsert
4. `collection = "parent.children"` — navigate to parent via `parent_id`, then splice or upsert in nested array

No re-fetch needed — the notify payload carries the row (or `{ id }` for removes).

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

## Web Components

App code lives in `components/`. Each component is a custom element using `connectedCallback` and `disconnectedCallback` to wire and clean up effects.

Pattern:

```typescript
class MyComponent extends HTMLElement {
  private disposers: (() => void)[] = [];

  async connectedCallback() {
    const { api, profile, openDoc } = await connect(this.getAttribute("token")!);
    const doc = openDoc("thing_doc", 1, await api.thing_doc(1));

    this.disposers.push(effect(() => {
      const d = doc.get() as any;
      this.innerHTML = `<p>${d?.thing?.name}</p>`;
    }));
  }

  disconnectedCallback() {
    this.disposers.forEach(d => d());
  }
}
customElements.define("my-component", MyComponent);
```
