---
title: DDL Provisioning
---

# DDL provisioning

PostgreSQL DDL APIs take a `PgPhysicalModel`, created once with
`createPgPhysicalModel({ mode: 'logical', model, schema, dbCasing })`. Pass that
same value to `generateDDL`, `compareSchemata`, and live comparison; an
introspected model is wrapped with `mode: 'physical'` and is never mapped again.

CHECK expressions, index predicates and expressions, policy `USING` and
`WITH CHECK`, and SQL default expression text use database column names after
`dbCasing`; identifiers inside those SQL strings are not rewritten. If
`createdAt` is mapped by `snake_case`, write `created_at` in an expression such
as `created_at > now()`. CHECK expressions may be trimmed, have `NOT VALID`
re-attached, and be wrapped as a `CHECK` clause; engine-canonical literals can
also be re-escaped when the DDL is rendered.

Managed database changes use one path: `dbsp plan` records a proven change and
`dbsp apply` executes a replayable record. This keeps execution authority, live
observation, and the durable outcome in the same workflow.

Use `dbsp apply` without a run id when you want DBSP to make and persist a new
plan before showing it for approval. Keep the run ID and digest printed by
`plan` or `apply`. Use `dbsp apply <run-id>` only to execute a replayable
recorded plan unchanged. `--dry-run` never persists a new run; a declined
removal is not replayable and must be planned again when you are ready to
proceed.

`dbsp generate ddl` is intentionally separate. It renders DDL for a caller to
own and execute, so it is explicitly unmanaged and has no ledger authority.
Runtime DDL helpers are likewise caller-owned, schema-scoped APIs. Use
`inspect`, `reconcile`, `release`, and `preflight --reinitialize` to observe or
administer the managed ledger rather than to bypass it.
