# Research: PocketBase collection semantics and runtime D1 schema evolution

## Question and scope

What externally observable PocketBase behavior should define parity for a generic collection
platform, and what can Cloudflare D1 safely support when administrators create and evolve real
tables and columns at runtime?

This report is current as of **2026-10-24**. PocketBase findings target **v0.40.6**, whose release
commit is
[`9d281cc`](https://github.com/pocketbase/pocketbase/tree/9d281ccaba65f2686eb7b0b614ccda72d1116a1b).
D1 findings target the documented production service and the repository-pinned
`@cloudflare/workers-types@5.20260910.1` and `wrangler@4.130.0` interfaces.

**Included:** base/view collections, fields, schema evolution, records and queries, rules, files,
collection import/export, logs, backups, jobs, mail, deployed hooks, D1 runtime DDL, transactions,
foreign keys, concurrency, limits, recovery, testing and SQL-generation security.

**Excluded:** configurable Auth collections and all authentication behavior, because Identity stays
protected on Better Auth. Realtime subscriptions/SSE are also excluded. The only relevant boundary
is that PocketBase view collections have no create/update/delete operations and therefore emit no
record realtime events; this project promises neither that event transport nor Auth parity
([PocketBase collections](https://pocketbase.io/docs/collections/#view-collection)).

## Executive answer

Runtime collection DDL is **technically feasible on D1**. Cloudflare documents that SQL statements
can be executed through a Worker D1 binding, and that binding exposes `prepare`, transactional
`batch`, raw `exec`, and sessions. D1 uses SQLite's query engine and supports schema inspection,
foreign keys, tables, views and indexes
([D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
[D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)). The repository's
pinned types confirm that surface and expose no callback/interactive transaction API
([workers-types package source](https://unpkg.com/@cloudflare/workers-types@5.20260910.1/index.d.ts)).

Feasibility is not the same as safety. D1 limits a table to **100 columns**, serializes each
database's queries one at a time, queues concurrent work, and can reject overload. Runtime schema
mutation therefore competes directly with record traffic and cannot be treated as ordinary hot-path
CRUD
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)).
Schema operations need an application-owned catalog, a per-database mutation lease or optimistic
revision check, idempotency keys, impact preview, explicit destructive confirmation, and a durable
operation/history record.

PocketBase parity should mean its **observable contract**, not a port of its internals. PocketBase
stores base collections as SQLite tables, but its observable layer adds typed zero values,
validation, relation expansion, filters, five-valued access-rule configuration, file lifecycle,
transactional batches, schema import and deployed hook behavior
([PocketBase collections](https://pocketbase.io/docs/collections/),
[records API](https://pocketbase.io/docs/api-records/),
[rules](https://pocketbase.io/docs/api-rules-and-filters/)). Its source currently performs direct
SQLite rename/drop/add operations when synchronizing record tables, but that is an implementation
detail, not a parity requirement
([schema sync source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/collection_record_table_sync.go#L15-L152)).

The safest next step is prototype #219: prove a deliberately small base-collection slice against
both local Miniflare and a disposable remote D1 database, including concurrent mutation, stale
catalog revisions, statement reuse across DDL, foreign-key rebuilds, failure injection and recovery.
Do not prototype the full PocketBase rule language, files, views or hooks yet.

## PocketBase observable semantics

### Collections

PocketBase exposes three collection kinds, but only two are in this research scope:

| Kind | Observable behavior                                                                                                                         | Parity target                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Base | Mutable records backed by a generated SQLite table named for the collection. Collection create/update/delete and record CRUD are available. | Yes.                                                      |
| View | Read-only records produced by a plain SQL `SELECT`; schema is inferred from the query. No create/update/delete operations or indexes.       | Yes, later and only through a validated admin capability. |
| Auth | Base behavior plus password/token/email fields and authentication APIs.                                                                     | No. Better Auth Identity remains protected.               |

Sources: [PocketBase collections](https://pocketbase.io/docs/collections/),
[collections API](https://pocketbase.io/docs/api-collections/).

Collection metadata observable through the API includes stable `id`, unique `name`, immutable
`type`, `system`, `fields`, raw index definitions, five CRUD rules and, for views, `viewQuery`.
Collection management APIs are superuser-only. A system collection cannot be renamed, deleted or
have its API rules changed
([collections API](https://pocketbase.io/docs/api-collections/#create-collection)).

The public operations are list/get/create/patch/delete/truncate, bulk collection import, scaffold
discovery and view-query dry run. Deleting a referenced collection can fail; truncation deletes all
records, related files and cascade-delete relations and can fail on required references
([collections API](https://pocketbase.io/docs/api-collections/#delete-collection),
[truncate](https://pocketbase.io/docs/api-collections/#truncate-collection)).

View creation accepts a `SELECT`, derives fields, and exposes only list/view record operations.
SQLite views are themselves read-only unless application code adds `INSTEAD OF` triggers, which is
not part of PocketBase's view contract
([PocketBase view collections](https://pocketbase.io/docs/collections/#view-collection),
[SQLite CREATE VIEW](https://sqlite.org/lang_createview.html)).

### Field model and all in-scope field types

Every field has a stable `id` plus `name`, `type`, `system`, `hidden`, `presentable` and `help`.
`system` prevents rename/removal; `hidden` suppresses ordinary API serialization; `presentable` is a
Dashboard relation-label hint; `help` is UI guidance. These options are explicit in the field source,
for example
[`TextField`](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_text.go#L60-L114).
Except for JSON, fields are non-nullable and normalize missing data to a type-specific zero value
([PocketBase collections](https://pocketbase.io/docs/collections/#fields)).

| Type       | API value and zero                                                      | Type-specific options and behavior                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bool`     | Boolean; `false`.                                                       | `required` means the value must be `true`, not merely present ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_bool.go#L21-L51)).                                                                                                                                                                           |
| `number`   | Float64-compatible number; `0`.                                         | Nullable `min`/`max`, `onlyInt`, `required` means non-zero; `field+` and `field-` perform arithmetic ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_number.go#L35-L81)).                                                                                                                                  |
| `text`     | String; `""`.                                                           | Character `min`, `max` (zero applies the default 5000), regex `pattern`, `autogeneratePattern`, `required`, and the single collection `primaryKey`; `field:autogenerate` requests generation ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_text.go#L50-L114)).                                           |
| `email`    | Email string; `""`.                                                     | Mutually exclusive `onlyDomains`/`exceptDomains`, `required` ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_email.go#L24-L64)).                                                                                                                                                                           |
| `url`      | URL string; `""`.                                                       | Mutually exclusive `onlyDomains`/`exceptDomains`, `required` ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_url.go#L24-L64)).                                                                                                                                                                             |
| `editor`   | HTML string; `""`.                                                      | `maxSize` bytes (zero defaults to about 5 MB), `convertURLs`, `required` ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_editor.go#L26-L68)).                                                                                                                                                              |
| `date`     | UTC datetime string; `""`.                                              | `min`, `max`, `required`; dates use the documented `Y-m-d H:i:s.uZ` representation and compare as strings ([collections docs](https://pocketbase.io/docs/collections/#datefield), [source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_date.go#L21-L61)).                                                        |
| `autodate` | Server-set datetime string; `""`.                                       | `onCreate` and/or `onUpdate`; at least one is required ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_autodate.go#L30-L60)).                                                                                                                                                                              |
| `select`   | String when `maxSelect <= 1`, array when `maxSelect > 1`; `""` or `[]`. | Allowed `values`, `maxSelect`, `required`; prefix/suffix `+` prepends/appends and suffix `-` removes values ([collections docs](https://pocketbase.io/docs/collections/#selectfield), [source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_select.go#L54-L89)).                                                  |
| `file`     | Stored filename string or filename array; `""` or `[]`.                 | Per-file `maxSize` (zero defaults to 5 MB), `maxSelect`, MIME allowlist, thumbnail sizes, `protected`, `required`; `+`/`-` modifiers manage individual files ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_file.go#L76-L139), [file docs](https://pocketbase.io/docs/files-handling/)).                  |
| `relation` | Related record ID string or ID array; `""` or `[]`.                     | Target `collectionId`, `cascadeDelete`, `minSelect`, `maxSelect`, `required`; `+`/`-` modifiers manage IDs ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_relation.go#L54-L102)).                                                                                                                         |
| `json`     | Any serialized JSON, including `null`; zero is `null`.                  | `maxSize` bytes (zero defaults to 1 MB), `required` rejects `null`, empty string/array/object ([source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_json.go#L32-L68)).                                                                                                                                           |
| `geoPoint` | `{ "lon": number, "lat": number }`; `{ "lon": 0, "lat": 0 }`.           | `required` rejects Null Island; filters expose `geoDistance(...)` ([collections docs](https://pocketbase.io/docs/collections/#geopoint), [source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_geo_point.go#L34-L61), [rules](https://pocketbase.io/docs/api-rules-and-filters/#geodistancelona-lata-lonb-latb)). |

`password` is a registered PocketBase field type, but it belongs to Auth collection internals and is
not an in-scope configurable field
([password source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_password.go)).

Parity should reproduce public values, validation and mutation modifiers. It should **not** require
the same physical representation. Multi-select/file/relation fields are JSON columns in current
PocketBase source, for example, but a D1 implementation may normalize relations into join tables if
the HTTP behavior remains stable
([file column source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/field_file.go#L186-L199)).

### Schema rename, type change and deletion

PocketBase tracks a field by stable ID. Renaming the collection renames its table; renaming a field
with the same ID renames its column, using temporary names to avoid swaps/collisions. Therefore a
rename preserves records and should be a first-class operation, not modeled as delete-plus-add
([schema sync source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/collection_record_table_sync.go#L49-L129)).

PocketBase rejects changing an existing collection's type and rejects changing a field's type while
retaining its ID. A type conversion is therefore **not required for PocketBase parity**; it can be an
explicit improvement implemented as add/backfill/switch/retire with preview and recovery
([collection validation source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/collection_validate.go#L210-L243)).

Removing a field ID drops the physical column and its values. Removing a collection drops its data,
subject to relation checks. Collection import with `deleteMissing=true` likewise deletes omitted
non-system collections and fields, including record data
([schema sync source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/collection_record_table_sync.go#L80-L90),
[collections import API](https://pocketbase.io/docs/api-collections/#import-collections)).

Changing single/multiple cardinality is allowed for select/file/relation fields. Current PocketBase
wraps a scalar into an array and, when converting multiple to single, keeps the last value; file
objects discarded from the field are not automatically deleted by that schema conversion. This is
observable data-conversion behavior worth testing if cardinality changes enter parity
([normalization source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/collection_record_table_sync.go#L155-L297)).

PocketBase's prebuilt binary enables automigration by default: Dashboard/API collection changes
generate migration files. User migrations execute transactionally, support optional down functions,
and applied filenames are tracked in `_migrations`
([PocketBase migrations](https://pocketbase.io/docs/js-migrations/)). Observable parity does not
require reproducing generated JavaScript migrations, but this project must provide at least as much
operator-visible history and preferably safer reversible retirement.

### Records: CRUD, query, projection, expansion and batch

Base records expose list/search, get-by-ID, create, patch and delete. Create may accept a client ID
of exactly 15 characters or generate one. JSON and multipart bodies are accepted; file upload
requires multipart. Create/update responses can apply `expand` and `fields`
([records API](https://pocketbase.io/docs/api-records/#crud-actions)).

List uses one-based page/per-page pagination (defaults 1/30), returns totals and items, and supports
`skipTotal`, which yields `-1` totals. Sort accepts comma-separated fields with `-` descending and
supports `@random`, `@rowid`, `id` and schema fields
([list records](https://pocketbase.io/docs/api-records/#listsearch-records)).

Client filters are ANDed with `listRule`. Operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, `~`, `!~`
and `?`-prefixed any-match variants; expressions support literals, parentheses, `&&`, `||` and line
comments. Multi-valued/nested relation paths default to match-all unless a `?` operator requests
any-match
([list records](https://pocketbase.io/docs/api-records/#listsearch-records),
[filter syntax](https://pocketbase.io/docs/api-rules-and-filters/#filters-syntax)).

`expand` follows relation paths to at most six levels, places authorized related records under an
`expand` object and silently omits relations the caller cannot view. `fields` is a comma-separated
projection with depth-local `*`, nested expanded paths and `:excerpt(maxLength, withEllipsis?)`
([records API](https://pocketbase.io/docs/api-records/#listsearch-records)).

The optional batch endpoint supports record create/update/upsert/delete across collections in one
request and one read/write transaction. All subrequests share auth state; file multipart keys are
indexed by request. Any failing subrequest rolls back the batch. PocketBase warns that the held
transaction queues other work and recommends small time/body limits and avoiding slow files/hooks
([batch records](https://pocketbase.io/docs/api-records/#batch-createupdateupsertdelete-records)).

### Access rules

Each collection has `listRule`, `viewRule`, `createRule`, `updateRule`, and `deleteRule`. `null` means
locked/superuser-only and is the default; `""` means public; a non-empty expression authorizes and,
for reads, filters records. Superusers bypass rules
([PocketBase rules](https://pocketbase.io/docs/api-rules-and-filters/#api-rules)).

Failure visibility is deliberately different by operation: an unsatisfied list rule returns a 200
empty list, create returns 400, and view/update/delete return 404; a locked operation returns 403.
These anti-disclosure semantics are part of observable parity
([PocketBase rules](https://pocketbase.io/docs/api-rules-and-filters/#api-rules)).

Rules can reference current/nested relation fields, `@request.context`, method, normalized headers,
query, auth and body, plus unrelated `@collection.*` joins. They include time macros,
`:isset`, `:changed`, `:length`, `:each`, `:lower`, `geoDistance` and `strftime`. Uploaded files are
currently excluded from request-body modifiers
([rule fields](https://pocketbase.io/docs/api-rules-and-filters/#filters-syntax),
[modifiers](https://pocketbase.io/docs/api-rules-and-filters/#special-identifiers-and-modifiers)).

This is a language implementation, not merely a stored SQL predicate. The project should initially
support a narrow, typed rule AST for authenticated ownership and fixed field predicates, compiling
values to bound parameters. Claiming broad PocketBase rule parity before relation traversal,
request contexts and response-shaping behavior exist would be inaccurate.

### Files

PocketBase stores only generated filenames in records; bytes live on local disk or S3-compatible
storage. Uploads go through record create/update multipart requests, names are sanitized and receive
a random suffix, and replacing/removing field values deletes managed files
([file handling](https://pocketbase.io/docs/files-handling/#uploading-files),
[deleting files](https://pocketbase.io/docs/files-handling/#deleting-files)).

Files are fetched by collection/record/filename URL. Configured image thumbnails support crop/fit
variants; `download=1` requests attachment behavior. Files are public-by-URL by default. A protected
field requires a short-lived file token and applies the record's view rule
([file URLs](https://pocketbase.io/docs/files-handling/#file-url),
[protected files](https://pocketbase.io/docs/files-handling/#protected-files)).

For this project, observable parity maps naturally to R2 plus D1 metadata, but requires an atomicity
policy for database/object-store partial failure. D1 transactions cannot include R2. Use staged
objects, finalize metadata only after upload, and asynchronous cleanup of abandoned/stale objects;
do not pretend a cross-service transaction exists.

### Import/export and migration history

PocketBase has a superuser bulk **collection configuration import**. Existing collections are
replaced/extended and new ones created in one transaction; `deleteMissing=true` destructively
removes omitted non-system collections/fields and their data
([API](https://pocketbase.io/docs/api-collections/#import-collections),
[source](https://github.com/pocketbase/pocketbase/blob/9d281ccaba65f2686eb7b0b614ccda72d1116a1b/core/collection_import.go#L17-L37)).
`migrate collections` exports a full collection-configuration snapshot into a deployable migration
([PocketBase migrations](https://pocketbase.io/docs/js-migrations/#collections-snapshot)).

The documented PocketBase Web API does not define a generic record CSV import/export endpoint.
Record transfer can be built from paginated record APIs/batches, while full application data is
covered by backups. Therefore “import/export parity” should be split into schema snapshot/import,
record data export/import, and full-service backup/restore rather than treated as one feature.

### Logs, backups, jobs and mail

PocketBase persists structured application/request logs asynchronously: after three seconds of
debounce, at a 200-entry threshold, and on graceful termination. Superusers can list/filter/project,
view, aggregate hourly statistics and truncate logs; retention, minimum level and IP/auth-ID capture
are configurable
([logging](https://pocketbase.io/docs/js-logging/),
[logs API](https://pocketbase.io/docs/api-logs/),
[settings](https://pocketbase.io/docs/api-settings/#update-settings)).

PocketBase backups are ZIP snapshots of application data. Superusers can list/create/upload/delete,
download with a file token, and restore; create/restore are mutually exclusive and restore restarts
the process. Scheduled backups support cron, retention count and optional S3 storage
([backups API](https://pocketbase.io/docs/api-backups/),
[backup settings](https://pocketbase.io/docs/api-settings/#update-settings)).

PocketBase extension code registers cron-like jobs by ID/expression/handler; jobs run in the server
process and can be listed and manually triggered by superusers
([job scheduling](https://pocketbase.io/docs/js-jobs-scheduling/),
[crons API](https://pocketbase.io/docs/api-crons/)). Cloudflare's analogous deployed mechanism is a
Worker Cron Trigger or scheduled Workflow, configured at deployment and executed in UTC
([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).

PocketBase mail uses sendmail or SMTP behind a mail client, supports custom HTML messages and
system templates, and exposes mailer interception hooks
([PocketBase mail](https://pocketbase.io/docs/js-sending-emails/),
[mailer hooks](https://pocketbase.io/docs/js-event-hooks/#mailer-hooks)). Cloudflare Workers can send
structured mail through a binding, but transport parity is an adapter concern rather than collection
DDL
([Email Sending binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)).

### Deployed extension hooks

PocketBase can be extended in deployed Go or JavaScript with routes, commands and hooks
([extension overview](https://pocketbase.io/docs/use-as-framework/)). Relevant hook families cover:

- application bootstrap/settings/backup/termination;
- record enrich, validate and before/execute/after-success/after-error create/update/delete;
- collection validate and corresponding lifecycle phases;
- record and collection HTTP request interception, batch and file requests;
- settings and mailer events.

Transaction-aware after-success hooks run only after commit; after-error hooks can be immediate or
delayed until rollback. Lower-level model hooks have no request context, while `*Request` hooks do
([event hooks](https://pocketbase.io/docs/js-event-hooks/#record-model-hooks),
[request hooks](https://pocketbase.io/docs/js-event-hooks/#request-hooks)).

Parity should preserve stable **deployed** lifecycle seams and commit semantics, not execute scripts
stored by administrators. The map explicitly excludes panel-authored arbitrary code. Worker releases
can carry typed hook registrations and version metadata for attribution
([Workers version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)).

## D1 runtime schema capability

### Worker binding surface and DDL operations

D1 permits supported SQLite statements through a Worker binding. The production documentation says
statements can be executed through the dashboard, Wrangler or Worker Binding API
([SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)). The pinned type
surface is:

- `D1Database.prepare(query)`, `batch(statements)`, `exec(query)`, `withSession(...)`;
- `D1DatabaseSession.prepare`, `batch`, `getBookmark`;
- `D1PreparedStatement.bind`, `first`, `run`, `all`, `raw`;
- deprecated `dump()`, limited to obsolete alpha databases.

Sources: [D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[`workers-types@5.20260910.1`](https://unpkg.com/@cloudflare/workers-types@5.20260910.1/index.d.ts).

Consequently, Worker code can issue runtime `CREATE TABLE`, `ALTER TABLE ... RENAME`, `RENAME
COLUMN`, `ADD COLUMN`, `DROP COLUMN`, `DROP TABLE`, `CREATE/DROP INDEX`, and `CREATE/DROP VIEW`
where accepted by D1's SQLite build. D1 explicitly documents schema introspection with
`PRAGMA table_list/table_info/index_list` and `sqlite_master`, foreign-key pragmas, and creating
views/indexes
([D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
[D1 indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/)).

SQLite rename updates schema references, but rename can fail when a view/trigger becomes ambiguous.
`DROP COLUMN` rewrites table content and fails when the column participates in keys, indexes,
constraints, generated expressions, triggers or views. Arbitrary type/constraint changes use the
create-copy-drop-rename rebuild procedure
([SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)). These SQLite semantics are useful
design input, but only D1-documented/tested behavior should be treated as the service contract.

Recommended operation classes:

| Operation                          | D1 path                                                                                           | Safety classification                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Create base collection             | Transactional batch: catalog row + `CREATE TABLE` + indexes, using generated identifiers.         | Reversible until records exist; low/medium risk.                              |
| Rename collection/field            | `ALTER TABLE ... RENAME` / `RENAME COLUMN`, then catalog update in same batch if proven.          | Data-preserving, but dependent views/indexes/rules must be preflighted.       |
| Add optional/defaulted field       | `ALTER TABLE ... ADD COLUMN`, then catalog update.                                                | Usually additive; validate D1/SQLite restrictions and 100-column headroom.    |
| Change validation only             | Catalog update, no DDL unless a physical constraint is intentionally used.                        | Low risk, but existing rows may violate stricter application validation.      |
| Change type/constraint/cardinality | Build replacement table, copy with explicit conversion, verify, swap, recreate indexes/views/FKs. | High risk; asynchronous/admin-only operation with preview and rollback point. |
| Delete field/collection            | First retire from API; later `DROP COLUMN`/`DROP TABLE`.                                          | Destructive; delayed purge only.                                              |
| Create view                        | Validate one read-only `SELECT`, infer/project a stable schema, create view and catalog row.      | High security and dependency risk; defer.                                     |

### Transactions and foreign keys

D1 is auto-commit by default. `D1Database.batch()` executes prepared statements sequentially and
non-concurrently as one SQL transaction; any failure aborts or rolls back the whole batch
([D1 `batch`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)). The current
binding/types expose no interactive transaction callback, `BEGIN`, savepoint or transaction handle.
Cloudflare's import guide requires stripping `BEGIN TRANSACTION`/`COMMIT` because execution already
runs in a transaction
([D1 import](https://developers.cloudflare.com/d1/best-practices/import-export-data/#convert-sqlite-database-files)).

This means a runtime schema mutation must either be expressible as a predetermined batch or use a
multi-phase operation with durable state and compensation. It cannot read arbitrary intermediate
results in Worker code and then continue the same database transaction. The prototype must test DDL
inside `batch()` rather than infer support from SQLite alone.

D1 enforces foreign keys for every query/migration by default. `PRAGMA foreign_keys=off` is not a
safe escape because each query is in an implicit transaction; D1 supports
`PRAGMA defer_foreign_keys=on` until transaction end. Cascade actions still run while checks are
deferred
([D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
[PRAGMA behavior](https://developers.cloudflare.com/d1/sql-api/sql-statements/#pragma-defer-foreign-keys-onoff)).
Rebuilds must finish valid, run `PRAGMA foreign_key_check`, and explicitly recreate all dependent
foreign keys/indexes/views.

### Concurrent schema mutation and the single-threaded database

Each D1 database is inherently single-threaded and executes queries one at a time. Concurrent
requests queue; a full/slow queue produces overload errors. Throughput is approximately bounded by
query duration plus request overhead
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput),
[error list](https://developers.cloudflare.com/d1/observability/debug-d1/#error-list)).

Serialization prevents two SQL statements from physically running simultaneously, but it does not
make a multi-request admin workflow atomic. Two Workers can both read catalog revision 7, derive
different mutations, and have their individual statements interleave or apply sequentially from
stale assumptions. A single-threaded database therefore **does not replace** application-level
compare-and-swap/idempotency.

Required control plane behavior:

1. Store a monotonic schema revision and immutable collection/field IDs.
2. Require every mutation to name the expected revision and an idempotency key.
3. Acquire one database-wide schema-operation lease or atomically move one operation from pending to
   running; reject/queue all other schema writes.
4. Re-read and validate physical schema (`PRAGMA table_xinfo`, indexes, foreign keys, views) before
   mutation.
5. Put all predetermined DDL/catalog changes in one `batch()` where D1 proves that combination.
6. Mark outcome and new revision durably; reconcile unknown outcomes instead of blindly retrying.
7. Keep ordinary record APIs available only for schema states they understand; return a stable
   maintenance/conflict response during incompatible swaps.

D1 automatically retries read-only `SELECT`/`EXPLAIN`/`WITH` queries up to twice, but not writes.
Write retries are safe only when the application operation is idempotent. A Worker-side timeout via
`Promise.race` does not cancel D1, so a timed-out DDL/write may still commit
([D1 debugging](https://developers.cloudflare.com/d1/observability/debug-d1/#automatic-retries),
[timeout behavior](https://developers.cloudflare.com/d1/observability/debug-d1/#d1-binding-timeout-behavior)).

### Prepared statements and schema invalidation

D1 documents `prepare(query)` and reusable statement construction, but does **not** document the
lifetime of compiled plans, cross-request statement caching, or exact behavior when another request
changes the schema
([prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)). The
Workers binding should therefore be treated as a query descriptor, not a durable compiled-plan cache.

Underlying modern SQLite prepared statements normally auto-recompile after a schema change and may
eventually return `SQLITE_SCHEMA` after bounded retries
([SQLite prepare](https://sqlite.org/c3ref/prepare.html),
[SQLite `SQLITE_SCHEMA`](https://sqlite.org/rescode.html#schema)). That is SQLite behavior, not an
explicit D1 guarantee. Do not cache prepared statement objects in module global scope; generate them
per operation/request from the current catalog. The prototype must prepare before DDL, execute after
DDL for rename/add/drop, and record local/remote differences and exact errors.

### Limits that shape the product

Current D1 limits include 100 columns/table, 100 bound parameters/query, 100 KB SQL statements,
2 MB string/BLOB/row, 30-second query duration, 10 GB/database on Paid (500 MB Free), 1,000 D1
queries per paid Worker invocation (50 Free), and six simultaneous open D1 connections per Worker
invocation
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).

The **100-column limit is a product limit**, not a remote implementation detail. A one-column-per
field base collection must reserve columns for system metadata and reject additions before reaching 100. The exact user-field cap should be intentionally lower to leave evolution headroom. Relations
and repeatable structures should use join/child tables rather than consuming wide-table columns when
that improves integrity and query behavior.

Large `DROP COLUMN`, rebuild, backfill and index creation operations can exceed the 30-second limit
and monopolize the single query executor. Cloudflare advises batching large data migrations and
running schema/index changes once rather than in request hot paths
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/#query-performance),
[index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/#indexes-and-your-bill)).

### Migrations versus runtime schema history

D1 migrations are ordered SQL files stored in the repository and recorded by filename in a
configurable migrations table. Wrangler can create/list/apply them and supports nested ORM layouts
([D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)). They are appropriate
for protected system schema, including Better Auth and collection-engine catalog tables.

Administrator-created runtime collections cannot be represented by a new Git migration after every
click without turning runtime state into deployment state. Runtime schema needs a separate append-only
history with operation ID, actor, requested/effective definitions, previous/new revisions, generated
SQL digest, timestamps, outcome/error, and recovery bookmark/export reference. This history is an
application contract; D1 does not create it automatically.

Keep the boundaries explicit:

- **repository migrations:** engine/system schema, reviewed and deployed with code;
- **runtime schema operations:** tenant/deployment collection definitions, generated by the engine;
- **data backfills/purges:** resumable jobs tied to a runtime operation;
- **Time Travel/export:** disaster recovery, not normal schema rollback.

### Recovery: Time Travel and export

D1 Time Travel is always on for production-backend databases and restores to any minute within
30 days on Workers Paid or seven days on Free. Restore overwrites the database in place, cancels
in-flight queries/transactions, and returns a bookmark that can undo the restore. Time Travel does
not yet clone/fork a database
([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[limits](https://developers.cloudflare.com/d1/platform/limits/)).

Time Travel is a last-resort database-wide recovery mechanism: using it to undo one collection
change also discards unrelated valid writes after the restore point. Normal destructive evolution
should instead use reversible retirement, shadow tables or explicit per-operation backups. Require
an operator runbook before relying on Time Travel.

Wrangler can export all/schema/data or one table to SQL. Export blocks other database requests and
does not support databases containing virtual tables. A scheduled Workflow can call the D1 export
REST API and stream the dump to R2 for retention beyond Time Travel
([D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/#export-an-existing-d1-database),
[D1-to-R2 Workflow](https://developers.cloudflare.com/workflows/examples/backup-d1/)).

### Local-test fidelity

Wrangler local D1 runs through Miniflare/workerd with the same D1 version Cloudflare runs globally,
keeps local state separate by default and supports programmatic binding access
([D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)).
Cloudflare's Vitest integration runs tests inside the Workers runtime with local Miniflare bindings
and isolated storage per test file
([Workers Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/)).

Local parity is high enough for fast SQL/DDL tests but cannot prove distributed service behavior:
remote queue overload, latency, Time Travel, restore cancellation, replication/bookmarks, control
plane export and production limits need disposable remote-D1 tests. D1 result metadata explicitly
omits remote serving-region/primary fields locally
([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/#check-where-d1-request-was-processed)).
Prototype #219 should make a local/remote result matrix rather than treating either as sufficient.

### Dynamic identifiers and SQL-generation security

D1 binding parameters protect **values**, not SQL grammar or identifiers. D1 currently supports
anonymous/ordered `?` parameters and recommends bound prepared statements to prevent injection
([D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/#bind)).
Collection/table/column/index names therefore cannot be accepted as arbitrary text and passed through
`bind()`.

Required generator rules:

- Keep immutable random internal IDs distinct from editable display/API names.
- Generate physical identifiers from trusted internal IDs, not user labels; use a strict ASCII
  allowlist and deterministic length bound.
- Quote identifiers centrally using SQLite double-quote rules after validation; never interpolate
  unvalidated names, sort fields, filter paths, index expressions or view SQL.
- Compile client filters/rules from a parser/AST with an allowlisted field map and bind every literal.
- Expose index construction as structured columns/order/unique/optional safe predicate, not arbitrary
  SQL.
- Do not expose raw view SQL initially. If added, accept exactly one read-only `SELECT`, reject
  comments/multiple statements/PRAGMA/functions outside an allowlist, impose query-plan/resource
  checks, and bind no administrator-provided identifier directly.
- Avoid `exec()` for user-influenced input. Cloudflare calls it less safe and recommends it only for
  maintenance/one-shot migration work
  ([D1 `exec`](https://developers.cloudflare.com/d1/worker-api/d1-database/#exec)).

## Observable parity and risk matrix

| Capability                | PocketBase observable contract                               | D1/Workers fit                                          | Risk           | Recommendation                                                    |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| Base collection CRUD      | Real table, stable collection/field IDs, typed record APIs   | Direct fit with generated tables and catalog            | Medium         | Prototype first.                                                  |
| Collection/field rename   | Preserves data by stable ID                                  | Native rename exists                                    | Medium         | Preflight dependencies; one guarded operation.                    |
| Field type change         | Rejected                                                     | Requires rebuild/conversion                             | High           | Improvement, not parity; defer and model explicitly.              |
| Field/collection delete   | Immediate destructive drop                                   | Native drop/rebuild; Time Travel is DB-wide             | Critical       | Retire first, delayed purge, impact preview and recovery point.   |
| View collection           | Read-only `SELECT`, inferred fields, list/view only          | SQLite views fit                                        | High           | Defer until SQL validator/dependency graph exists.                |
| All field validations     | Rich application semantics and zero values                   | D1 types/checks plus Worker validation                  | Medium         | Application contract; do not overuse physical constraints.        |
| Multi-select/relation     | Scalar/array modifiers and nested filtering                  | JSON or normalized tables                               | High           | Normalize relations; preserve API shape.                          |
| Query/filter/sort/fields  | Custom language, relation traversal, projection              | Must compile safely to SQL                              | High           | Narrow AST first; cap cost/depth.                                 |
| Expand                    | Up to six levels, per-related-record view rules              | Joins/fan-out queries possible                          | High           | Add later with budgets and authorization at each edge.            |
| Batch record mutation     | One request/transaction; rollback all                        | `batch()` is transactional                              | Medium         | Feasible if predetermined statements; test limits/files boundary. |
| Access rules              | Five rules; null/public/expression; anti-disclosure statuses | Worker policy compiler required                         | Critical       | Ownership/static predicates first; never store raw SQL.           |
| Files                     | Multipart lifecycle, public/protected URLs, thumbnails       | R2 + D1, no cross-service transaction                   | High           | Separate vertical slice with staging/cleanup.                     |
| Schema import/export      | Transactional config import; snapshot migrations             | D1 batch + app catalog; Wrangler export is operator API | High           | Dry-run diff, never default delete-missing.                       |
| Record data import/export | No generic documented Web endpoint; CRUD/batch compose it    | Worker streaming/jobs required                          | Medium         | Specify separately after CRUD.                                    |
| Logs                      | Queryable persisted logs/stats/retention                     | Workers Logs plus optional durable audit/history        | Medium         | Separate operational logs from durable schema audit.              |
| Backups                   | App ZIP list/create/upload/restore                           | Time Travel + SQL export/R2                             | High           | Different UX/semantics; expose recovery capabilities honestly.    |
| Jobs                      | Deployed cron registration and manual run                    | Cron Triggers/Workflows                                 | Low/medium     | Deployed jobs only; no panel scripts.                             |
| Mail                      | SMTP/sendmail abstraction and hooks                          | Existing mail adapter / Email binding                   | Low for engine | Reuse application boundary; defer collection-specific templates.  |
| Deployed hooks            | Rich before/after/request/commit lifecycle                   | Typed Worker registrations and domain events            | High           | Define a small stable event contract after CRUD transactions.     |
| Auth                      | Auth collections and methods                                 | Better Auth already owns Identity                       | Out of scope   | Protect system tables from collection engine.                     |
| Realtime                  | SSE record subscriptions                                     | Not required                                            | Out of scope   | Stabilize internal events without public subscriptions.           |

## Unresolved facts

The following are not established by current primary documentation and must not be assumed:

1. Whether every required multi-statement DDL sequence is accepted atomically by remote
   `D1Database.batch()`, especially `PRAGMA defer_foreign_keys`, rebuild, view/index recreation and
   catalog updates in one batch.
2. Exact remote behavior of a `D1PreparedStatement` object created before a concurrent rename/drop,
   and whether local Miniflare matches it.
3. Whether D1's current SQLite build exposes the newly documented SQLite 3.53
   `ALTER COLUMN SET/DROP NOT NULL`; D1 docs do not promise it, so do not use it without proof
   ([SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html#alter_table_alter_column)).
4. Queueing/failure behavior when record traffic overlaps a long index build or table rebuild,
   including the point at which overload is returned.
5. Practical table size at which drop/rebuild/index creation approaches D1's 30-second limit for
   this workload.
6. Whether a timed-out/disconnected runtime-DDL request's final result can always be reconciled from
   D1 metadata plus the application operation ledger.
7. The exact safe subset and cost model for future administrator-defined view queries.
8. Product requirements for generic record CSV/JSON import/export, because PocketBase's documented
   Web APIs establish schema import and backup but no equivalent generic record transfer endpoint.
9. Retention/compliance needs beyond Time Travel's 30/7-day window and whether scheduled R2 exports
   are required at launch.
10. The eventual user-field cap below D1's hard 100 columns and whether any field kinds consume
    auxiliary columns/tables in the chosen physical model.

## Concrete recommendations for prototype #219

Prototype #219 should answer the unresolved runtime questions, not build product UI.

### Minimal model

Use one protected catalog, one operation ledger and generated physical names. Support only a base
collection with immutable IDs and these field kinds: text, number, bool and date. Include one unique
and one non-unique structured index. Keep Identity/Better Auth tables on a denylist and reject names
that resolve to protected/system objects.

### Required scenarios

1. Create collection/table/catalog/indexes in a D1 batch; introspect and verify exact physical schema.
2. Create/read/update/delete records with bound values and generated identifiers.
3. Rename collection and field while preserving IDs/data/indexes; test dependent view failure even
   if views are not a supported product feature yet.
4. Add a field with existing rows and deterministic zero/default behavior.
5. Retire a field in the catalog without physical drop, then restore it.
6. Purge the retired field using direct drop where legal and a create-copy-drop-rename rebuild where
   not; verify foreign keys, indexes and data checksums.
7. Reject a 101st physical column and prove the chosen lower product cap.
8. Run two mutations from the same expected revision and prove exactly one succeeds.
9. Retry the same idempotency key before, during and after completion; prove no duplicate DDL/history.
10. Prepare record statements before rename/add/drop, execute afterward, and capture exact behavior.
11. Inject failure at every batch/multi-phase boundary and reconcile catalog, physical schema and
    operation status.
12. Overlap record traffic with add/rename/index/rebuild; measure queue latency and overload behavior.
13. Execute the same suite locally and on a disposable remote D1 database; record divergences.
14. Record pre-operation Time Travel bookmark where available, but demonstrate logical rollback by
    retirement/shadow swap rather than restoring the whole database.

### Acceptance evidence

The prototype report should include generated SQL, catalog revisions, `sqlite_master`,
`PRAGMA table_xinfo/index_list/foreign_key_list/foreign_key_check/quick_check`, D1 result metadata,
timings, exact errors, row checksums, and local/remote comparison. It should state whether each
scenario is safe, unsafe or still unknown.

### Architecture direction if the prototype succeeds

- Approve real D1 tables/columns for base collections behind a collection-engine boundary.
- Keep protected system schema in repository migrations and runtime collection history in an
  append-only operation ledger.
- Use stable internal IDs for physical names and editable API/display names as metadata.
- Ship additive create/add/rename plus reversible retirement before physical destructive purge.
- Start rules with authenticated ownership and static predicates; expand the typed rule language in
  vertical slices.
- Treat views, files, broad relation expansion, import, hooks, jobs, logs/backups and mail as later
  independently specified slices.
- Preserve Better Auth and all protected system tables outside generic collection administration.

### Stop conditions

Do not approve the architecture if remote D1 cannot atomically combine the minimum DDL/catalog
change, if unknown write outcomes cannot be reconciled, if concurrent revision control is unreliable,
or if routine rebuilds block record traffic beyond an acceptable operational envelope. In that case,
retain D1 for protected system data and revisit a different persistence/control-plane design rather
than masking unsafe evolution behind the API.

## Primary source index

### PocketBase

- [Collections and field behavior](https://pocketbase.io/docs/collections/)
- [Collections API](https://pocketbase.io/docs/api-collections/)
- [Records and batch API](https://pocketbase.io/docs/api-records/)
- [Rules and filters](https://pocketbase.io/docs/api-rules-and-filters/)
- [Files](https://pocketbase.io/docs/files-handling/)
- [Migrations](https://pocketbase.io/docs/js-migrations/)
- [Logs API](https://pocketbase.io/docs/api-logs/) and [logging extension](https://pocketbase.io/docs/js-logging/)
- [Backups API](https://pocketbase.io/docs/api-backups/)
- [Jobs](https://pocketbase.io/docs/js-jobs-scheduling/) and [crons API](https://pocketbase.io/docs/api-crons/)
- [Mail](https://pocketbase.io/docs/js-sending-emails/)
- [Event hooks](https://pocketbase.io/docs/js-event-hooks/)
- [v0.40.6 source](https://github.com/pocketbase/pocketbase/tree/9d281ccaba65f2686eb7b0b614ccda72d1116a1b)

### Cloudflare and SQLite

- [D1 Worker Binding API](https://developers.cloudflare.com/d1/worker-api/)
- [D1 Database methods](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [SQL statements and PRAGMAs](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [Foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Local development](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [D1 debugging and errors](https://developers.cloudflare.com/d1/observability/debug-d1/)
- [SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)
- [SQLite CREATE VIEW](https://sqlite.org/lang_createview.html)
- [SQLite prepared statements](https://sqlite.org/c3ref/prepare.html)
