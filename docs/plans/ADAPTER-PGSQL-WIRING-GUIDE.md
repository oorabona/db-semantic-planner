# adapter-pgsql Wiring Guide

Quick reference for integrating existing modules into PgsqlAdapter.

## 1. Recursive CTE Wiring

**Location:** `packages/adapter-pgsql/src/pgsql-adapter.ts:338-343`

**Current (STUB):**
```typescript
compileRecursive(
  _report: RecursivePlanReport,
  context: CompilerContext,
): Dump {
  throw new Error('PgsqlAdapter.compileRecursive: Not implemented - Phase 2');
}
```

**Implementation Template:**
```typescript
import { buildRecursiveCte } from './recursive/cte-compiler.js';

compileRecursive(
  report: RecursivePlanReport,
  context: CompilerContext,
): Dump {
  const config = report.config; // Extract RecursiveCteConfig
  const { cte, anchor, recursive } = buildRecursiveCte(config);
  
  // Integrate into main SELECT:
  // - Prepend WITH RECURSIVE clause
  // - Modify FROM to reference cte.alias
  // - Preserve WHERE/ORDER BY from report
  
  const sql = this.compiler.compileSelect({
    ...baseQuery,
    withClauses: [cte],
  });
  
  return {
    plan: report,
    sql,
    params: context.state.params,
  };
}
```

**Key Dependencies:**
- `import { buildRecursiveCte } from './recursive/cte-compiler.js'`
- `import type { RecursiveCteConfig } from './recursive/cte-compiler.js'`

**Tests to Add:**
- Ancestors traversal (parent chain)
- Descendants traversal (child tree)
- Cycle detection with visited array
- Path tracking (breadcrumb trail)
- Max depth limiting
- PG14+ CYCLE clause variant

**Success Criteria:**
- Generated SQL matches PostgreSQL WITH RECURSIVE syntax
- No runtime errors on valid inputs
- E2E test: hierarchical query returns correct results

---

## 2. Upsert Wiring

**Location:** `packages/adapter-pgsql/src/pgsql-adapter.ts:327-331`

**Current (STUB):**
```typescript
compileUpsert(
  _intent: UpsertIntent,
  _context: CompilerContext,
): Dump {
  throw new Error('PgsqlAdapter.compileUpsert: Not implemented - Phase 2');
}
```

**Implementation Template:**
```typescript
import { compileUpsert as compileUpsertMutation } from './mutations/upsert.js';
import type { UpsertConfig } from './mutations/upsert.js';

compileUpsert(
  intent: UpsertIntent,
  context: CompilerContext,
): Dump {
  // Step 1: Extract config from intent
  const config: UpsertConfig = {
    table: intent.table,
    columns: intent.columns,
    values: intent.values,
    conflictTarget: intent.conflictTarget,
    onConflict: intent.onConflict, // 'nothing' | 'update'
    updateSet: intent.updateSet,
    where: intent.where,
  };
  
  // Step 2: Compile to AST
  const insertStmt = compileUpsertMutation(
    config,
    context,
    context.state,
  );
  
  // Step 3: Convert AST to SQL
  const sql = this.astToSql(insertStmt);
  
  return {
    plan: { type: 'upsert', intent },
    sql,
    params: context.state.params,
  };
}
```

**Key Dependencies:**
- `import { compileUpsert } from './mutations/upsert.js'`
- `import type { UpsertConfig, ConflictTarget } from './mutations/upsert.js'`
- **BLOCKER:** `UpsertIntent` type must be defined in `@dbsp/core` or bridged via `RawIntent`

**Tests to Add:**
- INSERT ... ON CONFLICT DO NOTHING
- INSERT ... ON CONFLICT DO UPDATE SET
- Multiple column conflict targets
- Named constraint targets
- Partial index WHERE clauses
- EXCLUDED.column references
- Conditional updates (WHERE after UPDATE)

**Success Criteria:**
- Generated SQL matches PostgreSQL INSERT ... ON CONFLICT syntax
- Params are properly bound (no SQL injection)
- E2E test: upsert queries return correct results

---

## 3. Streaming Wiring

**Location:** `packages/adapter-pgsql/src/pgsql-adapter.ts:400-407`

**Current (STUB):**
```typescript
stream(
  intent: SelectIntent,
  context?: CompilerContext,
  batchSize?: number,
): AsyncIterable<unknown[]> {
  // Phase 2: Implement cursor-based streaming
  throw new Error('Not implemented');
}
```

