# Modeler CLI Reference

## CLI Commands

All mutations use `save <schema> '<json>'` or `delete <schema> '<json>'`. The 16 schemas are: entity, field, relation, story, document, expansion, method, publish, notification, permission, checklist, check, metadata, task, memory, flag.

```
Mutations:
  bun model save <schema> <json>       Upsert by natural key (coalescing)
  bun model delete <schema> <json>     Remove by natural key

Queries:
  bun model list [schema]              List all, or items of a schema type
  bun model get <schema> <key>         Get one item as JSON
  bun model export                     Markdown spec to stdout

Maintenance:
  bun model doctor [--fix]             Report/repair orphaned references

Batch:
  bun model batch                      JSONL from stdin: ["save","entity",{...}]
  bun model import <file.yml|json>     Import YAML or JSON file containing model definitions
```

## Save — Schema Reference

### entity
Natural key: `name`. Children: `fields`, `methods`.
```bash
bun model save entity '{"name":"Room","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"}]}'
```

### field
Natural key: `entity` + `name`.
```bash
bun model save field '{"entity":"Room","name":"capacity","type":"number"}'
```

### relation
Natural key: `from` + `to` + `label`. Cardinality: `*` (has-many, default) or `1` (belongs-to).
```bash
bun model save relation '{"from":"Room","to":"Message","label":"messages","cardinality":"*"}'
bun model save relation '{"from":"Message","to":"Account","label":"sender","cardinality":"1"}'
```

### story
Natural key: `actor` + `action`. Children: `links` (type + name).
```bash
bun model save story '{"actor":"visitor","action":"browse available rooms"}'
bun model save story '{"actor":"member","action":"send a message","links":[{"type":"entity","name":"Room"},{"type":"document","name":"RoomDoc"}]}'
```

### document
Natural key: `name`. Children: `expansions`. Boolean flags: `collection`, `public`. Fetch mode: `fetch` (select|cursor|stream).
```bash
bun model save document '{"name":"RoomDoc","entity":"Room"}'
bun model save document '{"name":"RoomList","entity":"Room","collection":true,"public":true}'
bun model save document '{"name":"MessageFeed","entity":"Message","collection":true,"fetch":"cursor"}'
```

### expansion
Natural key: `document` + `name`. Boolean flags: `belongs_to`, `shallow`. Nested via `parent` field. Children: `expansions` (recursive).
```bash
# has-many
bun model save expansion '{"document":"RoomDoc","name":"messages","entity":"Message","foreign_key":"room_id"}'

# belongs-to nested under messages
bun model save expansion '{"document":"RoomDoc","name":"sender","entity":"Account","foreign_key":"sender_id","belongs_to":true,"parent":"messages"}'

# shallow
bun model save expansion '{"document":"VenueDoc","name":"occasions","entity":"Occasion","foreign_key":"venue_id","shallow":true}'
```

### method
Natural key: `entity` + `name`. Children: `publishes`, `permissions`, `notifications`. String shorthand for publishes and permissions. Boolean flag: `auth_required` (default true).
```bash
# Full form with nested children
bun model save method '{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"]}'

# Method with permission inline
bun model save method '{"entity":"Room","name":"deleteRoom","args":[],"permissions":["@creator_id"]}'

# No auth required (no user_id prepended)
bun model save method '{"entity":"Account","name":"register","args":[{"name":"name","type":"string"},{"name":"email","type":"string"}],"auth_required":false}'
```

### publish
Natural key: `method` (Entity.name) + `property`.
```bash
bun model save publish '{"method":"Room.rename","property":"name"}'
```

### notification
Natural key: `method` + `channel`.
```bash
bun model save notification '{"method":"Room.invite","channel":"room-invite","recipients":"invitee_id"}'
```

### permission
Natural key: `method` + `path`.
```bash
bun model save permission '{"method":"Room.rename","path":"@room_id->acts_for[org_id=$]{active}.user_id"}'
```

