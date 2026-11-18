# EXEC-009 Stage 6: trusted CSV comparison baseline

Status: implementation merged and exact-candidate and post-merge validation
verified. Issue #7 and story acceptance remain open.
Owner: implementation controller. Date: 2026-11-16.
Requirements: FR-CON-006/007/008/010/012, FR-EVD-009, NFR-SEC-001,
AC-CON-005, E2E-CON-005, FAIL-006; Issue #7.
Parent increment: connected CREATE/INVALID customer proof, PR #166.

## Problem and fixed boundaries

The public upload controller supplies no baseline. The current repository can
accept an internal raw-key baseline, but the HTTP workflow always computes
baseline-free CREATE proposals. The lower-layer UPDATE/UNCHANGED and conservative
renamed/moved-key tests therefore do not prove those behaviors through the real
upload boundary. Durable row keys are SHA-256 of the canonical sheet/key pair;
raw row keys, complete CSV inputs and unmapped cells must remain unretained.

This work compares source proposals. It publishes no canonical fact, changes no
source authority, and treats a reviewed import as a proposal selection. Human
approval is not a model-callable tool. Preserve the approved interface/layout,
live-onboarding restrictions, immutable migrations and existing user work.

The public endpoint must never accept a client-asserted baseline or silently use
a partial/purged/unauthorized one. Same command and same input must replay the
original receipt after newer uploads, while current permission revocation still
denies the response. No inferred deletion or clearing is introduced.

## Proposed controller decision: comparison cohort

Use the complete prior set of successfully observed CSV record identities and
their last supplied mapped proposal values under the source's mapping, not just
the subset later selected for reviewed import. Selection is a separate workflow;
it cannot erase an unselected but already observed row from comparison history.
This choice is a technical definition of source comparison state, not an
authority rule or promotion of the proposal to a fact. Independent requirements
and source reviews must approve the choice before implementation.

A valid incoming supplied field replaces that field's comparison reference.
An optional missing field leaves its previous reference intact; it does not
clear a value. An invalid/review-required row does not advance its prior values.
Previously accepted identities remain in the complete set even if absent from a
later upload; an unfamiliar incoming key alongside a missing prior identity
requires identity review. Rows missing a baseline are not inferred deleted.
An invalid-only row with no persisted source record does not fabricate one.

The comparison state is scoped to the customer, exact source, sheet and mapping
revision. Configuration/project/reader changes require explicit current scope
validation and a reviewed transition rule; no hidden-project values may enter
an authorized receipt. Mapping incompatibility must fail closed rather than
silently relabel existing observations CREATE. Define the transition explicitly
before implementation; do not infer a reset permission from mapping editing.

## Ordering and immutable command binding

Existing lastSuccessReceiptId is connector-only: its database guard rejects a
CSV receipt. Record/revision/projection tables have no trustworthy current head.
Timestamps and random UUIDs must not select a latest CSV value. An additive,
independently reviewed migration is required; no applied migration is edited.

Proposed minimal shape for review:

1. A CSV comparison head under each applicable source/mapping scope, with a
   monotonic revision and immutable snapshot reference, advanced under the
   existing source lock and compare-and-swap rules.
2. An immutable comparison snapshot/command binding for each new CSV preview.
   It pins the preceding head/revision/digest and a complete bounded state of
   hashed record identities, project IDs and per-fact projection references.
   Reuse immutable projection/content rows; retain no duplicate proposal values
   that could evade the retention policy. The snapshot is evidence of comparison
   inputs and lineage, not business truth.

Challenge this shape in design review. A simpler alternative is acceptable only
if it provides explicit ordering, complete identity coverage, optional-field
carry-forward, retention compliance and immutable replay. A latest full-file
preview alone loses records absent from later files or optional fields omitted
from a row; a reviewed subset alone loses eligible unselected records.

Inside the authorized source transaction, first check an existing command.
Authenticate and authorize current source/project readers before returning its
receipt. Reuse its original baseline binding and compare the original immutable
input identity; never recompute it against the current head. New commands derive
the complete trusted state while locked, validate mapping and permissions,
compute bounded outcomes, persist their immutable binding/results, and advance
the head atomically. Concurrent new commands must serialize or reject stale
state; neither may silently use the same stale comparison head.

Keep existing command/event/source-revision deduplication distinct. Identical
source revision/content reuses its existing record/projection; conflicting bytes
under one immutable revision still fail. A changed unmapped cell can create a
new source revision while its mapped proposals remain UNCHANGED.

## Hashed identity and completeness

Introduce an explicit typed boundary for hashed baseline matching. Do not pass
hashes into the old raw-key matcher, fabricate raw keys from persisted metadata,
or retain raw keys merely to reuse that function. Apply exactly the same
canonical sheet/key hashing used by durable CSV records. Current raw keys may
exist transiently while parsing the bounded incoming file.

The complete identity set and per-record field-reference set must have explicit
limits derived from the existing 1,000-row/32-field contracts. Any overflow,
missing projection, incompatible fact type, unsealed/invalid receipt, purged
required proposal content, legacy history without a trustworthy ordering pin,
or incomplete historical coverage fails closed with a finite safe result.
Never truncate to a limit, choose an arbitrary record on a tie, silently omit an
unauthorized record or report unavailable comparison data as an empty baseline.
The first truly empty source can have a verified empty comparison state.

Define exact serialized-size bounds, sorted ordering, hash inputs and SQL
reference validation before implementing snapshot storage. The head/snapshot
must be customer/source/project/mapping bound, with receipt lineage guarded in
SQL against direct API-role tampering. Only allowed API operations may advance
it; worker mutation remains denied and backup/restore privileges remain explicit.

## Required review decisions before implementation

- Resolve configuration-scope transitions and old-mapping data without hidden
  value disclosure or an invented reset/delete permission.
- Establish handling of legacy CSV history; do not manufacture a chronological
  backfill from dates/UUIDs. Determine whether a safe explicit unavailable state
  permits an administrator remediation path under existing requirements.
- Pin the smallest safe SQL schema/constraints, lock order, snapshot size bound,
  retention behavior, role matrix and immutable receipt validation rules.
- Define supported rollback: older applications must not create unbound previews
  on activated sources. A fail-closed CSV boundary is preferable to corrupting
  comparison state, but its operational behavior must be explicit and reviewed.
- Decide whether unavailable comparison returns a bounded error or row-level
  REVIEW_REQUIRED state without inventing an unapproved authority/reset workflow.

## Validation and acceptance gates

Pure/domain controls cover hashed stable identity, CREATE/UPDATE/UNCHANGED,
optional blanks with no clearing, duplicate keys, moved projects, renamed keys,
missing prior rows, invalid fields, unknown/incomplete state and exact limits.
Do not replace the existing raw-key primitive tests with mocks of the new path.

Native API-role/owner probes cover complete state, counter/parent/receipt/hash
tampering, unauthorized reader/project/mapping transitions, purge, legacy state,
overflow, concurrent new commands and same-key races. Existing command replay
must succeed with the original baseline after intervening uploads, and fail for
changed bytes or lost current permission. Verify one result/audit batch on retry.

The real browser/API/database journey must upload an actual prior file, then a
changed file showing UPDATE and UNCHANGED before saving selected proposals. A
real renamed/moved-key upload must require identity review and refuse selection;
canonical/project projections remain unchanged. Add current receipt reads/replays
after recreation and native checks before restore mutation probes. Preserve
strict original-response disclosure and runtime CONNECT quarantine.

Run full build/lint/typecheck/unit, relevant browser and native migration/recovery
checks. Require independent design, evolving-source and exact-candidate reviews,
fresh hosted checks and current original evidence before merge. Update table and
migration inventories only from the final reviewed schema. No complete story,
source-publication or release acceptance is implied by this draft.

## Controller resolutions after the first independent audit

The three read-only audits agree on the reference-only head/snapshot direction.
The following proposed resolutions narrow the implementation; they still need
the concrete SQL/native guard review described below.

- New comparisons use all successfully observed valid rows, including eligible
  unselected rows. Invalid/review-required rows preserve prior coverage/values.
  Optional missing fields preserve their original projection reference and clock.
- Keep the existing HTTP input fingerprint (CSV hash, explicit configuration and
  mapping revisions, baseline:null). Store server comparison context separately
  and immutably. Resolve a matching command under current authorization before
  reading newer heads, expired content or capacity limits; metadata-only replay
  must not advance state or resurrect content.
