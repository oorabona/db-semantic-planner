# ARCH-002 v2: Codegen-First "One Ring" Architecture

> **Status:** APPROVED  
> **Created:** 2026-01-10  
> **Updated:** 2026-01-10 (v2 - pivot to codegen-first)  
> **Type:** Architecture  
> **Scope:** core, CLI, adapters

## Executive Summary

**v2 Pivot:** Transform db-semantic-planner from a runtime-introspection ORM wrapper into a **codegen-first schema platform** where `dbsp.schema.ts` is the Source of Truth, generating typed adapters for Kysely/Drizzle/Prisma.

## Why v2? (Lessons from v1 ideation)

| v1 Problem | v2 Solution |
|------------|-------------|
| Runtime introspection = cold start penalty | Build-time codegen = zero runtime cost |
| Types = `unknown` (no TS inference from DB) | Full TS types (generated) |
| Competes with Drizzle/Prisma as "another ORM" | Becomes SoT, projects TO adapters |
| Drift between code and DB undetected | `dbsp verify` for drift detection |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SOURCE OF TRUTH                                  │
│                                                                         │
│  dbsp.schema.ts                                                         │
│  ├── tables: { users, posts, categories, ... }                          │
│  ├── relations: { 'posts.author': { ... }, ... }                        │
│  ├── hints: { defaultStrategy, cardinality, ... }                       │
│  └── conventions: { fkPattern, pluralize, ... }                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                          ┌─────────┴─────────┐
                          │   dbsp generate   │
                          └─────────┬─────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐          ┌───────────────┐          ┌───────────────┐
│ kysely/       │          │ drizzle/      │          │ manifest/     │
│ ├── DB.ts     │          │ ├── schema.ts │          │ ├── schema.ts │
│ └── types.ts  │          │ └── types.ts  │          │ └── model.ts  │
└───────────────┘          └───────────────┘          └───────────────┘
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           RUNTIME                                       │
│                                                                         │
│  import { DB } from './generated/kysely/DB'                             │
│  import { schema } from './generated/manifest/schema'                   │
│  import { createOrm } from 'db-semantic-planner/kysely'                 │
│                                                                         │
│  const orm = createOrm({ db, schema })  // ✅ Full types, no DB call    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Principles

| Principle | Description |
|-----------|-------------|
| **SoT = dbsp.schema.ts** | Single source of truth for schema + relations + hints |
| **Codegen, not runtime** | Types and adapters generated at build time |
| **Adapters are targets** | Kysely/Drizzle/Prisma are compilation targets, not wrappers |
| **Drift detection** | `dbsp verify` compares SoT vs real DB |
| **Zero runtime overhead** | No introspection in prod, schema is pre-compiled |

## CLI Commands

### `dbsp generate <target>`

Generate typed code for a specific adapter.

```bash
# Generate Kysely types + DB interface
dbsp generate kysely --out ./generated/kysely

# Generate Drizzle schema
dbsp generate drizzle --out ./generated/drizzle

# Generate internal manifest (ModelIR)
dbsp generate manifest --out ./generated/dbsp
```

### `dbsp verify`

Drift detection: compare SoT vs real database.

```bash
dbsp verify --db postgres://user:pass@localhost/mydb

# Output:
# ✅ Schema matches database
# ⚠️  Extra column: users.avatar (in DB, not in schema)
# ❌ Type mismatch: posts.views (schema: number, DB: bigint)
# ❌ Missing table: audit_logs (in schema, not in DB)
```

### `dbsp import <source>`

Import existing schema to bootstrap SoT.

```bash
# From Drizzle schema
dbsp import drizzle ./src/db/schema.ts

# From Prisma schema
dbsp import prisma ./prisma/schema.prisma

# From Kysely types (limited - types only, no relations)
dbsp import kysely ./src/db/types.ts

# From live database (introspection)
dbsp import db postgres://user:pass@localhost/mydb
```

## Schema Definition (SoT)

