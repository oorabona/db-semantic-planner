---
name: project-experience
description: Project-specific patterns, gotchas, and learnings for db-semantic-planner
---

# Project Experience: db-semantic-planner

## Project Context

**Vision:** Semantic query planning for databases - intent-first approach
**Generated:** 2026-01-06
**Phase:** MVP in progress

## Architecture: Ports & Adapters

```
packages/core          → DB-agnostic (MUST NOT import adapter code)
packages/adapter-kysely → Depends on core
packages/dx            → Depends on core + adapter-kysely
```

**STRICT RULE:** Core has zero knowledge of SQL dialects or Kysely.

## Scopes

| Scope | Package | Key Concerns |
|-------|---------|--------------|
| core | `packages/core` | ModelIR types, IntentAST nodes, Planner decisions |
| adapter | `packages/adapter-kysely` | SQL generation, Kysely integration, multi-tenant |
| dx | `packages/dx` | Strict mode, ambiguity detection, compat helpers |

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

### 5. Multi-tenant Schema Validation

**Problem:** Raw schema names in SQL = injection risk.

**Solution:** Always validate + use Kysely `.withSchema()`:

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
