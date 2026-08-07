---
doc-meta:
  status: draft
  scope: core
  type: specification
  target_project: /mnt/disk/dev/db-semantic-planner
  created: 2026-08-06
  updated: 2026-08-07
  complexity: ENTERPRISE
  time-budget: 16.5d
target: "the managed declarative apply path never destroys or mutates an object it has not created or adopted, and every way it can be interrupted has a defined way out"
done_when:
  - outcome: "An operator applies a CREATE UNIQUE INDEX CONCURRENTLY plan, kills it mid-build, runs recovery, and is told the outcome"
    verified_by: "tests/e2e/transition-non-transactional-apply.test.ts drives apply and recover against a real PostgreSQL over a 200k-row table with an overlap-asserted concurrent writer"
  - outcome: "An operator runs the apply path against a database holding an extension dbsp never created and sees it survive a plan that removes an equivalently situated adopted one"
    verified_by: "tests/e2e/removal-authority.test.ts installs one extension out of band, adopts a second, and asserts only the adopted one is removed"
  - outcome: "An operator whose address is refused runs one command and learns the address, its state, which authority withheld permission, and what to run next"
    verified_by: "tests/e2e/inspect-and-reconcile.test.ts drives a refusal of each kind and asserts inspect names the cause and the resolving command"
  - outcome: "An operator recovers every way an apply can be interrupted: before the claim, between the claim and the DDL, during the DDL, after it, and with the ledger write itself failing"
    verified_by: "tests/e2e/outcome-protocol.test.ts induces each failure against a real PostgreSQL and asserts the chain reaches a lawful member without DDL ever being re-issued"
  - outcome: "An operator restoring a dump into another database is refused rather than silently given management of objects dbsp has never seen"
    verified_by: "tests/e2e/lineage.test.ts restores a dump into a second database and asserts mutation refuses while inspect works"
non_goals:
  - "Migrating data. Deferred deliberately; its mechanism is the attested statement and its reservation lifecycle, decided in principle in ADR 0006 and shipped with the data-steps decision"
  - "The attested-statement surface itself; nothing in this delivery wires the existing manual-sql operation to the DSL or CLI"
  - "Takeover of another controller's object, and the migrate execution-audit event; deferred to #490, and an address owned by another controller simply refuses"
  - "An in-place lineage rebase; the supported path after a restore is a fresh ledger plus explicit adoption"
  - "Returning a schema to an earlier state; no command offers it"
  - "Managing what the DSL cannot declare; a mutation affecting an undeclarable kind is excluded from managed plans entirely"
  - "Removal on the recorded-plan path; the transition planner maps no removal and refuses one, and the bound is stated"
  - "Re-addressing any kind but tables, or across databases; both refuse with the bound stated"
  - "Keeping push under any name; its implementation, tests and documentation are deleted"
  - "Archival or retention of ledger events; full history is retained and archival needs a verified checkpoint that is not built here"
hard_constraints:
  - constraint: "A schema-scoped object's events live in a ledger inside its own schema; a database-scoped object's events live in dbsp_meta, to which no tenant role holds a grant"
    because: "Tenant schemas are a trust boundary in the deployments this serves"
  - constraint: "Events for an address form a chain; live writers are serialized by a per-ledger advisory lock; a reservation relation keyed on the canonical address — inserted with the claim's append, deleted with its resolution, in the same transactions — makes a double claim a primary-key violation; UNIQUE (address, predecessor) NULLS NOT DISTINCT with a same-address predecessor reference makes a fork or a second root unwritable"
    because: "An index over immutable events cannot express open-ness, a lock dies with its session, and what blocks a writer across a crash is the durable reservation row that survives one"
  - constraint: "For a non-transactional segment, executing commits before the first statement is sent; recovery never re-issues DDL past an executing member; refused after executing is appended only by recovery with a read-back proving no effect"
    because: "A killed client's concurrent index build was measured finishing on the server, so a post-DDL marker would make recovery read a crash window as nothing ran"
  - constraint: "A claim covers its address and everything it contains: children by parent hierarchy, and an adopted extension's member objects"
    because: "One DROP TABLE removes the table's indexes and constraints, and PostgreSQL defines DROP EXTENSION as dropping the members; per-row tokens would make every composite statement unexpressible"
  - constraint: "A digest is computed from a canonical form of the parsed value, and plan time refuses a declaration that is not canonicalizable JSON, naming the offending path"
    because: "jsonb reorders keys and drops duplicate keys, and ColumnDef.default is typed unknown, so neither storage bytes nor the type system guarantees a stable digest"
  - constraint: "One exhaustive interpreter produces the lifecycle state, the destructive decision and the claim token; no emitter receives booleans it could assemble itself"
    because: "Six call sites would otherwise re-derive whether an object is managed, and the second one to drift is invisible"
  - constraint: "A ledger records the database and namespace identity it was written for; a mismatch refuses mutation and leaves reading available"
    because: "A restore or a carried dump would otherwise hand dbsp management of objects it has never seen"