```typescript
// dbsp.schema.ts
import { defineSchema, type Schema } from 'db-semantic-planner/schema';

export const schema = defineSchema({
  // Tables with full column definitions
  tables: {
    users: {
      id: { type: 'uuid', primaryKey: true },
      name: { type: 'string', nullable: false },
      email: { type: 'string', nullable: false, unique: true },
      createdAt: { type: 'timestamp', default: 'now()' },
    },
    posts: {
      id: { type: 'uuid', primaryKey: true },
      title: { type: 'string', nullable: false },
      content: { type: 'text', nullable: true },
      authorId: { type: 'uuid', nullable: false },
      editorId: { type: 'uuid', nullable: true },
      publishedAt: { type: 'timestamp', nullable: true },
    },
    categories: {
      id: { type: 'uuid', primaryKey: true },
      name: { type: 'string', nullable: false },
      parentId: { type: 'uuid', nullable: true }, // self-referential
    },
    post_categories: {
      postId: { type: 'uuid', nullable: false },
      categoryId: { type: 'uuid', nullable: false },
      // M:N junction - will be auto-detected
    },
  },

  // Explicit relations (override conventions if needed)
  relations: {
    // Disambiguation: two FKs to same table
    'posts.author': { target: 'users', foreignKey: 'authorId' },
    'posts.editor': { target: 'users', foreignKey: 'editorId' },
    'users.authoredPosts': { target: 'posts', foreignKey: 'authorId' },
    'users.editedPosts': { target: 'posts', foreignKey: 'editorId' },
    
    // Self-referential
    'categories.parent': { target: 'categories', foreignKey: 'parentId' },
    'categories.children': { target: 'categories', foreignKey: 'parentId' },
  },

  // Planner hints
  hints: {
    'posts.comments': { defaultStrategy: 'exists' },
    'users.posts': { cardinality: 'many' },
  },

  // Convention config
  conventions: {
    fkPattern: '{singular}Id',
    pluralize: true,
    timestamps: ['createdAt', 'updatedAt'],
  },
});

export type AppSchema = typeof schema;
```

## Runtime Usage

```typescript
// app.ts
import { Kysely, PostgresDialect } from 'kysely';
import { createOrm } from 'db-semantic-planner/kysely';
import { DB } from './generated/kysely/DB';
import { schema } from './generated/dbsp/schema';

// Kysely instance with full types
const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

// ORM with schema (SYNC - no await needed, no DB introspection)
const orm = createOrm({ db, schema });  // ✅ Sync - no I/O at startup

// Full type inference!
const posts = await orm
  .select('posts')
  .columns(['id', 'title'])  // ✅ Autocomplete
  .include('author')          // ✅ Relation known
  .where(eq('publishedAt', isNotNull()))
  .all();
// posts: { id: string, title: string, author: User }[]
```

## Modes of Operation

### Mode A: Greenfield (SoT)

New project, db-semantic-planner owns the schema.

```bash
# 1. Define schema
vim dbsp.schema.ts

# 2. Generate adapters
dbsp generate kysely
dbsp generate manifest

# 3. Use in code
import { schema } from './generated/dbsp/schema'

# 4. (Optional) Generate migrations via drizzle-kit
dbsp generate drizzle
drizzle-kit generate
```

### Mode B: Adoption (Import)

Existing project with Drizzle/Prisma schema.

```bash
# 1. Import existing schema
dbsp import drizzle ./src/db/schema.ts

# 2. Enhance with relations/hints
vim dbsp.schema.ts  # Add semantic layer

# 3. Generate manifest
dbsp generate manifest

# 4. Use ORM
```

### Mode C: Quickstart (Runtime - discouraged)

For prototyping only. NOT recommended for production.

```typescript
// ⚠️ Types will be unknown/any
// ⚠️ Cold start penalty
const orm = await createOrm({ 
  db, 
  introspect: true  // Runtime introspection
});
```

## M:N Relations

### Auto-detected (pure junction)

```typescript
// Table with ONLY FK columns + metadata
post_categories: {
  postId: { type: 'uuid' },
  categoryId: { type: 'uuid' },
  // Auto-detected as M:N: posts ↔ categories
}
```

