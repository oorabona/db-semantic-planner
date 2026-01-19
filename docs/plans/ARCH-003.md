---
doc-meta:
  status: draft
  scope: core, schema, cli, mcp-server
  type: specification
  created: 2026-01-19
  updated: 2026-01-19
  complexity: COMPLEX
  time-budget: 2h
---

# Specification: ARCH-003 Merge @dbsp/schema into @dbsp/core

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | core, schema, cli, mcp-server |
| Complexity | COMPLEX |
| Time budget | 2h |
| Blocks | 6 |
| BDD scenarios | 9 |
| Risk level | MEDIUM |

## 1. Problem Statement

The codebase has accumulated significant duplication across `@dbsp/schema` and `@dbsp/core`:

- **3 copies** of `ColumnType` (core, schema, schema-bridge)
- **2 copies** of `OnDeleteAction`
- **2 `defineSchema()` functions** with different behaviors
- **Multiple Column/Index/FK interfaces** with different names
- **965-line schema-bridge.ts** doing redundant type conversion

This causes:
- Maintenance overhead (changes must be made in multiple places)
- Type mismatches at package boundaries
- Confusion about which types/functions to use
- Unnecessary complexity in the conversion layer

## 2. User Stories

### US-01: Developer Experience
```
AS A developer using db-semantic-planner
I WANT a single source of truth for schema types and functions
SO THAT I don't have to wonder which package to import from

ACCEPTANCE: All schema types and defineSchema() come from @dbsp/core
```

### US-02: Maintainer Experience
```
AS A maintainer of db-semantic-planner
I WANT duplicate code eliminated
SO THAT changes only need to be made in one place

ACCEPTANCE: @dbsp/schema package is deleted, no duplicate types remain
```

### US-03: Clean Architecture
```
AS AN architect
I WANT schema-bridge.ts to be minimal
SO THAT there's no redundant type conversion layer

ACCEPTANCE: schema-bridge.ts < 200 lines, no type mapping functions
```

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: `defineSchema()` returns `ModelIR` directly (no intermediate ResolvedSchema)
- INV-02: All schema types are defined in `@dbsp/core` only
- INV-03: No backward compatibility shims or re-exports

### 3.2 Preconditions (required before action)

- PRE-01: All current tests pass before migration starts
- PRE-02: All consumers of @dbsp/schema are identified

### 3.3 Effects (what changes)

- EFF-01: @dbsp/schema package is deleted
- EFF-02: CLI imports from @dbsp/core instead
- EFF-03: MCP server imports from @dbsp/core instead
- EFF-04: schema-bridge.ts is simplified (no type conversion)

### 3.4 Error Handling