**Implementation Template:**
```typescript
import {
  buildDeclareCursor,
  buildFetch,
  buildCloseCursor,
  generateCursorName,
} from './streaming/cursor.js';
import type { CursorOptions, FetchOptions } from './streaming/cursor.js';

async *stream(
  intent: SelectIntent,
  context?: CompilerContext,
  batchSize: number = 1000,
): AsyncIterable<unknown[]> {
  const cursorName = generateCursorName('__stream');
  const defaultBatchSize = batchSize || 1000;
  
  // Step 1: Compile SELECT intent to AST
  const selectAst = this.compiler.compileSelect(intent, context);
  
  // Step 2: Build cursor declaration
  const declareCursor = buildDeclareCursor({
    name: cursorName,
    query: selectAst,
    scroll: 'no_scroll',
    hold: 'with_hold', // Survive transaction boundary
  });
  
  // Step 3: Start transaction
  const client = await this.db.connect();
  try {
    await client.query('BEGIN');
    
    // Step 4: Declare cursor
    await client.query(this.astToSql(declareCursor));
    
    // Step 5: Stream batches
    let exhausted = false;
    while (!exhausted) {
      const fetch = buildFetch({
        name: cursorName,
        direction: 'forward',
        count: defaultBatchSize,
      });
      
      const result = await client.query(this.astToSql(fetch));
      
      if (result.rows.length === 0) {
        exhausted = true;
      } else {
        yield result.rows;
      }
    }
    
  } finally {
    // Step 6: Cleanup
    const close = buildCloseCursor(cursorName);
    await client.query(this.astToSql(close));
    await client.query('COMMIT');
    client.release();
  }
}
```

**Key Dependencies:**
- `import { buildDeclareCursor, buildFetch, buildCloseCursor, generateCursorName } from './streaming/cursor.js'`
- `import type { CursorOptions, FetchOptions } from './streaming/cursor.js'`

**Tests to Add:**
- Small batch size (verify multiple yields)
- Large batch size (verify single yield)
- Empty result set
- Single row result set
- Exact multiple of batch size
- Non-multiple of batch size
- Transaction isolation
- Error handling (early termination)

**Success Criteria:**
- Yields batches asynchronously (non-blocking)
- Memory-efficient (doesn't load all rows upfront)
- Proper cursor lifecycle (DECLARE → FETCH → CLOSE)
- Works with large datasets (millions of rows)

---

## 4. Introspection Wiring (Phase 4)

**Location:** `packages/adapter-pgsql/src/pgsql-adapter.ts:419-420`

**Current (STUB):**
```typescript
async introspect(): Promise<ModelIR> {
  throw new Error('PgsqlAdapter.introspect: Not implemented - Phase 4');
}
```

**Module Structure to Create:**
```
packages/adapter-pgsql/src/introspection/
├── schema-analyzer.ts      - Query PostgreSQL catalog
├── model-builder.ts        - Convert schema → ModelIR
├── column-type-mapper.ts   - PG type → DBSP type mapping
├── constraint-analyzer.ts  - Extract constraints
└── index.ts                - Module exports
```

**Implementation Steps:**
1. Query `pg_tables` for table list
2. Query `pg_columns` for column definitions
3. Query `pg_constraints` for PKs, FKs, uniques
4. Query `pg_indexes` for index information
5. Query `pg_type` for custom types
6. Map PostgreSQL types to DBSP types
7. Build ModelIR with all relationships

**Tests to Add:**
- Simple table with primary key
- Table with foreign keys
- Composite keys
- Check constraints
- Default values
- Nullable columns
- Custom types (enums, domains)
- Inherited tables
- Partitioned tables

**Success Criteria:**
- Introspects real PostgreSQL databases
- Produces valid ModelIR
- Round-trip: introspect → query → results work correctly

---

## Integration Checklist

### Before Any Implementation
- [ ] Review import paths (ensure relative paths work)
- [ ] Check that all dependencies are already in node_modules
- [ ] Verify `CompilerContext` and `CompilerState` match expectations

### Implementation Order (Recommended)
1. **Recursive CTE** (fastest, no blockers)
   - Lowest risk, highest immediate value
   - Can be tested independently
   
2. **Streaming** (medium complexity)
   - Requires transaction handling
   - Good for memory stress testing
   
3. **Upsert** (medium complexity, blocked)
   - Wait for core `UpsertIntent` type definition
   - Or use `RawIntent` as bridge
   
4. **Introspection** (Phase 4, can defer)
   - Highest complexity, lowest priority
   - Should be started only after Phase 2 is complete

### Testing Strategy
- Unit: Each function independently
- Integration: With real PostgreSQL database
- E2E: Full query → execute → result cycle
- Regression: Ensure existing tests still pass

### Success Metrics
- All stubs removed (0 "Not implemented" errors)
- 100% test coverage for new code
- E2E tests pass with real data
- No performance regressions

