# Modeling (`bun model`)

Domain modeling CLI powered by [Easy](https://github.com/blueshed/easy). Stores the design in SQLite (`model.db`) and generates specs for `/implement`.

> `bun model` resolves to `docker compose exec easy bun model` — it runs inside the Easy container. Requires `bun run up` first.

## Workflow

```
bun model ...  →  bun model export > spec.md  →  /implement
```

1. Model stories, entities, documents, methods
2. Browse at http://localhost:8080 — diagrams, entity graphs, checklists
3. Export: `bun model export > spec.md`
4. `/implement` reads spec.md and generates SQL, components, routing

## CLI Quick Reference

The CLI has **8 commands** operating on **13 schemas**. All data is passed as JSON objects. Save uses coalescing upsert by natural key.

```
bun model save <schema> '<json>'       Upsert by natural key
bun model delete <schema> '<json>'     Remove by natural key
bun model list [schema]                List all, or items of a type
bun model get <schema> <key>           Get one item as JSON
bun model export                       Markdown spec to stdout
bun model doctor [--fix]               Report/repair orphans
bun model batch                        JSONL from stdin
bun model import <file.yml|json>       Import YAML or JSON file
```

### Stories

```bash
bun model save story '{"actor":"visitor","action":"browse available rooms"}'
bun model save story '{"actor":"member","action":"send a message in a room","description":"Member must have joined the room first"}'
bun model list story
```

### Entities and Fields

```bash
# Entity with inline fields
bun model save entity '{"name":"Room","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"}]}'

# Add a field separately
bun model save field '{"entity":"Room","name":"created_at","type":"string"}'

# Delete
bun model delete entity '{"name":"Room"}'
bun model delete field '{"entity":"Room","name":"created_at"}'
```

### Relations

```bash
# has-many (cardinality "*", the default)
bun model save relation '{"from":"Room","to":"Message","label":"messages"}'

# belongs-to (cardinality "1")
bun model save relation '{"from":"Message","to":"Account","label":"sender","cardinality":"1"}'

bun model delete relation '{"from":"Room","to":"Message","label":"messages"}'
```

### Documents

```bash
bun model save document '{"name":"RoomDoc","entity":"Room"}'
bun model save document '{"name":"RoomList","entity":"Room","collection":true,"public":true}'
bun model save document '{"name":"MessageFeed","entity":"Message","fetch":"cursor","description":"Paginated message history"}'
bun model list document
bun model delete document '{"name":"RoomDoc"}'
```

- `collection: true` — list document, client opens with `openDoc("room_list", 0)`
- `public: true` — no auth required
- `fetch: "cursor"` — paginated: doc function accepts cursor/limit, client uses `loadMore()`
- `fetch: "stream"` — streaming: server auto-sends all pages after initial load

The fetch mode appears on the model site's document page and in `export` output. `/implement` uses it to generate the appropriate doc function and client wiring.

### Expansions

```bash
# has-many (default)
bun model save expansion '{"document":"RoomDoc","name":"messages","entity":"Message","foreign_key":"room_id"}'

# belongs-to — single parent row
bun model save expansion '{"document":"RoomDoc","name":"sender","entity":"Account","foreign_key":"sender_id","belongs_to":true,"parent":"messages"}'

# shallow — fields only, no nested expansions
bun model save expansion '{"document":"VenueDoc","name":"occasions","entity":"Occasion","foreign_key":"venue_id","shallow":true}'

bun model delete expansion '{"document":"RoomDoc","name":"messages"}'
```

- Default: has-many (`jsonb_agg`)
- `belongs_to: true`: single parent (`jsonb_build_object`)
- `shallow: true`: fields only, no nested expansions
- `parent: "name"`: nest under an existing expansion

### Methods

Args are a JSON array of `{name, type}` objects.

```bash
bun model save method '{"entity":"Room","name":"sendMessage","args":[{"name":"body","type":"string"}],"return_type":"{id:number}"}'
bun model save method '{"entity":"Room","name":"search","args":[{"name":"query","type":"string"}],"auth_required":false}'

# Inline publishes and permissions
bun model save method '{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"],"permissions":["@created_by"]}'

bun model delete method '{"entity":"Room","name":"rename"}'
```

### Publish

Declares which fields a method changes — determines the `pg_notify` payload.

```bash
bun model save publish '{"method":"Room.rename","property":"name"}'
bun model delete publish '{"method":"Room.rename","property":"name"}'
```

### Permissions

Path syntax: `@field->table[filter]{temporal}.target_field`

```bash
bun model save permission '{"method":"User.updateProfile","path":"@user_id","description":"Only the user themselves"}'
bun model save permission '{"method":"Organisation.createVenue","path":"@owner_id->acts_for[org_id=$]{active}.user_id","description":"Active org member"}'
```

- `@user_id` — direct ownership
- `@owner_id->acts_for[org_id=$]{active}.user_id` — org membership
- `[field=$]` matches current user, `[role='admin']` literal filter, `{active}` temporal

### Story Links

Inline on story save. Target types: `entity`, `document`, `method`, `notification`.

```bash
bun model save story '{"actor":"member","action":"send a message","links":[{"type":"document","name":"RoomDoc"},{"type":"method","name":"Room.sendMessage"}]}'
```

### Metadata

```bash
bun model save metadata '{"key":"theme","value":"60s flower power — warm oranges, earthy browns, groovy rounded shapes"}'
bun model list metadata
bun model get metadata theme
bun model delete metadata '{"key":"theme"}'
```

### Listing and Export

```bash
bun model list                # all entities with fields/methods/relations
bun model list story
bun model list document
bun model list checklist
bun model list method
bun model export              # markdown spec to stdout
bun model export > spec.md
```

### Batch

**Prefer individual commands** — run each `bun model` call separately so errors are caught immediately. Only use batch for large bulk imports where you've verified the syntax.

Pipe JSONL to run many save/delete operations at once:

```bash
cat <<'EOF' | bun model batch
["save","entity",{"name":"Room","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"}]}]
["save","relation",{"from":"Room","to":"Message","label":"messages"}]
["save","method",{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"]}]
EOF
```

### Import from File

Import a YAML or JSON file containing model definitions. Plural keys (e.g. `entities`, `stories`) are automatically mapped to singular schema names. All items are saved in a single transaction — if any item fails, the entire import is rolled back.

```bash
bun model import model.yml
bun model import model.json
```

Example YAML file:
```yaml
entities:
  - name: Room
    fields:
      - { name: id, type: number }
      - { name: name, type: string }
  - name: Message
    fields:
      - { name: id, type: number }
      - { name: text, type: string }
      - { name: room_id, type: number }

relations:
  - { from: Room, to: Message, label: messages, cardinality: "*" }

documents:
  - name: RoomDoc
    entity: Room
    expansions:
      - { name: messages, entity: Message, foreign_key: room_id }
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
# Create checklist with inline checks
bun model save checklist '{"name":"Venue Setup","description":"Owner creates and manages venue","checks":[{"actor":"venue_owner","method":"Venue.addArea","description":"Add an area"},{"actor":"sponsor","method":"Venue.addArea","description":"Sponsor blocked","denied":true}]}'

# Or separately
bun model save checklist '{"name":"Venue Setup","description":"Owner creates and manages venue"}'
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","description":"Add an area"}'
bun model save check '{"checklist":"Venue Setup","actor":"sponsor","method":"Venue.addArea","description":"Sponsor cannot add area","denied":true}'

# Alternative: use action field instead of denied boolean
bun model save check '{"checklist":"Venue Setup","actor":"sponsor","method":"Venue.addArea","description":"Sponsor cannot add area","action":"denied"}'

# List
bun model list checklist       # [A.] api only, [.U] ux only, [AU] both

# Mark checks as verified (confirmed bitmask: 1=api, 2=ux, 3=both, 0=reset)
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","confirmed":1}'   # [A.]
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","confirmed":3}'   # [AU]
```

## Account Entity

Simple's auth provides a `user` table (id, name, email). In the model, represent it as **Account**:

```bash
bun model save entity '{"name":"Account","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"},{"name":"email","type":"string"}]}'
```

`/implement` maps Account to the existing `user` table — no separate table created.

## Change Targets

`export` shows **Changes** per entity — which documents and collection paths a mutation affects:

```
`venue_doc(venue_id)` → `areas`
`occasion_doc(occasion_id)` → `packages.allocations.options` [package_id, allocation_id]
`PostFeed(id)` (collection)
```

Each becomes a `pg_notify` target in the mutation function. The model site shows these on entity pages and the reverse (**Changed by**) on document pages.
