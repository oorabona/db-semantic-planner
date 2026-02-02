# Architecture

## Overview

db-semantic-planner is an intent-first database query system. Users declare **what** to fetch, and the planner decides **how** — producing optimized, parameterized SQL with full observability into every decision.

```
User Code → IntentAST → Planner → PlanReport → Adapter → SQL + Parameters
```

## Monorepo Structure

```
packages/
├── types/          # Shared TypeScript types (IntentAST, ModelIR)
├── nql/            # Natural Query Language parser & compiler
├── core/           # Schema, Planner, DX layer, Adapter interface
├── adapter-pgsql/  # PostgreSQL SQL compiler + execution engine
├── cli/            # CLI tools (generate, introspect, repl, verify)
└── mcp-server/     # MCP server integration
```

**Build order:** `types` → `nql` → `core` → `adapter-pgsql` → `cli`

**Dependency rule:** Core is DB-agnostic. `adapter-pgsql` depends on `core`, never the reverse.

## Pipeline

### 1. NQL (Natural Query Language)

Three-stage pipeline: **Lex → Parse → Compile**

```
NQL String
  │  "users | where active = true | select name, email"
  ▼
Lexer (chevrotain) → Token Stream
  ▼
Parser → CST (Concrete Syntax Tree)
  ▼
Visitor → NQL AST (NqlProgram)
  ▼
Compiler → IntentAST (QueryIntent / MutationIntent)
```

NQL also auto-generates `IncludeIntent` from dotted paths in SELECT (`userRoles.role.name` → nested includes).

### 2. IntentAST (packages/types)

The intermediate representation between user intent and SQL planning.

| Type | Purpose |
|------|---------|
| `QueryIntent` | Complete query: from, select, where, include, orderBy, groupBy, having, distinct, limit, offset |
| `SelectIntent` | Column selection: all fields, specific fields, expressions, aggregates |
| `WhereIntent` | Filter tree: comparisons, logical ops (and/or/not), exists, range, null checks |
| `IncludeIntent` | Relation loading with nested includes, filters, recursive traversal |
| `OrderByIntent` | Sort: field, direction, nulls position |

**Expression kinds** in SELECT: column, columnAlias, relationColumn, pseudoColumn, aggregate, window, arithmetic, case, coalesce, raw, function, literal.

### 3. Planner (packages/core)

The planner reads `QueryIntent` + `ModelIR` (schema) and produces a `PlanReport` — a list of typed decisions with reasoning.

#### Strategy Selection Algorithm

For each `IncludeIntent`, the planner selects an include strategy:

1. **Recursive relations** → `cte` (WITH RECURSIVE)
2. **Explicit override** → use specified strategy (validated against dialect capabilities)
3. **Auto-detection** (default path):
   - Dialect supports `json_agg`? → `json_agg` (nested JSON subqueries, no row explosion)
   - Dialect supports `LATERAL`? → `lateral` (flat joins with LIMIT support)
   - Fallback → `join` (LEFT JOIN, database optimizer handles row explosion)

Each decision records: chosen strategy, reasoning, available alternatives, and context.

#### PlanReport

```typescript
type PlanReport = {
  rootTable: string;
  intent: QueryIntent;       // Original intent (for observability)
  decisions: PlanDecision[];  // Typed decisions for the adapter
  ctes: CteDefinition[];     // Extracted CTEs
  warnings: string[];        // Planner warnings
};
```

### 4. Adapter (packages/adapter-pgsql)

Two-phase compilation: **Intent → Decisions → SQL**

#### Phase A: Intent to Decisions (`intent-to-decisions.ts`)

Converts `QueryIntent` into flat `PlanDecision[]` for the SQL compiler:
- SELECT expressions → `select`, `selectFunction`, `selectWindow`, `selectArithmetic`, `selectRelationColumn`, `selectExpression`
- WHERE conditions → `where` (comparison, like, in, between, exists, null, range)
- ORDER BY / GROUP BY / HAVING → typed decisions
- LIMIT / OFFSET → parameterized decisions
- Mutations → `insert`, `update`, `delete` with field/value pairs

Include strategy decisions are extracted separately from the PlanReport and merged. When a relation has both an include strategy and `selectRelationColumn` expressions, the include strategy takes precedence (deduplication at merge point).

#### Phase B: SQL Compiler (`compiler.ts`)

Dispatches `PlanDecision[]` to handler functions that build PostgreSQL AST nodes:

```
PlanDecision[]
  ▼
Handler dispatch (switch on decision.type)
  ├─ select → column/function/window ResTarget nodes
  ├─ includeStrategy → json_agg/lateral/join/cte handlers
  ├─ where → A_Expr / BoolExpr condition nodes
  ├─ orderBy → SortBy nodes
  ├─ groupBy → ColumnRef nodes
  └─ insert/update/delete → mutation statement nodes
  ▼
PostgreSQL AST (pg-native types)
  ▼
deparseQuoted() → SQL string + $N parameters
```

