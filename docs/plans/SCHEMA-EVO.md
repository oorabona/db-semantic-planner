---
doc-meta:
  status: canonical
  scope: adapter-pgsql, cli, gui
  type: specification
  created: 2026-02-16
  updated: 2026-02-16
  complexity: COMPLEX
  time-budget: 2h+
  adversarial_applied: true
  llm_reviewed: true
---

# Specification: SCHEMA-EVO — DOWN Migrations, Schema Versioning, GUI Enhancements

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | adapter-pgsql/ddl, cli, gui |
| Complexity | COMPLEX |
| Time budget | 2h+ |
| Blocks | 6 |
| BDD scenarios | 27 |
| Risk level | MEDIUM |

## 1. Problem Statement

The DDL provisioning system currently supports forward-only migrations. Developers cannot roll back applied migrations, have no schema version tracking, and the GUI schema diff shows only a text list of changes without SQL preview or apply capability. This limits developer productivity and operational safety.

## 2. User Stories

### US-1: Rollback Safety
AS A developer deploying schema changes,
I WANT auto-generated DOWN SQL for each migration with manual override,
SO THAT I can safely roll back schema changes when a deployment goes wrong.

ACCEPTANCE: `dbsp migrate rollback 1` reverts the last migration.

### US-2: Schema Version Tracking
AS A DBA monitoring schema state,
I WANT a monotonic schema version number and destructive flag per migration,
SO THAT I can quickly assess schema age and identify breaking changes.

ACCEPTANCE: `dbsp migrate status` shows current schema version and flags destructive migrations.

### US-3: Visual Schema Management
AS A developer using the GUI,
I WANT to preview UP/DOWN SQL, apply diffs directly, and see side-by-side changes,
SO THAT I can manage schema evolution without leaving the desktop app.

ACCEPTANCE: GUI shows SQL preview, Apply button executes changes, side-by-side view compares old/new.

## 3. Business Rules

### 3.1 Invariants
- INV-01: Every migration file contains an UP section; DOWN section is optional
- INV-02: `schema_version` is a state pointer — increments on apply, decrements on rollback (no gaps)
- INV-03: Rollback only applies to tracked migrations (present in `_dbsp_migrations`)
- INV-04: Advisory lock protects concurrent migration/rollback operations (dedicated client, not pool query)
- INV-06: DOWN is considered destructive if it produces DROP TABLE, DROP COLUMN, or lossy ALTER COLUMN TYPE
- INV-05: Apply button in GUI requires SQL preview confirmation before execution

### 3.2 Preconditions
- PRE-01: Rollback requires the migration file to exist on disk with a `-- DOWN` section
- PRE-02: Rollback of destructive DOWN (per INV-06) requires `--force` flag (CLI) or double confirmation (GUI)
- PRE-03: Apply button requires an active database connection

### 3.3 Effects
- EFF-01: `generateDownSQL(diff)` returns reverse SQL for each change (or warning comment for irreversible)
- EFF-02: `dbsp migrate dev` generates files with UP + DOWN sections separated by `-- DOWN`
- EFF-03: Rollback removes the migration record from `_dbsp_migrations` after executing DOWN
- EFF-04: Each `recordMigration` increments `schema_version` by 1
- EFF-05: GUI Apply executes the UP SQL via sidecar, refreshes diff on success

### 3.4 Error Handling
- ERR-01: Rollback with no DOWN section → error "No DOWN section in migration [name]"
- ERR-02: Rollback with checksum mismatch → error "Migration file modified since apply"
- ERR-03: Rollback count > applied count → error "Cannot rollback N, only M applied"
- ERR-04: DOWN section empty → error "Empty DOWN section — use --force to skip and remove record"
- ERR-05: GUI Apply failure → transaction rollback, error displayed, diff unchanged

## 4. Technical Design

### 4.1 Architecture Decision

**DOWN SQL generation** uses a symmetric `changeToUpSQL`/`changeToDownSQL` pattern. Each `ChangeKind` has paired functions. This avoids divergence between UP and DOWN logic.

