---
doc-meta:
  status: canonical
  scope: adapter
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# Specification: DIALECT-001 Multi-dialect Capabilities

## 1. User Stories

### US-1: Dialect Detection and Capability Query

```
AS A developer using db-semantic-planner
I WANT to query dialect capabilities at runtime
SO THAT I can conditionally use features based on what the database supports

ACCEPTANCE:
- getCapabilities(db) returns a typed capabilities object
- Each dialect has a predefined capability profile
- Unknown dialects return safe defaults
```

### US-2: Capability-gated Compilation

```
AS A developer deploying to multiple database backends
I WANT the compiler to adapt SQL generation based on capabilities
SO THAT queries compile correctly regardless of dialect

ACCEPTANCE:
- Multi-tenant queries fail gracefully on dialects without schema support
- EXPLAIN uses dialect-specific syntax
- Parameter binding matches dialect conventions (handled by Kysely)
```

### US-3: Cross-dialect Testing Support

```
AS A library maintainer
I WANT the same test intents to produce verifiable SQL across dialects
SO THAT I can ensure correctness for PostgreSQL, MySQL, and SQLite

ACCEPTANCE:
- Test helpers to check capability before running tests
- SQL snapshot tests work per-dialect
- Graceful skip for unsupported features
```

---

## 2. Business Rules

### BR-1: Capability Interface (Invariants)

The `DialectCapabilities` interface MUST define these boolean flags:

| Capability | Description | PostgreSQL | MySQL 8+ | SQLite 3.35+ |
|------------|-------------|------------|----------|--------------|
| `supportsCTE` | Common Table Expressions | true | true | true |
| `supportsExplain` | EXPLAIN command | true | true | true |
| `supportsWithSchema` | Runtime schema switching | true | false | false |
| `supportsReturning` | RETURNING clause | true | false | true (3.35+) |
| `supportsNullsFirstLast` | NULLS FIRST/LAST ordering | true | true (8.0+) | true (3.30+) |
| `supportsStreaming` | Cursor-based streaming | true | false | false |

### BR-2: Dialect Detection (Preconditions)

- Detection MUST work from a Kysely instance without requiring additional configuration
- Detection method: Use Kysely's internal dialect information or configuration
- Fallback: If dialect cannot be determined, return `unknown` profile with minimal capabilities

### BR-3: Capability Enforcement (Effects)

When a query uses a feature requiring a capability that is `false`:

| Feature | Missing Capability | Behavior |
|---------|-------------------|----------|
| `forTenant(schema)` | `supportsWithSchema` | Throw `UnsupportedOperationError` |
| `explain({ analyze: true })` | `supportsExplain` | Throw `UnsupportedOperationError` |
| `stream()` | `supportsStreaming` | Throw `UnsupportedOperationError` with guidance |
| NULLS FIRST/LAST in orderBy | `supportsNullsFirstLast` | Omit NULLS clause (degrade gracefully) |

### BR-4: Error Messages (Errors)

All capability-related errors MUST include:

1. The operation that failed
2. The capability that was missing
3. The detected dialect
4. Guidance on alternatives or workarounds

Example:
```
UnsupportedOperationError: Operation 'forTenant' requires 'supportsWithSchema' capability.
Detected dialect: MySQL
MySQL uses database switching instead of schemas. Consider using separate database connections per tenant.
```

### BR-5: Test Helpers (Preconditions)

Test utilities MUST provide:

- `skipIfMissingCapability(db, capability)` - Skip test if capability missing
- `getDialectName(db)` - Return dialect identifier string
- `withDialectCapabilities(caps, fn)` - Run code with mocked capabilities

---

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| **Types** | New `DialectCapabilities` interface, `DialectName` type | Type exports, no runtime cost |
| **Detection** | New `detectDialect()` and `getCapabilities()` functions | Returns correct profile per dialect |
| **Compiler** | Pass capabilities to compile(), guard feature usage | No regression in PostgreSQL output |
| **EXPLAIN** | Dialect-specific EXPLAIN syntax | PostgreSQL unchanged, MySQL/SQLite adapted |
| **Stream** | Guard with `supportsStreaming` capability | Clear error messages |
| **Multi-tenant** | Guard `forTenant()` with `supportsWithSchema` | Clear error on MySQL/SQLite |
| **Tests** | Test helpers, per-dialect snapshots | All existing tests pass |

### Files to Create