assumptions:
  - claim: "Assumption.class unions five literals with (string & {}), so adding non-transactional-segment is not a breaking change"
    basis: verified
    evidence: "packages/types/src/transition/proof.ts:25"
  - claim: "The ten schemas under examples/ round-trip byte-identical through JSON.stringify; the ColumnDef.default type is unknown, so the round-trip is a property of these instances and plan-time validation, never of the type"
    basis: verified
    evidence: "examples/ecommerce.schema.ts"
  - claim: "The shipped journal permits exactly intent, completion and observed, keyed (run_id, seq), so it carries neither the new event kinds nor any order across executions"
    basis: verified
    evidence: "packages/adapter-pgsql/src/transition/journal.ts:101"
  - claim: "The applier computes transactional per segment and opens a transaction only when it holds; an end-to-end run with the admission check removed reached completed against PostgreSQL 18"
    basis: verified
    evidence: "packages/core/src/transition/applier.ts:997"
  - claim: "push executes DDL and writes no record: its only reference to the migrations table excludes that table from the --drop pattern"
    basis: verified
    evidence: "packages/cli/src/commands/push.ts:85"
  - claim: "The schema differ emits eleven removal kinds and the generator renders them in a dedicated ordered phase; the transition operation set contains six operations and no removal"
    basis: verified
    evidence: "packages/adapter-pgsql/src/ddl/schema-diff.ts:368"
  - claim: "An advisory-lock discipline for writers already exists on both write paths: migrate takes one, and the durable apply takes a run-scoped one"
    basis: verified
    evidence: "packages/adapter-pgsql/src/ddl/migration-tracker.ts:38"
  - claim: "A PostgreSQL object identifier is not permanent across a drop and recreate, so recording it detects recreation except where the identifier was reused"
    basis: assumed
    breaks_if_wrong: "If identifier reuse is common rather than rare in these deployments, identity matching is weaker than claimed and the authority needs a second signal such as a catalogue creation timestamp"
  - claim: "Every sink that executes managed DDL can be made to require a claim token"
    basis: assumed
    breaks_if_wrong: "If a sink cannot take one, the guarantee does not hold for it and the sink must be relabelled as an explicitly unmanaged API rather than left implying the invariant"
---

# Specification: The Managed Set and Its Outcome Protocol (ADR 0006)

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | core, adapter-pgsql, cli, types |
| Complexity | ENTERPRISE |
| Time budget | 16.5 d across two deliveries |
| Work units | 14 |
| BDD scenarios | 67 (53 e2e of which 3 local-only, 12 integration, 2 static) |
| Risk level | HIGH — changes a shipped metadata shape, deletes a published command, creates the authority to destroy data |
| Decision record | `docs/adr/0006-managed-state-ledger.md` |

**CRITICAL — data migration with an adoption cutover, and a major version of `@dbsp/cli`.**
Revert procedure in §8.

## 1. Problem Statement

Three commands emit DDL and only one records anything. `push` records nothing, so dbsp cannot
tell an object it created from one that was already there — measured against a database with
pre-installed extensions, the DDL path proposed dropping nineteen it had never created. `dbsp
apply` refuses any plan whose segment forbids a transaction. And nothing records what dbsp
manages, so no command can refuse to change an object owned by another.

Recording it is only half the work: a record that blocks an address after a crash, with no
defined way to unblock it, trades a silent wrong answer for a stuck deployment.

## 2. User Stories

```
AS A platform operator running schema-per-tenant PostgreSQL
I WANT the declarative apply path to know which objects it manages in each tenant schema
SO THAT it never changes or destroys an object it did not create or adopt
ACCEPTANCE: an out-of-band extension survives a plan that removes an adopted one
```

```
AS an operator whose apply was interrupted
I WANT one command that tells me what state the address is in and what to run next
SO THAT a refusal is a step in a procedure rather than a dead end
ACCEPTANCE: every refusal names its cause and its resolving command
```

```
AS A tenant operator
I WANT my schema's ledger to be unreadable by another tenant
SO THAT my object names, declarations and provenance are not disclosed
ACCEPTANCE: a tenant role cannot read another tenant's ledger or dbsp_meta
```

## 3. Business Rules

### 3.1 Invariants

- INV-01: No persisted value expresses the state of an address; every answer derives from its
  chain, and events are immutable.
- INV-02: Events for an address form a chain, each naming its predecessor; the terminal member is
  the latest, and no answer depends on a table-wide position.
- INV-03: Live writers are serialized by a per-ledger advisory lock. A reservation relation,
  primary-keyed on the canonical address and maintained in the same transactions as the claim's
  append and resolution, makes a double claim unwritable; `UNIQUE (address, predecessor)`
  `NULLS NOT DISTINCT` with a same-address predecessor reference makes a fork or a second root
  unwritable. What blocks a writer across a crash is the durable reservation row. The chain stays
  the authority: a reservation disagreeing with its chain is a malformed state that fails closed.
- INV-03b: A reservation enumerates its claim's whole effects closure — contained addresses plus
  every managed dependent an enumerated cascade reaches — one row per address, each carrying the
  root claim's identity and home ledger. Advisory locks and reservation rows spanning ledgers are
  acquired in one global order inside one transaction: `dbsp_meta` first, then schemas by name.
  Extension members are parent-accounted, with no per-member rows.
- INV-04: An address has a stable state — `unknown`, `managed`, `absent` — and at most one open
  claim. A claim that ends without establishing a new stable state leaves the previous one
  untouched.
- INV-05: The grammar is a matrix per claim kind: a claim opens only from the stable states its
  kind names and resolves only through its own column. `observed` after a retirement, or `absent`
  after a create, are unwritable.