- Reader-only changes and scope widening can retain state only when mapping
  semantics remain identical, every carried project stays configured, and the
  actor has current grants/source-reader rights across the complete state.
  Scope narrowing or mapping/identity/sheet changes fail new comparisons closed;
  they do not filter prior rows or initialize an empty head. No reset is added.
- Initialize verified-empty state only when native history proves there are no
  prior persisted source records/accepted CSV observations. Existing unordered
  populated history is unavailable for new comparisons. Preserve supported
  authorized old receipt reads and exact metadata replay; no chronological
  backfill, reset, deletion or remediation workflow is inferred.
- Unavailable, expired, purged, incompatible or incomplete comparison state
  rejects the whole new preview with a finite safe error and no receipt/head
  mutation. Row-level INVALID/REVIEW_REQUIRED is reserved for input conflicts
  evaluated against a valid complete baseline. Map the finite error consistently
  through the domain/API/UI without exposing hidden project or content details.
- Retention expiry alone, even without a purge job, can make new comparisons
  unavailable. Re-uploading unchanged bytes does not restore immutable expired
  content. This can be a lasting availability limit; document it explicitly.
  Per-field carry-forward never renews the old observation or its retention.
- An older application must fail closed for new unbound previews after feature
  activation, while compatible historical reads/replays remain supported.
  Prefer roll-forward; no comparison history is dropped during rollback.

### Candidate bounds and encoding for the concrete review

Use at most 1,000 cumulative retained identities, 32 distinct fields per identity,
32,000 total field references and 100 project scopes. This is a cumulative cohort
limit, not a per-file limit. Overflow fails the entire new command; absent rows
are not dropped to regain room. Check LIMIT+1/counts before materializing data.

Propose one immutable mapping-bound dictionary of fact types/value types and
compact rows containing hashed key, record/project IDs and sorted index/UUID
projection references. Avoid repeating 96-character field names 32,000 times.
Pin a versioned canonical encoding and a 2 MiB UTF-8 state limit only after a
worst-case proof including serialization overhead. Bigint head revisions remain
checked decimal strings at JavaScript boundaries, never unsafe Numbers.

Bound unique retained proposal content before decoding/comparing it as well as
the reference metadata. Sparse carry-forward across many files can accumulate
more content than one incoming CSV. Reuse the existing 4 MiB serialized content
boundary where compatible; reject oversize rather than partially dereferencing.
Acquire the required policy/projection/content locks before validating expiry,
hashes and the byte budget so purge and comparison cannot race.

For review, cap per-source immutable comparison metadata at 4,096 contexts and
256 MiB of stored state. Store validated per-row byte counts and aggregate those
bounded counters under the source lock; do not repeatedly decode every historic
snapshot to count its bytes. Existing-command metadata replay does not allocate
a new context and remains eligible at the cap. These are proposed technical
limits, not a history deletion permission. Review the storage/availability cost
and any safe state deduplication before fixing the final schema/constants.

### Concrete SQL review still required

Specify the two table definitions, foreign keys, versioned payload schema/hash,
the exact canonical serializer shared by SQL and TypeScript, initialization and
activation guards, transition validator and deferred receipt/head binding.
Validate that the resulting complete set equals the prior state plus accepted
current observations, with only permitted per-field reference replacements.
Cross-source/project/mapping references, duplicated indexes, extra identities,
state counter/digest tampering and unbound old-binary writes must all fail native
commit, not merely application validation. Pin API/worker/backup privileges and
the complete lock order, including retention/purge, before implementation.

Add tests for prior value -> optional blank -> same value, omitted identities
returning later, unmapped-only changes, raw input equal to a stored 64-hex hash,
cumulative overflow across valid files, expiry without purge, purge/permission
races, old-command replay after newer uploads/expiry, legacy sources and old
applications. No schema/application implementation is authorized by a claim
that this unresolved concrete-design gate has already passed.

## Concrete schema and transaction proposal for final design review

Use exactly two new business tables, named `IngestionCsvHead` and
`IngestionCsvContext`. After the retention correction, this proposes 87 business
tables and 28 migrations;
inventories must follow the actual approved migration, not this prediction.

`IngestionCsvHead` has a customer/source composite primary key and source FK;
immutable activation configuration/mapping revisions and a sorted mapping
dictionary; immutable `READY`/`LEGACY_UNAVAILABLE` initialization; bigint revision;
nullable current context receipt ID; nullable state hash; and bigint cumulative
canonical bytes. READY revision zero has no context, the verified-empty-state
hash and zero accumulated bytes. LEGACY_UNAVAILABLE has no context/hash and
zero counters. Only revision/current receipt/hash/byte-counter columns are
API-updatable, and native guards require one exact applied successor.

`IngestionCsvContext` is keyed by its CSV preview receipt ID, with a composite
customer/source/receipt FK, unique customer/source/revision and the receipt's
configuration/mapping revisions. It stores predecessor receipt ID/revision/hash,
complete sorted reference-only rows, canonical byte count and state hash.
Require successor revision = predecessor + 1; revision one has an absent parent
receipt and the head's verified-empty hash. Context mutation and truncation are
denied. Head/current-context and predecessor FKs are restrictive and deferred
where insertion order requires it. No reference uses timestamp/UUID ordering.

Hash this exact array grammar:

```text
["pdaa.csv.state.v1", customerId, sourceId, mappingRevisionString,
 sorted [[factType,valueType],...],
 sorted [[hashedKey,recordId,projectId,
          [[fieldIndexString,projectionId],...]],...]]
```

All tokens are canonical lowercase UUID/hex, normalized decimal strings, the
existing ASCII fact-type grammar or four fixed value types. Field indexes sort
numerically; identities/dictionary use bytewise ordering matching SQL COLLATE C.
There are no generic objects, arbitrary Unicode/escaped strings, raw sheet/key
text or proposal values. TypeScript JSON.stringify produces compact bytes.
Only after complete grammar validation may SQL remove JSONB formatter spaces
and recompute identical SHA-256/length. Do not use this serializer for generic
JSON or proposals. The dictionary is immutable on the head and injected into
each hash input; context rows store references, not duplicate dictionaries.

An independent worst-case calculation for this exact grammar gives 1,614,668
canonical ASCII bytes at maximum row/reference/dictionary lengths. Retain the
2 MiB state bound. The 256 MiB history budget counts accumulated canonical
serialized-state bytes, not physical PostgreSQL/TOAST/index/WAL/backup storage.
It permits about 166 maximum-grammar states, or 128 states at the full byte cap;
4,096 contexts is a separate ceiling. Both limits are checked atomically and
old-command replay allocates nothing. No deletion or reset is introduced.

Initialize heads natively after a source's current sealed configuration becomes
CSV. An AFTER source-configuration-pointer trigger can observe the now-current
sealed mapping without a transient old-pointer exception. It initializes only
when no head exists, derives the dictionary/classification from native data and
uses a head INSERT guard that independently verifies those inputs. Migration
backfill uses the same classification for existing CSV sources. Existing
records, accepted observations or any prior CSV preview receipt (including an
invalid-only preview) mean LEGACY_UNAVAILABLE. This preserves legacy receipt
validity without an invented migration-time ordering marker. Mapping changes retain
the old head. API gets guarded head INSERT plus narrow UPDATE; no caller reset
flag or privileged reset function exists.

An INSERT-only deferred CSV receipt requirement applies to new previews after
the migration: every new preview must have its valid context and applied head.
Historical receipts are left unchanged. Context INSERT guards derive the exact
next state from the preceding state plus the current receipt's accepted rows;
they must include accepted NONE identities with zero proposal references.
Omitted identities and optional omitted fields carry forward. Only supplied
fields may replace references, and only with that receipt's accepted projection.
Recompute CREATE/UPDATE/UNCHANGED/NONE and conservative identity eligibility from
the trusted prior values and finite hashed outcomes. Require exact set equality,
not subset membership. Defer receipt completeness checks where necessary and
avoid recursion with valid_ingestion_receipt.

Historical structural validity is distinct from live content availability.
The insertion/commit guard validates live values and classification then;
immutable context/receipt structure must remain valid after later lawful purge.
The static restore validator verifies structure, references and transition
lineage without restoring or requiring redacted plaintext. A new transition
still rejects expired/missing content, including expiry without a purge job.

