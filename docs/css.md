# CSS

Plain vanilla CSS with a token-based design system. No preprocessors, no frameworks, no CSS-in-JS. Single file: `styles.css`.

## Structure

The stylesheet is organized into sections:

1. **Reset** — universal box-sizing, margin, padding
2. **Tokens** — CSS custom properties in `:root` and `[data-theme="dark"]`
3. **Base** — body defaults
4. **Components** — element-level styles (fieldset, legend, label, input, button, pre)
5. **Utilities** — `.accent`, `.muted`
6. **Component overrides** — scoped to web component tag names (`app-login`, `app-home`)

## Tokens

All visual properties are defined as CSS custom properties. Theming is a matter of swapping values in `[data-theme="dark"]`.

### Colors

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--bg` | `#f8fafc` | `#0f172a` | Page background |
| `--fg` | `#1e293b` | `#e2e8f0` | Body text |
| `--fg-heading` | `#0f172a` | `#f8fafc` | Headings |
| `--fg-muted` | `#64748b` | `#94a3b8` | Secondary text, legends, labels |
| `--surface` | `#fff` | `#1e293b` | Card/fieldset background |
| `--surface-border` | `#e2e8f0` | `#334155` | Borders |
| `--surface-shadow` | subtle | deeper | Box shadow |
| `--primary` | `#0284c7` | `#38bdf8` | Primary actions |
| `--primary-hover` | `#0369a1` | `#7dd3fc` | Primary hover |
| `--primary-fg` | `#fff` | `#0f172a` | Text on primary |
| `--secondary` | `#e2e8f0` | `#334155` | Default buttons |
| `--secondary-hover` | `#cbd5e1` | `#475569` | Button hover |
| `--secondary-fg` | `#1e293b` | `#e2e8f0` | Text on secondary |
| `--accent` | `#0284c7` | `#38bdf8` | Emphasis |
| `--danger` | `#c00` | `#f87171` | Errors |

### Typography

| Token | Value | Usage |
|-------|-------|-------|
| `--font` | `system-ui, -apple-system, sans-serif` | All text |
| `--font-size-legend` | `0.75rem` | Legend text, small labels |
| `--font-size-sm` | `0.85rem` | Labels, buttons, secondary text |
| `--font-size-base` | `0.9rem` | Body text, inputs |
| `--font-size-lg` | `1.5rem` | Headings |

### Spacing

| Token | Value |
|-------|-------|
| `--space-xs` | `0.25rem` |
| `--space-sm` | `0.5rem` |
| `--space-md` | `0.75rem` |
| `--space-lg` | `1.5rem` |
| `--space-xl` | `3rem` |

### Other

| Token | Value | Purpose |
|-------|-------|---------|
| `--radius` | `6px` | Inputs, buttons, pre |
| `--radius-lg` | `10px` | Fieldsets |
| `--transition-fast` | `150ms` | Background color transitions |
| `--transition-snap` | `100ms` | Transform (button press) |

## Layout

- **Max-width 640px**, centered with `margin: auto`
- **Fieldsets** are the primary layout container — each section is a fieldset with legend
- **Flexbox** for inline layouts (connection bar, button groups)
- **No media queries** — responsive by being narrow and simple

## Theming

Light mode is the default (`:root`). Dark mode activates via `[data-theme="dark"]` on any ancestor element. JavaScript toggles the attribute; CSS variables do the rest.

Every color is a token. Components never use hardcoded colors — they reference `var(--token)`.

## Conventions

- **No class-based component styling** — element selectors (`fieldset`, `button`, `input`) define base appearance
- **Web component scoping** — overrides use tag name prefix: `app-login .error`, `app-home .status`
- **No BEM, no utility classes** (beyond `.accent` and `.muted`)
- **Semantic HTML** — fieldsets with legends, labels with inputs, buttons with no extra wrappers
- **Micro-interactions** — `scale(0.96)` on button active, smooth hover transitions

## Adding a New Component

1. Style base elements (fieldset, button, input, etc.) — they inherit tokens automatically
2. If component-specific overrides are needed, add a section at the bottom scoped to the tag name:
   ```css
   /* === app-widget === */
   app-widget .special { color: var(--accent); }
   ```
3. Use tokens for all colors, spacing, and radii — never hardcode values
4. Use `--secondary` for default buttons, `--primary` for call-to-action buttons