### Explicit (junction with attributes)

```typescript
// Table with FK columns + business attributes
order_items: {
  orderId: { type: 'uuid' },
  productId: { type: 'uuid' },
  quantity: { type: 'integer' },  // ← Business attribute
  unitPrice: { type: 'decimal' },  // ← Business attribute
}

// NOT auto-detected as M:N - treated as entity
// Must declare relations explicitly:
relations: {
  'orders.items': { target: 'order_items', foreignKey: 'orderId' },
  'order_items.order': { target: 'orders', foreignKey: 'orderId' },
  'order_items.product': { target: 'products', foreignKey: 'productId' },
}
```

## Package Structure

```
db-semantic-planner/
├── packages/
│   ├── core/                    # INTERNAL (not published separately)
│   │   ├── src/
│   │   │   ├── model-ir.ts      # Schema types
│   │   │   ├── intent-ast.ts    # Query intent types
│   │   │   ├── planner.ts       # Query planning
│   │   │   └── dx/              # Helpers (eq, gt, etc.)
│   │   └── package.json         # private: true
│   │
│   ├── schema/                  # Schema definition DSL
│   │   ├── src/
│   │   │   ├── define.ts        # defineSchema()
│   │   │   ├── types.ts         # Column types, relation types
│   │   │   └── conventions.ts   # FK pattern matching
│   │   └── package.json
│   │
│   ├── cli/                     # dbsp CLI
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── generate.ts  # dbsp generate
│   │   │   │   ├── verify.ts    # dbsp verify
│   │   │   │   └── import.ts    # dbsp import
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── kysely/                  # Kysely adapter
│   │   ├── src/
│   │   │   ├── index.ts         # createOrm, helpers
│   │   │   ├── compiler.ts      # Intent → Kysely SQL
│   │   │   └── generator.ts     # Generate DB interface
│   │   └── package.json
│   │
│   └── drizzle/                 # Drizzle adapter (future)
│       └── ...
```

## MVP Blocks (Revised)

| # | Block | Description | Effort |
|---|-------|-------------|--------|
| 1 | Schema DSL | `defineSchema()` with tables, relations, hints | M |
| 2 | Convention inference | FK detection, M:N auto-detection | S |
| 3 | CLI scaffold | `dbsp` binary with commander/citty | S |
| 4 | `dbsp generate manifest` | Schema → ModelIR manifest | M |
| 5 | `dbsp generate kysely` | Schema → Kysely DB interface | M |
| 6 | Kysely adapter refactor | Use generated schema, remove runtime introspect | M |
| 7 | `dbsp verify` | Compare schema vs real DB | M |
| 8 | Update tests | All existing tests use new API | L |

## Future Blocks (Post-MVP)

| # | Block | Description |
|---|-------|-------------|
| 9 | `dbsp import drizzle` | Import Drizzle schema |
| 10 | `dbsp import prisma` | Import Prisma schema |
| 11 | `dbsp import db` | Introspect DB to bootstrap schema |
| 12 | `dbsp generate drizzle` | Generate Drizzle schema |
| 13 | Prisma adapter | $queryRaw compilation |

## Success Criteria

1. **Zero runtime introspection** in production
2. **Full TypeScript types** from schema to query results
3. **Drift detection** catches schema/DB mismatches in CI
4. **Adoption path** for existing Drizzle/Prisma projects
5. **All existing tests pass** with new API

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CLI complexity | Use proven libs (commander, citty) |
| Competing with Drizzle/Prisma | Position as "semantic layer on top", not replacement |
| Schema definition verbosity | Good defaults + conventions |
| Adoption friction | `dbsp import` for existing projects |

## References

- [ADR-002: Merge DX into Core](../adrs/ADR-002-merge-dx-into-core.md)
- [ARCH-001: Dialect-Agnostic Architecture](../specs/ARCH-001-dialect-agnostic-recursive.md)
- Drizzle schema philosophy: https://orm.drizzle.team/docs/sql-schema-declaration
- Prisma introspection: https://www.prisma.io/docs/concepts/components/introspection
