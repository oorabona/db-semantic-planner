# adapter-pgsql Architecture

## Overview

`@dbsp/adapter-pgsql` is a native PostgreSQL adapter that uses **tree-to-tree transformation** to compile query plans into SQL. Unlike the Kysely-based adapter that builds SQL through a query builder API, this adapter operates directly on the PostgreSQL AST.

```
PlanReport → PostgreSQL AST → SQL (via pgsql-deparser)
```

## Key Benefits

1. **Native PostgreSQL Features**: Direct access to PostgreSQL-specific syntax (LATERAL, json_agg, WITH RECURSIVE)
2. **AST Validation**: Roundtrip tests ensure generated AST is valid PostgreSQL
3. **Performance**: No intermediate query builder overhead
4. **Debugging**: AST can be inspected before deparse

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         PlanReport                               │
│  (from @dbsp/core semantic planner)                              │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PlanCompiler                                │
│  src/compiler.ts                                                 │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Handler   │  │   Handler   │  │      Handler            │  │
│  │   Registry  │→→│  Dispatch   │→→│      Execution          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                  │
│  Handlers:                                                       │
│  • WHERE handlers (comparison, logical, collection, pattern)     │
│  • EXPRESSION handlers (aggregate, window, case, coalesce)       │
│  • INCLUDE handlers (json_agg, join, lateral, cte)               │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL AST                               │
│  @pgsql/types (Node)                                             │
│                                                                  │
│  SelectStmt, InsertStmt, UpdateStmt, DeleteStmt                  │
│  JoinExpr, WhereClause, TargetList, etc.                         │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        pgsql-deparser                            │
│                                                                  │
│  deparse(ast: Node) → Promise<string>                            │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                          SQL String                              │
│  + Parameters (readonly unknown[])                               │
└─────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
packages/adapter-pgsql/src/
├── index.ts                    # Public exports
├── compiler.ts                 # Main PlanCompiler
├── comparison-adapter.ts       # Dual-adapter validation
├── validate.ts                 # Identifier validation (security)
├── naming-plugin.ts            # camelCase ↔ snake_case
├── param-ref.ts                # Parameter reference ($1, $2, ...)
├── ast-helpers.ts              # AST node builders
├── ast-compare.ts              # AST comparison utilities
│
├── handlers/
│   ├── index.ts                # Handler registry
│   ├── types.ts                # Handler interfaces
│   ├── where/                  # WHERE clause handlers
│   │   ├── comparison.ts       # =, !=, <, >, <=, >=
│   │   ├── logical.ts          # AND, OR, NOT
│   │   ├── in.ts               # IN, NOT IN
│   │   ├── like.ts             # LIKE, ILIKE
│   │   ├── null.ts             # IS NULL, IS NOT NULL
│   │   ├── exists.ts           # EXISTS subquery
│   │   ├── between.ts          # BETWEEN
│   │   ├── subquery.ts         # Subquery conditions
│   │   └── range.ts            # PostgreSQL range operators
│   │
│   ├── expression/             # Expression handlers
│   │   ├── aggregate.ts        # COUNT, SUM, AVG, MIN, MAX
│   │   ├── window.ts           # ROW_NUMBER, RANK, etc.
│   │   ├── case.ts             # CASE WHEN
│   │   ├── coalesce.ts         # COALESCE
│   │   ├── pseudo.ts           # Pseudo-columns (depth, path)
│   │   └── raw.ts              # Raw SQL escape hatch
│   │
│   └── include/                # Include strategy handlers
│       ├── json-agg.ts         # JSON aggregation
│       ├── join.ts             # JOIN strategy
│       ├── lateral.ts          # LATERAL subquery
│       └── cte.ts              # CTE strategy
│
├── mutations/
│   ├── index.ts                # Mutation exports
│   ├── mutation-compiler.ts    # INSERT/UPDATE/DELETE
│   └── upsert.ts               # ON CONFLICT handling
│
├── recursive/
│   ├── cte-compiler.ts         # WITH RECURSIVE generation
│   ├── cycle-detection.ts      # Cycle detection in hierarchies
│   └── path-tracking.ts        # Path materialization
│
├── explain/
│   └── explain.ts              # EXPLAIN statement builder
│
└── streaming/
    ├── index.ts                # Streaming exports
    └── cursor.ts               # DECLARE CURSOR / FETCH
