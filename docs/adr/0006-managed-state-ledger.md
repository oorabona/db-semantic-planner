# ADR 0006: The Managed Set, Its Outcome Protocol, and One Apply

## Status

Accepted. It decides what ADR 0005 left open: the recorded-state model, the atomicity of the
change/record couple, and — because they turn out to be the same decision — how many commands may
write DDL. It supersedes three rules of ADR 0005, named in "What ADR 0005 no longer says".

Implementation status (#567): accepted and implemented — v3 is the current generated-postcondition
wire format; persisted v1 and v2 values are refused as `REPLAN_REQUIRED` and must be re-planned.

## Decision

### The record describes managed intent and verified outcome, never the schema

Live introspection stays the authority on what the database contains. The ledger answers a
narrower question: which objects dbsp manages, what it last declared them to be, and what it last
verified about them. Absence of any event for an address means *unknown*, never *absent*.

### What is guaranteed, and over which path

**The managed declarative apply path never destroys, and never mutates, an object it has not
created or adopted — within the stated identity-detection bounds.** Detection rests on catalogue
identities PostgreSQL can reuse, and a column dropped and re-added identically is
indistinguishable from the original, so the guarantee is as strong as those bounds and no
stronger; each is stated where its mechanism is. One deliberate carve-out: removing an adopted
extension removes its member objects, which PostgreSQL defines and which may include kinds the
DSL cannot declare — those members are inside the extension's containment, adopted and removed
with it, and they are the one place an undeclarable object is touched by a managed plan.

Outside that path, the adapter's runtime DDL helpers execute what their caller
asks. They are explicitly unmanaged; what they do to a managed object surfaces
as drift at the next plan or inspect. Every execution sink is classified:
token-gated managed DDL, explicitly unmanaged API, or removed. A sink that is
none of the three is a defect. Enforcement of that rule is code review plus a
syntactic tripwire (`packages/adapter-pgsql/src/ddl-execution-sinks.syntactic-tripwire.static.test.ts`)
whose recognized grammar is documented in the test itself; dynamic SQL,
aliased or wrapped query calls, and configuration-object dispatch sit outside
the tripwire's sight and are caught only by review.

Changing what the DSL cannot declare awaits an attested-statement
surface — a native statement with an author-declared blast radius, riding a reservation lifecycle
that touches no managed state — is decided in principle as the mechanism for that and for data
steps, and ships with the data-steps decision, not here. The unwired operation it builds on
already exists in the transition pack.

### The managed scope is bounded by what the DSL can declare

`TableIR` carries facts the DDL path can emit and the `schema()` inputs cannot express —
`rlsEnabled` and `policies`, the table `comment`, `partition`, `logicalIdentity`,
`pseudoColumns`. An object dbsp cannot declare is never adopted, never claimed, never proposed
for change, **and never removed or altered by a managed plan**: a mutation affecting an
undeclarable kind is excluded from managed plans entirely, so the differ's `drop_policy` and
`drop_comment` outputs never reach managed execution. Widening the DSL widens the managed scope
by itself.

**Non-declarable means no manifest.** RLS controls, policies, and comments may
remain schema-diff diagnostics, but the sole manifest-construction boundary
refuses them before an address, claim, reservation, or DDL bundle exists.

### The ledger is partitioned by object scope, and tenant schemas are a trust boundary

A schema-scoped object's events live in a ledger inside its own schema: tenant schemas are a
trust boundary in the deployments this serves.
A database-scoped object — an extension above all — cannot belong to a tenant schema; its events
live in `dbsp_meta`, to which no tenant role holds a grant. An address is schema-scoped or
database-scoped and never both, so exactly one ledger records any address.

The boundary is grants, not geography, and they are prescribed rather than assumed: ledger tables
are owned by the deployment role; creation revokes ALL from PUBLIC and grants no tenant role
anything; the preflight validates ownership and grants on every scope it touches and refuses a
ledger whose grants have widened. One bound is stated rather than solved: a tenant role that
*owns* its schema can drop its own ledger — it still cannot read a peer's, and destroying one's
own ledger is destroying one's own history, detected at the next command as a missing marker.

### One append-only chain per address, serialized by a lock and guaranteed by constraints

Events for an address form a chain: each names its predecessor, and the projection reads the
terminal member. There is no table-wide position — a sequence orders allocation, not commit, so a
table-wide maximum can name an earlier fact as the latest one.

Three mechanisms share the serialization work, each doing the job the others cannot:

- **An advisory lock per ledger** serializes live writers. Application code sees no retry path.
- **A reservation relation** — one row per reserved address, primary-keyed on the canonical
  address — is inserted in the same transaction as the claim's append and deleted in the same
  transaction as its resolution. At most one open claim per address is then a primary-key fact.
  An index over immutable events could not express it: an appended claim is indexed forever, and
  no index knows a later event closed it. The chain stays the authority — a reservation row is
  derivable from it, maintained transactionally with it, and a disagreement between the two is
  itself a malformed state that fails closed.
- **Constraints on the chain are the backstop**: `UNIQUE (address, predecessor)` declared
  `NULLS NOT DISTINCT` — so two roots for one address are as unwritable as two children of one
  event — plus a same-ledger, same-address predecessor reference, so a writer cannot chain onto
  another address's history.

What blocks a second writer **across a crash** is the durable reservation row, because a crash
releases every lock the dead session held. A reservation enumerates the claim's whole **effects
closure** — the contained addresses, plus every managed dependent an enumerated cascade would
reach — one row per address, each row carrying the root claim's identity and home ledger, so a
row in a schema ledger whose claim chain lives in `dbsp_meta` still names its anchor. A claim on
a table thereby conflicts with a claim on its index, and a database-scoped claim with a
schema-scoped one. Advisory locks and reservation rows spanning ledgers are both acquired in one
global order, inside one transaction: `dbsp_meta` first, then schemas by name.

### The outcome protocol

An address carries a **stable state** — `unknown`, `managed`, `absent` — and, separately, **at
most one open claim**. A claim that ends without establishing a new stable state leaves the
previous one untouched: a refused modification of a managed table leaves it managed. Conflating
the two was the error an earlier draft made.

**The grammar is a matrix per claim kind.** A claim opens from the stable states its kind names,
and resolves only through its own column:

| claim kind | opens from | before DDL | resolution |
|---|---|---|---|
| `intent` (create) | `unknown`, `absent` | `refused` (nothing ran) | `executing` → `observed` \| `indeterminate` |
| `intent` (modify) | `managed` | `refused` | `executing` → `observed` \| `indeterminate` |
| `retire-intent` | `managed` | `refused` | `executing` → `absent` \| `indeterminate` |
| `readdress-intent` (paired, per closure member) | source `managed`; target `unknown` \| `absent` | `refused` on both | pair events, or `refused` on both — no `executing`, see below |
| `adopt-intent` | `unknown` | `refused` | `adopt` (read-back, one transaction, no DDL) |

A replacement is not a kind: it is a `retire-intent` then an `intent` (create), two claims, two
tokens. Adoption goes through its reservation. Release is the one deliberate direct terminal:
the closed fourteen-kind grammar contains no `release-intent`; it is still serialized,
lineage-checked and owner-checked in one transaction before appending `released`.

`resolved` closes an `indeterminate` and only an `indeterminate`. Its stable outcome is drawn
from the original claim's column — `managed` or the prior stable state for an `intent`, `absent`
or `managed` for a `retire-intent`, and for a re-address pair one outcome for the whole pair —
always carrying the read-back that supports it. The event set is closed at these fourteen:
`adopt-intent`, `adopt`, `intent`, `retire-intent`, `readdress-intent`, `refused`, `executing`,
`observed`, `absent`, `indeterminate`, `resolved`, `readdressed-to`, `readdressed-from`,
`released` — and an event kind outside it, met by any reader, is a malformed chain.

`refused` carries the assertion that **no effect occurred**. The executor may append it only
before `executing`, without reading — nothing was sent. After `executing`, only recovery may
append it, and only with a read-back proving the object untouched: a crash between committing
`executing` and sending the statement ends there, with evidence rather than assumption.
`observed` after a `retire-intent`, or `absent` after a create, are not edges: a claim resolves
through its own column or not at all.

**Two execution patterns, decided by the segment.**

*Transactional segment*: the claim, the DDL and the resolution ride one transaction. A crash rolls
all of it back; nothing durable remains, so there is nothing to block or recover. This is ADR
0005's existing practice.

*Non-transactional segment*: the claim commits first — it must block competitors across a crash —
then **`executing` commits before the first statement is sent**. `executing` means the execution
window is open and the outcome is unknown from here on. Written after the call instead, a crash
between sending and recording would leave a terminal claim that recovery reads as "nothing ran" —
and the measurement says otherwise: a killed client's concurrent index build was finished by the
server, which only notices a dead socket when it replies.

**Every failure has one answer.**

| terminal member | recovery does |
|---|---|
| open claim, no `executing` | reads live state; if untouched, appends `refused`; the stable state is unchanged |
| `executing` | reads live state; appends `absent`, `indeterminate` — or `refused` when the read-back proves no effect, or `observed` under the condition below; **never re-issues DDL** |
| several addresses claimed, some resolved | classifies each address independently from the catalogue |
| a resolving append failed | retries; the append is idempotent on its predecessor, so a retry cannot fork |
| the catalogue could not be read | appends nothing further — a read that did not happen is not evidence; the claim stays open and the address stays `pending` |

**A read-back proves shape, not causation.** After a crash, an object matching the declaration
may be dbsp's work or an external writer's. Recovery may append `observed` for a create only
under the run's accepted `external-ddl-exclusion` assumption — the machinery ADR 0005 already
has for exactly this: the operator accepted that no outside DDL runs in the window, and that
acceptance is recorded with the run. Without it, a shape-matching object at a formerly `unknown`
address is `indeterminate`, because establishing `managed` there would silently adopt what an
outsider built.

**`indeterminate` is an open claim, not a terminal one.** It keeps excluding other writers, the
address reports `blocked`, and it ends only through `resolved`: an operator's decision, admitted
with ownership and carrying a live read-back as its evidence. `resolved` establishes the stable
state that read-back supports.

**A creation checks vacancy after its claim and before its DDL.** The address was `unknown` or
`absent` at plan time, and an out-of-band object can appear between plan and execution; a
creation that finds the address occupied refuses, and an `absent` address found occupied is
drift, reported and never silently adopted.

**A claim token** is opaque, bound to one claim, and **valid exactly while its claim is open** —
never bound to a transaction, since a non-transactional statement runs after the transaction
that committed its claim. What a claim authorises is its **statement bundle**: the ordered
statements the plan recorded for it, fixed at plan time, not one physical statement — a
transactional segment's steps share the segment's claims. An emitter that throws mid-bundle
enters recovery; a token presented for another claim's addresses is rejected by the boundary.

**A resolving append is idempotent by content, not merely by position**: it carries the claim it
resolves and a canonical payload, so a retry that finds a resolution already present compares
payloads — equal is success, different is a malformed chain that fails closed. A unique
predecessor alone would make the retry an error rather than a no-op.

**The execution window is guarded, not assumed.** For transactional DDL, the locks the operation
declares are acquired before the identity is re-read on the executing session, and held through
execution — ADR 0005's existing order. Non-transactional DDL cannot hold that lock across its
own internal commits, so its execution window is covered the way its recovery is: by the run's
accepted `external-ddl-exclusion` assumption, and that is a stated bound on the guarantee, not a
silent one.

### Two projections, and what is reported

The **declaration** dbsp last stated for an address and the **last recorded observation** are
separate facts derived from the same chain. Persisted observations change only through claims.
**Drift is computed live**: `plan` and `inspect` compare a fresh introspection against the
declaration, and an outside change is reported there rather than appended — an observation event
written outside any claim would be a mutation of the record by a reader.

Reported state combines the stable state with the claim: `pending` while a claim is open,
`blocked` on `indeterminate` or a malformed chain, otherwise the stable state itself.

**Management is established only by an event carrying a read-back**: `observed`, `adopt`,
`readdressed-from`, `resolved`. Four events, one rule — evidence, not a spelling.

**One interpreter produces every decision that rests on this** — lifecycle, destructive decision,
claim token — as one exhaustive function. Adapters supply typed catalogue evidence, the CLI
renders a decision it did not make, and an emitter receives a token rather than booleans it could
assemble itself. **A chain that cannot be projected refuses every managed mutation**; a cycle, a
missing predecessor, a fork, or an unknown event kind is a structured value naming the ledger,
the address, the events, the reason and the code version, and `inspect` still reads it.

### Addresses, identities, and containment

An address is `(database, schema, parent, kind, name)`, and each kind has a stated identity:

| kind | catalogue identity | note |
|---|---|---|
| table, index, sequence, enum, extension | its OID | reused OIDs are the stated bound |
| constraint | its OID (`pg_constraint`) | |
| column | parent table's identity + column name | columns have no standalone OID; `attnum` is not stable across drop/re-add |

A name alone would let dbsp keep managing an object dropped and recreated by someone else, then
remove it as its own. Every read-back records the identity it saw, and admission to change or
destroy requires it to match. PostgreSQL offers no permanent intrinsic identity; detection fails
exactly where an identifier was reused, and the bound is stated rather than hidden.

**A claim covers the address and everything it contains.** Children by parent hierarchy — a
table's columns, indexes, constraints — and, for an adopted extension, its member objects. One
`DROP TABLE` is one claim on the table; its contained addresses are accounted by containment, not
by separate tokens. A cascade that reaches a **managed dependent outside containment** is part of
the effects closure: it is enumerated at plan time, reserved with the claim, and resolved with
it — or the removal refuses when the closure cannot be enumerated. Extension members are the
stated exception: they are parent-accounted, carried by the extension's claim without per-member
address rows, because their kinds may be undeclarable and their removal is PostgreSQL's defined
cascade, not dbsp's choice. This is what lets one physical statement affect many catalogue rows
without a group-token protocol.

### The declaration comes from the DSL inputs, produced and validated at plan time

### Generated postcondition wire versions

Generated postconditions are currently encoded as v3 declarations with a separate target binding.
The decoder has one interpretation per version: v3 decodes; v1 and v2 are `REPLAN_REQUIRED` outcomes,
not compatibility inputs or subset-reader candidates. Their digest includes the wire version, so a
digest from one version cannot authenticate the value of another.

The fragment stored on an event is the per-object slice of the four inputs `schema()` accepts.
The ten schemas under `examples/` round-trip byte-identical through `JSON.stringify`; the *type*
does not guarantee it — `ColumnDef.default` is `unknown` — so **plan time validates every
declaration is canonicalizable JSON and refuses what is not**, naming the offending path.
`Schema<T>` retains `extras` and the schema options, which it currently discards; both are
preconditions, or extensions, sequences and options would have no declaration to store.

`plan` persists the declaration set with the run, covered by the plan digest; `apply <run-id>`
consumes that artifact and loads no schema file.

Digests are computed from a canonical form of the parsed value, never over stored bytes: `jsonb`
reorders keys by length then bytes and keeps only the last duplicate, so a byte-level digest does
not survive a read.

### Destroying data requires positive evidence, and removal is not the only way to do it

Two destructive actions: **executing a removal** (a dropped table, column, index, constraint,
enum, extension or sequence, on the managed path) and **executing a data-destructive
transformation** (a lossy type change, a truncation, and any generated mutation not classified —
unclassified is destructive).

Either executes only when every authority returns its permitting value, each from a closed set
whose other values — including every "could not decide" — refuse: the address is managed by this
controller; the declaration requires the change (or the reviewed plan requested the replacement);
the recorded identity matches the live one; the operator accepted a destructive plan; and for a
removal, everything the removal takes with it lies inside the claim's containment or is itself
managed and enumerated. An unmanaged object is therefore never removed — the measured case: run
against a database with nineteen pre-installed extensions, the untracked DDL path proposed
dropping every one.

**Removals execute on the generator path** — the no-argument apply, whose plan is rendered by the
schema differ — bridged into token-gated execution by the destructive authority. **The
transition-planner path maps no removal and refuses one.** A persisted generator run that carries
a removal is therefore **non-replayable**: it is reviewable by its identifier, and executing it
requires a fresh no-argument apply against live state. "Execute exactly the recorded plan" is a
property of transition-planner runs, and the command says so rather than letting a removal-bearing
run refuse as a surprise.

### Re-addressing: declared, verified, performed — tables only, for now

A rename and a move between schemas are one operation: the object keeps its identity and changes
its address. The author declares `from` and `to`; the engine verifies and performs. Supported for
tables in this delivery — `ALTER TABLE … RENAME TO` and `ALTER TABLE … SET SCHEMA` — and refused
for other kinds, a stated bound. A table's move re-keys its contained addresses with it, because
PostgreSQL moves the indexes, constraints and owned sequences too.

The protocol straddles the DDL, which is transactional, so no `executing` marker is needed.
**History is never rewritten**: a move appends pair events for the table *and for every contained
address* — its indexes, constraints, owned sequences — the old chain closing with
`readdressed-to`, and `readdressed-from` **appending to the target's chain where one exists** (a
previously retired address has history) and opening one only where the target is `unknown`, all
sharing one pair identifier. Nothing re-keys an existing row.