Within a new preview transaction, use current sorted project/grant fences,
optional retention-policy SHARE, source UPDATE, head UPDATE and sorted content
SHARE. A missing policy row must not itself prevent an existing metadata replay;
require policy/content only after resolving an existing command. Policy lock
acquisition does not renew data or evaluate expiry/capacity for a replay. Do not
add row locks or UPDATE privileges to immutable receipts/records/revisions/
projections: current ACLs give SELECT/INSERT only. Use source serialization and
immutable/FK anchors instead. Align the new path with purge's policy-before-
source order; preserve current authorization and explicit operation timeouts.

Bound unique complete projection-content arrays referenced by the preceding
and resulting state as one logical 4 MiB union before returning/decoding that
union. Count full content, not only selected fields. The incoming CSV has its
separate existing 1 MiB limit; these are serialized-data limits, not a claim
about exact JavaScript heap usage. Under the content/policy locks, validate
original revision age using clock_timestamp, hash/schema/type integrity and
current complete permissions. References do not refresh clocks or inhibit purge.

Public request identity stays CSV hash + submitted revisions + baseline:null.
Current authorization must precede existing-command return; new-head selection,
new-command configuration rejection, content dereference and capacity checks
follow it. Preserve supported old metadata replay even after intervening uploads
or expiry. Refuse caller-asserted baselines at the repository boundary. The new
hashed matcher must hash raw incoming keys exactly once, including raw text
that happens to be 64 hex characters. No raw key is retained to reuse the old
matcher. The old raw-key domain helper can remain a separately tested primitive.

API gets SELECT/INSERT on contexts and guarded narrow head access. Worker gets
no new privileges; backup gets SELECT. Migration role owns tables/functions.
Private trigger functions stay non-callable; grant only required read validators
to API and rebuild the finite function matrix during roleless bootstrap and
quarantined restore. Native tests must demonstrate actual restricted-role
operations, not only owner connections or mocked repository results.

Final design review must approve the exact DDL/function signatures, serializer
vectors, static/live validator split, lock/replay ordering and metadata-budget
availability limitations before these definitions become an applied migration.

## Native definitions submitted for the concrete design gate

These are proposed migration-28 definitions, not an applied migration. Use the
existing UUID, configuration, receipt and projection keys; introduce no timestamp
ordering or additional privileges on immutable ingestion tables.

```sql
CREATE TABLE public."IngestionCsvHead" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "activationConfigRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  dictionary jsonb NOT NULL,
  readiness varchar(24) NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  "currentReceiptId" uuid,
  "stateHash" char(64),
  "canonicalHistoryBytes" bigint NOT NULL DEFAULT 0,
  PRIMARY KEY ("customerId","sourceId"),
  UNIQUE ("customerId","sourceId","mappingRevision"),
  FOREIGN KEY ("customerId","sourceId")
    REFERENCES public."IngestionSource"("customerId",id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","sourceId","activationConfigRevision","mappingRevision")
    REFERENCES public."IngestionConfigurationRevision"
      ("customerId","sourceId",revision,"mappingRevision")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("activationConfigRevision">0 AND "mappingRevision">0),
  CHECK (revision BETWEEN 0 AND 4096 AND "canonicalHistoryBytes" BETWEEN 0 AND 268435456),
  CHECK (readiness IN ('READY','LEGACY_UNAVAILABLE')),
  CHECK ((readiness='LEGACY_UNAVAILABLE' AND revision=0 AND "currentReceiptId" IS NULL
          AND "stateHash" IS NULL AND "canonicalHistoryBytes"=0)
    OR (readiness='READY' AND "stateHash" IS NOT NULL AND "stateHash" ~ '^[a-f0-9]{64}$'
      AND ((revision=0 AND "currentReceiptId" IS NULL AND "canonicalHistoryBytes"=0)
        OR (revision>0 AND "currentReceiptId" IS NOT NULL AND "canonicalHistoryBytes">0))))
);
CREATE TABLE public."IngestionCsvContext" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "configRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  revision bigint NOT NULL,
  "predecessorReceiptId" uuid,
  "predecessorRevision" bigint NOT NULL,
  "predecessorHash" char(64) NOT NULL,
  rows jsonb NOT NULL,
  "canonicalBytes" integer NOT NULL,
  "stateHash" char(64) NOT NULL,
  PRIMARY KEY ("receiptId"),
  UNIQUE ("customerId","sourceId",revision),
  UNIQUE ("customerId","sourceId",revision,"receiptId","stateHash"),
  FOREIGN KEY ("customerId","sourceId","receiptId")
    REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","sourceId","configRevision","mappingRevision")
    REFERENCES public."IngestionConfigurationRevision"
      ("customerId","sourceId",revision,"mappingRevision")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","sourceId","mappingRevision")
    REFERENCES public."IngestionCsvHead"("customerId","sourceId","mappingRevision")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","sourceId","predecessorRevision","predecessorReceiptId","predecessorHash")
    REFERENCES public."IngestionCsvContext"
      ("customerId","sourceId",revision,"receiptId","stateHash")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (revision BETWEEN 1 AND 4096 AND "predecessorRevision"=revision-1),
  CHECK ((revision=1)=("predecessorReceiptId" IS NULL)),
  CHECK ("predecessorHash" ~ '^[a-f0-9]{64}$' AND "stateHash" ~ '^[a-f0-9]{64}$'),
  CHECK ("canonicalBytes" BETWEEN 1 AND 2097152),
  CHECK (jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=1000)
);
ALTER TABLE public."IngestionCsvHead" ADD CONSTRAINT "IngestionCsvHead_current_context_fkey"
  FOREIGN KEY ("customerId","sourceId",revision,"currentReceiptId","stateHash")
  REFERENCES public."IngestionCsvContext"
    ("customerId","sourceId",revision,"receiptId","stateHash")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
```

The insert/transition guards must reject NULL or false from every grammar/hash
validator explicitly with `IS NOT TRUE`; SQL CHECK's treatment of NULL must never
make an invalid dictionary or hash acceptable. READY requires an explicit
non-NULL digest even at revision zero. Add direct constraints or guards for
this property rather than relying on the regex alone.

Proposed finite function signatures:

| Function | Volatility and caller | Responsibility |
| --- | --- | --- |
| `valid_ingestion_csv_state(uuid,uuid,integer,jsonb,jsonb) RETURNS boolean` | IMMUTABLE, API executable | Strict six-element state grammar, dictionary/identity/index ordering, bounds; false for any NULL or malformed token. |
| `ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb) RETURNS text` | IMMUTABLE, API executable | Return canonical ASCII only after full grammar validation; NULL otherwise. |
| `valid_ingestion_csv_context(uuid) RETURNS boolean` | STABLE, API executable | One context's static scope/hash/byte/reference/parent/result structure; no expiry or plaintext requirement. |
| `valid_ingestion_csv_head(uuid,uuid) RETURNS boolean` | STABLE, API executable | Exact READY or legacy shape; ledger count/sum/current pointer and initial digest. |
| `guard_ingestion_csv_head() RETURNS trigger` | private invoker | Derive initial classification/dictionary; allow only exact successor counters/pointer and immutable activation metadata. |
| `initialize_ingestion_csv_head() RETURNS trigger` | private invoker | AFTER source configuration-pointer insertion/update, initialize missing CSV head only. |
| `guard_ingestion_csv_context() RETURNS trigger` | private invoker | INSERT only; live locked comparison and exact reference-state transition; deny UPDATE/DELETE. |
| `require_ingestion_csv_complete() RETURNS trigger` | private invoker | Deferred INSERT-only receipt/context/head binding and final static integrity. |

Use `SET search_path=pg_catalog,public` on all functions. No SECURITY DEFINER.
Do not split the live validator into a private nested function called by an
invoker guard: that call would require the executing API role's EXECUTE grant.
Keep the live validation in the trigger body, with only the four safe read/pure
validators granted to API. Rebuild the same finite matrix after roleless
bootstrap and `--no-acl` restore. Add no worker access; backup receives SELECT
on both tables. Head INSERT is guarded; UPDATE permits only revision,
currentReceiptId, stateHash and canonicalHistoryBytes. Context is SELECT/INSERT.
No DELETE/TRUNCATE or update grant to either history table is introduced.

### Static proof and transition algorithm