- INV-06: Only an event carrying a read-back establishes `managed`: `observed`, `adopt`,
  `readdressed-from`, `resolved`. A read-back proves shape, not causation: recovery establishes
  `managed` for a create only under the run's accepted `external-ddl-exclusion` assumption;
  without it, a shape-matching object at a formerly unknown address is `indeterminate`.
- INV-07: In a transactional segment, the claim, the DDL and the resolution ride one transaction.
  In a non-transactional segment the claim commits first and `executing` commits before the first
  statement is sent.
- INV-08: Recovery reads live state before it appends, never re-issues DDL past an `executing`
  member, and appends `refused` after `executing` only with a read-back proving no effect. A
  resolving append is idempotent by content: it carries the claim it resolves and a canonical
  payload; a retry finding an equal resolution is success, a differing one is a malformed chain.
- INV-08b: The event set is closed at fourteen kinds; `resolved` closes only an `indeterminate`,
  drawing its stable outcome from the original claim's column, and an unknown kind met by any
  reader is a malformed chain.
- INV-08c: A claim authorises its statement bundle, fixed at plan time — not one physical
  statement. Transactional DDL holds its declared locks through execution with a post-lock
  identity re-read; non-transactional DDL's execution window is covered by the accepted
  external-ddl-exclusion assumption, a stated bound on the guarantee.
- INV-09: A catalogue read that fails appends nothing; the claim stays open and the address
  reports `pending`. `indeterminate` is an open claim that keeps excluding writers, reports
  `blocked`, and ends only through `resolved`.
- INV-10: A creation verifies the address vacant after its claim and before its DDL; an `absent`
  address found occupied is drift, reported and never adopted.
- INV-11: A claim covers its address and everything it contains: children by parent hierarchy,
  and an adopted extension's member objects.
- INV-12: A claim token is bound to one claim, single-use, and valid exactly while that claim is
  open. Every managed DDL execution consumes one, minted by the admission boundary only.
- INV-13: An address is `(database, schema, parent, kind, name)` with a per-kind catalogue
  identity; admission to change or destroy requires the recorded identity to match the live one.
- INV-13b: The controller is `current_user` read on the claiming transaction, never a
  caller-supplied value; an operator wanting another controller connects as that role.
- INV-13c: Ledger lineage is the tuple the shipped execution contract binds: cluster system
  identifier, database OID, namespace OID, read as `readPgExecutionTargetFromClient` reads them.
- INV-14: An object the DSL cannot declare is never adopted, claimed, proposed, removed or
  altered by a managed plan — with one stated carve-out: an adopted extension's member objects
  are inside its containment and are removed with it, PostgreSQL defining the cascade.
- INV-14b: The managed-path guarantee is qualified by the identity-detection bounds: a reused
  OID, and a column dropped and re-added identically, are undetectable and stated as such.
- INV-15: The declaration and the last recorded observation are separate facts; persisted
  observations change only through claims, and drift is computed live by plan and inspect, never
  appended.
- INV-16: A chain that cannot be projected is a structured value naming ledger, address, events,
  reason and code version; every mutation refuses and inspect still reads.
- INV-17: The lifecycle state, the destructive decision and the claim token have exactly one
  producer.
- INV-18: A name change or schema move is a re-addressing only when declared; undeclared, it is
  drift. A declared one reserves the full closure in both ledgers, verifies the source identity
  and every target's vacancy before DDL, then in one transaction performs the DDL, the read-backs,
  and a pair of append-only events per closure member sharing one pair identifier — history is
  never re-keyed. It is refused across databases and for kinds other than tables. Recovery by
  pair id over the whole reserved closure, with exactly three answers: complete closure verified
  at source → refused pair; any part unreadable → open, pending; every other readable shape —
  target-present, both, neither, identity mismatch, split closure — → indeterminate pair, no DDL
  re-issued. `readdressed-from` appends to a target chain where one exists and roots one only at
  `unknown`.
- INV-19: A ledger whose recorded database or namespace identity does not match the live one
  refuses mutation and permits reading.
- INV-20: Every execution sink is labelled token-gated managed DDL, explicitly unmanaged API, or
  removed.
- INV-21: A destructive action executes only when every authority in §4.5 returns its permitting
  value; every other value refuses, including each "could not decide".
- INV-22: `plan` validates every declaration is canonicalizable JSON and refuses otherwise,
  naming the offending path; the declaration set persists with the run under the plan digest, and
  a recorded apply consumes it without loading a schema file.
- INV-23: Human output escapes control and terminal-control sequences; JSON output comes from a
  serializer; SQL text, credentials and declarations are not logged by default.
- INV-24: Live introspection decides what the database contains.

### 3.2 Preconditions

- PRE-01: A pre-existing object enters management only through a declared adoption whose live
  shape and identity matched. A new object needs none.
- PRE-02: A non-transactional segment executes only when its assumption class is accepted.
- PRE-03: Every ledger in a command's scope reads current before any event is appended.
- PRE-04: A scope upgraded from the legacy shape resumes management only after its adoption
  cutover has run.

### 3.3 Effects

- EFF-01: `push` no longer exists; the no-argument `apply` is the only unrecorded-plan path.
- EFF-02: The no-argument `apply` persists its run before presenting it; `--yes` confirms
  non-interactively; `--dry-run` presents and persists nothing.
- EFF-03: Removals execute on the generator path only, bridged into token-gated execution by the
  destructive authority.
- EFF-04: Every generated mutation is classified non-destructive, removal, or data-destructive;
  unclassified is destructive.