- ERR-01: When import from @dbsp/schema → TypeScript error (package doesn't exist)
- ERR-02: When using old type names → TypeScript error (types renamed/unified)

## 4. Technical Design

### 4.1 Architecture Decision

**Choice: Option C - Merge @dbsp/schema into @dbsp/core completely**

Rationale:
- Eliminates all duplication at source
- No backward compatibility = cleaner codebase
- schema-bridge.ts becomes trivial
- Single source of truth for types

Rejected alternatives:
- Option A (new @dbsp/types): Adds another package, doesn't solve real problem
- Option B (schema depends on core): Circular dependency risk, complexity remains

### 4.2 Type Consolidation Map

| Old Location | Old Name | New Location | New Name |
|--------------|----------|--------------|----------|
| schema/types.ts | ColumnType | core/types.ts | ColumnType |
| schema/types.ts | ColumnDefinition | core/types.ts | ColumnDef |
| schema/types.ts | OnDeleteAction | core/types.ts | OnDeleteAction |
| schema/types.ts | ForeignKeyReference | core/types.ts | FKReference |
| schema/types.ts | IndexDefinition | core/types.ts | IndexDef |
| schema/types.ts | RelationDefinition | core/types.ts | RelationDef |
| schema/types.ts | ResolvedSchema | DELETED | (use ModelIR) |
| schema/define.ts | defineSchema() | core/schema-builder.ts | defineSchema() |
| schema/conventions.ts | * | core/conventions.ts | * |

### 4.3 API Contract

**Before (two packages):**
```typescript
import { defineSchema } from '@dbsp/schema';
import { createOrm } from '@dbsp/core';
```

**After (single package):**
```typescript
import { defineSchema, createOrm } from '@dbsp/core';
```

### 4.4 Files Changed Summary

| Package | Files Modified | Files Deleted |
|---------|----------------|---------------|
| core | 3-4 | 0 |
| schema | 0 | ALL (package deleted) |
| cli | 2-3 | 0 |
| mcp-server | 1-2 | 0 |

## 5. Acceptance Criteria (BDD)

### Scenario Group: Type Consolidation

```gherkin
@priority:high @type:nominal
Scenario: SC-01 defineSchema returns ModelIR
  Given a schema definition with tables, relations, and indexes
  When I call defineSchema(tables).build()
  Then I receive a ModelIR instance directly
  And the ModelIR contains all tables as TableIR
  And the ModelIR contains all inferred relations

@priority:high @type:nominal
Scenario: SC-02 All types importable from core
  Given a TypeScript file
  When I import ColumnType, ColumnDef, OnDeleteAction from @dbsp/core
  Then the imports resolve correctly
  And no type errors occur

@priority:high @type:edge
Scenario: SC-03 Import from deleted schema package fails
  Given @dbsp/schema package is deleted
  When I try to import from '@dbsp/schema'
  Then TypeScript reports module not found error
```

### Scenario Group: CLI Integration

```gherkin
@priority:high @type:nominal
Scenario: SC-04 CLI loads schema from core
  Given a schema file using defineSchema from @dbsp/core
  When I run dbsp generate kysely --schema ./schema.ts
  Then the command succeeds
  And types are generated correctly

@priority:medium @type:nominal
Scenario: SC-05 CLI DDL generation works
  Given a schema with unique, index, and FK constraints
  When I run dbsp generate ddl --schema ./schema.ts
  Then DDL output includes all constraints
```

### Scenario Group: Convention Functions

```gherkin
@priority:medium @type:nominal
Scenario: SC-06 Conventions available from core
  Given I need to use pluralize, singularize, inferRelations
  When I import them from @dbsp/core
  Then the imports resolve correctly
  And functions work as before

@priority:medium @type:edge
Scenario: SC-07 Custom conventions still work
  Given a schema with custom fkPattern convention
  When I call defineSchema(tables, { conventions: { fkPattern: '{table}_id' } })
  Then relations are inferred using the custom pattern
```

### Scenario Group: schema-bridge Simplification

```gherkin
@priority:high @type:nominal
Scenario: SC-08 schema-bridge is minimal
  Given the schema-bridge.ts file
  When I count the lines of code
  Then it has fewer than 200 lines
  And it contains no type mapping functions (convertColumnType, etc.)

@priority:medium @type:error
Scenario: SC-09 Invalid schema rejected
  Given an invalid schema definition (missing primary key)
  When I call defineSchema(invalidTables).build()
  Then a SchemaValidationError is thrown
  And the error message identifies the problem
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | ✓ | | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | | |
| SC-07 | | ✓ | | |
| SC-08 | ✓ | | | |
| SC-09 | | | ✓ | |

## 6. Implementation Plan

### Block 1: Consolidate Types — 30min
**Type:** Refactor
**Dependencies:** None
**Files:**
- `packages/core/src/types.ts` — add missing types from schema
- `packages/core/src/index.ts` — export new types

**Exit criteria:**
- [ ] All schema types defined in core/types.ts
- [ ] Types exported from @dbsp/core
- [ ] No duplicate type definitions

### Block 2: Merge defineSchema — 30min
**Type:** Refactor
**Dependencies:** Block 1
**Files:**
- `packages/core/src/schema-builder.ts` — merge defineSchema logic
- `packages/schema/src/define.ts` — reference for merge

**Exit criteria:**
- [ ] defineSchema() in core handles all schema features
- [ ] Validation logic preserved
- [ ] Builder pattern returns ModelIR directly

### Block 3: Move Conventions — 15min
**Type:** Refactor
**Dependencies:** Block 1
**Files:**
- `packages/core/src/conventions.ts` — create from schema/conventions.ts
- `packages/core/src/index.ts` — export convention functions

**Exit criteria:**
- [ ] pluralize, singularize, inferRelations in core
- [ ] Convention customization works

### Block 4: Simplify schema-bridge — 30min
**Type:** Refactor
**Dependencies:** Blocks 1-3
**Files:**
- `packages/core/src/dx/schema-bridge.ts` — remove type conversions

**Exit criteria:**
- [ ] schema-bridge.ts < 200 lines
- [ ] No type mapping functions
- [ ] loadSchema() works directly with ModelIR

### Block 5: Update Consumers — 20min
**Type:** Integration
**Dependencies:** Blocks 1-4
**Files:**
- `packages/cli/src/commands/generate.ts` — update imports
- `packages/cli/src/commands/repl.ts` — update imports
- `packages/mcp-server/src/*.ts` — update imports

**Exit criteria:**
- [ ] CLI imports from @dbsp/core
- [ ] MCP server imports from @dbsp/core
- [ ] All consumers compile without errors

### Block 6: Delete @dbsp/schema — 10min
**Type:** Cleanup
**Dependencies:** Blocks 1-5
**Files:**
- `packages/schema/` — DELETE entire directory
- `pnpm-workspace.yaml` — remove schema package
- Root `package.json` — remove schema scripts if any

**Exit criteria:**
- [ ] @dbsp/schema directory deleted
- [ ] pnpm install succeeds
- [ ] pnpm build succeeds
- [ ] All tests pass

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 10+ | Type definitions, defineSchema, conventions |
| Integration | 5+ | CLI commands, schema loading |
| E2E | 2 | Full workflow with new imports |

### Test data requirements:

**Fixtures:**
- minimal.schema.ts (already exists)
- complex schema with all features

**Existing tests to verify:**
- `packages/core/src/*.test.ts`
- `packages/cli/src/**/*.test.ts`
- `packages/adapter-kysely/src/*.test.ts`

### Test migration:
- Move schema package tests to core
- Update import paths in all test files

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking external consumers | H | L | No external consumers yet (pre-v1.0) |
| Missing edge cases in merge | M | M | Run full test suite after each block |
| Type incompatibilities | M | M | TypeScript strict mode catches mismatches |
| Build order issues | L | M | Verify pnpm build after schema deletion |

## 9. Definition of Done

- [ ] All blocks implemented
- [ ] All BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] schema-bridge.ts < 200 lines
- [ ] @dbsp/schema package deleted
- [ ] Documentation updated (CLAUDE.md if needed)
- [ ] /review clean (no blocking findings)