1. open the paired `readdress-intent` reservations on the full closure in both ledgers,
   atomically, sharing the pair identifier;
2. verify, before any DDL, that the source carries its recorded identity and every target address
   is vacant;
3. in one transaction: issue the DDL, re-read the identities, append every pair event — the
   opening ones carrying the re-keyed declarations and those read-backs.

A crash rolls step 3 back entirely, leaving the open pair. Recovery, keyed by the pair
identifier, reads the **whole reserved closure** and has exactly three answers: the complete
closure verified at the source with its recorded identities → `refused` on the whole pair; any
part of the closure unreadable → the pair stays open and reports `pending`; **every other
readable shape** — the object at the target, both names occupied, neither present, an identity
mismatch, a child missing or extra, the closure split across the two — → `indeterminate` on the
whole pair, no DDL ever re-issued. Step 3 is atomic, so none of those shapes can be a partial
success; each is evidence of outside interference, and completing the pair from any of them
would adopt what an outsider did. **A declared move is never inferred**: an undeclared name change is a creation and a
separately authorised retirement, and an undeclared `SET SCHEMA` is drift in both scopes.
Re-addressing across databases is refused — no transaction spans them.

### Adoption is declared; release and replacement are explicit

**Adoption** is a declaration naming a pre-existing object, read at plan time, presented in the
plan, idempotent, and admitted only when the live shape and identity match — because adoption is
what grants dbsp the authority to later destroy the object, and that grant belongs in the
reviewed plan.