- EFF-05: The preflight writes its cutover adoption file to an explicit `--out` path and appends
  nothing itself.

### 3.4 Error Handling

- ERR-01: Unaccepted non-transactional segment → `transactional-only-refusal`, run not attempted.
- ERR-02: Pre-existing object with no adoption → `unknown`; nothing proposed.
- ERR-03: Marker older, from a future version, mixed, or unreadable — or an advisory lock that
  errors — → refuse naming the preflight and the scopes; never upgrade inside an ordinary command.
- ERR-04: Removal whose containment cannot be enumerated or reaches an unmanaged object → refuse
  the whole removal before it runs.
- ERR-05: Recorded identity differing from live → refuse, report drift.
- ERR-06: Lineage mismatch → refuse mutation, permit reading, name the fresh-ledger path.
- ERR-07: Read-only target → one `database-read-only` outcome across preflight, append, DDL and
  recovery write.
- ERR-08: Malformed chain → structured value; mutations refuse; inspect reads.
- ERR-09: Catalogue read failure → one `catalogue-unavailable` outcome; nothing appended; no
  retry of a possibly executed step.
- ERR-10: Removal requested on the recorded-plan path → refuse; none is mapped there.

## 4. Technical Design

### 4.0 Prior-art check

```
- (none): no new external dependency, runtime, protocol or format.
```

### 4.1 Architecture Decision

`docs/adr/0006-managed-state-ledger.md`: the outcome protocol with its per-kind grammar matrix,
the two execution patterns, containment, the serialization split (lock for flow, constraints for
truth), and the deferred set (takeover, migrate audit, attested surface, rebase).

### 4.2 The model, in one picture

```
 stable state (changed only by an establishing event)
   unknown ── adopt / readdressed-from ──▶ managed ── retire ──▶ absent
      ▲  ◀───── released / readdressed-to ───┘  ▲                  │
      └──────────── create claim ◀──────────────┴── create claim ──┘

 claim (one open per address; leaves stable state alone unless it establishes)
   intent | retire-intent | readdress-intent(pair)
     ├─ refused ..................... executor, before executing only
     ├─ executing ─┬─ observed ...... managed   (read-back)
     │             ├─ absent ........ absent    (read-back)
     │             ├─ indeterminate . open, blocked, ends via resolved (read-back)
     │             └─ refused ....... recovery only, read-back proving no effect
     └─ (readdress pair: verify → one transaction: DDL + read-back + both events)

 serialization: advisory lock per ledger (flow)
                UNIQUE(address, predecessor) + one-open-claim index (truth)
                durable open claim (blocks across crashes)
```

Reported state: `pending` while a claim is open, `blocked` on `indeterminate` or a malformed
chain, otherwise the stable state.

### 4.3 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| per-schema ledger | new in each managed schema: address columns, per-kind `catalogue_identity`, `event_kind` over the closed set, `predecessor`, `pair_id`, `declared jsonb` + digest, `observed jsonb` + digest, `controller`, `recorded_at`; `UNIQUE (address…, predecessor) NULLS NOT DISTINCT`; same-address predecessor reference; terminal-member index | Yes |
| reservation relation per ledger | one row per reserved address (PK), carrying claim kind, execution, pair id; inserted with the claim append, deleted with its resolution, same transactions; ownership and grants as the ledger | Yes |
| `dbsp_meta` ledger | the same shape, for database-scoped addresses | Yes |
| ledger identity + shape marker | database and namespace identity, and a version marker, per ledger | Yes |
| declaration-set artifact | persisted by `plan` with the run, covered by the plan digest | Yes |
| legacy `dbsp_meta` transition tables | rows preserved read-only; no runtime reader of the old semantics | Yes |
| `_dbsp_migrations` | none | No |
| `Schema<T>` | retain `extras` and the schema options | No |
| `Assumption.class` | new value `non-transactional-segment` | No |

### 4.4 Command surface

| Shape | Behaviour |
|---|---|
| `dbsp plan <schema-file>` | prove and persist a run without executing (unchanged) |
| `dbsp apply` | plan, persist the run, present, execute on confirmation; `--yes`; `--dry-run` persists nothing; `--replace <address>` requests a recreation through the destructive authority |
| `dbsp apply <run-id> --plan-digest <sha>` | execute exactly the recorded plan |
| `dbsp inspect [address] --schema <name>` | stable state, claim, digests, live drift, refusal cause, resolving command; appends nothing |
| `dbsp reconcile <run-id>` | resolve open claims from live evidence; appends verified outcomes only |
| `dbsp release <address> --schema <name>` | end management without touching the object |
| `dbsp preflight --reinitialize --out <file>` | separately privileged: per scope, archives a lineage-mismatched ledger read-only in place, creates a fresh one recording live identity, writes adoption candidates from the current declaration; appends nothing |
| `dbsp push` | **deleted**, with implementation, tests and documentation |

Declared in the DSL, presented in the plan: adoption, and re-addressing (`from`/`to`, tables
only). The preflight takes its scope list explicitly and writes its adoption file to `--out`.
Ledger tables are owned by the deployment role, created with REVOKE ALL FROM PUBLIC and no
tenant grants, and the preflight validates ownership and grants on every scope it touches.

### 4.5 Destructive-action authority table