### checklist
Natural key: `name`. Children: `checks`.
```bash
bun model save checklist '{"name":"Room Access","checks":[{"actor":"member","method":"Room.rename"},{"actor":"outsider","method":"Room.rename","denied":true}]}'
```

### check
Natural key: `checklist` + `actor` + `method`. Use `denied: true` or `action: "denied"` for negative tests. The `confirmed` field is a bitmask tracking test status: `1` = API tested (A), `2` = UX tested (U), `3` = both. Children: `depends_on` (by natural key: `checklist` + `actor` + `method`).
```bash
bun model save check '{"checklist":"Room Access","actor":"outsider","method":"Room.rename","denied":true}'

# Mark API tested
bun model save check '{"checklist":"Room Access","actor":"member","method":"Room.rename","confirmed":1}'

# Mark UX tested
bun model save check '{"checklist":"Room Access","actor":"member","method":"Room.rename","confirmed":2}'

# Mark both API + UX tested
bun model save check '{"checklist":"Room Access","actor":"member","method":"Room.rename","confirmed":3}'

# Add dependency by natural key (outsider check runs after member check)
bun model save check '{"checklist":"Room Access","actor":"outsider","method":"Room.rename","depends_on":[{"checklist":"Room Access","actor":"member","method":"Room.rename"}]}'
```

### metadata
Natural key: `key`.
```bash
bun model save metadata '{"key":"theme","value":"Dark navy palette"}'
bun model save metadata '{"key":"name","value":"My Chat App"}'
```

### task
Natural key: `name`. Status: `pending` (default), `in_progress`, `done`, `blocked`. Children: `depends_on` (by task name).
```bash
bun model save task '{"name":"schema","description":"Create database tables","status":"done"}'
bun model save task '{"name":"auth","description":"Add JWT middleware","status":"in_progress"}'
bun model save task '{"name":"publish-flow","description":"Post lifecycle","status":"pending","depends_on":[{"name":"auth"}]}'
bun model save task '{"name":"tests","status":"blocked","depends_on":[{"name":"auth"},{"name":"publish-flow"}]}'
```

### memory
Natural key: `tag` + `content`. Use tags to categorise: architecture, decision, convention, todo, etc.
```bash
bun model save memory '{"tag":"architecture","content":"PostFeed uses cursor-based pagination"}'
bun model save memory '{"tag":"decision","content":"Tags use slugs for URL-safe identifiers"}'
```

### flag
Natural key: `name`. Status: `pass`, `fail`, `unknown` (default). Optional `cmd` for automated checks.
```bash
bun model save flag '{"name":"db-migrations","status":"pass"}'
bun model save flag '{"name":"api-tests","status":"fail"}'
bun model save flag '{"name":"lint","cmd":"bun run lint","status":"unknown"}'
```

## Delete

Delete by natural key. Provide only the key fields. Cascading deletes follow foreign key constraints.

```bash
bun model delete field '{"entity":"Room","name":"capacity"}'
bun model delete relation '{"from":"Room","to":"Message","label":"messages"}'
bun model delete entity '{"name":"Room"}'
bun model delete metadata '{"key":"theme"}'
```

## Detailed Examples

### Stories with Links

```bash
bun model save story '{"actor":"visitor","action":"browse available rooms","links":[{"type":"document","name":"RoomList"}]}'
bun model save story '{"actor":"member","action":"send a message to a room","links":[{"type":"document","name":"RoomDoc"},{"type":"method","name":"Room.sendMessage"}]}'
```

### Entity with Fields Inline

Every entity needs an `id: number` field. Foreign keys use `_id` suffix.

```bash
bun model save entity '{"name":"Room","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"},{"name":"created_by","type":"number"},{"name":"created_at","type":"string"}]}'
```

Or add fields individually:

```bash
bun model save entity '{"name":"Room"}'
bun model save field '{"entity":"Room","name":"id","type":"number"}'
bun model save field '{"entity":"Room","name":"name","type":"string"}'
```