```

## Handler Registry Pattern

The compiler uses a **handler registry** pattern for extensibility:

```typescript
// Registration
const equalityHandler: WhereHandler = {
  operators: ['='],
  compile(decision, ctx, state, dispatch) { /* ... */ },
};
const countHandler: ExpressionHandler = {
  types: ['count'],
  compile(decision, ctx, state) { /* ... */ },
};
registerWhereHandler(equalityHandler);
registerExpressionHandler(countHandler);

// INCLUDE is a closed collection: extend it by changing
// INCLUDE_STRATEGIES and allIncludeHandlers together.

// Dispatch
const whereHandler = getWhereHandler(operator);
const whereNode = whereHandler.compile(decision, ctx, state, dispatch);
const expressionHandler = getExpressionHandler(type);
const expressionNode = expressionHandler.compile(decision, ctx, state);
const includeHandler = getIncludeHandler(strategy);
const includeResult = includeHandler.compile(decision, ctx, state);
```

### Handler Interface

```typescript
interface WhereHandler {
  readonly operators: readonly string[];
  compile(
    decision: Decision,
    ctx: CompilerContext,
    state: CompilerState,
    dispatch: WhereDispatcher
  ): Node;
}

interface ExpressionHandler {
  readonly types: readonly string[];
  readonly nqlSafe?: boolean;
  compile(decision: Decision, ctx: CompilerContext, state: CompilerState): Node;
}

interface IncludeHandler {
  readonly strategy: IncludeHandlerStrategy;
  compile(
    decision: Decision,
    ctx: CompilerContext,
    state: CompilerState
  ): IncludeResult;
}
```

## Context and State

### CompilerContext (Immutable)

```typescript
interface CompilerContext {
  naming: NamingPlugin;      // Name transformation
  rootTable: string;         // Root entity table
  schema?: string;           // PostgreSQL schema
  maxRecursiveDepth: number; // CTE depth limit (default: 100)
  currentAlias?: string;     // Current table alias
}
```

### CompilerState (Mutable)

```typescript
interface CompilerState {
  parameters: unknown[];           // Collected parameters
  paramIndex: number;              // Current param index
  joins: Node[];                   // Accumulated JOINs
  ctes: Map<string, Node>;         // Named CTEs
  aliases: Map<string, string>;    // Table → Alias mapping
}
```

## Security

### Identifier Validation

All identifiers pass through `validateIdentifier()`:

```typescript
function validateIdentifier(value: string, type: 'table' | 'column' | 'schema' | 'alias'): void {
  // 1. Not empty
  // 2. Max 63 characters (PostgreSQL limit)
  // 3. Valid characters: ^[a-zA-Z_][a-zA-Z0-9_$]*$
  // 4. No control characters
  // 5. No SQL injection patterns
}
```

### Parameter Binding

All values are parameterized using `$1`, `$2`, etc.:

```typescript
// Never this:
`WHERE id = ${id}`

// Always this:
`WHERE id = $1` + parameters: [id]
```

## ComparisonAdapter (Validation)

For migration safety, the `ComparisonAdapter` can run both adapters and compare output:

```typescript
const mode = getComparisonMode(); // 'pgsql' | 'kysely' | 'compare' | 'strict'

// 'compare': Log differences
// 'strict': Throw on mismatch
```

Environment variable: `DBSP_COMPARISON_MODE`

## Test Strategy

| Category | Tests | Coverage |
|----------|-------|----------|
| WHERE handlers | 30 | All operators |
| EXPRESSION handlers | 52 | Aggregates, window, case |
| INCLUDE strategies | 23 | All 4 strategies |
| Recursive CTE | 13 | Depth, cycle, path |
| Mutations | 26 | INSERT/UPDATE/DELETE/UPSERT |
| ComparisonAdapter | 36 | SQL diff, metrics |
| Supporting | 233+ | AST, validation, params |
| **Total** | **413** | Comprehensive |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@dbsp/core` | PlanReport, IntentAST types |
| `@dbsp/types` | Shared type definitions |
| `@pgsql/types` | PostgreSQL AST node types |
| `pgsql-deparser` | AST → SQL conversion |

## Usage

```typescript
import { compilePlan, PlanCompiler } from '@dbsp/adapter-pgsql';

// Simple compilation
const { sql, params } = await compilePlan(planReport, {
  naming: camelCaseNaming(),
  schema: 'public'
});

// With compiler instance
const compiler = new PlanCompiler(options);
const result = await compiler.compile(planReport);
```