The dictionary has 1..32 unique fact types sorted with COLLATE C, each paired
with exactly one of text/date/number/boolean. Every identity row has exactly
four entries: lowercase 64-hex key, lowercase UUID record, lowercase UUID
project, and at most 32 unique field-index/projection pairs sorted by numeric
index. Require index strings to be canonical integers 0..dictionary.length-1.
Require rows to be strictly key-sorted, at most 1000 distinct identities and at
most 100 distinct projects. Arrays contain no NULL, extra entries, objects,
control characters, escapes or arbitrary text. Validate customer/source UUID
and positive normalized mapping-revision string before serialization.

Construct `jsonb_build_array('pdaa.csv.state.v1', customerId::text,
sourceId::text, mappingRevision::text, dictionary, rows)`. Only after validation,
remove the formatter's ASCII spaces and hash the UTF-8 bytes using existing
pgcrypto SHA-256. Since permitted tokens contain no spaces or escapes, this
matches compact JSON.stringify; generic JSON does not have that guarantee.
Pin empty and nonempty serializer vectors and run the same vectors through
PostgreSQL and TypeScript before migration/persistence acceptance or merge.

A static context validator checks its exact CSV_PREVIEW/HUMAN receipt scope,
configuration/mapping, predecessor digest/revision, canonical length/hash,
record/project/sheet binding and every projection's matching record/mapping/
fact-type membership. It checks reference-only transition shape from the prior
state and current ACCEPTED outcomes, including accepted NONE rows. It never
requires retained proposal plaintext to remain valid. The context validator
must not call valid_ingestion_receipt; the receipt validator may call the
context validator after its existing receipt rules, avoiding recursion.

READY implies no CSV preview receipt or record/accepted history existed at native
activation. Even invalid-only legacy previews cause LEGACY_UNAVAILABLE. Require every CSV
receipt on a READY source to have a structurally valid context. Legacy CSV
receipts remain valid under LEGACY_UNAVAILABLE, while all new previews on that
source are rejected by the INSERT-only deferred guard. No old unbound preview
can be introduced after activation, including by an older application binary.
Do not backdate or infer this distinction from a timestamp or UUID.

For a new command under the defined locks, reconstruct the prior complete
identity/reference map, then validate one exact ACCEPTED-observation overlay.
Preserve absent identities and each absent optional field reference. Replace
only supplied fields using the current accepted projection; zero-field accepted
rows still enter the identity set. INVALID/REVIEW_REQUIRED rows cannot replace
references. Recompute conservative identity-review eligibility from the finite
outcomes and complete prior identity set, then CREATE/UPDATE/UNCHANGED/NONE from
live, typed values. Enforce exact equality with every persisted operation and
with the full submitted successor state, not subset containment.

A separate live pass in the context INSERT guard checks the policy, expiry at
clock_timestamp(), content digest/schema/type, and union byte bound under the
retention/content locks. Reject missing or purged content; no reference refreshes
receivedAt. Historical structure cannot depend on this live pass after commit.
The source lock serializes new commands; the context must name the old head;
advance the head once by one and add exactly canonicalBytes to its history
counter. Head validation checks count=revision, sum(bytes)=historyBytes and the
highest explicit revision equals its current context. Unique revisions plus
exact predecessor FKs prohibit branches, gaps, unreferenced successors and cycles.

Failure results stay within the existing bounded vocabulary: current access
loss is DENIED; malformed/client baseline is INVALID_REQUEST; incompatible
submitted/current mapping is STALE_CONFIGURATION; absent required policy is
RETENTION_REQUIRED; unavailable legacy/expired/purged comparison or capacity
exhaustion is INVALID_PREVIEW; corrupted native anchors are INTEGRITY_CONFLICT.
Do not expose hidden keys, project IDs, values or retention details in errors.
Existing matching command replay remains authorized metadata-only and precedes
all new-comparison availability/capacity checks.


### Fixed canonical serializer vectors

These synthetic vectors pin bytes and SHA-256. Python and Node compact serialization must agree; native PostgreSQL equivalence is still a required implementation test.

`empty`: 162 ASCII bytes, SHA-256 `8838197404eeea2374fac6f83e03704340884e543b2c55642630ab1be0cbbfab`.

```json
["pdaa.csv.state.v1","00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","1",[["project.forecast","date"],["project.status","text"]],[]]
```

`two-supplied-fields`: 400 ASCII bytes, SHA-256 `d79544a42b54cb5484e6991b0e70b3d66152618e557214876711039a835a0bd6`.

```json
["pdaa.csv.state.v1","00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","1",[["project.forecast","date"],["project.status","text"]],[["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","00000000-0000-4000-8000-000000000010","00000000-0000-4000-8000-000000000003",[["0","00000000-0000-4000-8000-000000000020"],["1","00000000-0000-4000-8000-000000000021"]]]]]
```


## Concrete-review corrections: transaction, native fences and trigger wiring

These resolutions supersede the earlier shorthand wherever it omits one of the
following scopes or events. Three independent reviewers approved the corrected
design at SHA-256 a9d8b69181fd347ad34776f0cde08c63123bc94ce10333cb224b7b72e726bbde.
The controller accepts that design under the existing delegation. No migration
has been applied; native and implementation gates remain open.

### Replay and configuration transaction plan

Parse only the bounded public command shape, submitted revisions and complete
CSV hash before transaction entry. Refuse a caller baseline as INVALID_REQUEST;
do not decode it or use it as comparison state. The constant baseline:null
fingerprint remains identical to existing HTTP commands. Do not run the mapper,
reject a current CONNECTOR mapping, validate submitted revisions against the
current configuration, select a head, dereference content or evaluate capacity
before resolving an existing command.

Read minimal current source/configuration scope and any exact subject/kind/key
receipt with its original project scope as an internal lock plan. This metadata
read is customer/source bound and returns nothing to the caller. Lock the sorted
union of original receipt projects and the current complete configuration,
then the actor's applicable grants. This replay union can contain 200 projects;
the 100-project comparison-state/configuration/receipt bounds remain separate.
Do not route the 200-project lock plan through a helper that rejects write scopes
above 100. Factor lock planning from operation scope validation.

Acquire optional policy SHARE, then source UPDATE; re-read the current sealed
configuration and exact command under that source fence. If the internal scope
plan changed during lock acquisition, abort the transaction with bounded
CONFLICT, without writing a preview/context/head. This is an internal planning
race, not rejection of the client's historical revisions. A subsequent stable
attempt must replay. Recheck current grants and source-reader membership for
every project in the original receipt scope plus the current complete
configuration; a project absent from the current source-reader configuration
fails DENIED. Never filter old scope or content to obtain a partial replay.

For an existing receipt, compare the immutable request hash and validate static
receipt/context integrity, then return the original metadata. Only a new command
checks submitted/current revisions, mapping kind/head compatibility, policy
existence and live content/budgets. Map the parsed incoming CSV inside this
locked new-command branch. The current persistCsvPreview method must therefore
be refactored; its pre-transaction mapping and pre-replay stale checks cannot be
retained for this path.

Reorder the supported configure path to the same project/grant-before-source
order. Read its old configuration and all historical ConnectorSyncGrant scopes
without locks as a plan, union them with the submitted scope, acquire sorted
project/grant fences, then source UPDATE, recheck the exact planned configuration
and grant inventory, and only then lock sorted sync grants. A changed plan aborts
without configuration effects. New-source creation similarly fences submitted
projects before insertion; a concurrent creation conflicts safely. Preserve the
existing requirement to authorize ALL historic sync-grant projects: that
configuration union is not silently capped at 100 or 200 or truncated. The
existing transaction timeout remains its finite execution bound. Add real
configure-versus-preview/replay and grant-revocation races to prove ordering and
whole-transaction rollback.

### Native fences independent of repository discipline

Implementation refinement reviewed on 2026-11-16: the complete comparison scope
is the predecessor context's immutable configuration scope, or the activation
configuration at READY0. A succeeding comparison may widen that set but cannot
remove even a configured project with no accepted observation. Widening becomes
durable when a comparison records it; an intervening configuration that never
supplies a comparison does not redefine the trusted cohort. The loader rejects
a missing project before plaintext; the native guard independently locks the
same union and enforces it. Static validation preserves the immutable rule.

