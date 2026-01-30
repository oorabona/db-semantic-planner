# adapter-pgsql Feature Inventory

## Summary
**Status:** Partial Phase 2 implementation
- ✅ **Recursive CTE module:** COMPLETE (ready to wire)
- ✅ **Upsert module:** COMPLETE (ready to wire)
- ✅ **Streaming/Cursor module:** COMPLETE (ready to wire)
- ❌ **Introspection module:** NOT YET CREATED (Phase 4)

---

## 1. Recursive CTE Module (`packages/adapter-pgsql/src/recursive/`)

### Status: COMPLETE & READY TO WIRE

**Files:**
- `cte-compiler.ts` - Main recursive CTE compiler (420 lines)
- `cycle-detection.ts` - Cycle detection logic
- `path-tracking.ts` - Path tracking utilities
- `index.ts` - Module exports

**Key Functions (exported):**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `buildRecursiveCte()` | `(config: RecursiveCteConfig): { anchor, recursive, cte }` | Build complete WITH RECURSIVE CTE for hierarchical traversal (ancestors/descendants) |
| `buildRecursiveScalarSubquery()` | `(config: RecursiveScalarSubqueryConfig): Node` | Build scalar subquery for recursive lookups |
| `buildCycleDetection()` | `(depth, visitedArray): Node` | Generate cycle detection WHERE clause |
| `buildPg14CycleClause()` | `(columns): Node` | Generate PG14+ CYCLE syntax |
| `buildPathColumn()` | `(): Node` | Generate path tracking column |
| `appendPathColumn()` | `(node): Node` | Append path to existing SELECT |

**Configuration (RecursiveCteConfig):**
```typescript
interface RecursiveCteConfig {
  cteAlias: string;        // e.g., '__rc_0'
  table: string;
  pkColumn: string;        // Primary key
  fkColumn: string;        // Self-reference FK
  outerAlias: string;
  isAncestors: boolean;    // true = up, false = down
  maxDepth: number;        // Default 100
  selectColumns: string[];
  trackPath?: boolean;
  usePg14Cycle?: boolean;
  ctx: CompilerContext;
}
```

**What's needed in PgsqlAdapter (pgsql-adapter.ts line 338-343):**
```typescript
compileRecursive(
  report: RecursivePlanReport,
  context: CompilerContext
): Dump {
  // Currently throws "Not implemented - Phase 2"
  // Should:
  // 1. Extract config from report.config
  // 2. Call buildRecursiveCte(config)
  // 3. Integrate into main SELECT statement
  // 4. Return Dump with compiled SQL + params
}
```

**Status in PgsqlAdapter:**
- ❌ `compileRecursive()` is a stub (line 338-343)
- ✅ Capabilities advertised: `supportsRecursiveCTE: true` (line 121)

---

## 2. Upsert Module (`packages/adapter-pgsql/src/mutations/`)

### Status: COMPLETE & READY TO WIRE

**Files:**
- `upsert.ts` - Upsert compiler (260+ lines)
- `mutation-compiler.ts` - Mutation dispatcher
- `index.ts` - Module exports

**Key Functions (exported):**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `compileUpsert()` | `(config: UpsertConfig, ctx: CompilerContext, state: CompilerState): Node` | Compile INSERT ... ON CONFLICT statement |
| `buildOnConflictClause()` | `(config: UpsertConfig, ctx, state): Node` | Build ON CONFLICT DO NOTHING/UPDATE |
| `excludedRef()` | `(column: string): Node` | Generate EXCLUDED.column reference |
| `conditionalUpdate()` | `(set, where): Node` | Build conditional UPDATE with WHERE |

**Configuration (UpsertConfig):**
```typescript
interface UpsertConfig {
  table: string;
  columns: string[];       // Columns to insert
  values: unknown[][];     // Row values
  conflictTarget?: ConflictTarget;  // Which columns are unique
  onConflict: ConflictAction;       // 'nothing' | 'update'
  updateSet?: Record<string, unknown>;
  where?: Decision[];      // Partial index WHERE
}

interface ConflictTarget {
  columns?: string[];
  constraint?: string;
  where?: Decision[];
}
```