| Authority | Outcome set | Permits |
|---|---|---|
| declaration | `requires-removal` · `requires-lossy-change` · `replacement-requested-by-plan` · `requires-neither` · `absent` · `uncomputable` | the one matching the action; `replacement-requested-by-plan` permits only the named replacement |
| ownership | `managed-by-me` · `managed-by-other` · `pending` · `blocked` · `unknown` · `uncomputable` | `managed-by-me` |
| catalogue identity | `matches-recorded` · `differs` · `object-absent` · `catalogue-unavailable` | `matches-recorded` |
| operator acceptance | `destructive-plan-accepted` · `absent` | `destructive-plan-accepted` |
| containment closure (removal only) | `all-contained-or-managed` · `reaches-unmanaged` · `undecidable` | `all-contained-or-managed` |
| ledger lineage | `matches-database` · `differs` · `unreadable` | `matches-database` |

| Action | Covers |
|---|---|
| Execute a removal | a dropped table, column, index, constraint, enum, extension or sequence on the managed path; undeclarable kinds never reach it |
| Execute a data-destructive transformation | a lossy type change, a truncation, any unclassified mutation |
| Record an object absent | `executed` ∧ catalogue `absent`, per object including everything containment removed; `not-issued` · `failed` · `rolled-back` · `connection-lost` · `unknown` refuse |
| Upgrade a ledger shape | `explicit-preflight` ∧ lock `held` ∧ target `writable` ∧ marker in {`absent-legacy-tables-present`→upgrade, `absent-no-legacy`→initialize, `older`→upgrade}; `current` no-op; `future` · `mixed` · `unreadable` · lock `contended`/`error` refuse |

The permitting combination is a value the interpreter returns; an emitter cannot be reached
without it.

### 4.6 Consumer inventory

| Contract changed | Consumers | Covered by |
|---|---|---|
| ledger shape and readers | `transition/journal.ts` (renderers + shape check `:410`), `transition/constants.ts`, `transition/index.ts`, `adapter-pgsql/src/index.ts`, `cli/commands/apply.ts`, `cli/commands/recover.ts`, `core/transition/resume.ts` | ledgers |
| `transactional-only-refusal` reachability | `types/transition/apply-result.ts:16`, `core/transition/applier.ts:132`, `:2200`, `cli/commands/apply.ts:353` (exit 17), both test locks | non-transactional apply |
| `Schema<T>` retaining `extras` + options | `core/dx/schema.ts:320`, `:652`, `cli/utils/schema-loader.ts`, `types/loaded-schema.ts:11` | addresses/declarations |
| every sink executing DDL, labelled | `cli/commands/push.ts`, `cli/commands/generate.ts:142`, `adapter-pgsql/src/pgsql-adapter.ts:5666` + runtime DDL helpers, transition operation runtimes, `cli/commands/migrate.ts` | one apply |
| `push` disappearing | `push.ts`, its three test files, `packages/docs/guide/cli-usage.md`, VitePress nav | one apply |
| journal shape assertions | `transition/journal.test.ts`, six operation suites, two rule suites, `__tests__/introspection.test.ts` | ledgers |

### 4.7 Degraded modes

| Decision | If it fails | Behaviour |
|---|---|---|
| Chain projection | defect, unreadable ledger, cycle, fork, unknown kind | structured value; mutations refuse; inspect reads |
| Catalogue read | timeout, denial, lost connection, unparseable | `catalogue-unavailable`; nothing appended; no retry of a possibly executed step |
| Resolving append | write fails | predecessor stays terminal; retry idempotent |
| Identity | OID reused after drop/recreate | undetected in that case; stated assumption |
| Lineage | restore, carried dump, replica | mutation refuses; reading works; fresh-ledger path named |
| Writability | standby | one `database-read-only` outcome |
| Preflight over scopes | one scope fails | per-scope transactions and report; ordinary commands refuse non-current scopes |
| Token | emitter throws pre-use, double use, wrong address | boundary rejects; emitter path enters recovery |

## 5. Acceptance Criteria (BDD)

Compact form; every scenario is Given/When/Then in its test file. Level: E2E unless marked.
Scenarios marked *(local)* require the harness-provisioned container and fail — never skip — when
it is unavailable.

**H — Harness capability (unit 1)**
- SC-01 *(integration)* when role administration, container exec or the standby topology is
  unavailable, the suites that need them FAIL with a capability message; nothing skips.

**A — Non-transactional apply (unit 2, delivery 1, existing journal vocabulary)**
- SC-02 accepted segment executes over 200k rows; the build is held at a server-side witness
  phase, a writer inserts and commits inside the witnessed window, the build is released, the
  index is valid.
- SC-03 unaccepted segment → `transactional-only-refusal`, no step-attempt event.
- SC-04 client killed at an acknowledged checkpoint after the statement was sent; the server
  finishes the build; recover appends the missing record, outcome completed.
- SC-05 build aborted server-side leaving `indisvalid=false` → recovery-unknown-step-result; no
  test asserts uniqueness enforcement by an invalid index.
- SC-06 killed at the checkpoint before anything was sent → recovery-resume-required.

**B — Ledger storage (unit 4)**
- SC-07 *(integration)* UPDATE and DELETE on event rows are rejected at the database, whatever
  role attempts them.
- SC-08 *(integration)* two sessions append with allocation order inverted against commit order →
  the projection still reads the per-address terminal member, proving no answer depends on a
  table-wide position.
- SC-09 *(integration)* with the advisory lock bypassed: two children of one head, two roots for
  one address (`NULLS NOT DISTINCT`), and a predecessor from another address's chain each violate
  a constraint; with the lock, all serialize.