**`released`** ends management without touching the object: stable state returns to `unknown`, no
DDL. It requires lineage match and the owning controller, and refuses a `pending` or `blocked`
address. For admission, a released address and a never-seen one are the same — both unmanaged;
`inspect` distinguishes them from the history.

**A replacement** of an unchanged declaration is permitted by one thing: the reviewed plan
requested it, covered by the plan digest. It is two claims — a retirement, then a creation from
`absent` — each with its own token, passing every other authority unchanged.

### Ownership

The claim carries the controller, and the controller **is** `current_user`, read on the
transaction that appends the claim — never a value the caller supplies. A free string would let
any caller present a stored controller's name and obtain `managed-by-me`, a takeover in all but
name; binding to the authenticated role hands the impersonation problem to PostgreSQL, which
already solves it. An operator who wants a different controller connects as that role. Two
deployments sharing a role are one controller — fewer refusals, never a wrong admission. Taking
over another controller's object is deferred (#490); until then, such an address simply refuses.

### One apply, and `push` is deleted

| shape | behaviour |
|---|---|
| `dbsp plan <schema-file>` | prove and persist a run without executing (unchanged) |
| `dbsp apply` | plan, persist the run, present it, execute on confirmation; `--yes` confirms non-interactively; `--dry-run` presents and persists nothing |
| `dbsp apply <run-id> --plan-digest <sha>` | execute exactly the recorded plan |
| `dbsp inspect [address] --schema <name>` | stable state, claim, declaration and observation digests, live drift, refusal cause and resolving command; appends nothing |
| `dbsp reconcile <run-id>` | resolve open claims from live evidence; appends verified outcomes only |
| `dbsp release <address> --schema <name>` | end management without touching the object |
| `dbsp push` | **deleted**, with its implementation, tests and documentation |

