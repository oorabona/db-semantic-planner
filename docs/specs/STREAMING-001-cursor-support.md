---
doc-meta:
  scope: adapter, dx
  status: canonical
  type: spec
  created: 2026-01-07
  story-id: STREAMING-001
---

# STREAMING-001: Cursor/Streaming Support

## Summary

Add streaming support for processing large result sets without loading everything into memory. Uses Kysely's `.stream()` method with PostgreSQL cursors.

## User Story

> As a developer using db-semantic-planner, I want to iterate over large result sets row-by-row, so I can process millions of records without memory exhaustion.

## API Design

### packages/dx - QueryBuilder API

```typescript
interface StreamOptions {
  /**
   * Number of rows to fetch per batch (PostgreSQL only).
   * @default 100
   */
  readonly chunkSize?: number;

  /**
   * Callback invoked before streaming starts with query observability.
   * Useful for logging SQL/plan before iteration begins.
   */
  readonly onStart?: (dump: Dump) => void;
}

interface QueryBuilder {
  // ... existing methods ...

  /**
   * Execute the query and stream results row by row.
   *
   * Requires PostgreSQL with pg-cursor installed.
   * Breaking out of the loop early releases the connection.
   *
   * @throws {ExecutionError} If db is not configured
   * @throws {UnsupportedOperationError} If streaming not supported by dialect
   * @throws {MissingDependencyError} If pg-cursor not installed
   *
   * @example
   * ```typescript
   * for await (const user of orm.query('users').stream()) {
   *   console.log(user.name);
   *   if (shouldStop) break; // Connection released automatically
   * }
   * ```
   */
  stream(options?: StreamOptions): AsyncIterableIterator<unknown>;
}
```

### packages/adapter-kysely - Low-level API

```typescript
interface StreamQueryOptions {
  readonly chunkSize?: number;
  readonly onStart?: (dump: Dump) => void;
}

/**
 * Stream query results using database cursor.
 *
 * @param db - Kysely instance (must have cursor support configured)
 * @param dump - Query dump (contains compiled query)
 * @returns AsyncIterableIterator for row-by-row iteration
 */
function streamQuery<T = unknown>(
  db: Kysely<any>,
  dump: Dump,
  options?: StreamQueryOptions
): AsyncIterableIterator<T>;
```

### Error Classes

```typescript
/**
 * Thrown when a required dependency is not installed.
 */
class MissingDependencyError extends Error {
  readonly dependency: string;
  readonly installCommand: string;
}

/**
 * Thrown when operation not supported by current dialect/configuration.
 */
class UnsupportedOperationError extends Error {
  readonly operation: string;
  readonly reason: string;
}
```

## BDD Scenarios

### Scenario 1: Basic streaming iteration

```gherkin
Given a database with 1000 users
And the ORM is configured with a Kysely db instance
When I call orm.query('users').stream()
And I iterate with for-await-of
Then I should receive each row one at a time
And memory usage should remain constant
```

### Scenario 2: Streaming with chunkSize

```gherkin
Given a database with 1000 users
When I call orm.query('users').stream({ chunkSize: 50 })
Then rows should be fetched in batches of 50
And iteration should still yield one row at a time
```

### Scenario 3: Early break releases connection

```gherkin
Given a database with 1000 users
When I iterate with for-await-of and break after 10 rows
Then only approximately chunkSize rows should be fetched
And the database connection should be released
```

### Scenario 4: Streaming with onStart callback

```gherkin
Given a database with users
When I call orm.query('users').stream({ onStart: (dump) => ... })
Then onStart should be called before first row is yielded
And dump should contain sql, params, and plan
```

### Scenario 5: Multi-tenant streaming

```gherkin
Given tenant 'acme' with 100 users
And tenant 'globex' with 50 users
When I call orm.forTenant('acme').query('users').stream()
Then I should only receive acme's 100 users
And SQL should include schema prefix 'acme.users'
```

### Scenario 6: Streaming with filters

```gherkin
Given a database with 1000 users (500 active, 500 inactive)
When I call orm.query('users').where(eq('active', true)).stream()
Then I should only stream the 500 active users
```

### Scenario 7: Error - db not configured