The planned INVALID_PREVIEW/409 result is retained for unavailable comparison
state. Private live guards use finite SQLSTATE PDC01 for unavailable data,
PDC02 for a changed lock plan/predecessor and PDC03 for denied current scope.
The repository accepts only matching structured PostgreSQL adapter codes from
a P2010 error; it maps these to INVALID_PREVIEW, CONFLICT and DENIED without
reading or exposing SQL message/detail text. This keeps an expiry crossing the
final native check consistent with expiry detected by the loader. Other SQL
errors retain the existing bounded persistence failure. Native boundary and
race evidence remains required before candidate approval.

The context BEFORE INSERT guard independently derives current/previous project
scope and the receipt subject's grants, takes sorted project/grant fences, policy
SHARE, source UPDATE and head UPDATE, then rechecks configuration/permissions
and predecessor before reading live content. The caller cannot substitute an
assertion that the repository already holds these locks. Existing immutable
receipt/record/revision/projection rows are read with ordinary SELECT, never row
locked by granting UPDATE. Content SHARE locks are sorted and acquired before
live values, age, hashes and the complete union budget are validated.

A head BEFORE UPDATE guard first requires its exact proposed successor context
to exist, with matching old predecessor, revision, receipt and hash. It then
rechecks the same current anchors and counters. A valid uncommitted successor
must have passed the context INSERT guard in this transaction and therefore
retains the native source/head fences. A committed orphan successor cannot
exist because deferred context completion rejects it. A direct head update
without that context fails immediately; it must not acquire further locks in
an attempt to legitimize an arbitrary pointer. No privilege or lock-introspection
escape hatch is added.

PostgreSQL can acquire an UPDATE tuple lock before a BEFORE ROW trigger runs.
Native guards preserve safety even for arbitrary direct API-role statement
ordering; they do not promise deadlock-free execution for hostile statement
sequences or existing trigger paths. Such a conflict must abort atomically
under the existing timeout/deadlock handling. Supported repository paths use the
canonical order above. Native race tests must demonstrate successful serialization
or a complete bounded abort with no orphan/context/counter/audit change; they
cannot waive a partial write or widen grants to make a deadlock pass.

### Exact trigger events

Use these named events in migration 28; every trigger function is a private
invoker with fixed search_path. Add the corresponding BEFORE TRUNCATE statement
triggers on both tables, unconditionally rejecting truncation.

| Trigger | Table/event/timing | Required final condition |
| --- | --- | --- |
| ingestion_csv_head_guard | Head BEFORE INSERT OR UPDATE OR DELETE, ROW | Derive initialization; reject deletion; check exact successor and immutable fields. |
| ingestion_csv_context_guard | Context BEFORE INSERT OR UPDATE OR DELETE, ROW | INSERT-only live/native fences and transition; reject mutation/deletion. |
| ingestion_csv_initialize | Source AFTER INSERT OR UPDATE OF currentConfigRevision,mappingRevision, ROW | Initialize a missing head only when the current sealed mapping is CSV; retain any existing head. |
| ingestion_csv_receipt_complete | Receipt AFTER INSERT, ROW, WHEN NEW.kind='CSV_PREVIEW', CONSTRAINT DEFERRABLE INITIALLY DEFERRED | Every newly inserted CSV preview requires a READY head, matching valid context and complete applied lineage. |
| ingestion_csv_context_complete | Context AFTER INSERT, ROW, CONSTRAINT DEFERRABLE INITIALLY DEFERRED | New context is valid and belongs to the complete chain ending at the final head; no orphan context. |
| ingestion_csv_head_complete | Head AFTER INSERT OR UPDATE, ROW, CONSTRAINT DEFERRABLE INITIALLY DEFERRED | Re-read final head, require valid count/sum/digest/current pointer and all committed contexts covered. |

Deferred checks read the final stored head, not a stale NEW image captured during
initialization or the OLD image during BEFORE UPDATE. If multiple valid commands
occur in one transaction, an earlier context can be an ancestor of the final
head; explicit unique revisions, predecessor FKs and exact ledger totals prove
coverage without timestamps or recursive function cycles. Pin independent raw
API-role probes for receipt-without-context, context-without-head-advance,
head-without-context, substituted parent/hash/bytes, extra contexts, skipped
revision, deletion and truncation. Each rejection must leave the entire graph
and material audits unchanged.

### Historical receipts on a current non-CSV source

A source with historical CSV receipts may currently have a CONNECTOR mapping
and therefore no CSV head. Preserve its historical no-head receipts with the
existing structural receipt validator. The INSERT-only deferred CSV guard still
requires READY/current-CSV/context for EVERY new preview regardless of whether a
head was backfilled, so this compatibility branch does not permit new unbound
writes. Later CSV activation derives LEGACY_UNAVAILABLE from any existing CSV
preview (including invalid-only history), record or accepted observation; it
cannot manufacture an empty READY head. Add populated old-CSV/current-CONNECTOR
upgrade and read/replay fixtures, followed by a denied fresh preview and denied
old-binary direct insert. Existing historical receipts must remain structurally
valid after that later activation.

### Serializer review timing

The fixed ASCII grammar, bytes and hashes are design inputs; Python/Node vectors
have been checked. PostgreSQL equivalence has not run. Concrete design approval
authorizes writing the pure serializer/prototype and its synthetic native tests.
Those tests must prove both fixed vectors, sorting and malformed-token rejection
before the migration/persistence candidate can pass acceptance or merge. Do not
claim a native result merely from design approval, and do not require an applied
migration as a prerequisite for reviewing its pure prototype.

## Pure state prototype progress, 2026-11-16

The initial domain serializer validates and copies the complete reference-only ASCII
grammar, freezes all returned arrays, and exposes canonical text/byte counts.
It enforces numeric field ordering, unique identities/records, 1,000 lifetime
identities, 32 fields and 100 projects. That initial prototype contains no database
queries, value retention, comparison matcher or HTTP integration. Native identity binding,
transition authorization and live retention checks remain implementation work.

All 82 focused controls pass, including both fixed digest vectors, the independently
calculated 1,614,668-byte maximum, invalid structure/sorting/bounds, copied/frozen
state and 35 trailing-line-separator cases. Scoped strict TypeScript checking
and the normal source lint rules pass. A frozen-lockfile installation encountered
a Windows dependency-link EPERM; validation therefore used exact SHA-256-pinned
copies of the two new files with the already installed pinned runtime. The lockfile
is unchanged and the failed installation is retained. These are focused prototype
results, not a full Stage 6 workspace/native/customer acceptance.

The local Docker engine is unavailable, so no PostgreSQL serializer equivalence
has run and no database was changed. Three evolving source reviews find no
remaining blocker. Full implementation and exact-candidate/native/upgrade/recovery
checks still gate merge; no story or release acceptance changes.

## Native serializer prototype source, 2026-11-16

[The native prototype](prototypes/csv-comparison-state.sql) defines only the two
pure grammar/text functions. It reads no application tables and is outside the
applied migration directory and startup paths. Both functions are immutable
invokers with fixed search paths and PUBLIC execution revoked. Dictionary,
identity ordering and DISTINCT record/project counts explicitly use C collation;
bounded set counts avoid repeated growing array membership scans. The normal
role matrix will grant the approved read validators only when the actual
migration is implemented and reviewed.

Three independent static reviews approve the prototype direction; PostgreSQL
compilation and execution have not run. SQL customer/source UUID and mapping
revision are typed parameters, derived from native anchors. PostgreSQL normalizes
valid UUID spellings and rejects invalid casts before function entry. Native
parity tests must compare canonical typed scope inputs and all dictionary/row
grammar controls; they must not claim verbatim function-level parity with every
malformed raw TypeScript scope/revision case. Transport/full-state parsing and
native casts need their separate denial controls. Fixed vectors, maximum-state
execution, invoker ACL behavior and all later persistence guards remain required.

## Hashed comparison primitive, 2026-11-16

PR #166 merged as 7ce15ec9377f5e7d143f2665c42452ed6cf8141b after all exact-head
checks and independent source/CSV/recovery/distribution artifact reviews passed.
Its tree is 01f9c8843da36259d20adeb31a690415d837fb35. This continuation contains
that merge while preserving the separately reviewed local prototypes. The parent
proves baseline-free CREATE; it does not complete UPDATE or story acceptance.
Post-merge Foundation run 43805983699 and Documentation run 43805983637 both
passed on the actual merge commit; its tree matches the reviewed candidate.