### Relations

```bash
# has-many (cardinality *)
bun model save relation '{"from":"Room","to":"Message","label":"messages","cardinality":"*"}'

# belongs-to (cardinality 1)
bun model save relation '{"from":"Message","to":"Account","label":"sender","cardinality":"1"}'
```

### Documents with Expansions Inline

Each document becomes a postgres doc function that the client subscribes to with `openDoc(fn, id)`.

```bash
# Document with expansions inline
bun model save document '{"name":"RoomDoc","entity":"Room","expansions":[{"name":"messages","entity":"Message","foreign_key":"room_id"}]}'

# Collection document with public access
bun model save document '{"name":"RoomList","entity":"Room","collection":true,"public":true}'
```

### Expansion Types

Three expansion types:

- **has-many** (default): loads all child rows via `jsonb_agg(...)` in the doc function
- **belongs-to** (`belongs_to: true`): loads a single parent row via `jsonb_build_object(...)` join
- **shallow** (`shallow: true`): loads child rows (fields only) but does NOT recurse into nested expansions. Use for navigation references.

### Methods with Publish Inline

Args are a JSON array of `{name, type}` objects. Each method becomes a postgres function where the server prepends `p_user_id` as the first argument.

```bash
# Method with publishes inline (string shorthand)
bun model save method '{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"]}'

# Method with permissions inline
bun model save method '{"entity":"Room","name":"deleteRoom","args":[],"return_type":"boolean","permissions":["@creator_id"]}'
```

### Permissions

Permission paths use fkey path syntax to express who can call a method.

```bash
# Direct ownership
bun model save permission '{"method":"User.updateProfile","path":"@user_id","description":"Only the user themselves"}'

# Organisation membership
bun model save permission '{"method":"Organisation.createVenue","path":"@id->acts_for[org_id=$]{active}.user_id","description":"Active org member"}'

# Multi-hop
bun model save permission '{"method":"Site.updateSpec","path":"@venue_id->venues.owner_id->acts_for[org_id=$]{active}.user_id","description":"Active member of venue org"}'

# Role-restricted
bun model save permission '{"method":"Organisation.delete","path":"@id->acts_for[org_id=$,role='"'"'admin'"'"']{active}.user_id","description":"Org admin only"}'
```

**Path syntax:** `@field->table[filter]{temporal}.target_field`
- `@field` — start from a column on the entity
- `->table` — traverse to related table
- `[field=$]` — filter where field matches current user ID
- `[field='value']` — filter with literal value
- `[a=$,b='x']` — multiple conditions (AND)
- `{active}` — temporal filter (valid_from/valid_to)
- `.target_field` — project the user ID column

Multiple paths on the same method use **OR logic** — any matching path grants access.

### Viewing the Model

```bash
# List everything
bun model list

# List by schema type
bun model list entity
bun model list story
bun model list document
bun model list checklist
bun model list method
bun model list metadata

# Get a single item as JSON
bun model get entity Room
bun model get document RoomDoc

# Export markdown spec
bun model export
bun model export > spec.md

# View diagrams on the website
# Open http://localhost:8080
```

### Batch Operations

Pipe JSONL to `bun model batch` to run many commands in one call. Each line is a JSON array: `["save", "schema", {...}]` or `["delete", "schema", {...}]`.

```bash
cat <<'EOF' | bun model batch
["save","entity",{"name":"Room"}]
["save","field",{"entity":"Room","name":"id","type":"number"}]
["save","field",{"entity":"Room","name":"name","type":"string"}]
["save","relation",{"from":"Room","to":"Message","label":"messages","cardinality":"*"}]
["save","method",{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"]}]
EOF
```

Output:
```
Batch: 5 ok, 0 failed, 5 total
```

Errors on individual lines are caught and reported without stopping the batch. **Prefer individual commands** over batch — run each `bun model` call separately so errors are caught immediately. Only use batch for large bulk imports where you've already verified the syntax.

