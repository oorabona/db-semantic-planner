# TODO: CLI-MUT (REPL Mutation Syntax)

**Spec:** docs/plans/CLI-MUT-repl-mutation-syntax.md
**Status:** ✅ COMPLETE (2026-01-20)

## Overview

Extend REPL natural query language with INSERT/UPDATE/DELETE/UPSERT support.

**Key Features:**
- SQL-like `key = value` syntax
- Dry-run default, `!` suffix to execute
- `.explain` toggle for EXPLAIN output
- Column validation against schema
- Bulk operation confirmation (>100 rows)

---

## Pending

(none)

---

## In Progress

(none)

---

## Completed

- [x] ✅ Block 5: Query Executor Integration (2026-01-20)
  - executeMutation() function with INSERT/UPDATE/DELETE/UPSERT support
  - formatMutationResult() for display formatting
  - MutationExecutionResult type with dryRun indicator
  - REPL index.tsx integration for mutation handling
  - SC-13 (column validation), SC-14 (SQL injection prevention) scenarios covered
  - 15 new integration tests

- [x] ✅ Block 4: UPSERT Parser & Explain Toggle (2026-01-20)
  - parseUpsert() with DO NOTHING / DO UPDATE SET actions
  - Single and composite conflict column support (ON col / ON (col1, col2))
  - .explain dot command with on/off/toggle
  - Added explainMode to BatchState
  - SC-10 to SC-12, SC-15 to SC-17 scenarios covered
  - 17 new unit tests (12 UPSERT + 5 .explain)

- [x] ✅ Block 1: Types & Parser Foundation (2026-01-20)
  - Added MutationType, ParsedMutation, Assignment, MutationValue, OnConflictClause types
  - Added explainMode to ReplState
  - Added MUTATION_KEYWORDS, isMutationKeyword(), parseMutationValue() helpers
  - 22 new unit tests for mutation helpers

- [x] ✅ Block 2: INSERT Parser (2026-01-20)
  - Added parseAssignment(), parseAssignments(), validateColumn(), parseInsert()
  - Added parseMutation() dispatcher function
  - SC-01, SC-02, SC-03 scenarios covered
  - 25 new unit tests for INSERT parsing

- [x] ✅ Block 3: UPDATE & DELETE Parsers (2026-01-20)
  - Added parseUpdate() with SET clause and WHERE requirement
  - Added parseDelete() with WHERE safety check
  - Updated parseMutation() dispatcher for UPDATE/DELETE
  - SC-04 to SC-09 scenarios covered
  - 17 new unit tests for UPDATE/DELETE parsing

---

## Deferred (v2)

- [ ] `.load <table> <file>` - Bulk CSV/JSON import
- [ ] RETURNING clause support
- [ ] Transaction support (BEGIN/COMMIT/ROLLBACK)
