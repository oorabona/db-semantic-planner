---
name: project-experience
description: Project-specific patterns, gotchas, and learnings for db-semantic-planner
---

# Project Experience: db-semantic-planner

## Project Context

**Vision:** Semantic query planning for databases - intent-first approach
**Generated:** 2026-01-06
**Updated:** 2026-01-23
**Phase:** P2 Complete, CLI-NQL Complete, NQL v2.0 Parser Complete

## Architecture: Ports & Adapters

```
packages/core           → DB-agnostic, includes DX layer (MUST NOT import adapter code)
packages/adapter-kysely → SQL Compiler, Kysely Engine (depends on core)
packages/cli            → dbsp CLI (generate, verify, repl commands)
packages/mcp-server     → MCP Server for AI assistants (depends on core + adapter)
```

**STRICT RULE:** Core has zero knowledge of SQL dialects or Kysely.

## Scopes

| Scope | Package | Key Concerns |
|-------|---------|--------------|
| core | `packages/core` | ModelIR types, IntentAST nodes, Planner decisions, DX layer |
| adapter | `packages/adapter-kysely` | SQL generation, Kysely integration, multi-tenant |
| cli | `packages/cli` | Code generation, schema verification, REPL |
| mcp-server | `packages/mcp-server` | AI assistant integration via MCP protocol |
| nql | `packages/nql` | NQL v2.0 parser (Chevrotain, IntentAST output) |

## Tech Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| Language | TypeScript | Strict mode enabled |
| Runtime | Node.js | ESM preferred |
| Database | PostgreSQL-first | Multi-dialect P2 via capabilities |
| Adapter | Kysely | Peer dependency |
| Testing | Vitest | Golden tests for SQL snapshots |
| Build | tsup | ESM + CJS dual output |

---

## Gotchas

### 1. Alias Reuse in SQL

**Problem:** When the same subquery appears multiple times (e.g., ratio of filtered/total), naive compilation creates duplicate aliases.

**Solution:** Extract to CTE (Common Table Expression) and reference by CTE name.

```sql
-- BAD: Duplicate alias "products"
SELECT ..., (SELECT COUNT(*) FROM products) / (SELECT COUNT(*) FROM products WHERE active)

-- GOOD: CTE with distinct names
WITH products_all AS (SELECT * FROM products),
     products_active AS (SELECT * FROM products WHERE active)
SELECT ..., (SELECT COUNT(*) FROM products_active) / (SELECT COUNT(*) FROM products_all)
```

**When to apply:** Planner detects when same relation appears in numerator/denominator of ratio.

### 2. To-Many Row Explosion

**Problem:** JOIN on to-many relation multiplies rows (1 parent × N children = N rows).

**Why EXISTS default:** For filtering, EXISTS avoids duplication:

```sql
-- BAD: Row explosion (10 products × 5 images each = 50 rows)
SELECT p.* FROM products p
JOIN product_images i ON i.product_id = p.id
WHERE i.locale = 'FR'

-- GOOD: EXISTS (10 products = 10 rows)
SELECT p.* FROM products p
WHERE EXISTS (
  SELECT 1 FROM product_images i
  WHERE i.product_id = p.id AND i.locale = 'FR'
)
```

**Strategy:** `filterStrategy: 'exists'` is default for to-many relations.

### 3. Join Semantics Ambiguity

**Problem:** LEFT vs INNER JOIN changes result count when relation is optional.

**Rule:**
- `belongsTo` optional → LEFT JOIN (keep parent even if no child)
- `belongsTo` required → INNER JOIN (parent must have child)
- Filter on relation → INNER JOIN (filter implies existence)

### 4. Kysely Plugin State (WeakMap)

**Problem:** If Kysely plugin stores state in `transformQuery` to retrieve in `transformResult`, a cancelled query leaks memory.

**Solution:**

```typescript
// BAD: Memory leak
const stateMap = new Map<string, State>();

// GOOD: Auto-cleanup when query GC'd
const stateMap = new WeakMap<object, State>();

transformQuery(args) {
  stateMap.set(args.node, { ... }); // Use node as key
}

transformResult(args) {
  const state = stateMap.get(args.node);
  // May be undefined if query was cancelled
}
```

