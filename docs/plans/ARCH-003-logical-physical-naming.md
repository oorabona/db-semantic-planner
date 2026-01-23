---
doc-meta:
  status: draft
  scope: core, adapter-kysely, cli, examples
  type: specification
  created: 2026-01-23
  updated: 2026-01-23
  complexity: COMPLEX
  time-budget: 2-3h
  adversarial: complete (4 challenges resolved)
---

# Specification: ARCH-003 — Logical/Physical Naming Separation

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | core, adapter-kysely, cli, examples |
| Complexity | COMPLEX |
| Time budget | 2-3h |
| Blocks | 4 |
| BDD scenarios | 8 |
| Risk level | MEDIUM (breaking change to examples) |

## 1. Problem Statement

Schema definitions currently mix logical (domain) and physical (database) naming conventions inconsistently. Some schemas use camelCase (`productImages`), others use snake_case (`room_bookings`). Users naturally write camelCase in NQL queries but get "Unknown table" errors when the schema uses snake_case. The solution is to standardize on camelCase (logical) in `defineSchema`, with Kysely's CamelCasePlugin handling the transformation to snake_case (physical) for PostgreSQL.

## 2. User Stories

### US-01: NQL User writes natural queries
```
AS A developer using the CLI REPL
I WANT to write table/column names in camelCase
SO THAT I can use natural JavaScript naming conventions

ACCEPTANCE: `roomBookings | where bookingPeriod overlaps ...` works
```

### US-02: Schema author uses domain model
```
AS A schema author
I WANT to define tables/columns using camelCase domain names
SO THAT my schema reflects the business domain, not database conventions

ACCEPTANCE: `defineSchema({ roomBookings: { roomId: ... } })` generates correct DDL
```

### US-03: CLI provides helpful suggestions
```
AS A developer making typos
I WANT the CLI to suggest correct names
SO THAT I can quickly fix mistakes

ACCEPTANCE: `roombooking` shows "Did you mean 'roomBookings'?"
```

## 3. Business Rules

### 3.1 Invariants (always true)
- INV-01: `defineSchema` table keys MUST be camelCase
- INV-02: `defineSchema` column keys MUST be camelCase
- INV-03: Generated DDL table/column names MUST be snake_case (PostgreSQL convention)
- INV-04: NQL queries MUST use logical (camelCase) names
- INV-05: SQL output MUST use physical (snake_case) names

### 3.2 Preconditions (required before action)
- PRE-01: Kysely instance MUST have CamelCasePlugin configured
- PRE-02: Schema MUST be loaded before CLI can resolve names

### 3.3 Effects (what changes)
- EFF-01: CLI resolves user input against logical model names (ModelIR)
- EFF-02: Adapter transforms logical names to physical names via CamelCasePlugin
- EFF-03: DDL generator outputs snake_case table/column names
- EFF-04: Foreign key references use logical names in schema, physical in DDL

### 3.4 Error Handling
- ERR-01: Unknown table → suggest closest match (Levenshtein distance ≤ 3)
- ERR-02: Unknown column → suggest columns from current table context
- ERR-03: Ambiguous name → list all matches with context

## 4. Technical Design

### 4.1 Architecture Decision

**Approach:** Leverage Kysely's CamelCasePlugin — NO custom transformation code.

```
┌─────────────────────────────────────────────────────────────────┐
│  User Input (NQL)           │  Schema Definition               │
│  roomBookings | where ...   │  defineSchema({ roomBookings })  │
└──────────────┬──────────────┴──────────────┬────────────────────┘
               │                             │
               ▼                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ModelIR (Logical)                        │
│  tables: Map<'roomBookings', TableIR>                          │
│  columns: ['roomId', 'bookingPeriod', ...]                     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Kysely + CamelCasePlugin (Adapter)                 │
│  Transforms: roomBookings → room_bookings                       │
│              roomId → room_id                                   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Physical)                       │
│  SELECT * FROM "room_bookings" WHERE "room_id" = $1            │
└─────────────────────────────────────────────────────────────────┘
```

