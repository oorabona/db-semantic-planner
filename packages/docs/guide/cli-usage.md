---
title: CLI Usage
---

# CLI usage

`dbsp` reaches one managed DDL executor from two commands. The reviewed path is
plan a change, then apply it: a no-argument `apply` creates, persists, and
presents a fresh managed run, and an `apply <run-id>` executes exactly that
replayable recorded run. `dbsp migrate` converges a schema file without review
and admits only additions and declared adoptions. There is no migration-file
`apply` or `rollback` workflow.

## Managed workflow

| Command | Purpose |
| --- | --- |
| `dbsp plan` | Compare declared and live state, prove a managed plan, and record it. |
| `dbsp apply [run-id]` | Present and execute one replayable managed plan; without an id it persists before presenting. |
| `dbsp inspect [address]` | Read the ledger and live state without repairing it. |
| `dbsp reconcile <run-id>` | Classify a previously recorded run against live state. |
| `dbsp release <address>` | Release managed authority when its safety checks permit it. |
| `dbsp preflight --reinitialize` | Check and explicitly reinitialize a managed ledger when allowed. |
| `dbsp migrate <schema-file>` | Converge the schema to the file without review, through `convergePg`. |

```bash
dbsp plan ./schema.ts --db "$DATABASE_URL" --schema "$DBSP_SCHEMA"
# Run the recorded id and digest printed by the preceding command.
dbsp apply "$RUN_ID" --db "$DATABASE_URL" --plan-digest "$PLAN_DIGEST" --accept operation-pack-semantics --accept external-ddl-exclusion
dbsp inspect table:users --db "$DATABASE_URL" --schema "$DBSP_SCHEMA" --format json
```

`--dry-run` on no-argument `apply` does not persist a run. Keep the run ID and
digest printed by `plan` or `apply`: a recorded `apply <run-id>` is available
only for replayable runs. A declined removal is not replayable; re-plan it when
you are ready to proceed. `--yes` accepts the presentation step.

## Startup convergence

```bash
dbsp migrate ./schema.ts --db "$DATABASE_URL" --schema "$DBSP_SCHEMA" --format json
```

`dbsp migrate` runs [`convergePg`](./converge.md) once: it creates what the
schema file adds, adopts the tables it marks `adopt: true`, and refuses any
other change before sending DDL. It asks for no confirmation and has no dry
run; review a change with `dbsp plan` instead. The schema needs its ledger
first, from `dbsp preflight --reinitialize`. Name each index you manage
yourself with `--external-index <table>:<index>`; the table part cannot
contain `:`. Every result and refusal is a named outcome with its own exit
code, listed by `dbsp migrate --help`; `no-drift` and `applied` exit 0.

## Other local tools

`dbsp generate ddl` renders SQL for review or caller-owned execution. It is an
explicitly unmanaged API: it does not connect to a database, claim ledger
authority, or apply SQL. `dbsp repl`, `introspect`, and `verify` remain local
exploration and validation tools.

## Output

Commands that support JSON emit one JSON document to stdout. Human diagnostics
escape control and terminal-control sequences in database-controlled names;
SQL text, credentials, and declarations are not logged by default.

## Published internal adapter export

`@dbsp/adapter-pgsql/internal` is a published subpath used by DBSP's managed
facade. It is unsupported for external integrations; in-process use is trusted
by declaration and the subpath is not a security boundary. Use the public
adapter APIs for supported integrations.