### Import from File

Import a YAML or JSON file containing model definitions. The file should be a mapping of schema names (singular or plural) to arrays of objects.

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

Plural keys (e.g. `entities`, `stories`) are automatically mapped to singular schema names. All items are saved in a single transaction — if any item fails, the entire import is rolled back.

## Checklists

Checklists verify that **permission paths work** — that the SQL permission checks in mutation functions enforce who can do what. Each check is a method call by a specific actor. CAN checks prove the right actor succeeds. DENIED checks prove the wrong actor is blocked.

### Why checklists exist

In Simple, permission checks live in postgres mutation functions. When a client opens a document with `openDoc("venue_doc", 2)`, the doc function scopes data to that venue. Methods on entities within that document should only be callable by users who pass the permission check. A user who doesn't own the venue should be rejected by the SQL permission check.

Checklists make this testable. Each DENIED check asserts that an actor **cannot** call a method because the permission path in the mutation function blocks them.

### Creating checks

```bash
# Create a checklist with checks inline
bun model save checklist '{"name":"Venue Setup","description":"Venue owner creates and manages venue","checks":[{"actor":"venue_owner","method":"Venue.addArea","description":"Add an area to the venue"},{"actor":"sponsor","method":"Venue.addArea","description":"Sponsor cannot add area","denied":true}]}'

# Or add checks individually
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","description":"Add an area"}'
bun model save check '{"checklist":"Venue Setup","actor":"sponsor","method":"Venue.addArea","description":"Sponsor cannot add area","denied":true}'

# Add dependency — sponsor check runs after venue_owner check
bun model save check '{"checklist":"Venue Setup","actor":"sponsor","method":"Venue.addArea","depends_on":[{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea"}]}'
```

### Tracking test status

Each check has a `confirmed` bitmask that tracks whether it has been verified:

| Value | Meaning |
|-------|---------|
| `0`   | Not tested (default) |
| `1`   | **A** — API tested |
| `2`   | **U** — UX tested |
| `3`   | **A + U** — Both tested (fully done) |

Update the status by saving the check with `confirmed`:

```bash
# Mark API tested
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","confirmed":1}'

# Mark both API + UX tested
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","confirmed":3}'

# Reset to untested
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","confirmed":0}'
```

The site displays A and U badges on each check, and shows progress counts per checklist.

## Change Targets

`export` and the model site both show **Changes** per entity — which documents and collection paths a mutation affects. The model site also shows the reverse (**Changed by**) on each document page.

### Format

```
**Changes:**

- `doc_name(doc_id_fk)` → `collection.path` [intermediate_fks]
- `doc_name(id)` (collection)
```

- **doc_name** — the document that receives the merge event
- **doc_id_fk** — the foreign key used to find the document instance (`id` for root entities)
- **collection.path** — dotted path through the expansion tree to the affected array (omitted for root entities)
- **[intermediate_fks]** — remaining foreign keys in the chain (one per intermediate segment), omitted if the entity is a direct child
- **(collection)** — shown when the document is a collection

### Examples

```
- `venue_doc(venue_id)` → `areas`
- `occasion_doc(occasion_id)` → `packages.allocations.options` [package_id, allocation_id]
- `PostFeed(id)` (collection)
```

### How it maps to pg_notify

Each change target becomes a `pg_notify` target in the mutation's postgres function. The server fans out the event to every client that has the document open via `openDoc`, and the client merges the changed row into its local signal state.

```sql
-- For: `venue_doc(venue_id)` → `areas`
PERFORM pg_notify('change', jsonb_build_object(
  'fn', 'save_area', 'op', 'upsert', 'data', row_to_json(v_row)::jsonb,
  'targets', jsonb_build_array(
    jsonb_build_object('doc', 'venue_doc', 'doc_id', v_row.venue_id, 'collection', 'areas')
  )
)::text);
```