**Why this approach:**
- Kysely already has battle-tested CamelCasePlugin
- Zero custom transformation code to maintain
- Works for queries AND DDL generation
- Single source of truth (plugin config)

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| Example schemas | Convert snake_case → camelCase | No (regenerate DDL) |
| ModelIR | None (already supports any naming) | No |
| CLI completion | Add Levenshtein matching | No |

### 4.3 Files Impacted

| Package | File | Change |
|---------|------|--------|
| `cli` | `src/repl/completion.ts` | Add Levenshtein fuzzy matching |
| `cli` | `src/repl/query-executor.ts` | Resolve against logical names |
| `cli` | `src/commands/generate.ts` | Ensure CamelCasePlugin for DDL |
| `adapter-kysely` | `src/kysely-adapter.ts` | Document CamelCasePlugin requirement |
| `examples` | `scheduling.schema.ts` | Convert to camelCase |
| `examples` | `*.dbsp` | Already camelCase (verify) |
| `examples` | `*.ddl.sql` | Regenerate |

## 5. Acceptance Criteria (BDD)

### Scenario Group: Schema Definition

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Schema with camelCase generates snake_case DDL
  Given schema with table 'roomBookings' and column 'bookingPeriod'
  When I run 'dbsp generate ddl --schema ./schema.ts'
  Then DDL contains 'CREATE TABLE "room_bookings"'
  And DDL contains '"booking_period"'

@priority:high @type:nominal
Scenario: SC-02 Foreign key references transform correctly
  Given schema with 'roomBookings.roomId' referencing 'rooms'
  When I run 'dbsp generate ddl'
  Then DDL contains 'FOREIGN KEY ("room_id") REFERENCES "rooms"'
```

### Scenario Group: CLI Query Resolution

```gherkin
@priority:high @type:nominal
Scenario: SC-03 NQL query with camelCase table name succeeds
  Given schema with table 'roomBookings'
  When I run NQL 'roomBookings | where capacity > 10'
  Then SQL contains 'FROM "room_bookings"'
  And query executes successfully

@priority:high @type:nominal
Scenario: SC-04 NQL query with camelCase column name succeeds
  Given schema with 'roomBookings.bookingPeriod'
  When I run NQL 'roomBookings | select bookingPeriod'
  Then SQL contains 'SELECT "booking_period"'

@priority:medium @type:edge
Scenario: SC-05 Unknown table suggests closest match
  Given schema with table 'roomBookings'
  When I run NQL 'roombooking'
  Then error message contains "Did you mean 'roomBookings'?"

@priority:medium @type:edge
Scenario: SC-06 Unknown column suggests from table context
  Given schema with 'users' having columns 'firstName', 'lastName'
  When I run NQL 'users | where fristName = "John"'
  Then error message contains "Did you mean 'firstName'?"
```

### Scenario Group: Contextual Completion

```gherkin
@priority:medium @type:nominal
Scenario: SC-07 Tab completion shows tables at query start
  Given schema with tables 'users', 'orders', 'products'
  When I type 'us' and press Tab in REPL
  Then completion suggests 'users'

@priority:medium @type:nominal
Scenario: SC-08 Tab completion shows columns after table
  Given schema with 'users' having 'firstName', 'lastName', 'email'
  When I type 'users | where first' and press Tab
  Then completion suggests 'firstName'
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error |
|----------|---------|------|-------|
| SC-01 | ✓ | | |
| SC-02 | ✓ | | |
| SC-03 | ✓ | | |
| SC-04 | ✓ | | |
| SC-05 | | ✓ | ✓ |
| SC-06 | | ✓ | ✓ |
| SC-07 | ✓ | | |
| SC-08 | ✓ | | |

## 6. Implementation Plan

### Block 1: Standardize Example Schemas — 30min
**Type:** Refactor
**Dependencies:** None
**Packages:** examples

**Files:**
- `examples/scheduling.schema.ts` — Convert snake_case → camelCase
- `examples/ecommerce.schema.ts` — Audit (likely already camelCase)
- `examples/blog.schema.ts` — Audit
- `examples/blog-extended.schema.ts` — Audit

