---
title: Managed schema history
---

# Managed schema history

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