### 5. Kysely Dialect Detection via Internals

**Problem:** Need to detect database dialect at runtime to adapt SQL generation without requiring explicit configuration.

**Solution:** Access Kysely's internal adapter name:

```typescript
function detectDialect(db: Kysely<unknown>): DialectName {
  const adapter = db.getExecutor?.()?.adapter;
  const adapterName = adapter?.constructor?.name?.toLowerCase() ?? '';

  if (adapterName.includes('postgres')) return 'postgresql';
  if (adapterName.includes('mysql')) return 'mysql';
  if (adapterName.includes('sqlite')) return 'sqlite';
  if (adapterName.includes('mssql')) return 'mssql';
  return 'unknown';
}
```

**Why this works:** Kysely stores dialect-specific adapters internally. The adapter class name reliably indicates the dialect.

**Gotcha:** This relies on Kysely internals - changes between Kysely versions could break detection. Test helpers can mock this structure for unit tests.

### 6. exactOptionalPropertyTypes Compatibility

**Problem:** TypeScript's `exactOptionalPropertyTypes` flag causes errors when conditionally assigning optional properties with undefined values.

**Solution:** Use conditional assignment instead of always assigning:

```typescript
// BAD: Fails with exactOptionalPropertyTypes
constructor(options?: { capability?: string }) {
  this.capability = options?.capability; // Error if undefined
}

// GOOD: Conditional assignment
constructor(options?: { capability?: string }) {
  if (options?.capability !== undefined) {
    this.capability = options.capability;
  }
}
```

**When to apply:** Any class or interface with optional properties where the compiler complains about undefined assignment.

### 7. Multi-tenant Schema Validation

**Problem:** Raw schema names in SQL = injection risk.

**Solution:** Always validate + use Kysely `.withSchema()`:

### 8. NEVER Raw SQL in Adapter Code (CRITICAL)

**Problem:** Using `sql` template literals instead of Kysely's native expression builders.

**Why forbidden:**
- Breaks dialect portability (Kysely adapts `eb.fn()` per dialect)
- Loses type safety
- Injection risk without proper escaping

**Solution:** Always use native Kysely APIs:
- `eb.fn('coalesce', [...])` instead of `` sql`COALESCE(...)` ``
- `eb.ref('table.col')` instead of `sql.ref('table.col')`
- `eb.lit(1)` instead of `` sql`1` ``

**Exception:** Only `RawExpressionIntent` may use `sql.raw()` — it's the user's escape hatch.

```typescript
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateSchemaName(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name) || name.length > 63) {
    throw new InvalidIdentifierError(name);
  }
}

// Usage
orm.forTenant('tenant_acme'); // Validated, uses db.withSchema()
```

### 10. Type Chain Propagation Gap (2026-01-19)

**Problem:** Feature exists in adapter layer (DDL generator supports `unique`, `onDelete`, indexes) but schema layer (`@dbsp/schema`) doesn't expose them, so they never reach the adapter.

**Why it happens:** The type chain flows `@dbsp/schema` → `@dbsp/core` (ModelIR) → `@dbsp/adapter-kysely`. If a property isn't in an intermediate type (like `ColumnIR`), it's lost.

**Example:** `ColumnDefinition` has `unique: true` but `ColumnIR` doesn't, so DDL can't generate `UNIQUE` constraints.

**How to diagnose:** When a feature seems missing, trace the full type chain from user-facing API to adapter. The gap is usually in the intermediate IR types.

**Solution:** Add missing properties to IR types, not just the adapter or schema layers.

### 11. Handler/Dispatcher Pattern with Factory Functions (2026-01-20)

**Context:** Refactoring monolithic switch-based dispatchers (like `compileWhere()` with 12 cases) into modular handler registries.

**Pattern:**
- Define handler types in `types.ts` (WhereHandler, ExpressionHandler, etc.)
- Create registries using `Map<string, Handler>` in `registry.ts`
- For simple handlers: direct functions registered at module load
- For complex handlers with dependencies: use factory pattern

**Factory pattern for dependency injection:**

