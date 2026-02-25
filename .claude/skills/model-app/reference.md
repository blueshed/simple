# Modeler CLI Reference

## Commands

```
Mutations:
  bun model save <schema> '<json>'       Upsert by natural key (coalescing)
  bun model delete <schema> '<json>'     Remove by natural key

Queries:
  bun model list [schema]                List all, or items of a schema type
  bun model get <schema> <key>           Get one item as JSON
  bun model export                       Markdown spec to stdout

Maintenance:
  bun model doctor [--fix]               Report/repair orphaned references

Batch:
  bun model batch                        JSONL from stdin: ["save","entity",{...}]
  bun model import <file.yml|json>       Import YAML or JSON file

Schemas: entity, field, relation, story, document, expansion, method, publish,
         notification, permission, checklist, check, metadata
```

## Save — Coalescing Upsert

Save finds an existing record by natural key and updates only the provided fields. If no record exists, it inserts with defaults. Children (inline arrays) are merged by their own natural keys.

```bash
# First save creates the entity
bun model save entity '{"name":"Room"}'

# Second save with the same natural key (name) adds/updates fields only
bun model save entity '{"name":"Room","fields":[{"name":"created_at","type":"string"}]}'
```

## Detailed Examples

### Stories

```bash
bun model save story '{"actor":"visitor","action":"browse available rooms"}'
bun model save story '{"actor":"member","action":"send a message to a room"}'
bun model save story '{"actor":"creator","action":"delete a room"}'
```

### Entities and Fields

Every entity needs an `id: number` field. Foreign keys use `_id` suffix. Fields can be inline or saved separately.

```bash
# Inline — entity with fields in one command
bun model save entity '{"name":"Room","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"},{"name":"created_by","type":"number"},{"name":"created_at","type":"string"}]}'

# Separate — add a field to an existing entity
bun model save field '{"entity":"Room","name":"description","type":"string"}'
```

### Relations

```bash
# has-many (cardinality "*", the default)
bun model save relation '{"from":"Room","to":"Message","label":"messages"}'

# belongs-to (cardinality "1")
bun model save relation '{"from":"Message","to":"Account","label":"sender","cardinality":"1"}'
```

### Documents

Each document becomes a postgres doc function that the client subscribes to with `openDoc(fn, id)`.

```bash
# Single entity document — openDoc("room_doc", roomId)
bun model save document '{"name":"RoomDoc","entity":"Room"}'

# Collection document with public access — openDoc("room_list", 0)
bun model save document '{"name":"RoomList","entity":"Room","collection":true,"public":true}'

# Document with description and cursor pagination
bun model save document '{"name":"MessageFeed","entity":"Message","fetch":"cursor","description":"Paginated message history"}'
```

### Expansions

Three expansion types:

- **has-many** (default): loads all child rows via `jsonb_agg(...)` in the doc function
- **belongs-to** (`belongs_to: true`): loads a single parent row via `jsonb_build_object(...)` join
- **shallow** (`shallow: true`): loads child rows (fields only) but does NOT recurse into nested expansions. Use for navigation references — the client gets enough to render a list and can open the full document on demand.

```bash
# has-many: load messages for a room
bun model save expansion '{"document":"RoomDoc","name":"messages","entity":"Message","foreign_key":"room_id"}'

# belongs-to nested under messages: load sender of each message
bun model save expansion '{"document":"RoomDoc","name":"sender","entity":"Account","foreign_key":"sender_id","belongs_to":true,"parent":"messages"}'

# shallow: list occasions at a venue without loading their full tree
bun model save expansion '{"document":"VenueDoc","name":"occasions","entity":"Occasion","foreign_key":"venue_id","shallow":true}'
```

Inline expansions on a document:

```bash
bun model save document '{"name":"RoomDoc","entity":"Room","expansions":[{"name":"messages","entity":"Message","foreign_key":"room_id","expansions":[{"name":"sender","entity":"Account","foreign_key":"sender_id","belongs_to":true}]}]}'
```

