# db-semantic-planner

Semantic query planning for databases. An intent-first approach that transforms declarative query intents into optimized SQL with full observability.

## Features

- **Intent-first queries** - Describe what you want, not how to get it
- **Semantic planning** - Automatic EXISTS vs JOIN decisions based on cardinality
- **CTE extraction** - Common subqueries automatically optimized
- **Multi-tenant** - Schema-per-tenant with `forTenant()` API
- **Full observability** - Inspect plans, SQL, and parameters before execution
- **Type-safe** - Full TypeScript support with strict types
- **CLI tools** - Generate types, verify schemas, interactive REPL

## Installation

```bash
# Core packages
pnpm add @db-semantic-planner/core @db-semantic-planner/adapter-kysely

# Schema definition (optional, for codegen workflow)
pnpm add @db-semantic-planner/schema

# CLI (optional, for code generation and REPL)
pnpm add -D @db-semantic-planner/cli
```

## Quick Start

### Option A: Codegen Workflow (Recommended)

#### 1. Define your schema (`dbsp.schema.ts`)

```typescript
import { defineSchema } from '@db-semantic-planner/schema';

// Simple: Tables only (relations auto-inferred from FK references)
const schema = defineSchema({
  users: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    email: { type: 'string' },
    createdAt: { type: 'datetime' },
  },
  posts: {
    id: { type: 'integer', primaryKey: true },
    title: { type: 'string' },
    content: { type: 'string', nullable: true },
    authorId: { type: 'integer', references: { table: 'users' } },
    published: { type: 'boolean' },
  },
});

// With explicit relations (for complex cases like many-to-many)
const schemaWithRelations = defineSchema(
  {
    users: {
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string' },
    },
    roles: {
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string' },
    },
    user_roles: {
      userId: { type: 'integer', references: { table: 'users' } },
      roleId: { type: 'integer', references: { table: 'roles' } },
    },
  },
  {
    relations: {
      'users.roles': { kind: 'manyToMany', target: 'roles', through: 'user_roles' },
      'roles.users': { kind: 'manyToMany', target: 'users', through: 'user_roles' },
    },
  }
);

export default schema;
```

#### 2. Generate Kysely types

```bash
# Generate typed database interface
npx dbsp generate kysely --schema ./dbsp.schema.ts --output ./src/generated
```

This generates two files:

```typescript
// src/generated/types.ts
import type { Generated, ColumnType } from 'kysely';

export interface UsersTable {
  id: Generated<number>;
  name: string;
  email: string;
  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PostsTable {
  id: Generated<number>;
  title: string;
  content: string | null;
  authorId: number;
  published: Generated<boolean>;
}
```

```typescript
// src/generated/DB.ts
import type { UsersTable, PostsTable } from './types.js';

export interface DB {
  users: UsersTable;
  posts: PostsTable;
}
```

#### 3. Use with the ORM

```typescript
import { createOrm, eq } from '@db-semantic-planner/core';
import { createKyselyAdapter } from '@db-semantic-planner/adapter-kysely';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './generated/DB.js';

const kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const orm = createOrm({
  schema,  // Schema from @db-semantic-planner/schema
  adapter: createKyselyAdapter(kysely),
});

// Type-safe queries
const activeUsers = await orm
  .select('users')
  .where(eq('email', 'user@example.com'))
  .all();

// With relations
const postsWithAuthors = await orm
  .select('posts')
  .where(eq('published', true))
  .include('author')
  .all();
```

### Option B: Manual Schema Definition

