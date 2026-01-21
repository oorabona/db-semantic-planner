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

## Bugfixes

- [x] ✅ Column selection with aliases: `select name as n` (2026-01-21)
  - Parser now handles simple column names (not just aggregates)
  - Support for `AS alias` syntax per EBNF grammar
  - Query executor uses `col()` helper with native Kysely `eb.ref().as()`

- [x] ✅ Backspace/Delete key swap in REPL (2026-01-21)
  - Fixed key detection: Backspace checks `key.backspace`, `\x7f`, `\x08`, or `key.delete && input === ''`
  - Delete key ONLY trusts escape sequence `\x1b[3~` (not `key.delete` flag)
  - Resolves terminal-specific behavior differences

- [x] ✅ Include column filtering with explicit relation columns (2026-01-21)
  - Skip include when `relationColumn()` already handles the JOIN
  - Prevents duplicate columns: `category.name as categoryName include category` no longer returns all category columns
  - Collects relations with explicit column selections before adding includes

- [x] ✅ Qualified WHERE paths stay in main WHERE clause (2026-01-21)
  - Fixed parser to keep ALL qualified paths (e.g., `category.name`, `category.parent.name`) in main WHERE
  - Previously, qualified filters were incorrectly distributed to include filters (only filtering includes, not main query)

- [x] ✅ Delete key proper detection using raw stdin (2026-01-21)
  - Root cause: Ink's `parse-keypress.ts` maps both `\x7f` (Backspace) and `\x1b[3~` (Delete) to `key.delete`
  - Solution: Use `useStdin` hook to capture raw bytes BEFORE Ink processes them
  - Delete key now correctly deletes character AFTER cursor (forward delete)

- [x] ✅ CLI flags --use/--parse/--exec work standalone (2026-01-21)
  - Previously `--use` required `--eval` or `--input` (batch mode)
  - Now these flags can be used to pre-configure REPL environment
  - Added `initialSchemaName`, `initialParseMode`, `initialExecMode` to ReplConfig

- [x] ✅ Ctrl+R reverse history search (2026-01-21)
  - Added `reverseSearch()` method to CommandHistory class
  - Search mode with visual feedback: `(reverse-i-search): query → match`
  - Ctrl+R cycles through matches, Enter accepts, Escape cancels
  - Query executor converts qualified paths to `relationFilter` intents for proper JOIN/EXISTS handling
  - Fixed `getTableFromAlias()` in compiler to handle `_join` suffix for relation tables

- [x] ✅ ORDER BY alias not prefixed with table alias (2026-01-21)
  - Added `collectSelectAliases()` to detect aliases from SELECT clause
  - ORDER BY now uses bare alias (`"salesCount"`) instead of qualified (`"t0"."salesCount"`)
  - Fixes aggregate/window aliases in ORDER BY clause

- [x] ✅ GROUP BY relation path auto-JOIN (2026-01-21)
  - Fixed ModelIR API usage: `model.getTable()` instead of `model.tables[]`
  - Fixed ModelIR API usage: `model.getRelation()` instead of `model.relations[]`
  - GROUP BY `author.name` now correctly JOINs and uses alias `t1.name`

- [x] ✅ Cross-table ancestors syntax (2026-01-21)
  - Added `sourceRelation` field to `ExistenceCheck` interface
  - Extended `isExistenceCheck` to detect `<relation> has ancestors` pattern
  - Extended `parseExistenceCheck` to resolve cross-table lookup via relation target
  - Enables: `products where category has ancestors where name = 'Root'`

- [x] ✅ Auto-inferred recursive relations in lookupRelation (2026-01-21)
  - Fixed `lookupRelation()` to check `getRecursiveRelationInfo()` before throwing errors
  - Supports automatic inference of `ancestors`/`descendants` from `parent`/`children` relations
  - Enables: `categories where ancestors.name = 'Root'` without explicit schema definition

- [x] ✅ Qualified WHERE paths stay in main WHERE clause (2026-01-21)
  - Fixed parser to keep ALL qualified paths (e.g., `author.name`) in main WHERE
  - Previously, qualified filters were incorrectly distributed to pendingQualifiedFilters
  - Query executor converts qualified paths to relationFilter intents for proper JOIN/EXISTS

## Improvements

- [x] ✅ Native column aliasing via `col()` helper (2026-01-21)
  - Added `ColumnAliasIntent` to core intent-ast
  - Created `col(column, alias)` helper in core/dx/filters
  - Implemented native Kysely handler using `eb.ref().as()` (no raw SQL)
  - Replaces previous `raw()` approach for type-safe, dialect-portable aliasing

- [x] ✅ Relation column auto-JOIN via `relationColumn()` helper (2026-01-21)
  - Added `RelationColumnIntent` to core intent-ast
  - Created `relationColumn(relation, column, alias)` helper in core/dx/filters
  - Implemented `relationColumnHandler` with automatic LEFT JOIN creation
  - Enables simplified syntax: `products select name, categories.name as categoryName`
  - Supports multi-level paths: `product.category.parent.name`
  - Reuses existing JOINs from include/where operations

- [x] ✅ Table configuration via `.table` command (2026-01-21)
  - Added `packages/cli/src/config.ts` with ConfigManager singleton
  - Persistent config at `~/.dbsp/config.json` (override with `-c` flag)
  - Configurable options: borders, overflow, headers, padding
  - Result formatter uses @oclif/table with config values
  - `.table [option] [value]` for viewing/setting, `.table reset` for defaults

---

## Deferred (v2)

- [x] ✅ Add unit tests for config module (review finding F-001, S size) (2026-01-21)
- [x] ✅ Add compiler test for `compileRecursiveExists` (review finding F-002, M size) (2026-01-21)
- [ ] `.load <table> <file>` - Bulk CSV/JSON import
- [ ] RETURNING clause support
- [ ] Transaction support (BEGIN/COMMIT/ROLLBACK)
- [ ] Set operations (UNION, INTERSECT, EXCEPT)