**Schema versioning** uses a simple integer counter + boolean destructive flag per migration. No semver — simpler, no consumer confusion, same signal via the flag.

**GUI SQL** is pre-computed in the sidecar (not in the frontend). The sidecar returns `upSQL[]` and `downSQL[]` alongside the diff. This avoids shipping the migration-sql module to the frontend.

### 4.2 Reversibility Matrix (14 ChangeKinds)

| ChangeKind | Reversible | DOWN SQL | Notes |
|------------|------------|----------|-------|
| `create_table` | YES | `DROP TABLE` | |
| `drop_table` | NO | `-- WARNING: cannot reconstruct` | Data lost |
| `add_column` | YES | `ALTER TABLE DROP COLUMN` | DOWN is destructive (data lost) |
| `drop_column` | NO | `-- WARNING: cannot reconstruct` | Data lost |
| `alter_column_type` | PARTIAL | `ALTER COLUMN TYPE [fromType]` | Requires `meta.fromType`; missing meta → warning comment |
| `alter_column_nullable` | YES | Reverse SET/DROP NOT NULL | |
| `alter_column_default` | PARTIAL | `SET DEFAULT [oldDefault]` / `DROP DEFAULT` | Requires `meta.oldDefault`; missing meta → warning comment |
| `add_primary_key` | YES | `DROP CONSTRAINT` | |
| `drop_primary_key` | NO | `-- WARNING: cannot reconstruct` | Columns unknown |
| `add_foreign_key` | YES | `DROP CONSTRAINT` | |
| `drop_foreign_key` | NO | `-- WARNING: cannot reconstruct` | FK unknown |
| `alter_foreign_key` | YES | Reverse to `meta.oldFk` | Requires `meta.oldFk`; missing meta → warning comment |
| `create_index` | YES | `DROP INDEX` | |
| `drop_index` | NO | `-- WARNING: cannot reconstruct` | Index def unknown |

**Meta fallback rule:** When `meta.fromType`, `meta.oldDefault`, or `meta.oldFk` is missing (older migration, manual edit), treat as irreversible and generate warning comment.

### 4.3 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| `_dbsp_migrations` | Add `schema_version INTEGER NOT NULL DEFAULT 0` + backfill by `ROW_NUMBER() OVER (ORDER BY applied_at)` | Yes (auto-migrate) |
| `_dbsp_migrations` | Add `destructive BOOLEAN NOT NULL DEFAULT false` | Yes (auto-migrate) |
| `migration-tracker.ts` | Refactor advisory lock to use dedicated client (`pool.connect()`) not `pool.query()` | No (code fix) |
| `SchemaChange.meta` | Add `fromType`, `oldDefault`, `oldFk` for alter_* kinds | No (in-memory only) |

### 4.4 Migration File Format v2

```sql
-- Migration: 0003_add_user_email
-- Generated by: dbsp migrate dev
-- Date: 2026-02-16T19:30:00+01:00

ALTER TABLE "users" ADD COLUMN "email" varchar(255) NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");

-- DOWN

ALTER TABLE "users" DROP COLUMN "email" CASCADE;
-- WARNING: DROP INDEX "idx_users_email" auto-cascaded with column drop
```

**Parsing rules:**
- Separator: `^\s*-- DOWN\s*$` (strict regex, own line only)
- UP section: everything before separator (excluding header comments)
- DOWN section: everything after separator
- Statement splitting: by semicolons (`;`) — `$$` blocks not supported in auto-generated SQL
- Schema version is NOT in the file header (assigned at apply-time by `max(schema_version) + 1`)

### 4.5 IPC Contract (GUI sidecar)

**Extended `SchemaDiffResult`:**

```typescript
interface SchemaDiffResult {
  changes: SchemaDiffChange[];
  hasDestructive: boolean;
  summary: DiffSummary;
  upSQL: string[];      // NEW: pre-computed UP statements
  downSQL: string[];    // NEW: pre-computed DOWN statements
}
```

**New method: `schema.apply`**