```typescript
import { createOrm, eq } from '@db-semantic-planner/core';
import { createKyselyAdapter } from '@db-semantic-planner/adapter-kysely';

// Low-level ModelIR format (advanced users only)
const model = {
  tables: {
    users: {
      name: 'users',
      columns: [
        { name: 'id', type: 'number', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'email', type: 'string' },
      ],
    },
    posts: {
      name: 'posts',
      columns: [
        { name: 'id', type: 'number', primaryKey: true },
        { name: 'title', type: 'string' },
        { name: 'authorId', type: 'number' },
      ],
      foreignKeys: [{ column: 'authorId', references: { table: 'users', column: 'id' } }],
    },
  },
  relations: {
    users: { posts: { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' } },
    posts: { author: { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' } },
  },
};

const orm = createOrm({
  model,
  adapter: createKyselyAdapter(kysely),
});
```

---

## CLI Usage

The CLI provides tools for code generation, schema verification, and interactive exploration.

### Installation

```bash
# As dev dependency (recommended)
pnpm add -D @db-semantic-planner/cli

# Or globally
npm install -g @db-semantic-planner/cli
```

### Running the CLI

```bash
# Via npx (if installed as dependency)
npx dbsp <command>

# Via pnpm (in monorepo development)
pnpm dbsp <command>

# Via global install
dbsp <command>
```

### Commands

#### `dbsp generate kysely`

Generate Kysely type definitions from your schema.

```bash
dbsp generate kysely --schema ./dbsp.schema.ts --output ./src/generated
```

Generates:
- `DB.ts` - Main database interface
- `types.ts` - Table type definitions

Options:
- `-s, --schema <path>` - Path to schema file (default: auto-detect `dbsp.schema.ts`)
- `-o, --output <dir>` - Output directory (default: `./generated/kysely`)

#### `dbsp generate manifest`

Generate a JSON manifest of your schema (useful for tooling/MCP). Outputs JSON format.

```bash
dbsp generate manifest --schema ./dbsp.schema.ts --output ./generated
```

Generates `schema.json` in the output directory.

The manifest is a JSON file containing the resolved schema structure:

```json
{
  "tables": { "users": { ... }, "posts": { ... } },
  "relations": { "users.posts": { ... }, "posts.author": { ... } },
  "hints": {},
  "conventions": { "fkPattern": "{table}Id", "pluralize": true, "timestamps": [] }
}
```

#### `dbsp verify`

Compare your schema against a real database for drift detection.

```bash
dbsp verify --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb
```

Options:
- `-s, --schema <path>` - Path to schema file
- `-d, --db <url>` - Database connection URL (required)
- `--schema-name <name>` - Database schema name (default: `public`)
- `--json` - Output as JSON (for CI integration)

Example output:
```
🔍 Verifying schema: dbsp.schema.ts
   Database: postgres://user:***@localhost/mydb

✅ Schema is valid - no drift detected

Tables: 5 matched
Columns: 23 matched
```

#### `dbsp repl`

Interactive REPL for testing queries without a database connection.

```bash
# Basic REPL
dbsp repl --schema ./dbsp.schema.ts
```

Options:
- `-s, --schema <path>` - Path to schema file (auto-detected if not specified)

##### REPL Features

**Natural query syntax:**
```
> users
> users where active = true
> posts where authorId = 1 include author
> users limit 10 offset 20
```

**Dot commands:**
```
> .help              # Show all commands
> .tables            # List all tables
> .schema users      # Show table schema
> .relations posts   # Show table relations
> .clear             # Clear screen
> .exit              # Exit REPL (or .quit)
```

**Output:**
- SQL query generated
- Query plan with decisions
- Parameter bindings

**Features:**
- Tab completion for tables, relations, columns, and operators
- Command history (persisted to `~/.dbsp_history`)
- Up/Down arrows to navigate history
- Split view mode (toggle with `.split` command) for schema reference

---

## Multi-tenant Queries

```typescript
// Schema-per-tenant isolation
const tenantOrm = orm.forTenant('acme_corp');

const users = await tenantOrm.select('users').all();
// SQL: SELECT * FROM "acme_corp"."users"
```

---

## Observability

Every query provides full observability via `dump()`:

