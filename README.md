# db-semantic-planner

Semantic query planning for databases. An intent-first approach that transforms declarative query intents into optimized SQL with full observability.

## Features

- **Intent-first queries** - Describe what you want, not how to get it
- **Semantic planning** - Automatic EXISTS vs JOIN decisions based on cardinality
- **CTE extraction** - Common subqueries automatically optimized
- **Multi-tenant** - Schema-per-tenant with `withSchema()` API
- **Full observability** - Inspect plans, SQL, and parameters before execution
- **Type-safe** - Full TypeScript support with strict types
- **CLI tools** - Generate types, verify schemas, interactive REPL

## Installation

```bash
# Core + PostgreSQL adapter
pnpm add @dbsp/core @dbsp/adapter-pgsql

# CLI (optional, for code generation and REPL)
pnpm add -D @dbsp/cli
```

## Quick Start

### Define Your Schema

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  users: {
    id: 'uuid',
    name: 'string',
    email: 'string',
    createdAt: 'datetime',
  },
  posts: {
    id: 'uuid',
    title: 'string',
    content: 'string?',
    authorId: ref('users'),
    published: 'boolean',
  },
});
```

### Create ORM and Query

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(pool),
});

// Type-safe queries
const activeUsers = await orm
  .select('users')
  .where(eq('email', 'user@example.com'))
  .all();

// With relations (auto-inferred from ref())
const postsWithAuthors = await orm
  .select('posts')
  .where(eq('published', true))
  .include('author')
  .all();
```

---

## CLI Usage

The CLI provides tools for code generation, schema verification, and interactive exploration.

### Installation

```bash
# As dev dependency (recommended)
pnpm add -D @dbsp/cli

# Or globally
npm install -g @dbsp/cli
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

#### `dbsp generate manifest`

Generate a JSON manifest of your schema (useful for tooling/MCP). Outputs JSON format.

```bash
dbsp generate manifest --schema ./dbsp.schema.ts --output ./generated
```

Generates `schema.json` in the output directory.

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

## Common Patterns

### Include (Eager Loading)

Load related data with the `.include()` method.

#### Simple Include

```typescript
// Load posts for users
const usersWithPosts = await orm
  .select('users')
  .include('posts')
  .all();
// Result: [{ id: 1, name: 'Alice', posts: [{ id: 1, title: '...' }, ...] }]
```

#### Nested Include (Dot Notation) - Recommended

Use dot notation for deep includes. Options apply to the deepest level:

```typescript
// Load posts with their comments
const users = await orm
  .select('users')
  .include('posts.comments')
  .all();

// Three levels deep
const users = await orm
  .select('users')
  .include('posts.comments.author')
  .all();

// With options on the deepest relation
const users = await orm
  .select('users')
  .include('posts.comments', { 
    select: { type: 'fields', fields: ['text'] }
  })
  .all();

// Disambiguate with 'via' (applies to deepest level)
const users = await orm
  .select('users')
  .include('posts.author', { via: 'commentAuthor' })
  .all();
```

#### Multiple Includes (Chaining)

Chain multiple `.include()` calls:

```typescript
const users = await orm
  .select('users')
  .include('posts')
  .include('profile')
  .include('posts.comments')
  .all();
```

#### Recursive Includes (Hierarchies)

For self-referential relations (trees/hierarchies):

```typescript
// Traverse ancestors (up the tree)
const categories = await orm
  .select('categories')
  .where(eq('id', 5))
  .include('parent', {
    recursive: true,
    direction: 'ancestors'
  })
  .all();

// Traverse descendants (down the tree) with flat output
const categories = await orm
  .select('categories')
  .where(eq('id', 1))
  .include('children', {
    recursive: true,
    direction: 'descendants',
    flat: true,
    maxDepth: 10
  })
  .all();
```

#### Include Options Reference

| Option | Description |
|--------|-------------|
| `via` | Disambiguate when multiple relations exist between tables |
| `where` | Filter conditions on related records |
| `select` | Select specific columns from related records |
| `include` | Nested includes (alternative to dot notation) |
| `recursive` | Enable recursive CTE traversal (hierarchies) |
| `direction` | `'ancestors'` or `'descendants'` (required when recursive) |
| `flat` | Output as flat array with depth field (default: nested objects) |
| `maxDepth` | Maximum traversal depth (default: 100) |

---

## Multi-tenant Queries

```typescript
// Schema-per-tenant isolation
const tenantOrm = orm.withSchema('acme_corp');

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

## Mutations

```typescript
// Insert
await orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'name'])
  .execute();

// Update
await orm.update('users')
  .set({ name: 'Alice Smith' })
  .where(eq('id', 1))
  .execute();

// Delete
await orm.delete('posts')
  .where(eq('published', false))
  .execute();

// Upsert (insert or update on conflict)
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doUpdate()
  .execute();
```

All mutations support `dump()` for SQL preview and `returning()` for PostgreSQL RETURNING.