The pure CSV mapper now has a separate hashed-baseline schema and typed result.
An internal normalized-identity comparison engine preserves the original raw-key
CSV/grid/synthetic helpers. The new entrypoint requires an explicit baseline
shape; its repository caller must establish complete native state. For a verified
empty source that shape contains an explicit empty rows array. Shape validation
alone establishes no completeness, authorization, current grant, retention or
native reference binding. The native loader and guards remain necessary.

The repository-owned synchronous hash callback receives the exact untrimmed sheet
and raw key once per distinct valid incoming key. Valid keys on invalid-project
or invalid-field rows still participate; invalid keys remain unhashed. Stored
baseline digests are never rehashed. A raw key that happens to contain 64 hex
characters is still hashed as raw text. Malformed outputs, exceptions and
different-key collisions fail with a fixed safe error; native Promise outputs
are rejected without awaiting them or exposing rejection reasons.

The result explicitly labels keyHash and missingPreviousKeyHashes. Raw current
keys, identity strings and field inputs are transient preview material; native
persistence must use only the hashes and approved mapped proposals. Optional
blanks keep incoming proposals empty, while comparisons use the supplied carried
baseline. The helper neither mutates that baseline nor implements durable state
overlay, expiry, capacity accounting or a public baseline submission API.

The approved Stage 6 design and bounded matcher design, coverage and evolving
source reviews preserve this scope. All 195 focused tests across the serializer,
hashed matcher and original CSV/grid suites pass directly in the worktree; scoped strict TypeScript and source
lint pass. Coverage includes CREATE/UPDATE/UNCHANGED/NONE, renamed/moved keys,
missing/duplicate/invalid identities, typed values, optional omissions and returning
values, unselected observations, 1,000 rows, exact Unicode/hash arguments and
callback failure/collision/asynchronous results. These are pure comparison results,
not native persistence or connected UPDATE acceptance.

The existing frozen dependencies were installed from the local package store in
offline mode with install scripts disabled after Windows link restrictions were
resolved. No dependency version or lockfile changed. Full workspace build, lint,
type checking and all 2,778 unit tests across 187 files pass. Exact-candidate
reviews and all applicable native/integration/customer gates still gate a Stage 6
merge; pure prototype results do not satisfy connected UPDATE acceptance.

## Bounded native prototype validation harness, 2026-11-16

The synthetic database runner now invokes a separate temporary-function probe
after creating its unique `pdaa_test_DIGITS` database and applying the released
27 migrations, before seeding. The helper refuses `/pdaa`, other database names,
remote hosts, query/fragment overrides and production/non-synthetic configuration
before constructing a pool. It checks the actual connected database before DDL,
all 27 SQL checksums and the complete 85-business-table inventory. The reviewed
prototype SQL bytes are pinned; no applied migration changes.

One owned client executes the two pure functions inside an explicit transaction.
The harness compares the two independent fixed digest/byte vectors, numeric index
order, zero-field identities and the independent 1,614,668-byte maximum against
the TypeScript serializer. Native grammar corruption inputs bypass TypeScript
validation. Typed UUID/integer normalization and failed casts have separate
controls; they do not claim identical rejection semantics to the raw transport.
PUBLIC/API/worker/backup execution remains denied. The actual API-role denial
has positive role, nonsuperuser and schema-USAGE controls. Prototype ownership
is checked against the test session, not claimed as deployed migration ownership.

Connection, query, statement, lock and pool-finalization timeouts are bounded.
Idle-pool and checked-out-client socket errors remain in a finite non-logging
failure boundary. An attempted BEGIN always leads to a rollback attempt. Function
absence and exact ledger/table metadata are checked using the still-owned client
before release/end. Original and cleanup failures are retained as safe categories;
cleanup failures prevent a success receipt. No COMMIT, table/content write, role
creation, privilege grant, application startup or default-database mutation occurs.

Unit controls exercise target refusal before connection, actual-database mismatch,
DDL/uncertain-BEGIN failures, cleanup failures, checked-out socket errors and safe
diagnostics. Their database fixtures are deliberately failure-only; they cannot
produce a successful native vector or acceptance receipt. All 37 focused controls
and strict checking of the new test pass. Native execution has
not yet run. The local Docker engine remains unavailable and was not started.
The normal hosted runner must establish compilation, equivalence, role denial
and successful rollback before any native result is recorded.

This is a separately reviewable prerequisite for Stage 6, not context persistence
or connected UPDATE acceptance. When migration 28 installs the actual functions,
replace this temporary-DDL probe with tests of the applied definitions; never
install missing definitions as a test fallback. The complete head/context guards,
current source authorization/retention, cumulative state loader and transitions,
API/retry integration, customer UPDATE/rename proof, upgrade and recovery gates
remain pending. No story acceptance or customer-release hold changes.

## Cumulative reference overlay, 2026-11-16

The normal PR #167 hosted runner has now established genuine PostgreSQL
equivalence for the pure serializer prototype. Retained artifact 14203851136
from Foundation run 43817099999 matches candidate 5fafdae and its reviewed tree.
The independently checked original report records five vectors, including the
1,614,668-byte maximum, 116 native grammar denials, five cast denials and typed
normalization. Private immutable invoker permissions, actual API-role denial,
rollback/function absence and unchanged 27/85 metadata pass. Guard and QA
reviewers approve the actual native evidence; this is not applied migration 28.

An isolated continuation adds a pure accepted-reference overlay after three
independent design reviews. It parses the prior state and observation rows under
the same scope/dictionary, preserves every absent identity and optional field,
includes new zero-field identities, and rejects known-key record/project
rebinding. It sorts and revalidates the complete cumulative union, including
record uniqueness and lifetime identity/project bounds, before returning an
independent frozen result. No state is filtered or truncated to regain capacity.

The caller must establish complete accepted observations, native reference
binding, classification, current permissions and live retention independently.
This helper does not select reviewed rows, load plaintext, renew clocks, classify
changes, mutate a head or publish canonical facts. Repository integration,
native context guards, exact retry and connected UPDATE/customer acceptance
remain pending. All 20 focused overlay controls pass; the combined serializer,
hashed matcher and overlay suites pass 153 tests across three files. Scoped
strict TypeScript, full workspace build/lint/type checking and all 2,835 unit
tests across 189 files pass. Three evolving source reviews find no blocker;
exact-candidate review remains required. This local work is based on PR #167's
verified merge 71cc0effee68e7e32308806c3eec2093cacf3d8f and does not change its
source or approved publication package. Native persistence and connected UPDATE
acceptance are still pending.

## Native persistence and connected proof candidate, 2026-11-16

The next coherent batch integrates the reviewed primitives with an additive
migration 28, two scalar Prisma models and server-owned comparison loading and
advancement. The migration installs the applied serializer definitions, guarded
heads and immutable contexts, receipt-family/revision fences and deferred
completeness. It preserves the 27 released SQL files. Historical validation is
separate from live availability and never requires purged proposal plaintext.

The repository rejects caller baselines without invoking accessors. Matching
commands retain their original CSV/revision/baseline:null fingerprint and
original context under current complete authorization. They are resolved before
new-command kind, revision, head, expiry or capacity checks. New comparisons
validate the complete prior scope and bounded retained-content union, use the
hashed matcher, overlay accepted references and atomically advance the head.
Reviewed-import replay likewise retains its original revisions and selection.
Native reviewed-import birth and all semantic reads check the full parent
context, independently of the generic receipt validator's cheap metadata link.

Configuration planning preserves every historical sync-grant project and uses
the canonical project/grant-before-source order. Preview/replay planning admits
the complete 200-project original/current union while operation scopes remain
bounded at 100. Purge retains its project/grant, policy, source and mutable-content
fences; immutable identity/revision/projection rows need no UPDATE privilege.
Configuration/grant race controls establish the supported canonical project
gate; they do not claim an isolated grant-tuple-only blocking measurement.

The applied-definition harness no longer creates temporary functions. Missing
applied definitions fail closed, and existing byte/grammar/cast vectors now run
against the migration-installed functions. The API can execute the four safe
validators; all six private guards, including the two reused receipt guards,
remain inaccessible. Full table, column, grant-option and PUBLIC ACL checks run
after late bootstrap and real customer/operations restore. Ownership and finite
ACLs are reconstructed before use of any quarantined restored target.