- SC-10 *(integration)* a second reservation row for one address violates the primary key; the
  row appears with the claim's append and is gone after its resolution, in the same transactions;
  a reservation surviving its chain's terminal member is reported malformed.
- SC-11 a claim whose effects closure spans two ledgers: every closure row exists while the claim
  is open, each carrying the root claim's identity and home ledger; two opposing closures acquire
  in the global order — no deadlock, the second refuses.
- SC-12 *(integration)* an advisory lock that errors → refusal, never an unbounded wait.
- SC-13 ledgers are owned by the deployment role with no PUBLIC or tenant grant; a tenant role
  reads neither a peer ledger nor `dbsp_meta`; the preflight refuses a ledger whose grants
  widened; a tenant owning its schema is the stated bound.
- SC-14 a table's events land in its schema's ledger, an extension's in `dbsp_meta`, never both.

**C — Preflight and cutover (unit 5)**
- SC-15 markers older / future / mixed / unreadable each refuse, naming the preflight; nothing
  changes.
- SC-16 preflight over an explicit scope set with one scope denied → per-scope report (current /
  unchanged / failed / not-attempted); ordinary commands refuse the failed scope.
- SC-17 kill-point matrix: the preflight is killed at each acknowledged point — archive, create,
  grants, marker, output — and each time the old marker is intact and a rerun reaches current;
  the adoption file is written to a temp path and atomically renamed.
- SC-18 a schema holding application tables but no legacy dbsp tables initializes as new; legacy
  upgrade triggers only on the known legacy table names.
- SC-19 the cutover file contains adoption declarations only for DSL-declared objects lacking
  chains, lands at `--out`, and the preflight appended nothing.

**D — Addresses, identities, declarations (unit 3)**
- SC-20 fragments exist for declarable kinds; `rlsEnabled`, `policies`, `comment`, `partition`,
  `logicalIdentity`, `pseudoColumns` produce none — and a driven attempt to adopt, plan or
  execute against an undeclarable kind refuses at each surface.
- SC-21 *(integration)* the same constraint name under two tables yields distinct addresses.
- SC-22 *(integration)* digest before storage equals digest after a jsonb round trip.
- SC-23 *(integration)* per-kind identity is recorded: OID for table, index, sequence, enum,
  extension and constraint; parent identity + name for a column.
- SC-24 out-of-band drop and recreate under the same name → admission refuses, drift reported.
- SC-25 a schema whose column default is a function value → plan refuses naming the path.
- SC-26 recorded apply consumes the persisted declaration set with no schema file present;
  digests covered by the plan digest.

**E — Projections and the interpreter (unit 6)**
- SC-27 five fixtures report `managed`, `pending`, `blocked`, `absent`, `unknown`; `pending`
  reports both the claim and today's stable state.
- SC-28 a refused modification leaves `managed`; a refused creation leaves `unknown`.
- SC-29 cycle, missing predecessor, fork, unknown event kind → structured value; mutations
  refuse; inspect reads it.
- SC-30 *(static)* the lifecycle state, the destructive decision and the claim token each have
  exactly one producer, enforced by a dependency test.
- SC-31 an outside ALTER on a managed table: drift appears in plan and inspect from live
  introspection; the persisted observation is unchanged.

**F — The outcome protocol (units 7 and 8)**
- SC-32 a transactional segment killed mid-execution → full rollback: no event, no reservation,
  no catalogue effect.
- SC-33 killed at the acknowledged gate between `executing`'s commit and the statement send →
  recovery reads live state and appends `refused` with the no-effect read-back.
- SC-34 killed after the DDL, before resolution → recovery classifies from the catalogue, never
  re-issuing; a create receives `observed` only under the run's accepted external-ddl-exclusion —
  the same fixture without the acceptance yields `indeterminate`.
- SC-35 a multi-address run interrupted midway → each address classified independently.
- SC-36 *(integration)* resolution retry: an equal payload is a no-op success; a differing
  payload on the same predecessor is a malformed chain that fails closed.
- SC-37 *(integration)* a one-shot failpoint trigger on the targeted event insert → the append
  fails once, the retry converges to a single terminal member.
- SC-38 execution gated after the claim, its backend terminated from a second session → the
  catalogue read fails, nothing is appended past the claim, the address reports `pending`.
- SC-39 `indeterminate` keeps excluding a second writer, reports `blocked`, and ends only through
  `resolved` carrying a read-back; the resolved state is what the read-back supports.
- SC-40 a creation finds its address occupied after the claim, before the DDL → refuses; an
  `absent` address externally recreated → drift, never adoption.
- SC-41 two sessions race to create one address → exactly one open claim wins, the loser refuses.
- SC-42 *(integration)* a token presented for another claim's address, presented twice, or
  presented after its claim resolved is rejected; a statement outside the claim's recorded bundle
  refuses.

**G — Lineage and read-only targets (unit 10)**
- SC-43 *(local)* a real `pg_dump` piped to `pg_restore` into a second database via container
  exec → mutation refuses naming `preflight --reinitialize`; inspect lists every address; the
  reinitialize run archives the old ledger read-only, creates a fresh one with the live identity
  tuple, writes the adoption file, appends nothing.