```gherkin
Given an ORM without db configured
When I call orm.query('users').stream()
Then it should throw ExecutionError
And message should indicate db is required
```

### Scenario 8: Error - pg-cursor not installed

```gherkin
Given a PostgreSQL database without pg-cursor configured
When I call orm.query('users').stream()
Then it should throw MissingDependencyError
And message should include 'npm install pg-cursor'
```

### Scenario 9: Empty result set

```gherkin
Given a database with no users
When I call orm.query('users').stream()
And I iterate with for-await-of
Then the loop should complete immediately with 0 iterations
```

### Scenario 10: Query error during streaming

```gherkin
Given a database query that will fail (e.g., invalid column)
When I iterate over stream()
Then it should throw the database error
And the connection should be released
```

## Implementation Plan

### Block A: Adapter - streamQuery function (packages/adapter-kysely)

**Files:**
- `packages/adapter-kysely/src/stream.ts` (new)
- `packages/adapter-kysely/src/index.ts` (export)
- `packages/adapter-kysely/src/errors.ts` (new error classes)

**Implementation:**
1. Create `MissingDependencyError` and `UnsupportedOperationError` classes
2. Implement `streamQuery()` function:
   - Build Kysely query from compiled SQL
   - Detect if cursor support is available
   - Call `.stream(chunkSize)` on Kysely query
   - Wrap with onStart callback invocation
3. Export from index

**Tests:** 8 unit tests
- streamQuery returns AsyncIterableIterator
- chunkSize option passed to Kysely
- onStart callback invoked
- Error detection for missing cursor
- Error propagation

### Block B: DX - QueryBuilder.stream() method (packages/dx)

**Files:**
- `packages/dx/src/types.ts` (add StreamOptions, stream method)
- `packages/dx/src/orm.ts` (implement stream)
- `packages/dx/src/index.ts` (export StreamOptions)
- `packages/dx/src/errors.ts` (re-export new errors)

**Implementation:**
1. Add `StreamOptions` interface to types
2. Add `stream(options?)` method to `QueryBuilder` interface
3. Implement in `QueryBuilderImpl`:
   - Check db is configured (throw ExecutionError)
   - Build dump
   - Call adapter's `streamQuery()`
4. Export new types

**Tests:** 10 unit tests
- stream() returns AsyncIterableIterator
- stream() with options
- stream() throws if no db
- Multi-tenant streaming
- Filter + stream combination
- Aggregate + stream (should work)

### Block C: E2E Tests (tests/e2e)

**Files:**
- `tests/e2e/streaming.test.ts` (new)

**Implementation:**
1. Test real PostgreSQL streaming with testcontainers
2. Verify memory efficiency (optional, hard to test)
3. Test early break behavior
4. Test multi-tenant streaming
5. Test error scenarios

**Tests:** 8 E2E tests

## Test Requirements

| Component | Test Type | Count |
|-----------|-----------|-------|
| adapter-kysely/stream | Unit | 8 |
| dx/orm stream | Unit | 10 |
| E2E streaming | Integration | 8 |
| **Total** | | **26** |

## Dependencies

### Runtime (optional)
- `pg-cursor` - PostgreSQL cursor support (user installs if needed)

### Development
- No new dev dependencies required

## Non-Functional Requirements

1. **Memory efficiency**: Streaming should not load entire result set
2. **Connection safety**: Early break must release connection
3. **Type safety**: Return type should be `AsyncIterableIterator<unknown>`
4. **Error clarity**: Missing pg-cursor should have actionable error message

## Out of Scope

- Node.js Stream API (Readable)
- MySQL streaming (PostgreSQL first)
- Backpressure control
- Cursor-based keyset pagination (different feature)
- Retry/reconnect on transient errors

## Risks

| Risk | Mitigation |
|------|------------|
| pg-cursor detection unreliable | Test at dialect configuration level |
| Memory leak on error | Rely on Kysely's cleanup + test thoroughly |
| Performance overhead of observability | onStart is opt-in |

## References

- [Kysely Streaming API](https://kysely-org.github.io/kysely-apidoc/interfaces/Streamable.html)
- [pg-cursor npm](https://www.npmjs.com/package/pg-cursor)