**What's needed in PgsqlAdapter (pgsql-adapter.ts line 327-331):**
```typescript
compileUpsert(
  intent: UpsertIntent,
  context: CompilerContext
): Dump {
  // Currently throws "Not implemented - Phase 2"
  // Should:
  // 1. Extract UpsertConfig from intent
  // 2. Call compileUpsert(config, ctx, state)
  // 3. Wrap in INSERT statement
  // 4. Return Dump with compiled SQL + params
}
```

**Status in PgsqlAdapter:**
- ❌ `compileUpsert()` is a stub (line 327-331)
- ⚠️ Depends on `UpsertIntent` type definition in core (not yet created)

---

## 3. Streaming/Cursor Module (`packages/adapter-pgsql/src/streaming/`)

### Status: COMPLETE & READY TO WIRE

**Files:**
- `cursor.ts` - Cursor-based streaming support (280+ lines)
- `index.ts` - Module exports

**Key Functions (exported):**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `buildDeclareCursor()` | `(options: CursorOptions): Node` | Generate DECLARE CURSOR statement |
| `buildFetch()` | `(options: FetchOptions): Node` | Generic FETCH statement |
| `buildCloseCursor()` | `(cursorName: string): Node` | Generate CLOSE CURSOR |
| `buildFetchNext()` | `(cursorName: string): Node` | FETCH NEXT FROM cursor |
| `buildFetchForward()` | `(cursorName: string, count: number): Node` | FETCH FORWARD N ROWS |
| `buildFetchAll()` | `(cursorName: string): Node` | FETCH ALL FROM cursor |
| `buildFetchFirst()` | `(cursorName: string): Node` | FETCH FIRST FROM cursor |
| `generateCursorName()` | `(prefix?: string): string` | Generate unique cursor name |
| `buildStreamingStatements()` | `(query: Node, batchSize: number): Node[]` | Wrap query in cursor + fetch loop |

**Configuration:**
```typescript
interface CursorOptions {
  name: string;
  query: Node;
  scroll?: CursorScrollOption;     // 'scroll' | 'no_scroll'
  hold?: CursorHoldOption;          // 'with_hold' | 'without_hold'
  binary?: boolean;
}

interface FetchOptions {
  name: string;
  direction: FetchDirection;
  count?: number;
}

type FetchDirection = 'next' | 'prior' | 'first' | 'last' | 'absolute' | 
                     'relative' | 'forward' | 'backward' | 'forward_all' | 'backward_all';
```

**What's needed in PgsqlAdapter (pgsql-adapter.ts line 400-407):**
```typescript
stream(
  intent: SelectIntent,
  context: CompilerContext,
  batchSize?: number
): AsyncIterable<unknown[]> {
  // Currently throws "Not implemented - Phase 2"
  // Should:
  // 1. Call buildStreamingStatements(query, batchSize)
  // 2. Start transaction
  // 3. DECLARE CURSOR
  // 4. Yield batches via FETCH
  // 5. CLOSE CURSOR on completion
}
```

**Status in PgsqlAdapter:**
- ❌ `stream()` is a stub (line 400-407)
- ⚠️ Requires transaction context for proper cursor handling

---

## 4. Introspection Module

### Status: NOT YET CREATED (Phase 4)

**What exists:**
- Stub in `PgsqlAdapter.introspect()` (line 419-420)

**What needs to be created:**
- New directory: `packages/adapter-pgsql/src/introspection/`
- Modules:
  - `schema-analyzer.ts` - Query PostgreSQL catalog tables
  - `model-builder.ts` - Convert PostgreSQL schema → ModelIR
  - `column-type-mapper.ts` - Map PG types to DBSP types
  - `constraint-analyzer.ts` - Extract PK, FK, unique constraints
  - `index.ts` - Module exports

---

## Wiring Checklist for PgsqlAdapter

### Phase 2 - NOW (Quick Wins)

#### [ ] Line 338-343: Implement `compileRecursive()`
- **Import:** `import { buildRecursiveCte } from './recursive/cte-compiler.js'`
- **Extract** config from `report.config`
- **Call** `buildRecursiveCte(config)`
- **Integrate** into query compilation
- **Return** Dump with compiled SQL + params
- **Tests:** Unit tests for ancestors/descendants queries, cycle detection, path tracking