```typescript
interface SchemaApplyParams {
  connectionId: string;
  schemaPath: string;
  includeDestructive: boolean;
}

interface SchemaApplyResult {
  applied: number;       // statements executed
  schemaVersion: number; // new version after apply
  destructive: boolean;
}
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: DOWN SQL Generation

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Generate DOWN for create_table
  Given a SchemaDiff with a create_table change for "users"
  When generateDownSQL(diff) is called
  Then it returns 'DROP TABLE IF EXISTS "users" CASCADE;'

@priority:high @type:nominal
Scenario: SC-02 — Generate DOWN for add_column
  Given a SchemaDiff with add_column "email" on "users"
  When generateDownSQL(diff) is called
  Then it returns 'ALTER TABLE "users" DROP COLUMN "email" CASCADE;'

@priority:high @type:nominal
Scenario: SC-03 — Generate DOWN for alter_column_type
  Given a SchemaDiff with alter_column_type on "users"."age" with meta.fromType = "integer"
  When generateDownSQL(diff) is called
  Then it returns 'ALTER TABLE "users" ALTER COLUMN "age" TYPE integer;'

@priority:high @type:edge
Scenario: SC-04 — DOWN for irreversible drop_table
  Given a SchemaDiff with drop_table "legacy"
  When generateDownSQL(diff) is called
  Then it returns '-- WARNING: Cannot reverse drop_table "legacy" — table data was lost'

@priority:medium @type:nominal
Scenario: SC-05 — DOWN for alter_column_nullable
  Given a SchemaDiff changing "users"."name" from nullable to NOT NULL
  When generateDownSQL(diff) is called
  Then it returns 'ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;'

@priority:medium @type:nominal
Scenario: SC-06 — DOWN for add/drop FK and index
  Given a SchemaDiff with add_foreign_key and create_index
  When generateDownSQL(diff) is called
  Then FK returns DROP CONSTRAINT and index returns DROP INDEX

@priority:medium @type:nominal
Scenario: SC-07 — DOWN for alter_foreign_key with oldFk
  Given a SchemaDiff with alter_foreign_key and meta.oldFk stored
  When generateDownSQL(diff) is called
  Then it generates DROP new FK + ADD old FK

@priority:medium @type:edge
Scenario: SC-08 — DOWN topological order is reversed
  Given a SchemaDiff with create_table + add_fk + create_index
  When generateDownSQL(diff) is called
  Then order is: DROP INDEX, DROP FK, DROP TABLE (reverse of UP)
```

### Scenario Group: Migration File Format

```gherkin
@priority:high @type:nominal
Scenario: SC-09 — Generate migration with UP + DOWN
  Given a SchemaDiff with 3 changes
  When dbsp migrate dev generates a file
  Then file contains UP SQL, '-- DOWN' separator, and DOWN SQL

@priority:high @type:edge
Scenario: SC-10 — Parse migration with no DOWN section
  Given a migration file without '-- DOWN' separator
  When rollback is attempted
  Then error: "No DOWN section in migration 0001_initial.sql"

@priority:medium @type:edge
Scenario: SC-11 — Parse migration with empty DOWN
  Given a migration file with '-- DOWN' followed by only comments/whitespace
  When rollback is attempted
  Then error: "Empty DOWN section — use --force to skip and remove record"

@priority:medium @type:edge
Scenario: SC-25 — Separator inside string literal does not split
  Given a migration file with SQL: INSERT INTO t VALUES ('-- DOWN');
  When the file is parsed
  Then the entire INSERT is in the UP section (separator only matches own line)
```

### Scenario Group: Schema Versioning

```gherkin
@priority:high @type:nominal
Scenario: SC-12 — Version increments on apply
  Given _dbsp_migrations has max schema_version = 5
  When a new migration is applied
  Then schema_version = 6 is recorded

@priority:high @type:nominal
Scenario: SC-13 — Destructive flag set for destructive changes
  Given a migration with drop_table changes
  When the migration is applied
  Then destructive = true in the migration record

@priority:medium @type:edge
Scenario: SC-14 — First migration starts at version 1
  Given empty _dbsp_migrations table
  When first migration is applied
  Then schema_version = 1

@priority:medium @type:nominal
Scenario: SC-15 — Auto-migrate adds new columns to existing table
  Given _dbsp_migrations exists without schema_version column
  When ensureMigrationsTable() runs
  Then schema_version and destructive columns are added (ALTER TABLE)
```