`push` is not aliased: a deprecated second name is a second code path kept alive to spell one
behaviour twice, and this repository does not carry those. There is no `--drop` — removing what
the declaration no longer names is what apply does, under the destructive authority. Deleting a
published command is a major version of `@dbsp/cli`, taken now. The cutover's adoption file is
written to an explicit `--out` path, never guessed.

### `migrate` is deleted with `push` (greenfield decision, 2026-08-07)

The project has no production consumers, so the managed model ships greenfield: `migrate apply`,
`migrate rollback`, `_dbsp_migrations` and the migration-file machinery are deleted in the same
CLI major that deletes `push`. Nothing reads or migrates their tables; rows left in existing
development databases are inert. This supersedes the earlier "migrate stays" position and the
`execution-audit` half of #490. The reasoning that arbitrary SQL yields no honest object-level
fact stands — it is why hand-written steps enter the managed model as attested statements
(tracked separately), not why a parallel unrecorded executor should survive.

### Reshaping the shipped metadata

A shape marker per ledger records its version; every command reads it before acting. There is
no legacy upgrade path (greenfield decision, 2026-08-07): every scope initializes as new, and
the preflight deliberately validates pre-existing candidate ledger tables before accepting them;
counterfeit or incomplete shapes refuse. Unrelated pre-ledger `dbsp_transition_*` tables in
existing development databases are inert. The marker still versions the NEW ledger
shape: older, future, mixed, and unreadable markers all refuse in `dbsp preflight --reinitialize`.
Cross-version marker upgrade is out of scope until a second ledger shape version exists
(greenfield means no older marker exists today). The preflight's scope set is an explicit input:
the schemas the operator names, plus `dbsp_meta`. It proceeds per scope in its own transaction,
writes the marker only after creating and validating the fresh ledger shape, reports current /
unchanged / failed / not-attempted per scope, and an interrupted scope repeats from its old
marker. Ordinary commands refuse any scope that is not current. The cutover writes adoption declarations only
for objects the current DSL declares that no chain covers — deriving candidates from
introspection instead would offer to adopt everything in sight.

