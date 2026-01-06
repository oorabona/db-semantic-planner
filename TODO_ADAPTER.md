# Adapter Scope Backlog (`packages/adapter-kysely`)

**Package:** `packages/adapter-kysely`
**Phase:** MVP (PostgreSQL), P2 (multi-dialect)
**Dependencies:** `packages/core`, `kysely` (peer)

## Architecture Constraint

```
Imports from: packages/core (ModelIR, IntentAST, PlanReport)
MUST NOT import from: packages/dx
```

---

## In Progress

(none)

## Pending - MVP

### ADAPTER-001: Compile/Dump/Execute ([spec](docs/specs/ADAPTER-001-kysely-dump-compile-execute.md))

- [ ] :red_circle: [HIGH] Dump interface
  - plan: PlanReport
  - sql: string (from Kysely CompiledQuery.sql)
  - params: readonly unknown[] (from Kysely CompiledQuery.parameters)
  - meta?: DumpMeta
- [ ] DumpMeta interface
  - tenant?: string
  - queryName?: string
  - correlationId?: string
  - compiledAt?: Date
- [ ] :red_circle: [HIGH] QueryBuilder.compile() method
  - Returns Dump without executing
  - Uses Kysely .compile()
- [ ] QueryBuilder.dump() alias
- [ ] :red_circle: [HIGH] Deterministic output
  - Stable SQL (same intent → same SQL)
  - Consistent aliasing: t0, t1, t2...
  - Ordered params: $1, $2, $3...

### ADAPTER-002: Multi-tenant

- [ ] :red_circle: [HIGH] OrmContext interface
  - forTenant(schemaName): TenantOrmContext
  - query(model): QueryBuilder
  - kysely: Kysely (escape hatch)
- [ ] TenantOrmContext interface
  - extends OrmContext
  - tenant: string (readonly)
- [ ] :red_circle: [HIGH] Schema name validation
  - Identifier pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/
  - Max length: 63 (PostgreSQL)
  - InvalidIdentifierError on failure
- [ ] Integration with Kysely db.withSchema()

### ADAPTER-003: SQL Compilation

- [ ] :red_circle: [HIGH] PlanReport → Kysely query builder
- [ ] SELECT clause generation
- [ ] FROM clause with alias (t0)
- [ ] WHERE clause from WhereIntent
  - :red_circle: [HIGH] EXISTS subquery generation (Q1)
- [ ] JOIN generation
  - LEFT vs INNER based on plan decisions
- [ ] :red_circle: [HIGH] CTE generation (Q2)
  - WITH clause from plan.ctes
  - Reference CTEs in main query
- [ ] ORDER BY generation
- [ ] LIMIT/OFFSET generation
- [ ] Parameter binding

### ADAPTER-004: Query Execution

- [ ] QueryBuilder.execute() → Promise<T[]>
- [ ] QueryBuilder.findFirst() → Promise<T | undefined>
- [ ] QueryBuilder.findFirstOrThrow() → Promise<T>
- [ ] QueryBuilder.findMany() → Promise<T[]>
- [ ] Result mapping to typed objects

### Testing

- [ ] Q1 SQL snapshot test (EXISTS)
- [ ] Q2 SQL snapshot test (CTE + ratio)
- [ ] Q4 multi-tenant SQL snapshot
- [ ] Determinism test (same input → same output)

---

## Pending - P1

### Enhanced Observability

- [ ] explain() method
  - explain(options?: { analyze?: boolean }): Promise<ExplainResult>
  - ExplainResult: { plan, executionTime?, rowsReturned? }
- [ ] Structured logging
  - Correlation ID propagation
  - Query timing
- [ ] Parameter redaction
  - dump.meta.redactedParams for safe logging

---

## Pending - P2

### Multi-dialect Capabilities

- [ ] DialectCapabilities interface
  - supportsCTE, supportsExplain, supportsWithSchema
  - supportsLateralJson, supportsTransactionalDdl
  - supportsReturning, supportsNullsFirstLast
- [ ] PostgreSQL capability profile (baseline)
  - All capabilities: true
- [ ] MySQL capability profile
  - supportsWithSchema: false (uses database switching)
  - supportsLateralJson: false
- [ ] SQLite capability profile
  - supportsWithSchema: false
  - supportsReturning: false (until 3.35)
- [ ] Capability-gated strategy selection
  - if (caps.supportsLateralJson) use lateral-json-agg
  - else use separate-queries
- [ ] Cross-dialect acceptance test suite

---

## Completed

(none)

## Blocked / Deferred

(none)

---

## Golden Tests Owned by Adapter

| Test | Component | SQL Snapshot |
|------|-----------|--------------|
| Q1 | EXISTS subquery | SELECT ... WHERE EXISTS (...) |
| Q2 | CTE + ratio | WITH ... SELECT ... COUNT(DISTINCT) / NULLIF(...) |
| Q4 | Multi-tenant | SELECT ... FROM "schema"."table" |

## Kysely Plugin Gotcha

If implementing plugins with state:

```typescript
// BAD: Memory leak
const stateMap = new Map<string, State>();

// GOOD: Auto-cleanup
const stateMap = new WeakMap<object, State>();
```

## Open Questions

- [x] Transaction boundary handling? → **Defer to Kysely (user manages)**
- [x] Connection pooling? → **Defer to Kysely**
- [ ] Streaming/cursor support? → **P2 or later**
