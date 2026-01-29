# db-semantic-planner

## Project Context

### Vision

Semantic query planning for databases - an intent-first approach that transforms declarative query intents into optimized SQL with full observability.

### Key Principles

- **Intent-first:** Declare WHAT to fetch, planner decides HOW
- **Type-safe:** Full TypeScript inference from schema to results
- **Observable:** Every decision is inspectable via dump()
- **Deterministic:** Same inputs always produce same SQL/plan
- **Secure:** Identifier validation, parameter binding, no raw SQL exposure
- **Native Adapter APIs:** ALWAYS use adapter primitives (e.g., Kysely's `eb.fn()`, `eb.ref()`, `eb.lit()`), NEVER raw SQL templates except for explicit user escape hatches (see Adapter Rules below)

## Architecture: Ports & Adapters (ARCH-001)

```
┌─────────────────────────────────────────────────────────────────┐
│                        packages/core                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner       │  │
│  │  (Schema)   │→→│  (Query)    │→→│  (Plan + PlanReport)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  DX Layer (core/src/dx/)                                │    │
│  │  • Adapter interface  • createOrm()  • Query builders   │    │
│  │  • Filter helpers     • Strict mode  • Schema scoping   │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ⚠️  DB-AGNOSTIC: MUST NOT import adapter code                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ implements Adapter
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    packages/adapter-kysely                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Compiler   │  │KyselyAdapter│  │  Multi-dialect          │  │
│  │  (SQL gen)  │  │  (Engine)   │  │  (capabilities)         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                 │
│  PostgreSQL-first • Multi-dialect via capabilities              │
└─────────────────────────────────────────────────────────────────┘
```

### API Pattern

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createKyselyAdapter } from '@dbsp/adapter-kysely';

// Create ORM with adapter injection
const orm = createOrm({
  model: schema,
  adapter: createKyselyAdapter(kyselyDb)
});

// Query with type-safe API
const users = await orm.select('users').where(eq('active', true)).all();
```

### Dependency Rules (STRICT)

| Package | May Import | Must NOT Import |
|---------|------------|-----------------|
| `packages/core` | Nothing | `adapter-kysely` |
| `packages/adapter-kysely` | `core` | - |

### Enforcing Architecture (Recommended)

**Option 1: TSConfig Project References**

```jsonc
// packages/core/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "paths": {}  // No paths to adapter
  }
}

// packages/adapter-kysely/tsconfig.json
{
  "references": [{ "path": "../core" }],
  "compilerOptions": {
    "paths": {
      "@dbsp/core": ["../core/src"]
    }
  }
}
```

**Option 2: Dependency Cruiser**

```javascript
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: 'core-no-adapter',
      from: { path: 'packages/core' },
      to: { path: 'packages/adapter-' }
    }
  ]
};
```

**CI Integration:** Add architecture check to CI pipeline to prevent violations.

## Scopes

| Scope | Package | Description | Status |
|-------|---------|-------------|--------|
| `core` | `packages/core` | Schema, Query AST, Planner, DX layer, Adapter interface | ✅ Complete |
| `adapter` | `packages/adapter-kysely` | SQL compiler, KyselyAdapter, multi-dialect | ✅ Complete |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js (ESM preferred) |
| Primary DB | PostgreSQL |
| Adapter | Kysely (peer dependency) |
| Testing | Vitest |
| Build | tsup (ESM + CJS) |

## Stack (for /generate-tests, /generate-docs)

| Category | Value | Notes |
|----------|-------|-------|
| test_framework | vitest | |
| test_pattern | *.test.ts | colocated with source |
| assertion_style | expect | vitest built-in |
| mock_style | vi.mock | vitest built-in |
| doc_style | tsdoc | @param, @returns, @example |
| package_manager | pnpm | |

**Note:** Si cette section existe, /generate-tests et /generate-docs skip la détection auto.

## Adapter Rules (CRITICAL)

**NEVER use raw SQL templates in adapter implementations.** Always use the adapter's native expression builders.

### Kysely Adapter (`packages/adapter-kysely`)

| Need | ❌ DON'T | ✅ DO |
|------|---------|-------|
| SQL function | `` sql`COALESCE(${...})` `` | `eb.fn('coalesce', [...])` |
| Column reference | `` sql.ref('table.col') `` | `eb.ref('table.col')` |
| Literal value | `` sql`1` `` | `eb.lit(1)` or `eb.val(value)` |
| Join references | `` sql.join([...]) `` | Use Kysely's native `.select()` callback |

### Exception: User Escape Hatch

The **only** allowed use of `sql` template is for `RawExpressionIntent` — the explicit user escape hatch for arbitrary SQL that cannot be expressed via the planner's intent system:

```typescript
// This is OK - it's the user's explicit escape hatch
case 'raw':
  return query.select(sql`${sql.raw(expr.sql)}`.as(expr.as));
```

### Why This Matters

1. **Type safety:** Native APIs provide better TypeScript inference
2. **Dialect portability:** Kysely adapts `eb.fn('coalesce')` per dialect; raw SQL doesn't
3. **Security:** Native APIs handle escaping; raw SQL is injection-prone
4. **Maintainability:** Easier to understand and refactor

## Schema Scoping API

**Public API:** `orm.withSchema(schemaName)`

```typescript
// Returns a schema-scoped ORM context
const scopedOrm = orm.withSchema('tenant_123');
const users = await scopedOrm.select('users').all();
// SQL: SELECT * FROM "tenant_123"."users"
```

**Security:** Schema name MUST be validated against allow-list pattern (identifier validation).

## Observability

Every query produces a `Dump`:

```typescript
type Dump = {
  plan: PlanReport;      // Decisions + reasoning + warnings
  sql: string;           // Compiled SQL (from Kysely .compile())
  params: readonly unknown[]; // Bound parameters
  meta?: {
    schema?: string;      // Schema name if schema-scoped
    queryName?: string;   // Optional label
    correlationId?: string;
  };
};
```

## Documentation

- **Index:** `docs/DOCUMENTATION_INDEX.md`
- **Specs:** `docs/specs/` (implementation-ready specifications)
- **Backlogs:** `TODO.md`, `TODO_CORE.md`, `TODO_ADAPTER.md`
- **Scope indexes:** `docs/scopes/DOCS_<SCOPE>_INDEX.md`

## Build Order

```
packages/core → packages/adapter-kysely
```

## Workflow

1. Run `/next` to see prioritized tasks
2. Run `/clarify <scope>` to detail requirements
3. Run `/spec <story-id>` to create specifications

## NFRs

- **Type safety:** Strong TypeScript types throughout
- **Zero/minimal runtime deps:** Tree-shakeable, Kysely as peer
- **Full test coverage:** Unit + integration + golden tests
- **Deterministic:** Same inputs → same SQL/plan (stable aliasing)
- **Observability:** dump() = plan + SQL + params
- **Security:** Identifier validation, param redaction in logs
- **Performance:** Anti "row explosion" defaults, minimal JS overhead

## Out of Scope

These features are intentionally deferred:

- Cost-based optimization or join reordering
- NL-to-SQL / AI query generation
- Full ORM behavior (change tracking, dirty checking, migrations)
- Multi-dialect correctness guarantees (PostgreSQL-focused)
