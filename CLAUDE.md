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
- **Native Adapter APIs:** ALWAYS use adapter primitives (parameterized queries, AST-based compilation), NEVER raw SQL templates except for explicit user escape hatches (see Adapter Rules below)

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
│  DB-AGNOSTIC: MUST NOT import adapter code                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ implements Adapter
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    packages/adapter-pgsql                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Compiler   │  │ PgsqlAdapter│  │  PostgreSQL-native       │  │
│  │  (SQL gen)  │  │  (Engine)   │  │  (pg Pool)              │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                 │
│  PostgreSQL-native • No ORM dependency • Direct pg Pool         │
└─────────────────────────────────────────────────────────────────┘
```

### API Pattern

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

// Create ORM with adapter injection
const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(pgPool)
});

// Query with type-safe API
const users = await orm.select('users').where(eq('active', true)).all();
```

### Dependency Rules (STRICT)

| Package | May Import | Must NOT Import |
|---------|------------|-----------------|
| `packages/core` | Nothing | `adapter-pgsql` |
| `packages/adapter-pgsql` | `core` | - |

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

// packages/adapter-pgsql/tsconfig.json
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
| `core` | `packages/core` | Schema, Query AST, Planner, DX layer, Adapter interface | Complete |
| `adapter` | `packages/adapter-pgsql` | SQL compiler, PgsqlAdapter, PostgreSQL-native | Complete |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js (ESM preferred) |
| Primary DB | PostgreSQL |
| Adapter | pg (PostgreSQL native) |
| Testing | Vitest |
| Build | tsup (ESM + CJS) |

## Adapter Rules (CRITICAL)

**NEVER use raw SQL templates in adapter implementations.** Always use the adapter's native expression builders.

### PostgreSQL Adapter (`packages/adapter-pgsql`)

The adapter compiles `PlanReport` into parameterized SQL strings using an internal AST-to-SQL compiler. No ORM dependency — queries execute directly against a `pg.Pool`.

| Principle | Detail |
|-----------|--------|
| Parameterized queries | All user values use `$N` positional parameters |
| Identifier quoting | All table/column/schema names double-quoted |
| No raw SQL in compiler | The compiler builds SQL strings from the plan AST |

### Compile-Only Mode

