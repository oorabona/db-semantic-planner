---
title: CLI Usage
---

# CLI usage

`dbsp` has one managed DDL execution path: plan a change, then apply it. A
no-argument `apply` creates, persists, and presents a fresh managed run; an
`apply <run-id>` executes exactly that replayable recorded run. There is no
direct schema execution command or file-based execution command.

## Managed workflow

| Command | Purpose |
| --- | --- |
| `dbsp plan` | Compare declared and live state, prove a managed plan, and record it. |
| `dbsp apply [run-id]` | Present and execute one replayable managed plan; without an id it persists before presenting. |
| `dbsp inspect [address]` | Read the ledger and live state without repairing it. |
| `dbsp reconcile <run-id>` | Classify a previously recorded run against live state. |
| `dbsp release <address>` | Release managed authority when its safety checks permit it. |
| `dbsp preflight --reinitialize` | Check and explicitly reinitialize a managed ledger when allowed. |

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