### Lineage

A ledger records the identity tuple the shipped execution contract already binds to — the cluster
system identifier, the database OID, and the namespace OID — read the way
`readPgExecutionTargetFromClient` reads them today, under the same privileges. A restore, a
schema-only dump carried elsewhere, or a logical replica yields a mismatch: mutation refuses,
reading stays available. The tuple's own bound is stated with it: OIDs can be reused within a
cluster, so the tuple distinguishes databases and clusters, and within one database it is as
strong as OID reuse allows. An in-place rebase is not offered — it would be an unmodelled
mutation of history.

**The path out is a command, not a description**: `dbsp preflight --reinitialize --out <file>`,
separately privileged, taking the same explicit scope set. Per scope it archives the mismatched
ledger — renamed in place, read-only, its lineage kept as provenance — creates a fresh ledger
recording the live identity, and writes adoption candidates from the current declaration to
`--out`. It appends nothing to the new ledger; management resumes through the reviewed adoption,
exactly as the upgrade cutover does. It covers a full restore, a schema-only restore and a
logical replica alike.

A target in recovery, or any target refusing writes, yields one `database-read-only` outcome
across preflight, append, DDL and recovery write.

### Scale

Chains accumulate on the order of 10^5–10^6 events a year at the stated workload. The terminal
predecessor index supports the no-fork constraint; projection deliberately reads one address's
complete chain because admission needs its lineage, not only the terminal. Full history is
retained: archival would need a verified checkpoint first, and neither is built here.

