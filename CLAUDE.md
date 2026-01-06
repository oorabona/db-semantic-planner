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

## Architecture: Ports & Adapters

```
┌─────────────────────────────────────────────────────────────────┐
│                        packages/core                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner       │  │
│  │  (Schema)   │→→│  (Query)    │→→│  (Plan + PlanReport)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                 │
│  ⚠️  DB-AGNOSTIC: MUST NOT import adapter code                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ depends on
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    packages/adapter-kysely                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Compiler   │  │  Engine     │  │  Multi-tenant           │  │
│  │  (SQL gen)  │  │  (Kysely)   │  │  (orm.forTenant)        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                 │
│  PostgreSQL-first (MVP) • Multi-dialect via capabilities (P2)  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ depends on
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        packages/dx                              │
│  ┌─────────────────────────┐  ┌───────────────────────────────┐ │
│  │  Ambiguity Handling     │  │  Compat Layer (Drizzle-like)  │ │
│  │  (Strict mode + Override)│  │  (eq/and/or, findMany/First) │ │
│  └─────────────────────────┘  └───────────────────────────────┘ │
│                                                                 │
│  Phase: P1 (after MVP)                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Dependency Rules (STRICT)

| Package | May Import | Must NOT Import |
|---------|------------|-----------------|
| `packages/core` | Nothing | `adapter-kysely`, `dx` |
| `packages/adapter-kysely` | `core` | `dx` |
| `packages/dx` | `core`, `adapter-kysely` | - |

### Enforcing Architecture (Recommended)

**Option 1: TSConfig Project References**

```jsonc
// packages/core/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "paths": {}  // No paths to adapter/dx
  }
}

// packages/adapter-kysely/tsconfig.json
{
  "references": [{ "path": "../core" }],
  "compilerOptions": {
    "paths": {
      "@db-semantic-planner/core": ["../core/src"]
    }
    // No path to dx
  }
}

// packages/dx/tsconfig.json
{
  "references": [
    { "path": "../core" },
    { "path": "../adapter-kysely" }
  ]
}
```

**Option 2: ESLint no-restricted-imports**

```javascript
// packages/core/.eslintrc.js
module.exports = {
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        '@db-semantic-planner/adapter-*',
        '@db-semantic-planner/dx',
        '../adapter-*',
        '../dx'
      ]
    }]
  }
};
```

**Option 3: Dependency Cruiser**

```javascript
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: 'core-no-adapter',
      from: { path: 'packages/core' },
      to: { path: 'packages/adapter-' }
    },
    {
      name: 'core-no-dx',
      from: { path: 'packages/core' },
      to: { path: 'packages/dx' }
    },
    {
      name: 'adapter-no-dx',
      from: { path: 'packages/adapter-' },
      to: { path: 'packages/dx' }
    }
  ]
};
```

**CI Integration:** Add architecture check to CI pipeline to prevent violations.

## Scopes

| Scope | Package | Description | Phase |
|-------|---------|-------------|-------|
| `core` | `packages/core` | Schema (ModelIR), Query AST, Semantic planner | MVP |
| `adapter` | `packages/adapter-kysely` | SQL compiler, Kysely engine, multi-tenant, observability | MVP |
| `dx` | `packages/dx` | Ambiguity handling, Drizzle-like compat layer | P1 |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js (ESM preferred) |
| Primary DB | PostgreSQL (MVP) |
| Adapter | Kysely (peer dependency) |
| Testing | Vitest |
| Build | tsup (ESM + CJS) |

## Multi-tenant API

**Public API:** `orm.forTenant(schemaName)`

```typescript
// Returns a tenant-scoped context
const tenantOrm = orm.forTenant('tenant_123');
const users = await tenantOrm.query(User).findMany();
// Under the hood: Kysely db.withSchema('tenant_123')
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
    tenant?: string;      // Schema name if multi-tenant
    queryName?: string;   // Optional label
    correlationId?: string;
  };
};
```

## Documentation

- **Index:** `docs/DOCUMENTATION_INDEX.md`
- **Specs:** `docs/specs/` (implementation-ready specifications)
- **Backlogs:** `TODO.md`, `TODO_CORE.md`, `TODO_ADAPTER.md`, `TODO_DX.md`
- **Scope indexes:** `docs/scopes/DOCS_<SCOPE>_INDEX.md`

## Build Order

```
packages/core → packages/adapter-kysely → packages/dx
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

## MVP Non-Goals

- No cost-based optimization or join reordering
- No runtime schema introspection
- No NL-to-SQL / AI query generation
- No full ORM behavior (change tracking, dirty checking, migrations)
- No multi-dialect correctness guarantees (PostgreSQL-only for MVP)