| File | Purpose |
|------|---------|
| `packages/adapter-kysely/src/dialect.ts` | DialectCapabilities interface, profiles, detection |
| `packages/adapter-kysely/src/dialect.test.ts` | Unit tests for capability detection |

### Files to Modify

| File | Changes |
|------|---------|
| `packages/adapter-kysely/src/types.ts` | Export DialectCapabilities, DialectName |
| `packages/adapter-kysely/src/compiler.ts` | Accept capabilities, guard features |
| `packages/adapter-kysely/src/explain.ts` | Use dialect-specific EXPLAIN syntax |
| `packages/adapter-kysely/src/stream.ts` | Guard with supportsStreaming |
| `packages/adapter-kysely/src/dump.ts` | Pass capabilities through to compiler |
| `packages/adapter-kysely/src/index.ts` | Export new functions and types |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Feature: Dialect Detection

```gherkin
Scenario: Detect PostgreSQL dialect
  Given a Kysely instance configured with PostgresDialect
  When getCapabilities(db) is called
  Then all capabilities return true
  And getDialectName(db) returns "postgresql"

Scenario: Detect MySQL dialect
  Given a Kysely instance configured with MysqlDialect
  When getCapabilities(db) is called
  Then supportsWithSchema returns false
  And supportsStreaming returns false
  And supportsCTE returns true
  And getDialectName(db) returns "mysql"

Scenario: Detect SQLite dialect
  Given a Kysely instance configured with SqliteDialect
  When getCapabilities(db) is called
  Then supportsWithSchema returns false
  And supportsReturning returns true
  And getDialectName(db) returns "sqlite"

Scenario: Unknown dialect returns safe defaults
  Given a Kysely instance with an unknown dialect
  When getCapabilities(db) is called
  Then all capabilities return false except supportsCTE
  And getDialectName(db) returns "unknown"
```

### Feature: Multi-tenant Capability Guard

```gherkin
Scenario: forTenant works on PostgreSQL
  Given a Kysely instance with PostgresDialect
  And supportsWithSchema is true
  When forTenant("tenant_acme") is called
  Then the ORM context is scoped to schema "tenant_acme"

Scenario: forTenant throws on MySQL
  Given a Kysely instance with MysqlDialect
  And supportsWithSchema is false
  When forTenant("tenant_acme") is called
  Then UnsupportedOperationError is thrown
  And error.operation equals "forTenant"
  And error.message contains "supportsWithSchema"
  And error.message contains "MySQL"

Scenario: forTenant throws on SQLite
  Given a Kysely instance with SqliteDialect
  When forTenant("tenant_acme") is called
  Then UnsupportedOperationError is thrown
  And error.message contains "SQLite"
```

### Feature: EXPLAIN Dialect Adaptation

```gherkin
Scenario: EXPLAIN on PostgreSQL uses PostgreSQL syntax
  Given a compiled query and PostgresDialect
  When explain(compiled, db, { format: 'json' }) is called
  Then SQL starts with "EXPLAIN (FORMAT JSON)"

Scenario: EXPLAIN on MySQL uses MySQL syntax
  Given a compiled query and MysqlDialect
  When explain(compiled, db, { format: 'json' }) is called
  Then SQL uses "EXPLAIN FORMAT=JSON"

Scenario: EXPLAIN ANALYZE on SQLite uses EXPLAIN QUERY PLAN
  Given a compiled query and SqliteDialect
  When explain(compiled, db, { analyze: true }) is called
  Then SQL uses "EXPLAIN QUERY PLAN"
  And a warning is logged that SQLite doesn't support ANALYZE
```

### Feature: Streaming Capability Guard

```gherkin
Scenario: stream() works on PostgreSQL
  Given a Kysely instance with PostgresDialect
  And supportsStreaming is true
  When stream() is called on a query
  Then an AsyncIterableIterator is returned

Scenario: stream() throws on MySQL
  Given a Kysely instance with MysqlDialect
  And supportsStreaming is false
  When stream() is called on a query
  Then UnsupportedOperationError is thrown
  And error.operation equals "stream"
  And error.message contains "MySQL does not support cursor-based streaming"
```

### Feature: Test Helpers