Upgrade evidence is prepared from actual released-27 API-role graphs, with the
frozen released-27 grant body applied before seeding. The existing 26-to-27
retention proof remains a distinct step. Empty CSV, accepted CSV, invalid-only
history with no records, and historical CSV currently mapped CONNECTOR are
classified without chronological backfill. Late CSV activation must retain
legacy receipt validity, reads and exact retry while refusing a fresh comparison.
Current candidate inventories are 28 migrations and 87 business tables; historical
prefix inventories remain unchanged.

The same additive migration widens external-record types from 267 to 268
characters. The approved 256-character sheet plus the 12-character spreadsheet:
prefix requires this width. Receipt domain/wire schemas, OpenAPI and the browser
decoder agree; sheet input stays at 256. Maximum-sheet CREATE/UPDATE, reviewed
import, read and exact replay have native controls; domain/wire and browser
controls reject oversized sheet or receipt identities. Released SQL is unchanged.

Native controls cover optional NONE identities, all four value types, omitted
fields and unchanged clocks, exact retry after newer heads/configurations and
expiry/purge, malformed native graphs, mixed-state duplicates, type/formula/
number forgeries, scope narrowing, reader loss, actual lock waits and restored
head omission. The capacity fixtures construct genuine guarded history up to
4,096 contexts and the 256 MiB canonical budget, including a reachable 1,000-row/
32-field state and sparse full-content carry-forward. They do not rewrite
counters or disable constraints to manufacture capacity. The new long-batch
test wrapper is 300 seconds; individual queries remain bounded at 10 seconds
and transactions at 60 seconds. Meeting these bounds requires native execution.
Owner-only corruption fixtures are restricted to the approved isolated loopback
target and always roll back, including their trigger changes.

Exact-candidate review found that generic text proposals allow an empty string,
while CSV empty cells mean omission or a required-value error. The live context
guard now independently rejects exact empty text for optional and required
fields. Native forgery controls require full rollback; a positive whitespace
case preserves the matcher's untrimmed text semantics and later omission keeps
the old reference and clocks. Historical static validation still needs no
plaintext. The rejected candidate is retained; the corrected child requires
new exact-candidate approval.

A separate actual customer browser journey preserves the earlier CREATE/lost-
acknowledgement proof. It configures two authorized projects, uploads a prior
file, observes renamed/moved identities as unselectable, then uploads a changed
file with UPDATE and UNCHANGED. UI, API and native projections verify the exact
Forecast values before saving only the selected UPDATE proposal. Its source is
distinct from the original CSV proof and its move target is bound to the genuine
reconciliation fixture. Canonical snapshots must remain identical. Original
response disclosure drains and session finalization remain mandatory on failures.
Exact metadata replay after recreation and native retained data before restore
mutation probes are part of the host-validated evidence contract.

The first hosted attempt exposed a retention-wiring gap during source review:
the existing upload list retained only the earlier CSV CREATE fixture and image.
The production evidence upload now explicitly includes the new comparison
fixture and its four rename/move/changed/saved images for every customer profile.
These original files must be independently reviewed alongside their host-checked
hashes before accepting the connected proof; summary JSON alone is insufficient.

Local workspace build, lint and type checks pass. The full sheet-width rerun
passes 2,881 unit tests across 192 files, together with focused contract/privacy/
fixture controls. Strict checking of the new native and browser controls passes.
Three mocked browser variants pass with successful runner cleanup, including
the maximum and oversized receipt identities, after installing the pinned
browser, enabling local loopback access outside Windows sandbox isolation and
using an explicitly closed local server. Initial setup/cleanup failures are retained.
Documentation and architecture validation pass. No native migration, database,
packaged customer browser or recovery execution for this candidate has run
locally. The Docker engine and default local pdaa
database remain untouched. Three independent evolving reviews have resolved
concrete findings; immutable candidate and hosted original-evidence reviews are
still required. This is implementation work, not story or customer-release
acceptance. Reviewed imports remain proposals, OD-013/014 gates and all five
distribution holds remain open, and Original19/20 capture remains stopped.

## Initial hosted native failures and diagnostic correction, 2026-11-17

PR #168 opened on approved `cece4e8` with its exact description. Foundation
44131743979 verifies synthetic merge `53bd8c9`, whose tree matches the candidate
and whose ordered parents are main `71cc0ef` and `cece4e8`. Documentation passes.
Fresh role-absent/partial bootstrap, migration installation, build, contracts,
lint, types, units and dependency checks pass. Native integration records
380 passed, four failed and one skipped; the complete original provider-decoded
job log and its checksum are retained privately.

Two failures expose fixture barriers rather than established runtime defects.
The native successor helper left constraints immediate after its first graph;
the following same-transaction receipt was rejected before construction. Each
helper entry now explicitly defers construction and retains immediate final
validation. The reader-revocation gate paused before the now-first Project
fence, allowing a read to linearize before revocation. The corrected race holds
the real configuration fences, proves the named reader is blocked, then releases
configuration while retaining UNAVAILABLE and fresh-read hidden assertions.

The other failures occur during initial normal 1,000-row/32-field and 500-row/
32-field preview construction, before history filling or sparse carry-forward.
Their privacy-safe errors do not identify the underlying statement. A test-only
observer now reports one finite query family/ordinal, query or commit boundary,
bounded elapsed times and recognized Prisma/SQLSTATE codes before normal error
redaction. It emits no raw error, message, metadata, SQL or values, rethrows the
original error unchanged and stops after successful initial construction.
The existing 10-second query and 60-second transaction budgets, input bounds,
guards and capacity assertions remain unchanged. A new hosted run must establish
the cause before any enforcement or budget change is justified.

The genuine 4,096-context native control passes in 41.204 seconds, including its
next-command denial and old-command retry. This partial result does not accept
the complete native, customer, upgrade or recovery contract. Original19/20
capture remains stopped.

## Unpublished upstream security patch and independent diagnostics, 2026-11-17

The next exact candidate `b8e56e0` passed build/types/lint and all 2,881 unit
tests, but its native diagnostic did not execute. Mandatory audit rejected
picomatch 4.0.7 for
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
The advisory's affected range ends at 4.0.7. The audit prints a 4.0.8 patched
boundary, but the publisher registry has no such release: exact lookup fails,
independent registry metadata still lists latest 4.0.7, and the official advisory
lists no patched version. No dependency version is fabricated or adopted, and
no advisory exception, severity reduction or ignore flag is introduced.

To continue independent synthetic native diagnosis while preserving the existing
required check, the exact unchanged audit command moves to a final always-run
step in `verify`, before its existing Docker cleanup. Audit failure still fails
that same check; native failures also fail it, and the audit still runs after
them. The job name, tool pins, frozen install, full audit scope, contents-read
permission, timeout, required checks and branch settings remain unchanged.
This is the smaller reviewed alternative to new parallel jobs and an aggregate;
it avoids relying on an unverified new branch-protection requirement. Every
required exact-head check must pass before merge. An unresolved audit remains a
merge blocker even when useful native or packaged evidence is collected.

## Measured context-validation query cost, 2026-11-17

The `3bef9c2` run reaches the diagnostic: the first wide preview fails at query
37, CONTEXT_VALIDATION, after 10,004 ms, with 33,401 ms elapsed in its transaction.
The statement invokes the static context, head and generic receipt validators;
this measurement does not isolate one function. The corrected same-transaction
successor and real reader-revocation race pass. Subsequent fixture initialization
and old scenario phases show query timeouts/cascades, so none are accepted as
unrelated flakes. The complete original log and checksum remain retained.

Both static and live overlay reconstructions now aggregate references once per
C-collated identity key, then LEFT JOIN those groups onto the unchanged identity
union. Numeric field-index ordering, UNION ALL supplied/carried semantics, the
empty-array fallback for zero-field identities and final C-key ordering remain
identical. Exact equality, reference binding, hashes, live availability and all
other validators still run. The final three-validator query is retained for a
new native measurement; no COMMIT/stream guard or deadline changes are inferred.

This changes only unreleased migration 28 and this plan. All 27 released SQL
files stay byte-for-byte unchanged. Fresh native, upgrade and encrypted backup/
restore evidence must match the new checksum; old cece artifacts remain historical
prerequisites. The two genuine large initial repository constructions and all
capacity assertions, input bounds and budgets remain unchanged. The unresolved
upstream audit still blocks merge even if the native correction passes.

## Bounded immutable binding lookup, 2026-11-17