### Methods

Args are a JSON array of `{name, type}` objects. Each method becomes a postgres function where the server prepends `p_user_id` as the first argument.

```bash
bun model save method '{"entity":"Room","name":"sendMessage","args":[{"name":"body","type":"string"}],"return_type":"{id:number}"}'
bun model save method '{"entity":"Room","name":"join","args":[],"return_type":"boolean"}'
bun model save method '{"entity":"Room","name":"deleteRoom","args":[]}'
bun model save method '{"entity":"Room","name":"search","args":[{"name":"query","type":"string"}],"return_type":"{ids:number[]}","auth_required":false}'
```

Inline with publishes, permissions, and notifications:

```bash
bun model save method '{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"],"permissions":["@created_by"]}'
```

### Publish

Publish declares which fields a method changes. In Simple, these determine the data included in the `pg_notify` payload that fans out to clients with the document open.

```bash
bun model save publish '{"method":"Room.rename","property":"name"}'
```

String shorthand when inline on a method: `"publishes": ["name", "status"]`

### Notifications

Cross-document alerts triggered by a method.

```bash
bun model save notification '{"method":"Room.sendMessage","channel":"new_message","recipients":"@room_id->room_members.user_id","payload":"{room_id, body}"}'
```

### Permissions

Permission paths use fkey path syntax to express who can call a method. The path resolves to user IDs — if the authenticated user is in the set, access is granted. In Simple, these become SQL permission checks in the mutation function.

```bash
# Direct ownership — entity's user_id column
bun model save permission '{"method":"User.updateProfile","path":"@user_id","description":"Only the user themselves"}'

# Organisation membership — via acts_for join
bun model save permission '{"method":"Organisation.createVenue","path":"@id->acts_for[org_id=$]{active}.user_id","description":"Active org member"}'

# Multi-hop — traverse through intermediate entity
bun model save permission '{"method":"Site.updateSpec","path":"@venue_id->venues.owner_id->acts_for[org_id=$]{active}.user_id","description":"Active member of venue'\''s org"}'

# Role-restricted — only admins
bun model save permission '{"method":"Organisation.delete","path":"@id->acts_for[org_id=$,role='\''admin'\'']{active}.user_id","description":"Org admin only"}'
```

String shorthand when inline on a method: `"permissions": ["@user_id"]`

**Path syntax:** `@field->table[filter]{temporal}.target_field`
- `@field` — start from a column on the entity
- `->table` — traverse to related table
- `[field=$]` — filter where field matches current user ID
- `[field='value']` — filter with literal value
- `[a=$,b='x']` — multiple conditions (AND)
- `{active}` — temporal filter (valid_from/valid_to)
- `.target_field` — project the user ID column

Multiple paths on the same method use **OR logic** — any matching path grants access.

### Story Links

Connect stories to the artifacts they produce. Inline on story save, target types: `entity`, `document`, `method`, `notification`.

```bash
# Inline on story
bun model save story '{"actor":"member","action":"send a message","links":[{"type":"document","name":"RoomDoc"},{"type":"method","name":"Room.sendMessage"}]}'
```

### Metadata

Key-value store for project settings like theme, app name, etc.

```bash
bun model save metadata '{"key":"theme","value":"Dark navy palette with amber accents"}'
bun model save metadata '{"key":"name","value":"My Chat App"}'
bun model list metadata
bun model get metadata theme
bun model delete metadata '{"key":"name"}'
```

### Viewing the Model

```bash
# List everything
bun model list
bun model list entity
bun model list story
bun model list document
bun model list checklist
bun model list method
bun model list relation
bun model list metadata

# Get detail as JSON
bun model get entity Room
bun model get document RoomDoc

# Export markdown spec
bun model export
bun model export > spec.md

# View diagrams on the website
# Open http://localhost:8080
```