- SC-44 *(local)* a schema-only dump restored elsewhere → refused on the recorded lineage tuple.
- SC-45 *(local)* a streaming standby (`pg_is_in_recovery()` true) → one `database-read-only`
  outcome from preflight, apply and reconcile alike; a generic `default_transaction_read_only`
  session gets the same outcome as separate coverage.

**H — The destructive authority (unit 11)**
- SC-46 the unadopted extension survives the plan that removes the adopted one; the adopted one's
  members are parent-accounted, no per-member rows.
- SC-47 a removal without accepted destruction → refused, object present.
- SC-48 a cascade reaching an unmanaged dependent outside the closure → whole removal refused,
  nothing dropped; one reaching a *managed* dependent → that dependent is enumerated in the
  effects closure, reserved, and resolved with the claim.
- SC-49 a lossy type change against stored values → refused without accepted destruction;
  proceeds with it.
- SC-50 a mutation the classifier does not recognise → destructive by default, proven by adding
  one.
- SC-51 `DROP TABLE` is one claim; contained children get absence recorded per object.
- SC-52 a persisted generator run carrying a removal is labelled non-replayable at persistence;
  `apply <run-id>` on it refuses up front naming a fresh apply; a transition-planner run replays
  exactly.

**I — Re-addressing (unit 12)**
- SC-53 declared rename: rows intact, `RENAME TO` issued, the source chain closes, the target
  chain roots, and every pre-existing event row is byte-for-byte unchanged.
- SC-54 declared cross-schema move: the table, its index and its owned sequence each get their
  pair of events under one pair id; old rows byte-for-byte unchanged.
- SC-55 source identity mismatch, or an occupied target → refused before any DDL.
- SC-56 an applied declaration re-runs as a no-op; a source without a chain errors; a previously
  retired target's chain is appended to, not rooted anew.
- SC-57 pair recovery over the whole closure, three answers: verified source → `refused` pair;
  part unreadable → open, `pending`; target-present, split-closure and identity-mismatch fixtures
  each → `indeterminate` pair, no DDL re-issued.
- SC-58 a cross-database declaration refuses with outcome `readdress-unsupported`, detail
  `cross-database`, resolving command "declare the move as a retirement and a creation"; a
  non-table kind refuses with the same outcome, detail `unsupported-kind` naming the kind, same
  resolution — both before any claim is opened, both observable in the JSON output and in
  inspect.

**J — Adoption, release, replace (unit 13)**
- SC-59 adoption declared in the DSL, shown in the plan, idempotent; a shape or identity mismatch
  refuses; a match records declaration, shape and identity.
- SC-60 release refuses `pending`, `blocked`, another controller's address and a lineage
  mismatch; on success the object is untouched, the address `unknown`, and inspect distinguishes
  released from never-seen.
- SC-61 `--replace` without the plan having named it → refused; named and accepted → retirement
  then creation, two claims, two tokens.
- SC-62 an undeclared `SET SCHEMA` → drift in both scopes; neither adopts while the other's claim
  stands.

**K — One apply, diagnosis, and the surface (unit 14)**
- SC-63 `push` does not exist; the no-argument apply persists its run before presenting;
  declining leaves the run retrievable with the presented digest and no DDL; `--yes` executes
  non-interactively; `--dry-run` persists nothing.
- SC-64 the refusal catalogue, parameterized: ERR-01, ERR-02, each ERR-03 arm (older, future,
  mixed, unreadable marker; lock error), ERR-04 through ERR-10 — for each, inspect names the
  address, the state, the withheld authority and the resolving command.
- SC-65 *(static)* the sink inventory is discovered from the AST — every call site executing DDL
  — and compared against the labelled allowlist; an unlabelled sink fails.
- SC-66 the controller recorded on a claim equals `current_user` of the claiming transaction; a
  test connecting as a second role records that role; no flag or configuration supplies another
  value, proven over the CLI surface.
- SC-67 an object whose name carries ANSI and control sequences renders escaped in human output;
  JSON output parses and came from the serializer; logs carry neither SQL text nor credentials
  nor declarations.

**Totals: 67 scenarios — 53 E2E (3 local-only), 12 integration, 2 static.**

## 6. Implementation Plan

Fourteen units. Delivery one is units 1–2; delivery two is units 3–14. Units 3 and 4 begin in
parallel with 1–2; unit 9 exists because lineage and the destructive authority both consume the
apply pipeline, so it precedes them rather than arriving last.

| # | unit | depends on | budget | owns |
|---|---|---|---|---|
| 1 | Deterministic test harness: acknowledged checkpoints over child-process IPC, one-shot PostgreSQL failpoint triggers, container exec for dump/restore, a streaming-standby topology, capability gates that fail rather than skip | nothing | 1.5 d | SC-01 |
| 2 | Non-transactional apply becomes an accepted assumption (existing journal vocabulary) | 1 | 1 d | SC-02…06 |
| 3 | Addresses, per-kind identities, declarations, plan-time validation and persistence | nothing | 1 d | SC-20…26 |
| 4 | Ledger storage: chains, immutability, constraints, reservations with effects closures | 3 | 1.5 d | SC-07…12, SC-14 |
| 5 | Preflight, grants, cutover | 4 | 1 d | SC-13, SC-15…19 |
| 6 | Projections and the lifecycle interpreter | 4 | 1 d | SC-27…31 |
| 7 | Outcome protocol, forward path: claims, `executing`, transactional pattern, tokens and bundles, creation vacancy | 6 | 1.5 d | SC-32, SC-40…42 |
| 8 | Outcome protocol, recovery path: classification, resolution idempotency, faults, races, `resolved` | 7, 1 | 1.5 d | SC-33…39 |
| 9 | Command foundation: the no-argument apply pipeline, inspect and reconcile skeletons | 6 | 1 d | none — its exit is its own integration tests, and SC-43…64 verify it downstream |
| 10 | Lineage, `--reinitialize`, read-only targets | 5, 9, 1 | 0.5 d | SC-43…45 |
| 11 | Destructive authority: classification, containment, effects closure, differ→token bridge | 8, 9 | 1.5 d | SC-46…52 |
| 12 | Re-addressing | 11 | 1.5 d | SC-53…58 |
| 13 | Adoption, release, replace | 11 | 1 d | SC-59…62 |
| 14 | Final surface: `push` deleted, release command, docs, sink labelling, refusal catalogue, output escaping | 12, 13 | 1 d | SC-63…67 |

