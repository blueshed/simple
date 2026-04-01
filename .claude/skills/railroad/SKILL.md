---
name: railroad
description: "Railroad — micro reactive UI framework for Bun. Use when writing JSX components with signals, routes, when(), list(), or importing @blueshed/railroad."
---

Micro reactive UI framework for Bun. ~900 lines, zero dependencies, real DOM.

**Read the source files for full API detail** — each has a JSDoc header:
`signals.ts` · `jsx.ts` · `routes.ts` · `shared.ts` · `logger.ts`

## Setup

```json
// tsconfig.json
{ "jsx": "react-jsx", "jsxImportSource": "@blueshed/railroad" }
```

## Mental Model

Components run **once**. They return real DOM nodes. Reactivity comes from signals — not re-rendering. Effects and computeds auto-dispose when their parent scope (component, route, `when`, `list`) tears down.

```tsx
// Bare signal — auto-reactive
<span>{count}</span>

// Function child — auto-reactive expression
<span>{() => count.get() > 5 ? "High" : "Low"}</span>

// Signal.map() — derive a signal for attributes and list items
<input disabled={count.map(n => n > 10)} />
{list(todos, t => t.id, (todo$) => <li>{todo$.map(t => t.name)}</li>)}
```

## Key Patterns

```tsx
// Reactive attributes — .map() or computed()
<div class={visible.map(v => v ? "show" : "hide")}>...</div>

// Keyed list — render gets Signal<T>, use .map() for content
{list(todos, t => t.id, (todo$, idx$) => (
  <li class={idx$.map(i => i % 2 ? "odd" : "even")}>
    {todo$.map(t => t.name)}
  </li>
))}

// Nested routes — wildcard keeps layout mounted, route() for sub-navigation
routes(app, { "/sites/*": () => <SitesLayout /> });
function SitesLayout() {
  const detail = route<{ id: string }>("/sites/:id");
  return when(() => detail.get(), () => <SiteDetail />, () => <SitesList />);
}
```

## Anti-Patterns

1. **No React.** No useState, useEffect, hooks, lifecycle methods, or react imports.
2. **No `.get()` in JSX children.** `{count}` or `{() => count.get() + 1}` — never `{count.get()}`.
3. **No shared DOM nodes across `when()` branches.** Create nodes fresh inside each branch.
4. **No `transition-all` in CSS** near layout boundaries. Use specific properties.