#### [ ] Line 327-331: Implement `compileUpsert()`
- **Import:** `import { compileUpsert } from './mutations/upsert.js'`
- **Extract** config from intent
- **Call** `compileUpsert(config, context, state)`
- **Return** compiled SQL + params
- **Blocker:** Needs `UpsertIntent` type from core (or use `RawIntent` as bridge)
- **Tests:** Unit tests for INSERT ... ON CONFLICT, DO NOTHING, DO UPDATE

#### [ ] Line 400-407: Implement `stream()`
- **Import:** `import { buildStreamingStatements, generateCursorName } from './streaming/cursor.js'`
- **Build** cursor statements
- **Implement** async iteration over FETCH batches
- **Handle** transaction context
- **Tests:** Integration tests with large result sets, batch size validation

### Phase 4 - Later (Deferred)

#### [ ] Line 419-420: Implement `introspect()`
- **Create** `introspection/` module
- **Query** PostgreSQL catalog (`pg_tables`, `pg_columns`, `pg_constraints`)
- **Build** ModelIR from schema
- **Tests:** Introspection on real databases with various table/constraint patterns

---

## File Structure Reference

```
packages/adapter-pgsql/src/
├── recursive/
│   ├── cte-compiler.ts        ✅ Ready to integrate (420 lines)
│   ├── cycle-detection.ts
│   ├── path-tracking.ts
│   └── index.ts
├── mutations/
│   ├── upsert.ts              ✅ Ready to integrate (260 lines)
│   ├── mutation-compiler.ts
│   └── index.ts
├── streaming/
│   ├── cursor.ts              ✅ Ready to integrate (280 lines)
│   └── index.ts
├── introspection/             ❌ Not yet created
├── handlers/                  ✅ Expression/Where handler registry
├── explain/                   ✅ EXPLAIN plan analysis
├── ddl/                       ✅ CREATE TABLE / DROP TABLE
├── pgsql-adapter.ts           ⚠️ Stubs at lines 327, 338, 400, 419 (562 lines)
├── compiler.ts                ✅ Main expression compiler (657 lines)
├── ast-helpers.ts             ✅ AST node builders
├── ast-compare.ts
├── comparison-adapter.ts      ✅ EXPLAIN comparison logic
├── naming-plugin.ts           ✅ Identifier formatting
├── param-ref.ts
├── validate.ts
└── __tests__/
```

---

## Integration Effort Estimate

| Feature | Complexity | Time | Priority |
|---------|-----------|------|----------|
| Recursive CTE | MEDIUM | 2-3h | HIGH (quick win) |
| Upsert | MEDIUM | 3-4h | MEDIUM (needs core type) |
| Streaming | HIGH | 4-5h | MEDIUM (transaction handling) |
| Introspection | HIGH | 8-10h | LOW (Phase 4) |

---

## Success Criteria

### Phase 2a: Recursive CTE Complete
- [ ] `supportsRecursiveCTE` returns `true`
- [ ] `compileRecursive()` produces valid PostgreSQL WITH RECURSIVE
- [ ] Tests: ancestors, descendants, cycle detection, path tracking
- [ ] E2E: Hierarchical query examples work end-to-end

### Phase 2b: Upsert Complete
- [ ] `UpsertIntent` type defined in core (or bridge via `RawIntent`)
- [ ] `compileUpsert()` produces valid INSERT ... ON CONFLICT
- [ ] Tests: DO NOTHING, DO UPDATE, constraint targets
- [ ] E2E: Upsert examples work end-to-end

### Phase 2c: Streaming Complete
- [ ] `stream()` yields batches asynchronously
- [ ] Cursor lifecycle (DECLARE → FETCH → CLOSE) works
- [ ] Tests: large result sets, batch size validation
- [ ] E2E: Streaming examples work end-to-end

### Phase 4: Introspection Complete
- [ ] `introspect()` queries PostgreSQL catalog
- [ ] Produces valid ModelIR from existing schemas
- [ ] Tests: various constraint patterns, FK relationships
- [ ] E2E: Introspection → Query round-trip validation