Total 16.5 d. Each unit's property is its ADR section; its exit is its scenarios green at their
stated level plus `pnpm biome check` and `pnpm -r typecheck`. The orchestrator runs every
DB-backed suite; a delegated agent runs typecheck and pure unit tests only.

## 7. Test Strategy

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~85 | slicing and the undeclarable list, canonical digest, per-kind addresses and identities, the grammar matrix cell by cell — legal and illegal edges, `resolved` outcomes per claim kind — closure computation, destructive decisions over every authority combination, marker and lineage decisions, classification, token and bundle checks |
| Integration | 12 | SC-01, 07, 08, 09, 10, 12, 21, 22, 23, 36, 37, 42 |
| E2E | 53 | the remaining scenarios, against a real PostgreSQL; SC-43, 44, 45 local-container-only |
| Static | 2 | SC-30, SC-65 |

The harness (unit 1) provides: an acknowledged checkpoint the child process reaches and reports
over IPC before the parent sends `SIGKILL`, so every kill lands at a named point rather than a
sleep; a one-shot failpoint installed as a real trigger raising on a targeted event insert;
container exec so `pg_dump | pg_restore` runs inside the PostgreSQL container; a
primary-plus-streaming-standby topology; and capability gates that fail the requiring suites when
role administration, exec or the topology is unavailable — an under-privileged external
`DATABASE_URL` must never soften them into skips.

Fixtures: a two-table declared schema; a 200 000-row table; two tenant schemas with distinct
roles and a privileged setup role; an explicit multi-schema preflight scope with one denial; a
second database for restores; one extension out of band and one adopted; a managed table with an
unmanaged dependent and one with a managed dependent outside containment; a column whose values a
narrower type cannot hold; a schema whose default is a function value; chains fabricated for the
malformed shapes.

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| A destructive action runs against an unowned object | H | M | six authorities, closed sets, refusal on every undecided value; SC-46…52 |
| An address is stranded after a crash | H | M | every interruption point has a lawful terminal member; SC-32…39 induce each at acknowledged checkpoints |
| Recovery re-issues a statement that ran | H | M | INV-08; SC-33, SC-34 assert read-before-append at deterministic cut points |
| A fork, double claim or unserialized closure is written | H | M | advisory lock for flow, reservation PK and chain constraints for truth; SC-09…11, SC-41 |
| A composite statement's effects escape accounting | H | M | effects closure enumerated and reserved; SC-46, SC-48, SC-51, SC-54 |
| A mutation nobody classified destroys data | H | M | unclassified is destructive; SC-50 |
| A restore hands over management | H | L | lineage tuple per ledger; SC-43, SC-44 with a real dump/restore |
| The preflight leaves a mixed estate | M | M | per-scope transactions, kill-point matrix; SC-16, SC-17 |
| An impersonated controller obtains managed-by-me | H | L | controller is current_user, no override exists; SC-66 |
| The declaration type admits non-JSON | M | M | plan-time canonicalization validation; SC-25 |
| Tests soften on a weak environment | M | M | capability gates fail rather than skip; SC-01 |

**Migration and rollback, by delivery.** Delivery one changes no persisted shape and reverts by
reverting its commits. Delivery two: before any event exists in the new shape, revert the code
and drop the added structures; **after the first event, rollback is forward-fix only** — the
ledger is the record of what ran and deleting it is destroying history. The operator takes a
dump before the preflight, as the preflight itself instructs. Pre-0006 client binaries ignore
the new ledgers and could mutate untracked; the shape marker cannot gate a binary that never
reads it, so same-major client alignment is a stated operational bound of the `@dbsp/cli` major.
The preflight's own interruption behaviour is the SC-17 kill-point matrix.

## 9. Definition of Done

- [ ] All fourteen work units implemented; all 67 scenarios pass at their stated level
- [ ] Unit, integration and e2e suites green on the final HEAD; `pnpm biome check` and
      `pnpm -r typecheck` pass
- [ ] `docs/adr/0006-managed-state-ledger.md` moves from Proposed to Accepted, and ADR 0005
      records the three rules 0006 replaces
- [ ] `packages/docs/guide/cli-usage.md` documents plan, apply, inspect, reconcile, release and
      the reinitialize preflight, with no reference to a removed command, wired into the nav
- [ ] #490 tracks takeover and the migrate audit event; the data-steps decision tracks the
      attested surface; nothing from either leaked into this delivery
- [ ] The cross-family gate exits clean on the cumulative diff
