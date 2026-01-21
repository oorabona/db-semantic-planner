# TODO: CLI-NQL (Natural Query Language v1.0)

**Spec:** docs/plans/CLI-NQL-natural-query-language.md
**Status:** ✅ COMPLETE (2026-01-21)

## Overview

Extend REPL natural query language to be a complete "new SQL" - simpler for humans and AI.

**Key Features:**
- Relation path traversal (N levels): `product.category.parent.name`
- Quoted identifiers for column escape: `"children"` forces column interpretation
- Subqueries: `= (subquery)` and `in (subquery)`
- Existence checks: `has`/`not has` (EXISTS)
- FK lookup INSERT: `from table where`
- Recursive relations: ancestors/descendants
- Window functions: `rank() over (partition by ...)`
- Parse tree output: `.parse` command
- Mandatory comma separators for lists

---

## Pending

(None - all blocks completed)

---

## In Progress

(None)

---

## Completed (CLI-NQL)

- [x] ✅ Block 1: Schema Relation Types (2026-01-21)
- [x] ✅ Block 2: Path Expression Parser — N-level paths + quoted identifiers + comma separators (2026-01-21)
- [x] ✅ Block 3: Subquery Parser — `(table query_body)` syntax (2026-01-21)
- [x] ✅ Block 4: Existence Parser — `has`/`not has` keywords (2026-01-21)
- [x] ✅ Block 5: IN/NOT IN Subquery — Extend `parseWhereCondition()` (2026-01-21)
- [x] ✅ Block 6: INSERT FROM Parser — `from table where` and `for update` (2026-01-21)
- [x] ✅ Block 7: Recursive Relations Parser — ancestors/descendants from schema (2026-01-21)
- [x] ✅ Block 8: Window Expression Parser — `over (partition by ... order by ...)` (2026-01-21)
- [x] ✅ Block 9: Query Executor - Path Resolution — N-level JOINs and CTEs (2026-01-21)
- [x] ✅ Block 10: Query Executor - Subqueries — Scalar, IN, EXISTS generation (2026-01-21)
- [x] ✅ Block 11: INSERT FROM Executor — FK lookup SQL generation (2026-01-21)
- [x] ✅ Block 12: .parse Command — Parse tree toggle (2026-01-21)
- [x] ✅ Block 13: Documentation & Tests — QUICKSTART and .dbsp updates (2026-01-21)

**Total: ~20h (13 blocks)**

## Completed (CLI-MUT - Previous Sprint)

- [x] ✅ Block 5: Query Executor Integration (2026-01-20)
- [x] ✅ Block 4: UPSERT Parser & Explain Toggle (2026-01-20)
- [x] ✅ Block 1: Types & Parser Foundation (2026-01-20)
- [x] ✅ Block 2: INSERT Parser (2026-01-20)
- [x] ✅ Block 3: UPDATE & DELETE Parsers (2026-01-20)

---

## Deferred (v2)

- [ ] `.load <table> <file>` - Bulk CSV/JSON import
- [ ] RETURNING clause support
- [ ] Transaction support (BEGIN/COMMIT/ROLLBACK)
- [ ] Set operations (UNION, INTERSECT, EXCEPT)