**Exit criteria:**
- [ ] All example schemas use camelCase for tables and columns
- [ ] All `references: { table: 'x' }` use camelCase table names
- [ ] No snake_case identifiers in any schema definition

---

### Block 2: Regenerate DDL Files — 15min
**Type:** Infra
**Dependencies:** Block 1
**Packages:** examples

**Tasks:**
- Run `dbsp generate ddl` for each schema
- Verify output is snake_case
- Update seed files if column names changed

**Exit criteria:**
- [ ] All `.ddl.sql` files regenerated with snake_case
- [ ] All `.seed.sql` files use matching column names
- [ ] `dbsp repl` can import DDL and seed without errors

---

### Block 3: CLI Fuzzy Matching — 45min
**Type:** Feature
**Dependencies:** None (parallel with Block 1-2)
**Packages:** cli

**Files:**
- `packages/cli/src/repl/completion.ts` — Add Levenshtein distance function
- `packages/cli/src/repl/query-executor.ts` — Add fuzzy table/column lookup

**Implementation:**
```typescript
// Levenshtein distance (simple implementation)
function levenshtein(a: string, b: string): number { ... }

// Find closest match
function suggestMatch(input: string, candidates: string[]): string | null {
  const matches = candidates
    .map(c => ({ name: c, distance: levenshtein(input.toLowerCase(), c.toLowerCase()) }))
    .filter(m => m.distance <= 3)
    .sort((a, b) => a.distance - b.distance);
  return matches[0]?.name ?? null;
}
```

**Exit criteria:**
- [ ] Unknown table shows suggestion if Levenshtein ≤ 3
- [ ] Unknown column shows suggestion from current table
- [ ] Suggestions are case-insensitive

---

### Block 4: Contextual Tab Completion — 30min
**Type:** Feature
**Dependencies:** Block 3
**Packages:** cli

**Files:**
- `packages/cli/src/repl/completion.ts` — Context-aware suggestions

**Implementation:**
- At query start → suggest table names
- After `table |` → suggest clause keywords
- After `where` / `select` → suggest columns from active table
- After `with` → suggest relation names

**Exit criteria:**
- [ ] Tab completion context-aware
- [ ] Tables suggested at start
- [ ] Columns suggested after table context established

---

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 8 | Levenshtein, completion logic |
| Integration | 4 | DDL generation, query resolution |
| E2E | 4 | Full REPL scenarios |

### Test Data Requirements

**Fixtures:**
- `scheduling.schema.ts` (converted to camelCase)
- `pimdam.schema.ts` (already camelCase, reference)

**Mocks:**
- None needed (uses real Kysely with mock pool)

### Test Files

| File | Tests |
|------|-------|
| `packages/cli/src/repl/completion.test.ts` | Levenshtein, suggestions |
| `packages/adapter-kysely/src/ddl.test.ts` | CamelCase DDL output |
| `tests/e2e/naming-convention.test.ts` | Full scenarios SC-01 to SC-08 |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking existing user schemas | HIGH | LOW | Users with snake_case must convert (document migration) |
| CamelCasePlugin edge cases (acronyms) | MEDIUM | LOW | Use Kysely defaults, document behavior |
| Performance of Levenshtein on large schemas | LOW | LOW | Only compute on error path |
| CamelCasePlugin transforms JSONB keys | HIGH | MEDIUM | Use `maintainNestedObjectKeys: true` option; document in QUICKSTART |
| NQL lacks JSONB operators | MEDIUM | HIGH | Backlog task for JSONB support; use raw() escape hatch meanwhile |

## 9. Definition of Done

- [ ] All example schemas converted to camelCase
- [ ] All DDL files regenerated with snake_case output
- [ ] CLI resolves camelCase table/column names
- [ ] Fuzzy suggestions work for typos (Levenshtein ≤ 3)
- [ ] Tab completion is context-aware
- [ ] All BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] Documentation updated (QUICKSTART.md)
- [ ] /review clean (no blocking findings)
