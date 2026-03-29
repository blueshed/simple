import { describe, test, expect } from "bun:test";
import { signal, effect, computed, batch, matchRoute, Signal } from "@blueshed/railroad";

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL
// ═══════════════════════════════════════════════════════════════════════════

describe("signal", () => {
  test("get returns initial value", () => {
    const s = signal(42);
    expect(s.get()).toBe(42);
  });

  test("set updates value", () => {
    const s = signal(1);
    s.set(2);
    expect(s.get()).toBe(2);
  });

  test("peek reads without tracking", () => {
    const s = signal(10);
    const runs: number[] = [];
    effect(() => {
      runs.push(s.peek());
    });
    expect(runs).toEqual([10]);
    s.set(20);
    // effect should NOT re-run — peek doesn't track
    expect(runs).toEqual([10]);
  });

  test("update transforms value", () => {
    const s = signal(5);
    s.update((v) => v * 2);
    expect(s.get()).toBe(10);
  });

  test("set with same value does not notify", () => {
    const s = signal(1);
    let runs = 0;
    effect(() => {
      s.get();
      runs++;
    });
    expect(runs).toBe(1);
    s.set(1); // same value
    expect(runs).toBe(1);
  });

  test("Object.is comparison for NaN", () => {
    const s = signal(NaN);
    let runs = 0;
    effect(() => {
      s.get();
      runs++;
    });
    expect(runs).toBe(1);
    s.set(NaN); // Object.is(NaN, NaN) is true
    expect(runs).toBe(1);
  });

  test("mutate clones and modifies in place", () => {
    const s = signal({ items: [1, 2, 3] });
    const original = s.peek();
    s.mutate((v) => v.items.push(4));
    expect(s.get().items).toEqual([1, 2, 3, 4]);
    // original is not mutated — structuredClone was used
    expect(original.items).toEqual([1, 2, 3]);
  });

  test("mutate notifies even when reference changes", () => {
    const s = signal({ count: 0 });
    let runs = 0;
    effect(() => {
      s.get();
      runs++;
    });
    expect(runs).toBe(1);
    s.mutate((v) => { v.count = 1; });
    expect(runs).toBe(2);
    expect(s.get().count).toBe(1);
  });

  test("patch shallow-merges onto object", () => {
    const s = signal({ name: "Alice", age: 30 });
    s.patch({ name: "Bob" });
    expect(s.get()).toEqual({ name: "Bob", age: 30 });
  });

  test("patch notifies listeners", () => {
    const s = signal({ x: 1, y: 2 });
    let runs = 0;
    effect(() => {
      s.get();
      runs++;
    });
    expect(runs).toBe(1);
    s.patch({ x: 10 });
    expect(runs).toBe(2);
    expect(s.get()).toEqual({ x: 10, y: 2 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EFFECT
// ═══════════════════════════════════════════════════════════════════════════

describe("effect", () => {
  test("runs immediately", () => {
    let ran = false;
    effect(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("re-runs when dependency changes", () => {
    const s = signal("hello");
    const values: string[] = [];
    effect(() => {
      values.push(s.get());
    });
    expect(values).toEqual(["hello"]);
    s.set("world");
    expect(values).toEqual(["hello", "world"]);
  });

  test("tracks multiple dependencies", () => {
    const a = signal(1);
    const b = signal(2);
    const sums: number[] = [];
    effect(() => {
      sums.push(a.get() + b.get());
    });
    expect(sums).toEqual([3]);
    a.set(10);
    expect(sums).toEqual([3, 12]);
    b.set(20);
    expect(sums).toEqual([3, 12, 30]);
  });

  test("dispose stops updates", () => {
    const s = signal(0);
    const values: number[] = [];
    const dispose = effect(() => {
      values.push(s.get());
    });
    expect(values).toEqual([0]);
    dispose();
    s.set(1);
    expect(values).toEqual([0]); // no re-run
  });

  test("cleanup function is called before re-run", () => {
    const s = signal(0);
    const log: string[] = [];
    effect(() => {
      const v = s.get();
      log.push(`run:${v}`);
      return () => log.push(`cleanup:${v}`);
    });
    expect(log).toEqual(["run:0"]);
    s.set(1);
    expect(log).toEqual(["run:0", "cleanup:0", "run:1"]);
  });

  test("cleanup on dispose", () => {
    const log: string[] = [];
    const dispose = effect(() => {
      log.push("run");
      return () => log.push("cleanup");
    });
    expect(log).toEqual(["run"]);
    dispose();
    expect(log).toEqual(["run", "cleanup"]);
  });

  test("dynamic dependency tracking", () => {
    const flag = signal(true);
    const a = signal("A");
    const b = signal("B");
    const values: string[] = [];
    effect(() => {
      values.push(flag.get() ? a.get() : b.get());
    });
    expect(values).toEqual(["A"]);
    b.set("B2"); // not tracked — flag is true
    expect(values).toEqual(["A"]);
    flag.set(false); // now tracks b, not a
    expect(values).toEqual(["A", "B2"]);
    a.set("A2"); // no longer tracked
    expect(values).toEqual(["A", "B2"]);
    b.set("B3"); // now tracked
    expect(values).toEqual(["A", "B2", "B3"]);
  });

  test("infinite loop detection", () => {
    const s = signal(0);
    expect(() => {
      effect(() => {
        s.set(s.get() + 1); // get() tracks, set() triggers re-run → infinite loop
      });
    }).toThrow("Maximum effect depth exceeded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTED
// ═══════════════════════════════════════════════════════════════════════════

describe("computed", () => {
  test("derives from signals", () => {
    const a = signal(2);
    const b = signal(3);
    const sum = computed(() => a.get() + b.get());
    expect(sum.get()).toBe(5);
  });

  test("updates when dependencies change", () => {
    const a = signal(1);
    const doubled = computed(() => a.get() * 2);
    expect(doubled.get()).toBe(2);
    a.set(5);
    expect(doubled.get()).toBe(10);
  });

  test("chains with other computed", () => {
    const base = signal(3);
    const doubled = computed(() => base.get() * 2);
    const plusOne = computed(() => doubled.get() + 1);
    expect(plusOne.get()).toBe(7);
    base.set(10);
    expect(plusOne.get()).toBe(21);
  });

  test("triggers effects", () => {
    const a = signal(1);
    const doubled = computed(() => a.get() * 2);
    const values: number[] = [];
    effect(() => {
      values.push(doubled.get());
    });
    expect(values).toEqual([2]);
    a.set(5);
    expect(values).toEqual([2, 10]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BATCH
// ═══════════════════════════════════════════════════════════════════════════

describe("batch", () => {
  test("defers effects until batch completes", () => {
    const a = signal(1);
    const b = signal(2);
    let runs = 0;
    effect(() => {
      a.get();
      b.get();
      runs++;
    });
    expect(runs).toBe(1);
    batch(() => {
      a.set(10);
      b.set(20);
    });
    // Effect should run once, not twice
    expect(runs).toBe(2);
  });

  test("nested batch only flushes at outermost", () => {
    const s = signal(0);
    let runs = 0;
    effect(() => {
      s.get();
      runs++;
    });
    expect(runs).toBe(1);
    batch(() => {
      s.set(1);
      batch(() => {
        s.set(2);
      });
      // inner batch exits but outer is still open — no flush yet
      expect(runs).toBe(1);
    });
    // outer batch exits — flush
    expect(runs).toBe(2);
    expect(s.get()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MATCH ROUTE
// ═══════════════════════════════════════════════════════════════════════════

describe("matchRoute", () => {
  test("exact match", () => {
    expect(matchRoute("/", "/")).toEqual({});
    expect(matchRoute("/home", "/home")).toEqual({});
  });

  test("no match", () => {
    expect(matchRoute("/home", "/about")).toBeNull();
    expect(matchRoute("/a/b", "/a")).toBeNull();
  });

  test("param extraction", () => {
    expect(matchRoute("/thing/:id", "/thing/42")).toEqual({ id: "42" });
    expect(matchRoute("/a/:x/b/:y", "/a/1/b/2")).toEqual({ x: "1", y: "2" });
  });

  test("encoded params", () => {
    expect(matchRoute("/thing/:name", "/thing/hello%20world")).toEqual({
      name: "hello world",
    });
  });

  test("different segment count", () => {
    expect(matchRoute("/a/b", "/a/b/c")).toBeNull();
  });
});