### Scenario Group: Rollback

```gherkin
@priority:high @type:nominal
Scenario: SC-16 — Rollback last migration
  Given migration 0003_add_email.sql applied with DOWN section
  When dbsp migrate rollback 1
  Then DOWN SQL executes, migration record removed, schema_version decremented

@priority:high @type:error
Scenario: SC-17 — Rollback with checksum mismatch
  Given migration applied, then file modified
  When dbsp migrate rollback 1
  Then error: "Migration file modified since apply (checksum mismatch)"

@priority:high @type:error
Scenario: SC-18 — Rollback more than applied
  Given 3 migrations applied
  When dbsp migrate rollback 5
  Then error: "Cannot rollback 5 migrations, only 3 applied"

@priority:medium @type:security
Scenario: SC-19 — Destructive rollback requires --force
  Given rollback would execute DROP TABLE
  When dbsp migrate rollback 1 (without --force)
  Then error: "Destructive rollback requires --force flag"

@priority:high @type:edge
Scenario: SC-26 — Advisory lock uses dedicated client
  Given two concurrent rollback requests
  When both attempt to acquire advisory lock
  Then only one proceeds, the other waits (lock held on same client throughout)

@priority:medium @type:edge
Scenario: SC-27 — Auto-migrate backfills schema_version
  Given _dbsp_migrations has 3 rows without schema_version column
  When ensureMigrationsTable() adds the column
  Then existing rows are backfilled to 1, 2, 3 by applied_at order
```

### Scenario Group: GUI Enhancements