```typescript
const query = orm.select('users').where(eq('active', true));

const dump = query.dump();
console.log(dump.sql);      // SELECT * FROM "users" WHERE "active" = $1
console.log(dump.params);   // [true]
console.log(dump.plan);     // { decisions: [...], warnings: [...] }
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        @db-semantic-planner/cli                  │
│  dbsp generate | dbsp verify | dbsp repl                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│                              ▼                                   │
│  @db-semantic-planner/schema                                     │
│  defineSchema() → GeneratedSchema                                │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│                              ▼                                   │
│  @db-semantic-planner/core                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner       │  │
│  │  (Schema)   │→→│  (Query)    │→→│  (Plan + Decisions)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  DX Layer: createOrm(), eq(), include(), etc.           │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ implements Adapter
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  @db-semantic-planner/adapter-kysely                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  SQL Compiler (PlanReport → Kysely CompiledQuery)       │    │
│  │  KyselyAdapter, MockAdapter (for REPL/testing)          │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@db-semantic-planner/schema` | Schema DSL (`defineSchema()`) |
| `@db-semantic-planner/core` | Query intents, semantic planning, ORM API |
| `@db-semantic-planner/adapter-kysely` | SQL compilation via Kysely |
| `@db-semantic-planner/cli` | CLI tools (generate, verify, repl) |

## API Reference

### Schema Package

| Export | Description |
|--------|-------------|
| `defineSchema()` | Create a schema with tables, columns, and auto-inferred relations |

### Core Package

| Export | Description |
|--------|-------------|
| `createOrm()` | Create an ORM instance with adapter |
| `eq()`, `neq()`, `gt()`, `gte()`, `lt()`, `lte()` | Comparison filters |
| `like()`, `ilike()` | Pattern matching filters |
| `isNull()`, `isNotNull()` | Null checks |
| `inArray()` | Array membership |
| `and()`, `or()`, `not()` | Logical operators |
| `exists()`, `notExists()` | Subquery existence checks |

### Adapter Package

| Export | Description |
|--------|-------------|
| `createKyselyAdapter()` | Create adapter for Kysely instance |
| `createMockAdapter()` | Create compile-only adapter (no DB required) |

## Planner Decisions

The semantic planner automatically makes optimization decisions:

| Decision | Options | Criteria |
|----------|---------|----------|
| `filter-strategy` | `exists`, `join` | Cardinality (to-many → EXISTS) |
| `include-strategy` | `join`, `separate` | Cardinality and query complexity |
| `cte-extraction` | extract, inline | Access count (≥2 → CTE) |

## Examples

Ready-to-use example schemas in the `examples/` directory:

| File | Description | Complexity |
|------|-------------|------------|
| `minimal.schema.ts` | Users + Posts | Beginner |
| `blog.schema.ts` | Authors, Posts, Comments, Tags | Intermediate |
| `ecommerce.schema.ts` | Products, Categories, Orders | Advanced |

**Quick test:**

```bash
# Generate Kysely types from minimal schema
pnpm dbsp generate kysely --schema ./examples/minimal.schema.ts

# Start REPL with blog schema
pnpm dbsp repl --schema ./examples/blog.schema.ts
```

See [examples/QUICKSTART.md](examples/QUICKSTART.md) for detailed usage guide.

---

## Development

```bash
# Clone and install
git clone https://github.com/your-org/db-semantic-planner
cd db-semantic-planner
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Run CLI in development
pnpm dbsp repl --schema ./path/to/schema.ts

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## Status

**✅ v1.0 Ready** - 1300+ tests passing

- Schema: DSL with convention inference (54 tests)
- Core: ModelIR, IntentAST, Semantic Planner, DX Layer (543 tests)
- Adapter: SQL Compiler, Multi-tenant, Observability, Multi-dialect (628 tests)
- CLI: Generate, Verify, REPL (106 tests)
- E2E: PostgreSQL integration (Testcontainers)

## License

MIT