### Observability

Every step emits a structured record: preflight, claim, executing, DDL attempt, catalogue read,
resolution, recovery, refusal. Object names, comments, declarations and database error text are
database-controlled: human output escapes control and terminal-control sequences, JSON output
comes from a serializer, and SQL text, credentials and declarations are not logged by default.

## What ADR 0005 no longer says

**"Durable apply is transactional only."** A segment forbidding a transaction is admitted when
the operator accepts an assumption of class `non-transactional-segment`. Measured: such a plan
runs to `completed`; a killed run reconciles to `completed` when the DDL committed without its
record, `recovery-resume-required` when nothing ran. An index left `indisvalid=false` is
**indeterminate**: PostgreSQL documents an invalid index as possibly incomplete, with its
uniqueness property not guaranteed, so no enforcement claim is made and human intervention is
required.

**"Intent is written after locking, live observation and the `expectedBefore` check."** The claim
must precede any competing writer, so it is appended first, and a failed precondition appends
`refused` — the run stays pristine because nothing ran, which is what the old ordering achieved
by writing nothing.

**Direct `push`, and file-based execution, remain available.** Both are
deleted. Managed DDL has one apply path; caller-owned DDL remains explicitly
unmanaged.

## Delivery

**First, alone: non-transactional apply** — the assumption-gated admission, its tests, the ADR
0005 amendment. It ships on the existing journal semantics and vocabulary; nothing in it depends
on the new ledger.

