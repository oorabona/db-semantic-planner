---
title: DDL Provisioning
---

# DDL provisioning

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
