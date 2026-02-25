/**
 * Signals — Lightweight reactive primitives
 *
 * A standalone reactive system with no framework or DOM dependencies.
 *
 * Core API:
 *   signal<T>(value)        — create a mutable reactive value
 *   computed<T>(fn)         — derive a read-only signal from other signals
 *   effect(fn)              — run a side-effect whenever its dependencies change
 *   batch(fn)               — group multiple updates into a single flush
 *   route<T>(pattern)       — reactive hash route: Signal<T | null>, null when unmatched
 *   routes(target, table)   — hash router: maps patterns to handlers, swaps target content
 *   navigate(path)          — set location.hash programmatically
 *
 * Routing:
 *   route(pattern) returns a Signal that is null when unmatched, or a params object
 *   when the hash matches. Patterns use :param segments: "/site/:id" extracts { id }.
 *   All route() calls share one hashchange listener (lazy singleton).
 *
 *   routes(target, table) is a declarative router — Bun.serve style:
 *     routes(app, {
 *       "/":          () => dashboard(app),
 *       "/site/:id":  ({ id }) => siteDetail(app, id),
 *     });
 *   On hash change, clears target and calls the matching handler with extracted params.
 *   Returns a dispose function to tear down the effect and listener.
 *
 *   Handlers may return a value to control rendering:
 *     - string:   used as target.innerHTML (markup for the route)
 *     - function: update callback, called on param change without remount
 *     - void:     handler manages the DOM itself (e.g. appendChild)
 *
 *   Return a string for simple routes:
 *     routes(app, {
 *       "/": () => "<x-counter></x-counter>",
 *     });
 *
 *   Return an update callback for routes with params that change without remount:
 *     routes(app, {
 *       "/room/:id": ({ id }) => {
 *         mountChat(app);
 *         return ({ id }) => selectRoom(id);  // called on param change
 *       },
 *     });
 *
 * Signal<T> methods:
 *   .get()                  — read value (tracks dependency when inside effect/computed)
 *   .set(value)             — write value (notifies listeners if changed via Object.is)
 *   .update(fn)             — set via transform: s.update(v => v + 1)
 *   .peek()                 — read value without tracking
 *
 * Dependency tracking:
 *   Effects automatically track which signals are read during execution.
 *   On re-run, stale subscriptions are removed and new ones added.
 *   effect() returns a dispose function that unsubscribes from all deps.
 *
 * Dispose pattern:
 *   effect() can return a cleanup function, called before each re-run and on dispose.
 *   Components should collect dispose functions and return a combined Dispose.
 */

type Listener = () => void;

// Global tracking for effect dependencies
let currentListener: Listener | null = null;
let currentDeps: Set<Signal<any>> | null = null;
let batchDepth = 0;
const pendingEffects = new Set<Listener>();

// Infinite loop guard
let effectDepth = 0;
const MAX_EFFECT_DEPTH = 100;

// === Signal<T> ===

export class Signal<T> {
  private value: T;
  private listeners = new Set<Listener>();

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  get(): T {
    if (currentListener) this.listeners.add(currentListener);
    if (currentDeps) currentDeps.add(this);
    return this.value;
  }

  set(newValue: T): void {
    if (!Object.is(this.value, newValue)) {
      this.value = newValue;
      this.notify();
    }
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.value));
  }

  peek(): T {
    return this.value;
  }

  private notify(): void {
    if (batchDepth > 0) {
      for (const listener of this.listeners) pendingEffects.add(listener);
      return;
    }
    effectDepth++;
    try {
      if (effectDepth > MAX_EFFECT_DEPTH) {
        throw new Error(
          "Maximum effect depth exceeded — possible infinite loop",
        );
      }
      for (const listener of this.listeners) listener();
    } finally {
      effectDepth--;
    }
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }
}

// === effect() ===

export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: (() => void) | void;
  let deps = new Set<Signal<any>>();

  const execute = () => {
    if (cleanup) cleanup();

    const prevListener = currentListener;
    const prevDeps = currentDeps;
    const nextDeps = new Set<Signal<any>>();
    currentListener = execute;
    currentDeps = nextDeps;

    try {
      cleanup = fn();
    } finally {
      currentListener = prevListener;
      currentDeps = prevDeps;
    }

    // Unsubscribe from signals no longer read
    for (const dep of deps) {
      if (!nextDeps.has(dep)) dep.unsubscribe(execute);
    }
    deps = nextDeps;
  };

  execute();

  return () => {
    if (cleanup) cleanup();
    for (const dep of deps) dep.unsubscribe(execute);
    deps.clear();
  };
}

// === computed() ===

export function computed<T>(fn: () => T): Signal<T> {
  // effect() runs fn synchronously, so s is initialized before computed() returns.
  // We use null as a temporary placeholder that is immediately overwritten.
  let s: Signal<T>;
  effect(() => {
    const value = fn();
    if (s) s.set(value);
    else s = new Signal<T>(value);
  });
  return s!;
}

// === batch() ===

let flushing = false;

export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && !flushing) {
      flushing = true;
      try {
        while (pendingEffects.size > 0) {
          const effects = [...pendingEffects];
          pendingEffects.clear();
          for (const e of effects) e();
        }
      } finally {
        flushing = false;
      }
    }
  }
}

// === Convenience factory ===

export function signal<T>(initialValue: T): Signal<T> {
  return new Signal(initialValue);
}

// === Dispose type ===

export type Dispose = () => void;

// === route() ===

let hashSignal: Signal<string> | null = null;

function getHash(): Signal<string> {
  if (!hashSignal) {
    hashSignal = new Signal(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", () => {
      hashSignal!.set(location.hash.slice(1) || "/");
    });
  }
  return hashSignal;
}

export function matchRoute(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const pp = pattern.split("/");
  const hp = path.split("/");
  if (pp.length !== hp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i]!.startsWith(":")) {
      try {
        params[pp[i]!.slice(1)] = decodeURIComponent(hp[i]!);
      } catch {
        return null;
      }
    } else if (pp[i] !== hp[i]) return null;
  }
  return params;
}

export function route<
  T extends Record<string, string> = Record<string, string>,
>(pattern: string): Signal<T | null> {
  const hash = getHash();
  return computed(() => matchRoute(pattern, hash.get()) as T | null);
}

export function navigate(path: string): void {
  location.hash = path;
}

type RouteHandler = (
  params: Record<string, string>,
) => void | string | ((params: Record<string, string>) => void);

export function routes(
  target: HTMLElement,
  table: Record<string, RouteHandler>,
): Dispose {
  const hash = getHash();
  let activePattern: string | null = null;
  let activeUpdate: ((params: Record<string, string>) => void) | null = null;

  return effect(() => {
    const path = hash.get();
    for (const [pattern, handler] of Object.entries(table)) {
      const params = matchRoute(pattern, path);
      if (params) {
        try {
          if (pattern === activePattern && activeUpdate) {
            // Same pattern, different params — update without remount
            activeUpdate(params);
          } else {
            // New pattern — tear down and mount
            target.innerHTML = "";
            activePattern = pattern;
            const result = handler(params);
            if (typeof result === "string") {
              target.innerHTML = result;
            }
            activeUpdate = typeof result === "function" ? result : null;
          }
        } catch (e) {
          console.error(`Route error [${pattern}]:`, e);
          target.innerHTML = "";
          activePattern = null;
          activeUpdate = null;
        }
        return;
      }
    }
    // No match — clear
    target.innerHTML = "";
    activePattern = null;
    activeUpdate = null;
  });
}
