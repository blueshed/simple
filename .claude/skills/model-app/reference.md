# Modeler CLI Reference

## CLI Commands

```
Entities:
  bun model add-entity <Name>
  bun model add-field <Entity> <field> [type]
  bun model add-relation <From> <To> [label] [cardinality]
  bun model remove-entity <Name>
  bun model remove-field <Entity> <field>
  bun model remove-relation <From> <To> [label]

Stories:
  bun model add-story <actor> <action> [description]
  bun model remove-story <id>

Documents:
  bun model add-document <Name> <Entity> [--collection] [--public]
  bun model remove-document <Name>

Expansions:
  bun model add-expansion <Document> <name> <Entity> <foreign_key> [--belongs-to] [--shallow] [--parent <name>]
  bun model remove-expansion <Document> <name>

Methods:
  bun model add-method <Entity> <name> [args_json] [return_type] [--no-auth] [--permission <perm>]
  bun model remove-method <Entity> <name>

Publish:
  bun model add-publish <Entity.method> <property>
  bun model remove-publish <Entity.method> <property>

Permissions:
  bun model add-permission <Entity.method> <path> [description]
  bun model remove-permission <id>

Story Links:
  bun model link-story <story_id> <target_type> <target_name>
  bun model unlink-story <story_id> <target_type> <target_name>

Checklists:
  bun model add-checklist <name> [description]
  bun model remove-checklist <name>
  bun model add-check <checklist> <actor> <Entity.method> [description] [--denied] [--after <check_id>]
  bun model add-check-dep <check_id> <depends_on_id>
  bun model confirm-check <check_id> --api|--ux
  bun model unconfirm-check <check_id> --api|--ux
  bun model list-checks [checklist]

Metadata:
  bun model set-meta <key> <value>
  bun model get-meta [key]              (omit key to list all)
  bun model clear-meta <key>
  bun model set-theme <description>     (shortcut for set-meta theme ...)
  bun model get-theme
  bun model clear-theme

Listing:
  bun model list
  bun model list-stories
  bun model list-documents

Export:
  bun model export-spec

Batch:
  bun model batch              (reads JSONL from stdin)
```

## Detailed Examples

### Stories

```bash
bun model add-story visitor "browse available rooms"
bun model add-story member "send a message to a room"
bun model add-story creator "delete a room"
```

### Entities and Fields

Every entity needs an `id: number` field. Foreign keys use `_id` suffix.

```bash
bun model add-entity Room
bun model add-field Room id number
bun model add-field Room name string
bun model add-field Room created_by number
bun model add-field Room created_at string
```

### Relations

```bash
# has-many (cardinality *)
bun model add-relation Room Message messages *

# belongs-to (cardinality 1)
bun model add-relation Message Account sender 1
```

### Documents

Each document becomes a postgres doc function that the client subscribes to with `openDoc(fn, id)`.

```bash
# Single entity document — openDoc("room_doc", roomId)
bun model add-document RoomDoc Room

# Collection document with public access — openDoc("room_list", 0)
bun model add-document RoomList Room --collection --public
```

### Expansions

Three expansion types:

- **has-many** (default): loads all child rows via `jsonb_agg(...)` in the doc function
- **belongs-to** (`--belongs-to`): loads a single parent row via `jsonb_build_object(...)` join
- **shallow** (`--shallow`): loads child rows (fields only) but does NOT recurse into nested expansions. Use for navigation references — the client gets enough to render a list and can open the full document on demand.

```bash
# has-many: load messages for a room
bun model add-expansion RoomDoc messages Message room_id

# belongs-to nested under messages: load sender of each message
bun model add-expansion RoomDoc sender Account sender_id --belongs-to --parent messages

# shallow: list occasions at a venue without loading their full tree
bun model add-expansion VenueDoc occasions Occasion venue_id --shallow
```

### Methods

Args are a JSON array of `{name, type}` objects. Each method becomes a postgres function where the server prepends `p_user_id` as the first argument.

```bash
bun model add-method Room sendMessage '[{"name":"body","type":"string"}]' '{id:number}'
bun model add-method Room join '[]' boolean
bun model add-method Room deleteRoom '[]' boolean --permission creator
bun model add-method Room search '[{"name":"query","type":"string"}]' '{ids:number[]}' --no-auth
```

### Publish

Publish declares which fields a method changes. In Simple, these determine the data included in the `pg_notify` payload that fans out to clients with the document open.