```gherkin
Scenario: Skip test if capability missing
  Given a test that requires supportsWithSchema
  And the Kysely instance has SqliteDialect
  When skipIfMissingCapability(db, 'supportsWithSchema') is called
  Then the test is skipped with message "Skipped: SQLite lacks supportsWithSchema"

Scenario: Run test if capability present
  Given a test that requires supportsCTE
  And the Kysely instance has PostgresDialect
  When skipIfMissingCapability(db, 'supportsCTE') is called
  Then the test continues execution
```

---

## 5. Implementation Plan

### Block 1: DialectCapabilities Interface and Detection

**Packages:** `packages/adapter-kysely`

**Tasks:**
- Define `DialectCapabilities` interface in `src/dialect.ts`
- Define `DialectName` type: `'postgresql' | 'mysql' | 'sqlite' | 'mssql' | 'unknown'`
- Implement `detectDialect(db)` function using Kysely internals
- Implement `getCapabilities(db)` returning predefined profiles
- Implement dialect profiles: `POSTGRESQL_CAPABILITIES`, `MYSQL_CAPABILITIES`, `SQLITE_CAPABILITIES`, `UNKNOWN_CAPABILITIES`
- Export from `src/index.ts`

**Tests:**
- Unit tests for each dialect detection
- Test unknown dialect fallback
- Test capability profiles match expected values

**Acceptance criteria covered:** US-1 (all), Scenarios 1-4

**Complexity:** S
**Dependencies:** None

---

### Block 2: Multi-tenant Capability Guard

**Packages:** `packages/adapter-kysely`, `packages/dx`

**Tasks:**
- Add `capabilities` parameter to compiler functions
- Guard `forTenant()` with `supportsWithSchema` check
- Update `UnsupportedOperationError` to include dialect context
- Pass capabilities through dump/compile pipeline

**Tests:**
- Test forTenant() succeeds on PostgreSQL
- Test forTenant() throws UnsupportedOperationError on MySQL
- Test forTenant() throws UnsupportedOperationError on SQLite
- Test error message includes operation, capability, and dialect

**Acceptance criteria covered:** US-2 (partial), Scenarios 5-7

**Complexity:** M
**Dependencies:** Block 1

---

### Block 3: EXPLAIN Dialect Adaptation

**Packages:** `packages/adapter-kysely`

