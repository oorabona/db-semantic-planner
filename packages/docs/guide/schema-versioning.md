---
title: Managed schema history
---

# Managed schema history

Create the PostgreSQL physical model once for the target schema before comparing
versions. `compareSchemata(desiredPhysical, databasePhysical)` returns the
stamped diff that `generateMigrationSQL(diff)` consumes; schema and naming are
therefore not per-call options.

`dbsp plan` and its no-argument `dbsp apply` path do the same before transition
planning: they build `createPgPhysicalModel({ mode: 'logical', model, schema,
dbCasing })` once from the schema file. Declaration addresses, comparison and
transition operations then use `physical.model`; no plan or preflight command
maps declared identifiers independently.

DBSP records managed intent and verified outcomes in its ledger; it does not
make local SQL files an execution authority. The live catalogue remains the
authority for what a database contains.

Use `plan` to create a durable, reviewable record, `apply` to execute it,
`inspect` to read its address and state, and `reconcile` after an interrupted
run. `release` and `preflight --reinitialize` are explicit administration
operations with their own safety checks. A no-argument `apply` persists before
presentation; `apply <run-id>` executes only the recorded plan.

For caller-owned SQL, use `generate ddl` as rendering output and execute it
under the caller's own controls. It is not part of the managed apply protocol.

`plan` refuses a change that removes or replaces a unique index, a primary key
or a column's unique constraint when a foreign key in the compared schema
references the same columns, and so does `generateMigrationSQL` with
`includeDestructive`. dbsp cannot address that foreign key yet (#319): drop it,
change the key and recreate it in a reviewed manual migration, then plan again.
The schema comparison still reports the change, with the foreign keys in
`meta.referencedBy`.