```bash
# Publish: fields included in the merge event payload
bun model add-publish Room.rename name
```

### Permissions

Permission paths use fkey path syntax to express who can call a method. The path resolves to user IDs — if the authenticated user is in the set, access is granted. In Simple, these become SQL permission checks in the mutation function.

```bash
# Direct ownership — entity's user_id column
bun model add-permission User.updateProfile "@user_id" "Only the user themselves"

# Organisation membership — via acts_for join
bun model add-permission Organisation.createVenue "@id->acts_for[org_id=$]{active}.user_id" "Active org member"

# Multi-hop — traverse through intermediate entity
bun model add-permission Site.updateSpec "@venue_id->venues.owner_id->acts_for[org_id=$]{active}.user_id" "Active member of venue's org"

# Role-restricted — only admins
bun model add-permission Organisation.delete "@id->acts_for[org_id=$,role='admin']{active}.user_id" "Org admin only"

# Remove a permission by its ID
bun model remove-permission 1
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

### Story Links

Connect stories to the artifacts they produce. Target types: `entity`, `document`, `method`.

```bash
bun model link-story 1 document RoomList
bun model link-story 2 document RoomDoc
bun model link-story 2 method sendMessage
```

### Viewing the Model

```bash
# List everything
bun model list
bun model list-stories
bun model list-documents

# Export markdown spec
bun model export-spec
bun model export-spec > spec.md

# View diagrams on the website
# Open http://localhost:8080
```

### Batch Operations

Pipe JSONL to `bun model batch` to run many commands in one call. Each line is a JSON array: `["command", "arg1", "arg2", ...]`.

```bash
cat <<'EOF' | bun model batch
["add-entity","Room"]
["add-field","Room","id","number"]
["add-field","Room","name","string"]
["add-relation","Room","Message","messages","*"]
["add-method","Room","rename","[{\"name\":\"name\",\"type\":\"string\"}]","boolean"]
["add-publish","Room.rename","name"]
["link-story","1","entity","Room"]
EOF
```

Output:
```
Batch: 7 ok, 0 failed, 7 total
```

Errors on individual lines are caught and reported without stopping the batch. **Prefer individual commands** over batch — run each `bun model` call separately so errors are caught immediately. Only use batch for large bulk imports where you've already verified the syntax.

## Checklists

Checklists verify that **permission paths work** — that the SQL permission checks in mutation functions enforce who can do what. Each check is a method call by a specific actor. CAN checks prove the right actor succeeds. DENIED checks prove the wrong actor is blocked.

### Why checklists exist

In Simple, permission checks live in postgres mutation functions. When a client opens a document with `openDoc("venue_doc", 2)`, the doc function scopes data to that venue. Methods on entities within that document should only be callable by users who pass the permission check. A user who doesn't own the venue should be rejected by the SQL permission check.

Checklists make this testable. Each DENIED check asserts that an actor **cannot** call a method because the permission path in the mutation function blocks them.

### CLI Commands

```
bun model add-checklist <name> [description]
bun model remove-checklist <name>
bun model add-check <checklist> <actor> <Entity.method> [description] [--denied] [--after <check_id>]
bun model add-check-dep <check_id> <depends_on_id>
bun model confirm-check <check_id> --api|--ux
bun model unconfirm-check <check_id> --api|--ux
bun model list-checks [checklist]
```

### Creating checks

```bash
# Create a checklist for a workflow
bun model add-checklist "Venue Setup" "Venue owner creates and manages venue"

# CAN check — correct actor succeeds
bun model add-check "Venue Setup" venue_owner "Venue.addArea" "Add an area to the venue"

# DENIED check — wrong actor is blocked by permission check
bun model add-check "Venue Setup" sponsor "Venue.addArea" "Sponsor cannot add area" --denied

# Dependency — check B requires check A to pass first
bun model add-check-dep 3 2
```

### Confirming checks

Two confirmation channels: `--api` (WebSocket integration test) and `--ux` (browser/Playwright test). Both must pass for a check to be fully confirmed.

```bash
bun model confirm-check 1 --api    # API test passed
bun model confirm-check 1 --ux     # UX test passed
bun model list-checks              # Shows [A.] api, [.U] ux, [AU] both
```

## Change Targets

`export-spec` and the model site both show **Changes** per entity — which documents and collection paths a mutation affects. The model site also shows the reverse (**Changed by**) on each document page.

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