See [ORM API Guide](docs/guides/orm-api.md#5-mutations) for full mutation reference.

---

## NQL (Natural Query Language)

A pipe-based query language for the CLI/REPL and `.dbsp` files:

```
# Basic query
users | where active = true | select id, name | limit 10

# Includes (nested JSON)
authors | select *, posts.*

# Aggregates
orders | group by status | select status, count(*), sum(amount)

# Window functions
products | select name, rank() over (partition by category order by price) as priceRank

# Mutations
insert into users set name = 'Alice', email = 'alice@example.com'
update users set active = false where lastLogin < '2024-01-01'
```

Use in TypeScript via template literals:

```typescript
const results = await orm.nql<User[]>`users | where active = true`.all();
```

See [NQL Reference](docs/guides/nql-reference.md) for complete syntax.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        @dbsp/cli                                │
│  dbsp generate | dbsp verify | dbsp repl                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│                              ▼                                   │
│  @dbsp/core                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner       │  │
│  │  (Schema)   │→→│  (Query)    │→→│  (Plan + Decisions)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  DX Layer: schema(), createOrm(), eq(), ref(), etc.     │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ implements Adapter
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  @dbsp/adapter-pgsql                                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  SQL Compiler (PlanReport → PostgreSQL AST → SQL)       │    │
│  │  PgsqlAdapter (pg Pool), CompileOnlyAdapter (no DB)     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@dbsp/core` | Schema DSL, query intents, semantic planning, ORM API |
| `@dbsp/adapter-pgsql` | PostgreSQL-native SQL compilation + execution (pg Pool) |
| `@dbsp/nql` | Natural Query Language parser |
| `@dbsp/types` | Shared type definitions |
| `@dbsp/cli` | CLI tools (generate, verify, repl) |
| `@dbsp/mcp-server` | MCP Server for AI assistants |

## API Reference

### Core Package

| Export | Description |
|--------|-------------|
| `schema()`, `ref()` | Define tables, columns, and relations |
| `createOrm()` | Create an ORM instance with adapter |
| `eq()`, `neq()`, `gt()`, `gte()`, `lt()`, `lte()` | Comparison filters |
| `isDistinctFrom()` | Null-safe inequality (SQL:2003) |
| `like()` | Pattern matching filter |
| `isNull()`, `isNotNull()` | Null checks |
| `inArray()`, `inSubquery()` | Array membership / IN (subquery) |
| `and()`, `or()`, `not()` | Logical operators |
| `exists()`, `notExists()` | Subquery existence checks |
| `some()`, `every()`, `none()` | Relation quantifier filters |
| `rangeOverlaps()`, `rangeContains()`, `rangeContainedBy()` | PostgreSQL range operators |
| `count()`, `sum()`, `avg()`, `min()`, `max()` | Aggregate helpers (on QueryBuilder) |
| `rowNumber()`, `rank()`, `denseRank()` | Window ranking functions |
| `wSum()`, `wAvg()`, `wCount()`, `wMin()`, `wMax()` | Window aggregate functions |
| `lag()`, `lead()` | Window offset functions |
| `coalesce()`, `raw()`, `col()`, `distinct()` | Expression helpers |
| `subquery()`, `outerRef()` | Correlated subquery builders (WHERE + SELECT via `.asExpr()`) |
| `.union()`, `.intersect()`, `.except()` | Set operations (UNION, INTERSECT, EXCEPT) |
| `Errors` | Error factory with type guards |

See [ORM API Guide](docs/guides/orm-api.md) for complete API documentation.

### Adapter Package

| Export | Description |
|--------|-------------|
| `createPgsqlAdapter()` | Create adapter for pg Pool instance |
| `createPgsqlCompileOnlyAdapter()` | Create compile-only adapter (no DB required) |
| `cosineDistance()`, `l2Distance()`, `innerProduct()` | pgvector similarity operators |
| `bm25Search()`, `score()`, `parse()`, `boost()` | ParadeDB full-text search |
| `generateSeries()`, `nextval()` | PostgreSQL built-in helpers |

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
# Start REPL with blog schema
pnpm dbsp repl --schema ./examples/blog.schema.ts
```

See [NQL Reference](docs/guides/nql-reference.md) for detailed usage guide.

### Guides

| Guide | Description |
|-------|-------------|
| [ORM API Guide](docs/guides/orm-api.md) | Complete TypeScript API reference — schema, queries, mutations, pagination, errors |
| [NQL Reference](docs/guides/nql-reference.md) | Pipe-based query language — syntax, operators, window functions, hierarchy |
| [CLI Usage](docs/CLI_USAGE.md) | CLI commands — generate, verify, repl |

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

**✅ v1.0 Ready** - 7,000+ tests passing across 7 packages

- Core: Schema DSL, ModelIR, IntentAST, Semantic Planner, DX Layer (2,100+ tests)
- Adapter: PostgreSQL-native SQL Compiler, Multi-tenant, DDL, Observability (2,800+ tests)
- NQL: Natural Query Language parser (257 tests)
- CLI: Generate, Verify, REPL (314 tests)
- Types: Shared type contracts
- GUI: Desktop explorer (Tauri v2 + React 19)
- E2E: PostgreSQL integration via Testcontainers (333 tests)

## License

MIT