For CLI/tooling that needs SQL compilation without a database connection:

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlCompileOnlyAdapter();
const orm = createOrm({ schema: db, adapter });
const { sql, params } = orm.select('users').where(eq('active', true)).dump();
// sql, params — no Pool needed
```

## Schema Scoping API

**Public API:** `orm.withSchema(schemaName)`

```typescript
// Returns a schema-scoped ORM context
const scopedOrm = orm.withSchema('tenant_123');
const users = await scopedOrm.select('users').all();
// SQL: SELECT * FROM "tenant_123"."users"
```

**Security:** Schema name MUST be validated against allow-list pattern (identifier validation).

## DDL Features

The PostgreSQL adapter supports the following DDL schema features via `compareSchemata()` and `generateDDL()`:

- Tables, columns, types (enums, sequences), extensions
- Indexes, check constraints, foreign keys, comments
- **Row-Level Security (RLS):** `rlsEnabled` + `policies[]` on TableIR — see `docs/guides/how-to-use-rls-policies.md`
- Feature support is gated by `DialectCapabilities` flags (e.g. `supportsDDLRowLevelSecurity`)

### Runtime DDL Helpers (`orm.tables.<name>`)

| Method | Description |
|--------|-------------|
| `.truncate(options?)` | TRUNCATE TABLE — options: `{ cascade?, restartIdentity? }` |
| `.vacuum(options?)` | VACUUM — options: `{ full?, analyze? }` |
| `.storageSize()` | Returns total table size in bytes (`pg_total_relation_size`) |
| `.alterColumn(col, options)` | ALTER COLUMN — options: `{ type?, using?, setNotNull?, setDefault?, dropDefault? }` |
| `.indexes.create(options)` | CREATE INDEX — supports all methods: btree, gin, hnsw, bm25, etc. |
| `.indexes.drop(name, options?)` | DROP INDEX — options: `{ ifExists?, cascade?, concurrently?, schema? }` |
| `.indexes.list(options?)` | List indexes — options: `{ namePattern? }` → `IndexInfo[]` |
| `.indexes.exists(name)` | Returns `boolean` — whether index exists on this table |
| `orm.ddl.dropIndex(name, options?)` | Global shortcut — drop by name without a table reference |

All helpers respect `orm.withSchema()`. See `docs/guides/how-to-use-ddl-helpers.md`.

## Query Features

| Feature | API | Example |
|---------|-----|---------|
| Expression primitives | `op()`, `fn()`, `ref()`, `param()`, `cast()`, `literal()`, `unary()`, `namedArg()` | `op('<=>', ref('vector'), cast(param(qv), 'vector'))` |
| pgvector | `cosineDistance()`, `rawDistance()`, `l2Distance()`, `innerProduct()` | `cosineDistance('vector', qv).as('score')` |
| ParadeDB (low-level) | `score()`, `bm25Search()`, `parse()`, `boost()`, `booleanSearch()` | `bm25Search('s', term, { name: 3.0 })` |
| Full-text search | `fullTextSearch()`, `textScore()` | `fullTextSearch({ query, fields, tableAlias })` — preferred over `bm25Search`; see `docs/guides/how-to-use-full-text-search.md` |
| PG builtins | `generateSeries()`, `nextval()`, `isDistinctFrom()` | `generateSeries(1, 100)`, `nextval('seq')` |
| INNER JOIN | `include('rel', { join: 'inner' })` | Filters root rows by relation |
| Manual JOIN | `.join(rel)` / `.join(table, { on, as, type })` — flat, non-hydrating | `orm.select('calls').join('caller')` / `.join('t', { on: eq(...), as: 'alias' })` |
| DISTINCT ON | `.distinctOn('col1', 'col2')` | PostgreSQL DISTINCT ON |
| Set operations | `.union()`, `.unionAll()`, `.intersect()`, `.except()` | `q1.union(q2).all()` |
| IN subquery (= ANY) | `inSubquery('id', subquery('posts').select('userId'))` | Compiled as `col = ANY (SELECT ...)` |
| Scalar subquery | `subquery('t').count().asExpr('cnt')` | Subquery as SELECT column |
| Param type casting | Automatic `CAST($N AS type)` via ModelIR `originalDbType` | Prevents nullable column type mismatch |
| CASE expressions | `caseWhen().when(cond, val).when(...).else(val).as(alias)` — in columns + orderBy | `caseWhen<string>().when("status='a'", 'Active').else('Other').as('label')` |
| Guides | `docs/guides/how-to-use-expression-primitives.md`, `docs/guides/how-to-use-extensions.md`, `docs/guides/how-to-use-rls-policies.md`, `docs/guides/how-to-use-case-expressions.md`, `docs/guides/how-to-use-ddl-helpers.md`, `docs/guides/how-to-use-joins.md`, `docs/guides/how-to-use-recursive-cte.md`, `docs/guides/how-to-use-batch-values.md`, `docs/guides/how-to-use-full-text-search.md`, `docs/guides/how-to-use-schema-versioning.md`, `docs/guides/how-to-understand-result-hydration.md` | |

## Observability

Every query produces a `Dump`:

```typescript
type Dump = {
  plan: PlanReport;      // Decisions + reasoning + warnings
  sql: string;           // Compiled SQL
  params: readonly unknown[]; // Bound parameters
  meta?: {
    schema?: string;      // Schema name if schema-scoped
    queryName?: string;   // Optional label
    correlationId?: string;
  };
};
```

## Documentation

- **How-to guides:** `docs/guides/` — feature-specific walkthroughs (joins, CTEs, RLS, DDL helpers, etc.)
- **Comparison:** `docs/COMPARISON.md` — how this project compares to other query builders and ORMs
- **Patterns:** `docs/PATTERNS.md` — recommended query patterns and best practices
- **Production:** `docs/PRODUCTION.md` — deployment, connection pooling, schema scoping for multi-tenancy
- **CLI usage:** `docs/CLI_USAGE.md` — command-line interface reference

## Build Order

```
packages/core → packages/adapter-pgsql
```

## Getting Started

Install dependencies and build all packages:

```bash
pnpm install
pnpm -C packages/core build
pnpm -C packages/adapter-pgsql build
```

Run tests:

```bash
pnpm test
```

Type-check:

```bash
pnpm tsc --noEmit
```

## NFRs

- **Type safety:** Strong TypeScript types throughout
- **Zero/minimal runtime deps:** Tree-shakeable, pg as peer
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
