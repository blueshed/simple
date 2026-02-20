# Modeling (`bun model`)

Domain modeling CLI powered by [Easy](https://github.com/blueshed/easy). Stores the design in SQLite (`model.db`) and generates specs for `/implement`.

> `bun model` resolves to `docker compose exec easy bun model` — it runs inside the Easy container. Requires `bun run up` first.

## Workflow

```
bun model ...  →  bun model export-spec > spec.md  →  /implement
```

1. Model stories, entities, documents, methods
2. Browse at http://localhost:8080 — diagrams, entity graphs, checklists
3. Export: `bun model export-spec > spec.md`
4. `/implement` reads spec.md and generates SQL, components, routing

## CLI Quick Reference

### Stories

```bash
bun model add-story <actor> <action> [description]
bun model remove-story <id>
bun model list-stories
```

### Entities and Fields

```bash
bun model add-entity <Name>
bun model add-field <Entity> <field> [type]
bun model remove-entity <Name>
bun model remove-field <Entity> <field>
```

### Relations

```bash
bun model add-relation <From> <To> [label] [cardinality]
bun model remove-relation <From> <To> [label]
```

Cardinality: `*` = has-many, `1` = belongs-to.

### Documents

```bash
bun model add-document <Name> <Entity> [--collection] [--public]
bun model remove-document <Name>
bun model list-documents
```

- `--collection` — list document (e.g. a feed), client opens with `openDoc("post_feed", 0)`
- `--public` — no auth required

### Expansions

```bash
bun model add-expansion <Document> <name> <Entity> <foreign_key> [--belongs-to] [--shallow] [--parent <name>]
bun model remove-expansion <Document> <name>
```

- Default: has-many (`jsonb_agg`)
- `--belongs-to`: single parent (`jsonb_build_object`)
- `--shallow`: fields only, no nested expansions
- `--parent <name>`: nest under an existing expansion

### Methods

```bash
bun model add-method <Entity> <name> [args_json] [return_type] [--no-auth] [--permission <perm>]
bun model remove-method <Entity> <name>
```

Args are JSON: `'[{"name":"body","type":"string"}]'`

### Publish

```bash
bun model add-publish <Entity.method> <property>
bun model remove-publish <Entity.method> <property>
```

Declares which fields a method changes — determines the `pg_notify` payload.

### Permissions

```bash
bun model add-permission <Entity.method> <path> [description]
bun model remove-permission <id>
```

Path syntax: `@field->table[filter]{temporal}.target_field`

- `@user_id` — direct ownership
- `@owner_id->acts_for[org_id=$]{active}.user_id` — org membership
- `[field=$]` matches current user, `[role='admin']` literal filter, `{active}` temporal

### Story Links

```bash
bun model link-story <story_id> <target_type> <target_name>
bun model unlink-story <story_id> <target_type> <target_name>
```

Target types: `entity`, `document`, `method`.

### Listing and Export

```bash
bun model list                # everything
bun model list-stories
bun model list-documents
bun model export-spec         # markdown spec to stdout
bun model export-spec > spec.md
```

### Batch

Pipe JSONL to run many commands at once:

```bash
cat <<'EOF' | bun model batch
["add-entity","Room"]
["add-field","Room","id","number"]
["add-field","Room","name","string"]
EOF
```

## Checklists

Checklists verify permission enforcement — that the right actors can call methods and the wrong actors are blocked.

### Why they exist

Permission checks live in postgres mutation functions. Checklists make them testable. Each check is a method call by a specific actor — CAN checks prove success, DENIED checks prove rejection.

### What NOT to put in checklists

- Don't restate that a method publishes a property (already on the method)
- Don't restate permission checks (already on the method)
- Ask: "Is this already expressed on a method?" If yes, skip it

### What TO put in checklists

- **Denied paths** — proving someone *can't* do something
- **Document-level behaviour** — what appears/disappears after an action
- **Sequenced flows** — ordered multi-step scenarios
- **Cross-cutting concerns** — behaviour spanning multiple methods

### CLI

```bash
bun model add-checklist <name> [description]
bun model remove-checklist <name>
bun model add-check <checklist> <actor> <Entity.method> [description] [--denied] [--after <check_id>]
bun model add-check-dep <check_id> <depends_on_id>
bun model confirm-check <check_id> --api|--ux
bun model unconfirm-check <check_id> --api|--ux
bun model list-checks [checklist]
```

### Example

```bash
bun model add-checklist "Venue Setup" "Owner creates and manages venue"

# CAN — correct actor succeeds
bun model add-check "Venue Setup" venue_owner "Venue.addArea" "Add an area"

# DENIED — wrong actor blocked
bun model add-check "Venue Setup" sponsor "Venue.addArea" "Sponsor cannot add area" --denied

# Dependency — check 3 requires check 2
bun model add-check-dep 3 2
```

### Confirming

Two channels: `--api` (WebSocket test) and `--ux` (browser test). Both must pass.

```bash
bun model confirm-check 1 --api
bun model confirm-check 1 --ux
bun model list-checks          # [A.] api only, [.U] ux only, [AU] both
```

## Account Entity

Simple's auth provides a `user` table (id, name, email). In the model, represent it as **Account**:

```bash
bun model add-entity Account
bun model add-field Account id number
bun model add-field Account name string
bun model add-field Account email string
```

`/implement` maps Account to the existing `user` table — no separate table created.

## Change Targets

`export-spec` shows **Changes** per entity — which documents and collection paths a mutation affects:

```
`venue_doc(venue_id)` → `areas`
`occasion_doc(occasion_id)` → `packages.allocations.options` [package_id, allocation_id]
`PostFeed(id)` (collection)
```

Each becomes a `pg_notify` target in the mutation function. The model site shows these on entity pages and the reverse (**Changed by**) on document pages.