The grouped-overlay candidate `b61ee7d` moves the first failure to COMMIT. Its
final context-validation statement completes in 8,230 ms; the transaction fails
at commit after 23,742 ms. Native integration records 381 passed, three failed
and one skipped. This establishes progress and a deferred-work bottleneck, not
performance acceptance. Original job evidence and checksums are retained.

The next correction retains every completion trigger and validator call. The
static context validator expands all references once, deduplicates only immutable
record/projection lookup pairs, and materializes their exact scoped projection
and content-metadata bindings. Every original reference still separately checks
its C-collated field membership, rejecting missing/NULL bindings or membership
with IS NOT TRUE. Content-row presence remains valid after lawful plaintext
redaction; no plaintext, time, current grants, cache or all-history scan is added.
Zero-field identity anchors and all previous hash/scope/overlay checks remain.

A new owner-only rollback control creates two references sharing one projection,
then carries them through a later empty optional observation before removing
only one field from the older projection's metadata. The inspected context's
expected overlay stays unchanged, isolating per-reference membership from overlay
reconstruction. The cheap receipt link remains
valid while full context validation must reject the absent membership. The
original graph and audits must be restored by rollback. This complements the
unchanged genuine large constructions, optional omissions and purge/replay
controls. Fresh hosted timing and current-checksum recovery evidence remain
required; no completion-dispatch, budget or enforcement reduction is inferred.

## Deferred receipt and context validation

The `d500ad7` hosted run passed sparse carry-forward and the shared-projection
regression. The wide preview still failed at COMMIT after completing its final
validation query in 4,000 ms. The subsequent 4,096-context case reported a
query timeout. In total, 383 native tests passed, two failed and one skipped.
The required dependency audit also failed. The original verify log is retained.

CSV preview outcome callbacks now check their own row and its receipt bindings.
The header callback still validates the whole receipt, including the exact row
count. The immutable count fixes the allowed ordinal range. Each ordinal is
unique, so a completed receipt has no slot for a later row. An explicitly
immediate outcome constraint can validate rows during construction, while the
header constraint still checks completion when made immediate or at commit.
The native controls cover incomplete headers, malformed rows, a complete graph,
and append attempts against full and empty receipts.

The CSV head callback validates the stored head and its current context. Each
context callback independently validates its own context, including earlier
contexts in a multi-preview transaction. Receipt and context callbacks still
require the same scoped receipt link and sealed CSV source. The public validators
retain their full checks for reads and recovery. Migration 28 remains unreleased.
Fresh hosted results must establish timing and validate the new checksum before
merge. The existing audit gate continues to apply.

## Maximum-history test timing

The `75d34c6` hosted run passed the wide preview's commit, the 4,096-context
case, sparse carry-forward and the new selective-constraint checks. Its only
native failure was the 300-second deadline for the full 256 MiB history test.
Native totals were 385 passed, one failed and one skipped. The audit remains
blocking, and the exact run's original log is retained.

The serializer now checks the bounded field references together, orders them by
their actual array positions and casts an index only after validating its
canonical grammar. It renders the validated string once. When current and
predecessor rows are exactly equal under the same codec inputs, the validators
reuse that string within the call. Both stored digests and byte counts are
checked where previously required. The full reference, scope, retention and
completion checks still run. Native grammar, parity and rollback proofs remain
required for the new checksum.

The whole-history test now has a seven-minute budget for the real sequence of
commits. Each query still has ten seconds and each transaction has sixty.
The fixture stops launching work when Vitest aborts it and reports only the
phase, committed count, target count and elapsed time on failure. All history
and overflow assertions still apply, along with the existing hosted job deadline.

## Hosted verification job timing

The `ecb5301` Foundation run passed 2,881 unit tests and 386 native integration
tests, with one native skip. The native suite completed the genuine maximum
history and 4,096-context checks. Recovery passed. The 20-minute verify job
limit canceled Chromium after 271 of 324 tests completed, including the
reviewed CSV import. The required audit ran during cancellation and failed
for the same unresolved `picomatch` advisory.

The verify job gets 30 minutes to complete the browser suite, remaining proof
steps and artifact publication. The tests, their individual deadlines, the
production-boundary job and the mandatory audit command are unchanged. Review
the full browser results and exact candidate evidence from the next run. Merge
still requires the audit and every other required check and review to pass.

## Merge and post-merge evidence

[PR #168](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/168)
merged reviewed head `72505ef10250a85c860f749a82aef37ff08f9379` as
`ab2745c4ed7b47e2a91667f1c085421952b4ee3f`. Its first parent is
`71cc0effee68e7e32308806c3eec2093cacf3d8f` and its second is the reviewed head.
The actual merge and tested synthetic merge
`121aed26bf6570f9e5a38cb0f3324133d58095f9` have tree
`121f833a179bde0cff86b2af4c54abc5fe6ca2c2`.

[Candidate Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44185618987)
passed. [Candidate Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44185618881)
passed packaged acceptance on attempt 1. Its verify job reached the
seven-minute capacity-test deadline after committing 133 of 166 contexts.
The unchanged-head verify retry completed the capacity test in 394,557 ms,
with 2,889 unit tests, 386 native integrations and one skip, recovery, browser
workflows and the required dependency audit passing. The audit found zero
high or critical findings after the development dependency correction in
[ADR-016](../../03-architecture/adr/ADR-016-PICOMATCH-TOOLCHAIN-SECURITY-OVERRIDE.md).

Independent original-evidence reviews checked both customer profiles against
[the production-boundary artifact](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44185618881/artifacts/14374174894)
and the exact tested tree. The reviews matched rename and move exclusions,
UPDATE and UNCHANGED proposals, selected-row-only saving, idempotent replay
after a lost acknowledgement and environment recreation, and all ten CSV
screenshot hashes. Both isolated restores matched the source-scoped native
fingerprint and receipt lineage, with 28 released migration checksums,
87 business tables and API/worker connection quarantine. The running
application evidence came from synthetic customer profiles before restore.
Review confirmed the proposal workflow leaves canonical facts untouched.

[Post-merge Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44194349593)
and [post-merge Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44194349534)
passed on the actual merge on their first attempts. The distribution review
still has five open holds. No additional story credit follows from this increment.

## Migration 29 capacity and validation

The [main native check](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44213670338/job/134498024752)
reached 141 of 166 committed contexts before the existing seven-minute fixture
deadline. The packaged boundary and recovery job passed. Local PostgreSQL 17.11
profiling attributed most SQL time to encoding the canonical state, validating
stored contexts and checking retained proposals.

Migration 29 replaces the two existing context functions in place. Both
overlay statements use the validated predecessor directly when the receipt has
zero stored accepted outcomes. Strict canonical ordering, unique identities,
canonical UUIDs and ordered field indexes make the predecessor the exact
result of expanding and reassembling it in this case. Any accepted outcome,
including a zero-field identity, uses the original overlay. The existence check
and overlay share a single SQL statement snapshot. The guard indexes the
validated unique ASCII field names once per context. Each stored proposal then
has the same type or missing-key result as the original C-collated lookup.

Native tests cover exact empty and invalid-only carry, accepted zero-field
identities, history byte charging, expired and purged content, corrupted
projection membership and a forged zero-accepted overlay with matching
replacement hash and bytes. The upgrade fixture first populates migration 28
and then asserts the complete prior ledger, unchanged data and function
boundaries, exact replay and correct successor charging after migration 29.
The existing capacity fixture, deadline, scope, locks and recovery gates apply.
The candidate requires exact source approval and fresh hosted native capacity,
clean/repeat migration, populated upgrade, packaged acceptance and encrypted
recovery evidence before merge.

The [first hosted candidate](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44221862089/job/134525420097)
reached 144 of 166 contexts at the unchanged 420,000 ms deadline. The other
388 integration tests passed and one was skipped. A separate Windows native
experiment on that candidate profiled the canonical codec and reached 142
contexts, compared with 100 for the initial migration 29 body. Both local
runs timed out. The revised unreleased migration 29 also checks the UUID
grammar once per distinct projection string. It checks presence, type,
length and index for every reference. Canonical numeric indexes sort exactly
by length and C lexical order, so each reference can compare directly to its
immediate previous position. Malformed references still fail their own
checks, including when a comparison alone yields unknown. The exact native
controls exhaust all 1,024 pairs of canonical indexes and cover sparse and
multi-identity layouts, malformed tuples, indexes and projection IDs.
The revised candidate needs fresh exact review and hosted validation.
