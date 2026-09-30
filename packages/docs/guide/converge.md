---
title: Startup Convergence
---

# How to converge a schema at application start

`convergePg` applies the additions your declared model needs to a PostgreSQL schema, from inside
your application, at every start, with no plan to review. It compares the tables, sequences and
enums the model declares. Changes it does not apply unattended are refused while
planning; plan those with
`dbsp plan` and `dbsp apply`. The decision and its limits are recorded in
[ADR 0007](https://github.com/oorabona/db-semantic-planner/blob/main/docs/adr/0007-startup-convergence.md).

## When

- Your application owns its schema and must create it on a fresh install.
- A new version adds tables, or columns that are nullable or NOT NULL with a literal default.
- An earlier version created the tables outside dbsp, and you want dbsp to manage them from now on.

## The startup sequence

1. **Create the schema** you converge (`CREATE SCHEMA`); converge never creates it.
2. **At every start:** build a `PgPhysicalModel` for the target schema, then call
   `convergePg(pool, physical, { initialize })`. When the schema has no
   ledger, `initialize` decides what happens:
   - `'never'` (the default): refuse `ledger-absent`.
   - `'pristine'`: create the `dbsp_meta` schema, the transition journal and the schema's ledger,
     unless a declared table or sequence already exists in the schema, which refuses
     `initialization-refused`.
   - `'adopt-existing'`: create them whatever the schema holds.

   The role that converges then owns the ledger, so it needs `CREATE` on the database for
   `dbsp_meta`, and every later call must run as that role. `initialize` never archives or replaces a
   ledger that exists: an incompatible schema ledger is refused `incompatible-ledger`, and a
   `dbsp_meta` ledger whose identity no longer matches the database (a restored or cloned database)
   is refused `initialization-refused`; reinitialize those explicitly with `runPgReinitializePreflight`. When several instances start
   together, one converges and the others get `busy`: retry `busy` after a delay, or converge from a
   single instance. To prepare the ledger in a separate setup step instead, run
   `runPgReinitializePreflight` once and keep `initialize: 'never'`; it must run as the same role as
   every later `convergePg` call, since the ledger's owner is the only role converge admits.
3. **After converge, from a single instance:** create or repair the indexes you manage yourself (see
   [External indexes](#external-indexes)). The ledger lock is released when `convergePg` returns, so
   it does not serialize this step.

The ledger needs PostgreSQL 15 or later.

```typescript
// doctest: real-db-only — initializes and converges a real schema
import { convergePg, createPgPhysicalModel } from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';

const app = schema({
  settings: {
    id: { type: 'integer', primaryKey: true },
    name: 'string',
  },
});

await pool.query('CREATE SCHEMA IF NOT EXISTS converge_guide');

// At every start: 'applied' the first time, 'no-drift' afterwards.
const physical = createPgPhysicalModel({
	mode: 'logical', model: app.model, schema: 'converge_guide',
});
const result = await convergePg(pool, physical, {
  initialize: 'pristine',
});
if (result.kind !== 'applied' && result.kind !== 'no-drift') {
  throw new Error(`unexpected converge result ${result.kind}`);
}
```

## From the command line

`dbsp migrate` runs the same convergence from a schema file, for a deployment step that runs before
the application starts:

```bash
dbsp preflight --reinitialize --db "$DATABASE_URL" --schema-file ./schema.ts --scope app --out ./adoption.json
dbsp migrate ./schema.ts --db "$DATABASE_URL" --schema app
```

`dbsp migrate` passes no `initialize`, so the preflight shown above must run once per schema before
it, as the role `dbsp migrate` uses. `dbsp migrate` reads `dbCasing` from the
schema file, takes each external index as `--external-index <model-table>:<index>` (the same naming as
`externalIndexes` below), and prints the result
or refusal below as its outcome, with an exit code `dbsp migrate --help` lists (`no-drift` and
`applied` exit 0). A `recovery-required` refusal lists the run ids to pass to `dbsp reconcile`, the
runs still executing, and the execution ids no dbsp command resolves, whose owner its detail names.

## What converge applies

- **New tables**, with the indexes, CHECK constraints and foreign keys declared on them, except that
  [owned CHECKs and indexes](#owned-surfaces) are left to their assertion.
- **New sequences.** A sequence is created under its physical name, the declared name mapped through
  `dbCasing` like a table's (`orderNumberSeq` becomes `order_number_seq` under `snake_case`). A raw
  `nextval(...)` default is not rewritten, so it names the physical sequence. When a live sequence
  still carries the raw declared name from an earlier version and the physical one does not exist,
  converge throws before writing anything; the error message gives the schema-qualified
  `ALTER SEQUENCE … RENAME TO …` that fixes it.
- **New columns on tables dbsp already manages**, within the rules below.
- **Adoption** of existing tables and standalone sequences you mark `adopt: true`, or of every
  existing declared one under `initialize: 'adopt-existing'` (see
  [Adopting an existing install](#adopting-an-existing-install)).

It does not drop, rename or change existing definitions, it does not add indexes, CHECK constraints
or foreign keys to a table that already exists, and it refuses `replace` and `readdress`, except that
an assert may change an [owned CHECK, index or column type](#owned-surfaces). Owned CHECKs and indexes
on an existing table are left to that assert. It does not create enums or extensions: those the model
uses must already exist. An enum's declared name is its physical PostgreSQL type name under every
`dbCasing`, the name its columns' types refer to, so declare `mood_type` to match a live `mood_type`.

- A foreign key needs both of its tables created by the same call, its referenced columns covered by
  a primary key, a unique column or a declared unique index that is neither partial nor on an
  expression, and, for a single-column key, a declared index on its referencing column: any
  single-column index on it (a partial `WHERE <column> IS NOT NULL` index included), or a primary key
  or non-partial btree index without expressions whose first column it is.
- A new column on a managed table is nullable without a default, or NOT NULL with a boolean,
  finite-number or string literal default (not a function call such as `now()`). A column with a
  default must use a PostgreSQL built-in base type or an enum, whether it is declared by a neutral type
  or by `originalDbType`; a range such as `daterange` is refused. A new column whose type names its schema
  (`originalDbTypeSchema`), as an enum column in a non-public schema does, is refused. Adding a
  column takes an `ACCESS EXCLUSIVE` lock on its table, bounded by a five-second `lock_timeout`.

The tables a call creates and every change on them commit in one transaction: if one of them fails,
none of them remains and the next call starts again from absent tables. A sequence created by the
same call commits on its own and can remain after a failure.

## Results

| `result.kind` | Meaning |
|---|---|
| `no-drift` | Nothing to apply for the declared tables, sequences and enums, every `once` [application step](#application-steps) recorded, and every `assert` healthy. |
| `applied` | Every planned step committed; `applied` lists their change kinds (`adopt_table` and `adopt_sequence` for adoptions), followed by `application-step:<id>` for each application step that recorded a run. |
| `partially-applied` | The steps in `completedStepKeys` committed; those in `notStartedStepKeys` did not commit (a step whose transaction rolled back is listed there too). `detail` says why. Both lists cover generated and adoption steps only: `before-generated-ddl` application steps that already ran stay committed and are not listed. |
| `transport-ambiguous` | The connection was lost while a COMMIT was in flight. The next call observes whichever state PostgreSQL holds. |

## Checking without applying

`convergePg(pool, physical, { mode: 'check' })` takes the ledger lock, runs the checks and
planning refusals an apply runs before it starts executing, and returns without executing:

| `result.kind` | Meaning |
|---|---|
| `no-drift` | An apply would find nothing to do. |
| `would-apply` | `steps` lists, in execution order, the steps an apply would run. A generated or adoption step has `stepKey`, `kind` (a change kind, `adopt_table` or `adopt_sequence`), `address`, and the `table`, `column` and `details` of its change. An [application step](#application-steps) has only `kind: 'application-step'`, its `id`, `step` (`'once'` or `'assert'`) and, for an assert, `inspected`. `planDigest` identifies that plan. |

Before executing, a check refuses as an apply would (`busy`, `ledger-absent`, `database-read-only`,
`unsupported-change`, …), except that it never creates a ledger: with no ledger it refuses
`ledger-absent` whatever `initialize` says. With a ledger, `initialize: 'adopt-existing'` lists the
adoptions an apply would run. It commits nothing: the comparison's scratch DDL runs in a transaction that
is rolled back, which is why a read-only target is refused, and the ledger is unchanged. Its answer
holds for the moment it was taken: another session can change the database before your next apply,
and checks the executor makes only while executing, such as re-verifying an adopted table when it
claims it, can still refuse that apply. The options type is `ConvergePgCheckOptions` and the result type `PgConvergeCheckResult`;
[ADR 0008](https://github.com/oorabona/db-semantic-planner/blob/main/docs/adr/0008-convergence-program.md)
records the decision.

## Application steps

Work the model cannot declare (a backfill, a function or trigger you maintain yourself, dropping an
obsolete table) goes in `steps`, and converge runs it under its lock and records it in the ledger.
A step must not create or change what converge compares on a declared table: its columns, keys,
foreign keys, CHECK constraints and indexes (other than [owned surfaces](#owned-surfaces) and
[external indexes](#external-indexes)). The next call would compare an unowned difference against
the model and refuse `unsupported-change` before any step runs. Functions, triggers, data, and
tables the model does not declare are outside the comparison.

```typescript
// doctest: skip — illustrates the option only
await convergePg(pool, createPgPhysicalModel({ mode: 'logical', model, schema: 'app' }), {
  initialize: 'adopt-existing',
  steps: [
    {
      kind: 'once',
      id: 'backfill-project-state',
      digest: 'v1',
      phase: 'after-generated-ddl',
      apply: async (tx) => {
        await tx.query('INSERT INTO app.project_state (project_id) SELECT id FROM app.projects ON CONFLICT DO NOTHING');
      },
    },
    {
      kind: 'assert',
      id: 'touch-function',
      digest: 'v3',
      phase: 'after-generated-ddl',
      inspect: async (tx) => {
        const { rows } = await tx.query<{ readonly ok: boolean }>(
          "SELECT coalesce(pg_catalog.strpos(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('app.touch()')), '-- touch v3') OPERATOR(pg_catalog.>) 0, false) AS ok",
        );
        return rows[0]?.ok === true ? 'healthy' : 'unhealthy';
      },
      apply: async (tx) => {
        await tx.query('CREATE OR REPLACE FUNCTION app.touch() RETURNS integer LANGUAGE sql AS $$ SELECT 1 -- touch v3 $$');
      },
    },
  ],
});
```

- A `once` runs the first time and is recorded with its `digest`; later calls skip it. Changing its
  body needs a new `id`: the same `id` with another `digest` refuses `application-step-changed`.
- Every apply call inspects each `assert` by the time its phase comes. When it answers
  `'unhealthy'`, converge runs `apply`, inspects again, and records the run only if the database is
  now healthy; otherwise it refuses `application-step-failed`. A check inspects an assert only when
  nothing else is pending (see below).
- `phase: 'before-generated-ddl'` runs before converge's first generated DDL change,
  `'after-generated-ddl'` after the last one. Steps run in the order given within a phase.
- Each step runs in one transaction on converge's connection: its admission, `inspect`, `apply`,
  re-inspection and ledger record commit or roll back together. An `assert` inspected during
  planning is inspected there in a separate read-only transaction that is rolled back; if the plan
  has work, it is inspected again in its execution transaction, and if every assert is healthy and
  nothing else is pending, converge returns `no-drift` without one. `tx.query` sends one statement per call
  and refuses transaction-control statements (`BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`,
  `SAVEPOINT`, `RELEASE`, `SET TRANSACTION`, `SET SESSION CHARACTERISTICS`); this guards against
  mistakes, not against code that runs with the same role. `PREPARE TRANSACTION` is not checked: a
  step must not use it. A step must not release advisory locks
  (`pg_advisory_unlock_all()` and the like): converge's own lock lives on the same connection. `lock_timeout` is 5 s unless the step sets `lockTimeoutMs`;
  `statement_timeout` applies only if the step sets `statementTimeoutMs`, to `inspect` as well as
  `apply`. Both are whole milliseconds from 1 to 2147483647.
- Each step transaction sets `search_path` to the converged schema, `pg_temp`, then the
  connection's own entries, so `current_schema()` is `options.schema` and an unqualified
  `CREATE TABLE` or `CREATE FUNCTION` lands there whatever the pool's default is. Unless the
  connection's own `search_path` names `pg_catalog` explicitly, PostgreSQL searches it first, so a
  built-in name wins over a same-named object in `options.schema`; when it is named explicitly, it is
  searched at that position.
  Otherwise a name that exists in `options.schema` resolves there and a session temporary table
  cannot shadow it; a name absent from it continues down the path, like any query your application
  runs with that path, so schema-qualify names that live elsewhere. A schema literally named `$user`
  cannot host steps (`invalid-options`).
- `lockTimeoutMs` and `statementTimeoutMs` set PostgreSQL's `lock_timeout` and `statement_timeout`
  in the transactions that run the step's `inspect` or `apply`, so they limit each lock wait and
  each statement there, converge's ledger statements included. They do not limit how long the
  callback takes overall. Converge's planning admission runs without them.
- Use `SET LOCAL`, not `SET`: session-level effects (`SET`, `SET ROLE`, `LISTEN`, `PREPARE`,
  temporary tables, session advisory locks) are not part of the step and can affect the rest of that
  converge call. Converge closes its connection instead of returning it to the pool whenever a step
  ran, so they never reach your application's queries. `tx` is valid only until the callback returns.
- An error in a step rolls it back and records nothing; converge stops with
  `application-step-failed`, and what committed before stays committed. The next call retries it.
  If the connection is lost while the step's `COMMIT` is in flight, the result is
  `transport-ambiguous` instead: the step may or may not be recorded, so run converge again and let it
  observe the ledger rather than repeating the step's work yourself.
- A recorded run appears in `applied` as `application-step:<id>`. `no-drift` means no generated
  change, every `once` recorded and every `assert` healthy.
- An `assert` is inspected before anything runs only when nothing else is pending (no generated
  change, every `once` recorded, no earlier assert found unhealthy), since only then does its answer
  decide `no-drift`. Otherwise it is inspected when its phase comes, so an `after-generated-ddl`
  assert can read tables the same call creates, or what an earlier assert repaired. Every step's
  ledger record is still checked before anything runs, so a malformed or foreign record refuses
  before any step commits. Check mode never runs `apply` and lists pending steps as `application-step` entries of
  `steps`: each unrecorded `once`, and each `assert` either with `inspected: true` (inspected read-only
  and unhealthy) or, when other work is pending, with `inspected: false` (not inspected; apply will).
- dbsp cannot compare function bodies: the `digest` is your statement that a step changed.
- Steps apply to the converged schema only; `scope: 'database'` is refused.

### Owned surfaces

An `assert` may declare `owns` for named declared CHECK constraints, column types, and named
declared indexes that its `apply` maintains. `table`, `column`, and CHECK `name` are model names;
an index `name` is its resolved physical name (the naming plugin's resolved explicit name, or the
default index name). Converge leaves owned surfaces out of its schema comparison and planning, does
not emit an owned CHECK or index on a fresh table, and does not check one during adoption. For owned
CHECKs it renders the state handed to `inspect` and `apply`; the step decides whether that state is
healthy. Other column properties, including defaults and nullability, remain compared.

```typescript
// doctest: skip — illustrates an assertion-owned CHECK
{
  kind: 'assert', id: 'project-state-check', digest: 'v2',
  phase: 'after-generated-ddl',
  owns: { checks: [{ table: 'projects', name: 'project_state_check' }] },
  inspect: async (_tx, owned) =>
    owned.checks.every((check) => check.state === 'healthy') ? 'healthy' : 'unhealthy',
  apply: async (tx, owned) => {
    const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`
    const check = owned.checks[0]!
    await tx.query(`ALTER TABLE ${quoteIdentifier(check.physicalTable)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(check.physicalName)}`)
    await tx.query(`ALTER TABLE ${quoteIdentifier(check.physicalTable)} ADD CONSTRAINT ${quoteIdentifier(check.physicalName)} CHECK (state IN ('ready', 'archived'))`)
  },
}
```

`owns` must be a non-empty object containing only `checks`, `columnTypes`, and `indexes` arrays; at
runtime, a list set to `undefined` is treated as absent.
Entries have exactly the required non-empty string fields and must name one declared surface; no
surface may be owned twice. CHECKs and indexes require `after-generated-ddl`. An owned unique index
cannot be a key referenced by a declared foreign key toward the converged schema. A `once` cannot own anything.
An assert's `inspect` and `apply` both receive a second, read-only `owned` parameter. Its `checks` are in the declared `owns.checks`
order and carry model `table`/`name`, resolved `physicalTable`/`physicalName`, and one of `healthy`,
`absent`, `unrenderable`, `definition-mismatch`, or `unvalidated`. Treat `unrenderable` as unhealthy:
it means PostgreSQL could not render the declared expression yet. `apply` can use the physical names
for DDL; rendered definitions are intentionally not exposed. A CHECK-owning step must run after every
other step that owns a column type on the same table in execution order (a step owning both is allowed), so rendering
uses the current live column types.
`owns` is not part of the recorded step, so changing it never refuses `application-step-changed`;
it changes the check-mode `planDigest`.

An equivalent live index with a different name remains an unowned live index and is refused as
drift. `dbsp plan` and `dbsp apply` do not read `owns`, so they still report such drift. To stop
ownership, remove its entry: the next converge compares it again and refuses a difference as it
would without `owns`.

## Refusals

A refusal throws `PgConvergeRefusalError`: `refusal` names the case and `detail` explains it;
`changes` carries planning context and can be empty. An error raised before execution starts — an
invalid model, a connection failure, a database error while planning — is thrown as it is, except a
database error inside an `initialize` preflight scope (a missing privilege, for example), which
becomes `initialization-refused` with the error in `initialization.detail`, and an error in an
application step's `inspect` or `apply`, or while rendering an owned CHECK's state, which becomes
`application-step-failed` naming the step. A rendering failure carries the original error as
`cause`; an error thrown by `inspect` or `apply` is reported by its message in `detail`. A failed cleanup of
that rendering scope destroys the session: during planning only the rendering scope is rolled back
and no step ran; during execution the step transaction rolls back as for any `application-step-failed`. A failure
during execution becomes an `execution-refused`, `adoption-refused` or `application-step-failed`
refusal, or a `partially-applied` or `transport-ambiguous` result.

| `refusal` | Meaning |
|---|---|
| `invalid-options` | `mode` is not `'apply'`, `'check'` or absent, `initialize` is not `'never'`, `'pristine'`, `'adopt-existing'` or absent, a step is malformed (duplicate or empty `id`, empty `digest`, unknown `phase`, `scope` other than `'schema'`, a timeout that is not a whole number of milliseconds from 1 to 2147483647, a missing `inspect` or `apply`, or steps declared for a schema literally named `$user`), `owns` is malformed, duplicated, undeclared, in the wrong phase, reserves a foreign-key unique key, or runs a CHECK owner before another column-type owner for the same table, or `externalIndexes` is malformed, duplicated, names an undeclared table, or names a declared index. |
| `application-step-changed` | A `once` step already recorded under its `id` is declared with another `digest`. Give the changed step a new `id`. |
| `application-step-failed` | A step's `inspect` or `apply` threw, owned CHECK state rendering failed, an `assert` stayed unhealthy after `apply`, or a step timed out. It names the step and carries the original rendering error as `cause`; failed rendering-scope cleanup destroys the session. During planning only that scope is rolled back and no step ran; during execution the step transaction is rolled back and not recorded. |
| `ledger-absent` | The schema has no ledger and `initialize` is `'never'`, or the call is a check: pass `initialize`, or run `runPgReinitializePreflight`. |
| `initialization-refused` | `initialize` could not create the ledger: under `'pristine'` a declared table or sequence already exists, or the schema does not exist, or the role lacks a privilege. `initialization` carries the failing home, a refusal code, the step and the detail; the `'pristine'` guard's code is `pristine-live-relations`, other failures carry the preflight's code. The schema's ledger is created only after `dbsp_meta` is ready, so a refused `dbsp_meta` leaves the schema without a ledger and the next call refuses again; a refusal of the schema itself can leave `dbsp_meta` prepared, which the next call reuses. |
| `incompatible-ledger` | The schema's ledger fails its currency check; `detail` gives the reason. |
| `unsupported-server` | PostgreSQL is older than 15. |
| `database-read-only` | The target refuses writes (a standby, or a session whose transactions are read-only); converge checks this before comparing and writes nothing, even when the model already matches. A target that becomes read-only after that check and before converge's first write is reported `execution-refused`, with the reason in `detail`; after earlier steps committed, the result is `partially-applied`. |
| `busy` | Another converge call or transition writer holds the schema's ledger lock, or every open claim belongs to a run still executing. Retry after a delay. |
| `recovery-required` | Earlier runs left open claims. Reconcile each run in `runIds` with `reconcilePgTransitionRun(pool, runId)` (the pool must allow two connections) or `dbsp reconcile --db <database> <run-id>`; `busyRunIds` lists runs still executing. `executionIds` lists claims no readable journal run explains; no public operation resolves a claim by execution id, so they need the ledger owner. Call converge again once no claim is open. |
| `unsupported-change` | The model asks for a change converge does not apply. Plan it with `dbsp plan` and `dbsp apply`, or change the model. |
| `unmanaged-object` | A live object at an address converge would manage is not managed by dbsp: an existing table or sequence, or an object created while converge was running. |
| `unmanaged-parent` | A change targets a table dbsp does not manage. |
| `concurrent-drift` | A declared object disappeared while converge was planning. |
| `adoption-refused` | A table or sequence marked `adopt: true`, or treated as marked under `initialize: 'adopt-existing'`, could not be adopted. With an unknown ledger state, it is absent or differs from its declaration; a sequence is also refused when it is owned by a column (`OWNED BY`, serial or identity), is not `bigint` with cache 1, or is declared in another schema. An object already managed under the same catalogue identity is skipped, and its drift follows the ordinary rules (for example `unsupported-change`). Any other ledger state is refused, which includes a managed object that was dropped and recreated; converge offers no way to take it over. |
| `execution-refused` | The executor refused or failed a step; `detail` says why. |

## Adopting an existing install

If an earlier version of your application created its tables without dbsp, `convergePg` refuses
them as `unmanaged-object`. Two ways take them into management:

- `initialize: 'adopt-existing'` at every start. On every call, each declared table and standalone
  sequence that exists in the schema is treated as marked `adopt: true`, and each one that does not
  exist is created, whatever its declared flag. A call that stops part-way resumes on the next start.
  A table someone creates later outside dbsp with exactly its declared shape is adopted rather than
  refused.
- One pass in which the model marks each table `adopt: true`, then drop the flag. The rules below
  apply to both ways:

- A table is adopted only if it exists, its ledger state is unknown, and it matches its declaration
  exactly, columns, types, defaults, keys and indexes included (after [External indexes](#external-indexes)
  masking and [Owned surfaces](#owned-surfaces) masking: owned CHECKs, owned indexes and owned column
  types are masked). A mismatch found while planning refuses
  `adoption-refused` before anything is written.
- Each table is adopted in its own transaction. A table that changes while its adoption runs is
  refused, and tables adopted earlier in the same call stay adopted; the next call skips them.
- A table that is already managed is never adopted again, with `adopt: true` or
  `adopt-existing`: its model changes converge like those of any managed table.
- Without `adopt-existing`, `adopt: true` on a table that does not exist is refused, so do not set it
  on a fresh install.
- An install that lags the model, for example a missing column, must be brought to the model before
  the adoption pass.

A sequence created outside dbsp is refused as `unmanaged-object` too. Declare it with `adopt: true`
in the schema's `sequences` for the same pass, or converge with `initialize: 'adopt-existing'`:

- It is adopted only if it is a standalone sequence (not owned by a column through `OWNED BY`, serial
  or identity), `bigint` with cache 1, in the schema converge targets, its ledger state is unknown,
  and its start, increment, minimum, maximum and cycle match the declaration.
- Its current value is never read or reset: the next `nextval` continues where it was.
- The match is observed on the adoption's own session before it commits. PostgreSQL has no lock that
  keeps a sequence from being altered in between, so an `ALTER SEQUENCE` running at that moment is
  not excluded.
- Type, cache and ownership are checked only when adopting. A managed sequence later altered on them
  is not reported as drift.
- `adopt: true` kept on a sequence that is already managed is a no-op. Only `convergePg` and
  `dbsp migrate` adopt sequences; `dbsp plan` and `dbsp apply` refuse a sequence marked `adopt: true`.

```typescript
// doctest: real-db-only — adopts a table created outside dbsp
import { convergePg, createPgPhysicalModel, runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';

await pool.query('CREATE SCHEMA IF NOT EXISTS converge_guide');
const report = await runPgReinitializePreflight({
  pool,
  schemas: ['converge_guide'],
  declarations: { version: 1, digest: 'none', declarations: [] },
  writeAdoptionFile: async () => {},
});
if (report.scopes.some((scope) => scope.outcome === 'failed' || scope.outcome === 'not-attempted')) {
  throw new Error('preflight did not prepare every scope');
}
// A table an earlier version created by hand.
await pool.query(
  'CREATE TABLE IF NOT EXISTS converge_guide.legacy_notes ("id" integer NOT NULL PRIMARY KEY, "body" text NOT NULL)',
);

const tables = {
  legacy_notes: {
    id: { type: 'integer', primaryKey: true },
    body: 'text',
  },
} as const;

// The one-time pass over the existing install.
await convergePg(pool, createPgPhysicalModel({
	mode: 'logical',
	model: schema(tables, { legacy_notes: { adopt: true } }).model,
	schema: 'converge_guide',
}), {
});

// Every later start omits adopt.
const result = await convergePg(pool, createPgPhysicalModel({
	mode: 'logical', model: schema(tables).model, schema: 'converge_guide',
}));
if (result.kind !== 'no-drift') throw new Error(`expected no-drift, got ${result.kind}`);
```

## External indexes

Some indexes cannot be declared in the model, for example indexes with extension-specific options.
Create them yourself after `convergePg`, and name them so converge leaves them alone:

```typescript
// doctest: skip — illustrates the option only
await convergePg(pool, createPgPhysicalModel({ mode: 'logical', model, schema: 'app' }), {
  externalIndexes: [{ table: 'documents', name: 'documents_search_index' }],
});
```

Each entry names a declared table and the exact physical index name. Converge never drops a live
index named here and does not report it as drift. This is unlike `owns`: an external index is not
declared in the model and only filters a live-side `drop_index`; an owned index remains declared,
is removed from both comparison sides, and is maintained by an assert.

## Running alongside `dbsp apply`

`convergePg` and `dbsp apply` take the same ledger lock without waiting. On the same schema at the
same time, a `convergePg` call that finds the lock taken refuses `busy`, and a `dbsp apply` run stops
at the contested step with `execution-failed`, or `partially-applied` after earlier steps. Run them
one after the other.