```typescript
// handlers/where/exists.ts
export function createExistsHandler(helpers: {
  compileExists: ExistsCompilerFn;
  compileJoinedRelationConditions: JoinConditionFn;
}) {
  return (ctx: CompilerContext, eb: ExpressionBuilder, intent: WhereIntent) => {
    return helpers.compileExists(ctx, eb, intent);
  };
}

// Registration in compiler.ts
registerComplexWhereHandlers({
  compileExists,           // Pass existing functions
  compileJoinedRelationConditions,
});
```

**Why factory pattern:**
- Avoids circular dependencies (handlers don't import compiler.ts directly)
- Allows handlers to use existing compiler functions without extraction
- Establishes extensibility pattern first, logic extraction can happen later

**When to apply:** Any large switch statement that dispatches on a `kind` or `type` field.

### 12. Recursive CTE in EXISTS Requires sql Template (2026-01-21)

**Context:** Implementing `ancestors`/`descendants` traversal via EXISTS subquery with inline recursive CTE.

**Problem:** Kysely's expression builder (`eb`) doesn't support inline recursive CTEs within EXISTS. The `withRecursive()` method only works at the top query level, not nested within an EXISTS clause.

**Solution:** Use `sql` template directly (documented exception to "no raw SQL" rule). This is allowed because:
1. The recursive CTE pattern cannot be expressed via expression builder
2. All identifiers come from trusted schema (validated at ORM layer)
3. Column references use `sql.ref()` for proper parameterization

**Pattern:**
```typescript
// compileRecursiveExists uses sql template - ALLOWED EXCEPTION
const existsSql = sql`EXISTS (
  WITH RECURSIVE ${sql.raw(cteName)}(id, ${sql.raw(fkCol)}, _depth) AS (
    SELECT id, ${sql.raw(fkCol)}, 1 AS _depth
    FROM ${tableName}
    WHERE id = ${sql.ref(`${sourceAlias}.${fkCol}`)}
    UNION ALL
    SELECT t.id, t.${sql.raw(fkCol)}, r._depth + 1
    FROM ${tableName} t
    INNER JOIN ${sql.raw(cteName)} r ON ...
    WHERE r._depth < ${maxDepth}
  )
  SELECT 1 FROM ${sql.raw(cteName)}
  WHERE ${cteWhereClause}
)`;
```

**When to apply:** Any recursive tree traversal in WHERE context (ancestors, descendants, hierarchies).

### 13. NQL v2.0 Parser Architecture (2026-01-23)

**Context:** Building standalone NQL parser package (`@dbsp/nql`).

**Key decisions:**
- Chevrotain-based (same as CLI parser), no codegen needed
- Pipeline-first syntax: `table | clause | clause` (reads), SQL-style mutations
- Typed expressions output to IntentAST (no raw SQL ever)

**Layered architecture:**
1. **Lexer** (`src/lexer/`) — 35+ tokens, handles quoted identifiers, escape sequences
2. **Parser** (`src/parser/`) — CST generation via Chevrotain grammar
3. **Visitor** (`src/semantic/`) — CST → NQL AST transformation
4. **Compiler** (`src/compiler/`) — NQL AST → IntentAST

**Token naming gotcha:** Rename tokens that shadow JavaScript globals.

```typescript
// BAD: Set shadows global Set
export const Set = createToken({ name: 'Set', pattern: /set\b/i });

// GOOD: SetKeyword avoids shadowing
export const SetKeyword = createToken({ name: 'Set', pattern: /set\b/i });
```

**Why this matters:** Biome's `noShadowRestrictedNames` catches this. The token `name` property stays as `'Set'` for Chevrotain, but the export name changes.

---

## Debugging Tips

### Use dump() for Everything

```typescript
const dump = query.dump();
console.log('Plan:', JSON.stringify(dump.plan, null, 2));
console.log('SQL:', dump.sql);
console.log('Params:', dump.params);
```

### Compare Plan vs SQL

If SQL looks wrong, check `dump.plan.decisions`:

```typescript
const { plan } = query.dump();
for (const d of plan.decisions) {
  console.log(`[${d.type}] ${d.context}: ${d.choice} — ${d.reasoning}`);
}
```

### Check for Warnings

```typescript
if (dump.plan.warnings.length > 0) {
  console.warn('Plan warnings:', dump.plan.warnings);
}
```

### EXPLAIN/ANALYZE (P1)

When available:

```typescript
const explain = await query.explain({ analyze: true });
console.log(explain.plan);
console.log('Execution time:', explain.executionTime, 'ms');
```

---

## Patterns

### Schema Builder Pattern (Thenable)

```typescript
const schema = defineSchema({
  products: {
    id: 'number',
    name: 'string',
    categoryId: 'number',
  },
  categories: {
    id: 'number',
    name: 'string',
  },
})
.relations({
  products: {
    category: belongsTo('categories', { foreignKey: 'categoryId' }),
  },
  categories: {
    products: hasMany('products', { foreignKey: 'categoryId' }),
  },
})
.build(); // Returns ModelIR
```

### Query Builder Pattern (Intent-First)

```typescript
// Declarative: WHAT you want
const query = orm.query(Product)
  .select(['id', 'name'])
  .where(exists('images', { where: eq('approved', true) }))
  .include('category')
  .orderBy('name', 'asc')
  .limit(10);

// Planner decides HOW
const dump = query.dump();
// dump.plan shows: filter-strategy: exists, include-strategy: join, etc.

// Execute
const products = await query.findMany();
```

### Multi-tenant Pattern

```typescript
// Create base ORM
const orm = createOrm({ kysely: db, model: schema });

// Per-request tenant context
function handleRequest(req) {
  const tenantOrm = orm.forTenant(req.tenant);

  // All queries scoped to tenant schema
  return tenantOrm.query(User).findMany();
}
```

---

## Known Issues

*(Add entries as discovered during implementation)*

### Template

```markdown
### ISSUE-001: [Title]

**Discovered:** YYYY-MM-DD
**Status:** Open | Resolved | Won't Fix
**Severity:** Low | Medium | High | Critical

**Description:**
What happens and when.

**Workaround:**
How to avoid or mitigate.

**Resolution:**
(If resolved) How it was fixed.
```

---

## Performance Notes

### Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| JOIN on to-many for filtering | Row explosion | Use EXISTS |
| SELECT * with large relations | Over-fetching | Explicit field selection |
| Unbounded queries | Memory exhaustion | Always use LIMIT |
| N+1 includes | Round-trips | Planner uses batch loading |

### Strategy Selection

| Scenario | Default Strategy | Rationale |
|----------|------------------|-----------|
| Filter by to-many | EXISTS | No row multiplication |
| Include to-one | JOIN | Single row, efficient |
| Include to-many | Separate query | Avoid explosion |
| Computed ratio | CTE | Reuse subquery |

---

## Golden Tests Reference

| Test | Intent | Key Decision | Spec |
|------|--------|--------------|------|
| Q1 | Filter products by image locale | `filter-strategy: exists` | core-OVERVIEW.md |
| Q2 | Coverage ratio by category | `cte-extraction` | adapter-OVERVIEW.md |
| Q3 | Strict mode ambiguity | Throws `AmbiguousRelationError` | dx-OVERVIEW.md |

---

## Architectural Decisions

| Decision | Rationale | Documented In |
|----------|-----------|---------------|
| Intent-first planning | Planner decides strategy, not developer | CLAUDE.md |
| Kysely as first adapter | Mature, typed, multi-dialect ready | CLAUDE.md |
| Schema-per-tenant | Clean isolation, no row-level mixing | adapter-OVERVIEW.md |
| Deterministic output | Testability via golden tests | core-OVERVIEW.md |
| EXISTS default for to-many | Prevent row explosion | core-OVERVIEW.md |

### Dual Schema Definition Paths (2026-01-19)

**Pattern:** This project has two independent schema definition systems that must be kept in sync:

| Package | API | Purpose |
|---------|-----|---------|
| `@dbsp/schema` | `defineSchema(tables, config?)` | Code generation, CLI workflows |
| `@dbsp/core/schema-builder` | `defineSchema({ table: { columns, indexes } })` | Direct programmatic usage |

**When:** Adding new schema features (unique, indexes, onDelete, etc.)

**Why:** The two paths serve different use cases but converge on the same `ModelIR` format.

**How:**
1. Add types to both `@dbsp/schema/types.ts` AND `@dbsp/core/schema-builder.ts`
2. Propagate through `schema-bridge.ts` (for @dbsp/schema path)
3. Propagate through `schema-builder.ts` (for direct path)
4. Both paths output to `ModelIR` which feeds DDL generation

**Table-level indexes syntax differs:**
- @dbsp/schema: pass indexes in config second argument
- @dbsp/core/schema-builder: use `TableDefWithConfig` format with `columns` and `indexes` keys

### Dialect Type Safety Pattern (2026-01-19)

**Pattern:** Compile-time and runtime type safety for dialect-specific features.

**When:** Adding features that only work on certain databases (e.g., PostgreSQL range types).

**Why:** Prevents runtime errors by catching incompatible type usage early.

**How:**
1. Define dialect-specific types using TypeScript conditional types in `core/dialects/index.ts`
2. Use `SupportedColumnTypes<D>` for compile-time validation
3. Use `assertTypeSupported()` at DDL generation time for runtime validation
4. Provide helpful hints in error messages (e.g., "jsonb is PostgreSQL-only, use json instead")

**Key types:**
- `DialectName`: Union of supported dialect names
- `PostgresOnlyColumnType`: Types exclusive to PostgreSQL (ranges, jsonb)
- `SupportedColumnTypes<D>`: Conditional type mapping dialect to allowed types
- `UnhandledTypeInDialect`: Error class with type, dialect, and hint

---

### Multi-Dialect Sequence Management Pattern

**When:** Implementing sequence reset or setval functionality for multi-tenant data isolation.

**Why:** Each dialect handles auto-increment sequences differently. A unified API abstracts these differences.

**How:**
1. Create a dialect mapping for sequence operations:
   - PostgreSQL: `SELECT setval('schema.table_col_seq', COALESCE((SELECT MAX(col) FROM schema.table), 0))`
   - MySQL: `SET @max_id = ...; ALTER TABLE t AUTO_INCREMENT = @max_id`
   - SQLite: `UPDATE sqlite_sequence SET seq = (SELECT MAX(col) FROM t) WHERE name = 't'`
   - MSSQL: `DBCC CHECKIDENT ('schema.t', RESEED, @max_id)`
2. Use consistent naming convention: `{table}_{column}_seq` for PostgreSQL sequences
3. Support schema qualification for multi-tenant scenarios
4. Return null for dialects that don't support explicit sequence management

**Key functions:**
- `generateSequenceResetStatements()`: Batch reset all auto-increment sequences
- `generateSetvalStatement()`: Set explicit next value for a sequence

---

### Canonical Locations for Shared Functions (DRY)

**When:** Adding or consolidating shared utility functions across core and adapter packages.

**Why:** Avoid duplicate implementations that can drift apart. Single source of truth.

**Where to put shared functions:**

| Function Type | Canonical Location | Example |
|---------------|-------------------|---------|
| String manipulation (pluralize, singularize, capitalize) | `core/src/conventions.ts` | `singularize()` with IRREGULAR_PLURALS |
| Intent building helpers | `core/src/dx/intent-builder.ts` | `parseDotNotationInclude()` |
| AST-related utilities | `core/src/intent-ast.ts` | `getNodeIdAlias()` near related types |
| Type guards for AST nodes | `core/src/intent-ast.ts` | `isAdjacencyTraversal()` |
| Schema utilities | `core/src/model-ir.ts` or `core/src/conventions.ts` | FK detection |

**Cross-package sharing:** When adapter needs a function from core:
1. Export from core's index.ts
2. Import in adapter via `@dbsp/core`
3. Never duplicate - if you find yourself copying, refactor instead

**Backwards compatibility:** When moving a function, use re-export pattern:
```typescript
// In old location (e.g., lightweight-model.ts)
export { singularize } from '../conventions.js';  // Re-export for consumers
```

**Added:** 2026-01-20 (DUP-001, DUP-002, DUP-003 fixes)