**Second: the managed set** — everything else above.

**Deferred**: takeover and the migration audit event (#490); the attested-statement surface, its
reservation lifecycle and data steps (with the data-steps decision); an in-place lineage rebase
(not offered).

## Consequences

### Threat model and declared bounds

The ledger defends against cooperating deployment roles using dbsp: controller
ownership prevents takeover, the admitted-execution facade rejects fabricated
in-process inputs at its boundary, and claim/resolution recovery records a
crash or a lost COMMIT acknowledgement without treating it as a successful
operation. External DDL is detected by catalogue identity and operation
read-back before management is re-established.

These are detection and coordination guarantees, not a privilege boundary. A
superuser or table owner can race name resolution between the identity read and
DDL; dbsp detects that conflict post-hoc through its identity/read-back checks
but cannot prevent it. The published `@dbsp/adapter-pgsql/internal` subpath is
unsupported for external integrations; in-process code using it is trusted by
declaration, as stated above, and it is not a security boundary. Advisory locks bind only cooperating dbsp
processes; they do not constrain direct PostgreSQL clients.

Two of the three writers become one and one ceases to exist. The managed scope is narrower than
the DDL path's reach, and the guarantee says so. A stored state drifting from its own history is
inexpressible; an event history drifting from database reality is not — an `executing` whose DDL
never ran, DDL that partially ran, an external change — which is why introspection stays the
authority, why establishing `managed` requires a read-back, and why the outcome protocol exists.
Durable claims and non-transactional DDL still cannot share a transaction; the claim is durable
before the DDL, an open claim blocks, and recovery resolves against live state — which is what
was measured, and is weaker than atomicity. Returning a schema to an earlier state is not
offered. Plan identity names immutable reviewed material; execution identity names a concrete
attempt and its reservations. They are separate by construction.