### Deleting

Delete by natural key:

```bash
bun model delete entity '{"name":"Room"}'
bun model delete field '{"entity":"Room","name":"description"}'
bun model delete relation '{"from":"Room","to":"Message","label":"messages"}'
bun model delete document '{"name":"RoomDoc"}'
bun model delete expansion '{"document":"RoomDoc","name":"messages"}'
bun model delete method '{"entity":"Room","name":"rename"}'
bun model delete publish '{"method":"Room.rename","property":"name"}'
bun model delete story '{"actor":"visitor","action":"browse available rooms"}'
bun model delete checklist '{"name":"Access"}'
bun model delete metadata '{"key":"theme"}'
```

Cascading: deleting an entity removes its fields, methods, publishes, permissions, notifications, and story links. Deleting a document removes its expansions.

### Batch Operations

Pipe JSONL to `bun model batch` to run many save/delete operations in one call. Each line is a JSON array: `["save", "schema", {...}]` or `["delete", "schema", {...}]`.

```bash
cat <<'EOF' | bun model batch
["save","entity",{"name":"Room","fields":[{"name":"id","type":"number"},{"name":"name","type":"string"}]}]
["save","relation",{"from":"Room","to":"Message","label":"messages"}]
["save","method",{"entity":"Room","name":"rename","args":[{"name":"name","type":"string"}],"publishes":["name"]}]
["save","story",{"actor":"member","action":"rename a room","links":[{"type":"method","name":"Room.rename"}]}]
EOF
```

Output:
```
Batch: 4 ok, 0 failed, 4 total
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

### Doctor

Report or fix orphaned references (story links, checks, check deps pointing to deleted items).

```bash
bun model doctor           # report only
bun model doctor --fix     # remove orphaned rows
```

## Checklists

Checklists verify that **permission paths work** — that the SQL permission checks in mutation functions enforce who can do what. Each check is a method call by a specific actor. CAN checks prove the right actor succeeds. DENIED checks prove the wrong actor is blocked.

### Why checklists exist

In Simple, permission checks live in postgres mutation functions. When a client opens a document with `openDoc("venue_doc", 2)`, the doc function scopes data to that venue. Methods on entities within that document should only be callable by users who pass the permission check. A user who doesn't own the venue should be rejected by the SQL permission check.

Checklists make this testable. Each DENIED check asserts that an actor **cannot** call a method because the permission path in the mutation function blocks them.

### Creating checks

```bash
# Create a checklist
bun model save checklist '{"name":"Venue Setup","description":"Venue owner creates and manages venue"}'

# CAN check — correct actor succeeds
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea","description":"Add an area to the venue"}'

# DENIED check — wrong actor is blocked by permission check
bun model save check '{"checklist":"Venue Setup","actor":"sponsor","method":"Venue.addArea","description":"Sponsor cannot add area","denied":true}'

# Alternative: use action field instead of denied boolean
bun model save check '{"checklist":"Venue Setup","actor":"sponsor","method":"Venue.addArea","description":"Sponsor cannot add area","action":"denied"}'

# Dependency by ID
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.removeArea","description":"Remove an area","depends_on":[{"depends_on_id":1}]}'

# Dependency by natural key (checklist + actor + method) — no need to know the ID
bun model save check '{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.removeArea","description":"Remove an area","depends_on":[{"checklist":"Venue Setup","actor":"venue_owner","method":"Venue.addArea"}]}'
```

Inline on checklist:

```bash
bun model save checklist '{"name":"Venue Setup","checks":[{"actor":"venue_owner","method":"Venue.addArea","description":"Add an area"},{"actor":"sponsor","method":"Venue.addArea","description":"Sponsor blocked","denied":true}]}'
```

### Listing checks

```bash
bun model list checklist
```

Shows `[A.]` api confirmed, `[.U]` ux confirmed, `[AU]` both confirmed.

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