### 5. Handler Architecture

Handlers are organized by category and registered in a registry pattern:

#### Expression Handlers (`handlers/expression/`)

| Handler | Expression Types | Output |
|---------|-----------------|--------|
| column | column, columnAlias, star | ColumnRef / ResTarget |
| aggregate | count, sum, avg, min, max, countDistinct | FuncCall |
| window | rowNumber, rank, denseRank, lag, lead, ntile | WindowFunc |
| arithmetic | arithmetic, math, calc | A_Expr (AEXPR_OP) |
| case | case, simpleCase | CaseExpr |
| coalesce | coalesce, nullIf, greatest, least | CoalesceExpr / MinMaxExpr |
| relation | relationColumn, relationStar, relationColumns | ColumnRef with alias |
| pseudo | pseudoColumn, singleHopPseudo, chainedPseudo | WITH RECURSIVE subquery |
| raw | raw, sqlFunction, literal | RawSQL / FuncCall / A_Const |

#### Include Handlers (`handlers/include/`)

| Strategy | When Used | SQL Pattern |
|----------|-----------|-------------|
| `json_agg` | Default for hasMany | `COALESCE((SELECT json_agg(to_jsonb(__t__) \|\| ...) FROM ...), '[]'::json)` |
| `lateral` | When LIMIT needed | `LEFT JOIN LATERAL (SELECT ... LIMIT N) AS ... ON true` |
| `join` | Flat result sets | `LEFT JOIN ... ON ...` |
| `cte` | Recursive relations | `WITH ... AS (...) SELECT ... LEFT JOIN ...` |

#### Where Handlers (`handlers/where/`)

Condition types: comparison, like, in, between, null, exists, range (contains/overlaps/containedBy).

## Key Types

### ModelIR (Schema)

```typescript
type ModelIR = {
  tables: Map<string, TableDef>;    // Table definitions with columns
  relations: Map<string, Relation>; // Named relations between tables
};
```

### PlanDecision (Adapter)

```typescript
type PlanDecision = {
  type: string;      // Decision type discriminator
  column?: string;   // Target column
  table?: string;    // Target table
  alias?: string;    // Output alias
  // ... type-specific fields
};
```

## Observability

Every query produces a `Dump` for inspection:

```typescript
const dump = orm.select('users').where(eq('active', true)).dump();
// dump.plan    → PlanReport (all decisions with reasoning)
// dump.sql     → Compiled SQL string
// dump.params  → Bound parameter values
```

The planner records for each decision:
- **Choice**: what strategy/approach was selected
- **Reasoning**: why (dialect capabilities, relation type, user override)
- **Alternatives**: what other strategies were available
- **Context**: source table, target table, relation type, foreign key

## Testing Strategy

| Level | Location | What |
|-------|----------|------|
| Unit | `src/__tests__/*.test.ts` (colocated) | Handler output, compiler decisions, AST helpers |
| Golden SQL | `src/__tests__/golden-sql.test.ts` | Known-good SQL output comparison |
| E2E compile-only | `tests/e2e/example-assertions.test.ts` | Full pipeline: NQL → SQL (no database) |
| E2E with DB | `tests/e2e/` (Testcontainers) | Full execution against PostgreSQL |

**Example assertions** (`examples/*.assert.dbsp`) validate SQL output for each NQL query in the corresponding `.dbsp` file.

## NQL Grammar Coverage

| Feature | Status | Notes |
|---------|--------|-------|
| SELECT (columns, *, aliases) | Supported | All expression kinds |
| WHERE (=, !=, >, <, >=, <=) | Supported | Parameterized |
| LIKE / NOT LIKE | Supported | Pattern matching |
| IN (array) | Supported | `WHERE x IN (1, 2, 3)` |
| IN (subquery) | Supported | `WHERE x IN (SELECT ...)` |
| BETWEEN | Parsed | Compilation deferred |
| NOT IN | Parsed | Compilation deferred |
| EXISTS (subquery) | Blocked | System uses `relationFilter` pattern instead |
| ORDER BY / GROUP BY / HAVING | Supported | With direction, nulls |
| DISTINCT | Supported | `SELECT DISTINCT` |
| LIMIT / OFFSET | Supported | Parameterized |
| CASE WHEN | Parsed | Compilation deferred |
| Aggregates (COUNT, SUM, AVG, MIN, MAX) | Supported | With DISTINCT |
| Window functions | Supported | All standard functions |
| Arithmetic (+, -, *, /, %) | Supported | Binary and unary |
| Mutations (INSERT, UPDATE, DELETE) | Supported | With RETURNING |
| Includes (.include) | Supported | Nested, recursive, filtered |
| Pseudo-columns (parent, ancestor) | Supported | CTE/json_agg strategies |