```gherkin
@priority:high @type:nominal
Scenario: SC-20 — SQL preview shows UP and DOWN
  Given a schema diff with 3 changes
  When user views schema diff in GUI
  Then UP SQL and DOWN SQL tabs/sections are visible with formatted SQL

@priority:high @type:nominal
Scenario: SC-21 — Apply executes UP SQL with confirmation
  Given a schema diff with non-destructive changes
  When user clicks Apply and confirms in the preview dialog
  Then UP SQL executes, diff refreshes to show 0 changes

@priority:high @type:security
Scenario: SC-22 — Apply with destructive changes requires double confirmation
  Given a schema diff with hasDestructive = true
  When user clicks Apply
  Then dialog shows destructive warning + SQL preview + checkbox "I reviewed the SQL"

@priority:medium @type:nominal
Scenario: SC-23 — Side-by-side view for column changes
  Given a schema diff with alter_column_type and alter_column_nullable
  When side-by-side mode is enabled
  Then old column definition shown left, new shown right, differences highlighted

@priority:low @type:nominal
Scenario: SC-24 — Visual polish (icons, colors, grouping)
  Given a schema diff with mixed change types
  When rendered in GUI
  Then destructive changes shown red, additive green, alter yellow, grouped by table
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01..03 | ✓ | | | |
| SC-04 | | ✓ | | |
| SC-05..08 | ✓ | ✓ | | |
| SC-09 | ✓ | | | |
| SC-10..11 | | ✓ | | |
| SC-12..15 | ✓ | ✓ | | |
| SC-16 | ✓ | | | |
| SC-17..18 | | | ✓ | |
| SC-19 | | | | ✓ |
| SC-20..21 | ✓ | | | |
| SC-22 | | | | ✓ |
| SC-23..24 | ✓ | | | |
| SC-25 | | ✓ | | |
| SC-26 | | ✓ | | |
| SC-27 | | ✓ | | |

## 6. Implementation Plan

### Block 1: Meta Enrichment + DOWN SQL Generation — ~30min
**Type:** Feature slice
**Packages:** adapter-pgsql
**Dependencies:** None

**Files:**
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Enrich `compareColumns`, `compareForeignKeys` to store `fromType`, `oldDefault`, `oldFk` in meta
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Rename `changeToSQL` → `changeToUpSQL`, add `changeToDownSQL`, add `generateDownSQL(diff, options)`
- `packages/adapter-pgsql/src/ddl/migration-sql.test.ts` — Tests for all 15 ChangeKinds DOWN
- `packages/adapter-pgsql/src/ddl/schema-diff.test.ts` — Tests for meta enrichment

**Exit criteria:**
- [ ] `generateDownSQL` returns correct SQL for all 9 reversible ChangeKinds
- [ ] Irreversible ChangeKinds generate warning comments
- [ ] DOWN topological order is reversed (index first, then FK, then table)
- [ ] Meta contains `fromType`, `oldDefault`, `oldFk` for alter_* changes
- [ ] SC-01 through SC-08 covered by tests

### Block 2: Migration Tracker v2 + Schema Version — ~25min
**Type:** Feature slice
**Packages:** adapter-pgsql
**Dependencies:** Block 1

**Files:**
- `packages/adapter-pgsql/src/ddl/migration-tracker.ts` — Add `schema_version`, `destructive` columns; auto-migrate with backfill; update `recordMigration` to compute version + flag; refactor advisory lock to dedicated client (`pool.connect()`)
- `packages/adapter-pgsql/src/ddl/migration-tracker.test.ts` — Tests for version tracking, auto-migrate, backfill, advisory lock
- `packages/adapter-pgsql/src/index.ts` — Export new functions

**Exit criteria:**
- [ ] `ensureMigrationsTable` auto-adds new columns + backfills by `ROW_NUMBER() OVER (ORDER BY applied_at)`
- [ ] `recordMigration` accepts and stores `schema_version` + `destructive`
- [ ] Next version = max(schema_version) + 1
- [ ] Advisory lock acquired on dedicated client, released after all operations
- [ ] SC-12 through SC-15, SC-26, SC-27 covered by tests

### Block 3: Migration File Format v2 + Rollback — ~30min
**Type:** Feature slice
**Packages:** adapter-pgsql, cli
**Dependencies:** Block 1, Block 2

**Files:**
- `packages/adapter-pgsql/src/ddl/migration-file.ts` — NEW: `generateMigrationFile(diff, options)` with UP+DOWN sections, `parseMigrationFile(content)` to extract UP/DOWN
- `packages/adapter-pgsql/src/ddl/migration-file.test.ts` — Tests for file generation and parsing
- `packages/cli/src/commands/migrate.ts` — Add `rollback` subcommand with checksum verification, --force flag
- `packages/cli/src/commands/migrate.test.ts` — Tests for rollback scenarios

**Exit criteria:**
- [ ] Migration files contain UP + `-- DOWN` + DOWN sections
- [ ] Parser uses strict `^\s*-- DOWN\s*$` regex (SC-25: no false match inside strings)
- [ ] `isDestructiveDown(downStatements)` detects DROP TABLE/COLUMN/lossy ALTER TYPE
- [ ] `dbsp migrate rollback N` executes DOWN SQL in reverse order
- [ ] Checksum verified before rollback
- [ ] Empty DOWN = error unless --force
- [ ] --force required for destructive DOWN
- [ ] SC-09 through SC-11, SC-16 through SC-19, SC-25 covered by tests

### Block 4: Sidecar SQL Preview — ~15min
**Type:** Feature slice
**Packages:** gui/sidecar
**Dependencies:** Block 1

**Files:**
- `packages/gui/sidecar/schema-diff-handler.ts` — Extend `handleSchemaDiff` to compute and return `upSQL` + `downSQL`
- `packages/gui/sidecar/protocol.ts` — Update `SchemaDiffResult` type with `upSQL`, `downSQL`
- `packages/gui/sidecar/schema-diff-handler.test.ts` — Tests for SQL in response

**Exit criteria:**
- [ ] `SchemaDiffResult` includes `upSQL: string[]` and `downSQL: string[]`
- [ ] SQL is pre-computed in sidecar (not in frontend)
- [ ] Empty diff → empty SQL arrays

### Block 5: GUI Apply Button + SQL Preview — ~25min
**Type:** Feature slice
**Packages:** gui/sidecar, gui/frontend
**Dependencies:** Block 4

**Files:**
- `packages/gui/sidecar/schema-apply-handler.ts` — NEW: `handleSchemaApply(params)` executes UP SQL
- `packages/gui/sidecar/schema-apply-handler.test.ts` — Tests
- `packages/gui/sidecar/index.ts` — Register new handler in router
- `packages/gui/sidecar/protocol.ts` — Add `schema.apply` method + types
- `packages/gui/src/stores/schema-diff-store.ts` — Add `apply()` action
- `packages/gui/src/components/results/SchemaDiffView.tsx` — Add SQL preview toggle + Apply button
- `packages/gui/src/components/results/SqlPreviewPanel.tsx` — NEW: SQL preview with UP/DOWN tabs
- `packages/gui/src/components/results/ApplyConfirmDialog.tsx` — NEW: confirmation dialog with SQL + destructive warning
- `packages/gui/src/components/results/SchemaDiffView.test.tsx` — Tests for new interactions

**Exit criteria:**
- [ ] SQL preview shows UP and DOWN SQL (toggle or tabs)
- [ ] Apply button opens confirmation dialog with SQL preview
- [ ] Destructive changes show warning + "I reviewed" checkbox
- [ ] Apply executes SQL, refreshes diff on success
- [ ] Error shown on failure, diff unchanged
- [ ] SC-20 through SC-22 covered by tests

### Block 6: Side-by-Side Diff + Visual Polish — ~20min
**Type:** Feature slice
**Packages:** gui/frontend
**Dependencies:** Block 4 (needs meta for old/new values)

**Files:**
- `packages/gui/src/components/results/SchemaDiffView.tsx` — Add side-by-side mode toggle
- `packages/gui/src/components/results/SideBySideChange.tsx` — NEW: old vs new column view
- `packages/gui/src/components/results/SchemaDiffView.tsx` — Color coding (red/green/yellow), improved icons
- `packages/gui/src/components/results/SchemaDiffSummary.tsx` — Polish summary bar
- `packages/gui/src/components/results/SchemaDiffView.test.tsx` — Tests for side-by-side + colors

**Exit criteria:**
- [ ] Side-by-side view shows old/new definitions for alter_* changes
- [ ] Destructive = red, additive = green, alter = yellow
- [ ] Grouped by table with collapsible sections
- [ ] SC-23 through SC-24 covered by tests

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~45 | DOWN SQL gen, meta enrichment, file parsing, version tracking, destructive detection |
| Integration | ~12 | Rollback flow, sidecar handler, GUI store, advisory lock, backfill |
| Component | ~8 | GUI components (SQL preview, Apply dialog, side-by-side) |

### Test Data Requirements
- **Fixtures:** ModelIR pairs (schema vs db) for each ChangeKind
- **Mocks:** pg Pool (sidecar tests), introspection function (DI)
- **Patterns:** Reuse existing `schema()` + `ref()` inline schema builders

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Irreversible DOWN misleads dev | HIGH | MEDIUM | Clear WARNING comments + --force gate + isDestructiveDown() |
| Meta not stored for alter_* | HIGH | LOW | Enrich compareSchemata first (Block 1); missing meta → warning comment |
| Advisory lock lost on pool release | HIGH | HIGH | Refactor to dedicated client (Block 2) — per Copilot critical finding |
| Auto-migrate breaks existing _dbsp_migrations | MEDIUM | LOW | ALTER TABLE IF NOT EXISTS + backfill by applied_at |
| GUI Apply without review | MEDIUM | LOW | Preview-first pattern (INV-05) |
| `-- DOWN` false match in SQL strings | MEDIUM | LOW | Strict `^\s*-- DOWN\s*$` regex (SC-25) |

## 9. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 24 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + component)
- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm biome check` clean
- [ ] Documentation updated (ddl-provisioning.md)
- [ ] /review clean (no blocking findings)