**Tasks:**
- Refactor `buildExplainPrefix()` to accept dialect
- Add MySQL EXPLAIN syntax: `EXPLAIN FORMAT=JSON`
- Add SQLite EXPLAIN syntax: `EXPLAIN QUERY PLAN`
- Handle analyze option per dialect (SQLite doesn't support ANALYZE)
- Add warning system for unsupported options

**Tests:**
- Test PostgreSQL EXPLAIN unchanged
- Test MySQL EXPLAIN uses correct syntax
- Test SQLite EXPLAIN uses EXPLAIN QUERY PLAN
- Test SQLite logs warning when analyze requested

**Acceptance criteria covered:** US-2 (partial), Scenarios 8-10

**Complexity:** M
**Dependencies:** Block 1

---

### Block 4: Streaming Capability Guard

**Packages:** `packages/adapter-kysely`, `packages/dx`

**Tasks:**
- Guard `streamQuery()` with `supportsStreaming` check
- Guard `stream()` in QueryBuilder with capability check
- Ensure error message explains cursor requirements

**Tests:**
- Test streaming works on PostgreSQL (existing tests)
- Test streaming throws on MySQL
- Test streaming throws on SQLite
- Test error messages are helpful

**Acceptance criteria covered:** US-2 (partial), Scenarios 11-12

**Complexity:** S
**Dependencies:** Block 1

---

### Block 5: Test Helpers and Cross-dialect Support

**Packages:** `packages/adapter-kysely`

**Tasks:**
- Implement `skipIfMissingCapability(db, capability)` test helper
- Implement `getDialectName(db)` helper
- Implement `withMockedCapabilities(caps, fn)` for testing
- Update existing tests to use helpers where appropriate
- Create per-dialect SQL snapshot expectations (optional enhancement)

**Tests:**
- Test helpers work correctly
- Test skip functionality
- Test mocked capabilities

**Acceptance criteria covered:** US-3 (all), Scenarios 13-14

**Complexity:** S
**Dependencies:** Block 1

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| PostgreSQL detection | Yes | - | - |
| MySQL detection | Yes | - | - |
| SQLite detection | Yes | - | - |
| Unknown dialect fallback | Yes | - | - |
| forTenant on PostgreSQL | Yes | Yes | Yes (existing) |
| forTenant on MySQL | Yes | - | - |
| forTenant on SQLite | Yes | - | - |
| EXPLAIN PostgreSQL | Yes | Yes | Yes (existing) |
| EXPLAIN MySQL | Yes | - | - |
| EXPLAIN SQLite | Yes | - | - |
| Streaming PostgreSQL | Yes | Yes | Yes (existing) |
| Streaming MySQL error | Yes | - | - |
| Streaming SQLite error | Yes | - | - |
| Test helper: skip | Yes | - | - |
| Test helper: mock | Yes | - | - |

### Test Data Strategy

**Fixtures:**
- Reuse existing `createTestModel()` for all dialect tests
- No new fixtures required

**Dialect Instances:**
- PostgreSQL: Use real PostgresDialect in E2E (existing infrastructure)
- MySQL: Use MysqlDialect with mock connection for unit tests
- SQLite: Use SqliteDialect with better-sqlite3 (existing)

**Mocking:**
- Mock Kysely dialect internals for unit tests
- Use `withMockedCapabilities()` for isolated capability testing

### Test File Organization

| File | Tests | Type |
|------|-------|------|
| `dialect.test.ts` | Detection, profiles | Unit |
| `compiler.test.ts` | Capability guards | Unit |
| `explain.test.ts` | Dialect-specific EXPLAIN | Unit |
| `stream.test.ts` | Capability guards | Unit |
| E2E tests | No changes needed | E2E |

---

## 7. API Reference

### Types

```typescript
/**
 * Supported database dialect names.
 */
export type DialectName = 'postgresql' | 'mysql' | 'sqlite' | 'mssql' | 'unknown';

/**
 * Capability flags for database features.
 */
export interface DialectCapabilities {
  /** Common Table Expressions (WITH clause) */
  readonly supportsCTE: boolean;

  /** EXPLAIN command for query plans */
  readonly supportsExplain: boolean;

  /** Runtime schema switching (PostgreSQL schemas) */
  readonly supportsWithSchema: boolean;

  /** RETURNING clause for INSERT/UPDATE/DELETE */
  readonly supportsReturning: boolean;

  /** NULLS FIRST/LAST in ORDER BY */
  readonly supportsNullsFirstLast: boolean;

  /** Cursor-based streaming (requires pg-cursor) */
  readonly supportsStreaming: boolean;
}
```

### Functions

```typescript
/**
 * Detect the dialect from a Kysely instance.
 */
export function detectDialect(db: Kysely<any>): DialectName;

/**
 * Get capabilities for a Kysely instance.
 */
export function getCapabilities(db: Kysely<any>): DialectCapabilities;

/**
 * Get capabilities for a dialect name.
 */
export function getCapabilitiesForDialect(dialect: DialectName): DialectCapabilities;
```

### Predefined Profiles

```typescript
export const POSTGRESQL_CAPABILITIES: DialectCapabilities = {
  supportsCTE: true,
  supportsExplain: true,
  supportsWithSchema: true,
  supportsReturning: true,
  supportsNullsFirstLast: true,
  supportsStreaming: true,
};

export const MYSQL_CAPABILITIES: DialectCapabilities = {
  supportsCTE: true,
  supportsExplain: true,
  supportsWithSchema: false, // Uses database switching
  supportsReturning: false,
  supportsNullsFirstLast: true, // MySQL 8.0+
  supportsStreaming: false,
};

export const SQLITE_CAPABILITIES: DialectCapabilities = {
  supportsCTE: true,
  supportsExplain: true,
  supportsWithSchema: false,
  supportsReturning: true, // SQLite 3.35+
  supportsNullsFirstLast: true, // SQLite 3.30+
  supportsStreaming: false,
};

export const UNKNOWN_CAPABILITIES: DialectCapabilities = {
  supportsCTE: true, // Most modern DBs support CTEs
  supportsExplain: false,
  supportsWithSchema: false,
  supportsReturning: false,
  supportsNullsFirstLast: false,
  supportsStreaming: false,
};
```

---

## Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 14 BDD scenarios have passing tests
- [ ] All tests pass (`pnpm test`, `pnpm test:e2e`)
- [ ] Lint/typecheck pass (`pnpm biome check`, `pnpm typecheck`)
- [ ] No regression in existing PostgreSQL functionality
- [ ] Documentation updated (DOCUMENTATION_INDEX.md, TODO_ADAPTER.md)
- [ ] Exports added to package index
