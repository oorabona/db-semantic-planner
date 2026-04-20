# CLI Usage Guide

**Package:** `@dbsp/cli`
**Binary:** `dbsp`

The DBSP CLI provides schema-first code generation and an interactive REPL for exploring your database schema.

---

## Installation

```bash
# Install globally
npm install -g @dbsp/cli

# Or use via npx
npx @dbsp/cli <command>

# Or in a project
pnpm add -D @dbsp/cli
pnpm dbsp <command>
```

---

## Commands

| Command | Description |
|---------|-------------|
| `dbsp generate <target>` | Generate code from schema |
| `dbsp push` | Push schema changes to database (additive or full drop/recreate) |
| `dbsp migrate <subcommand>` | Database migration management (dev, apply, rollback, status) |
| `dbsp repl` | Launch interactive REPL |
| `dbsp introspect` | Generate schema from database |
| `dbsp verify` | Verify schema matches database |

---

## Generate Command

Generate code artifacts from your schema definition.

```bash
dbsp generate <target> [options]
```

### Targets

| Target | Output | Description |
|--------|--------|-------------|
| `ddl` | SQL | CREATE TABLE statements |

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | Auto-detect |
| `-o, --out / --output <dir>` | Output directory | `./generated/<target>` |
| `--dialect <name>` | Database dialect (only postgresql currently supported) | postgresql |
| `--casing <type>` | Column naming: snake, camel, none | Based on dialect |
| `--drop` | Include DROP TABLE statements (ddl only) | false |
| `--schema-name <name>` | Database schema name (ddl only) | - |

### Examples

```bash
# Generate DDL for PostgreSQL
dbsp generate ddl --schema ./schema.ts --drop

# Generate DDL with custom schema name
dbsp generate ddl --schema ./schema.ts --schema-name myapp

# Generate DDL to stdout (for piping)
dbsp generate ddl --schema ./schema.ts
```

---

## Push Command

Push schema changes to the database (additive by default).

```bash
dbsp push [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | `dbsp.schema.ts` |
| `-d, --db <url>` | Database connection URL (required) | - |
| `--schema-name <name>` | Database schema name | `public` |
| `--drop` | Drop and recreate all objects (preserves migrations table) | false |
| `--dry-run` | Print SQL without executing | false |
| `--json` | Output as JSON | false |

### Behavior

- **Default (additive):** Only creates missing tables, columns, and indexes. Existing objects are left untouched.
- **With `--drop`:** Generates full DDL with DROP statements, dropping and recreating all schema objects (migrations table is preserved).

### Examples

```bash
# Push schema changes (additive)
dbsp push --schema ./schema.ts --db postgresql://localhost/mydb

# Push with custom schema name
dbsp push --schema ./schema.ts --db postgresql://localhost/mydb --schema-name myapp

# Dry-run: view SQL without executing
dbsp push --schema ./schema.ts --db postgresql://localhost/mydb --dry-run

# Full drop and recreate
dbsp push --schema ./schema.ts --db postgresql://localhost/mydb --drop

# JSON output for CI
dbsp push --schema ./schema.ts --db postgresql://localhost/mydb --json
```

---

## Migrate Command

Database migration management (generate, apply, and track migrations).

```bash
dbsp migrate <subcommand> [options]
```

### Subcommands

#### `migrate dev`

Generate a migration from schema changes.

```bash
dbsp migrate dev [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | `dbsp.schema.ts` |
| `-d, --db <url>` | Database connection URL (required) | - |
| `--schema-name <name>` | Database schema name | `public` |
| `--dir <path>` | Migrations directory | `./migrations` |
| `-n, --name <description>` | Migration description | `migration` |
| `--allow-destructive` | Include destructive changes (drops) | false |

#### `migrate apply`

Apply pending migrations.

```bash
dbsp migrate apply [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --db <url>` | Database connection URL (required) | - |
| `--schema-name <name>` | Database schema name | `public` |
| `--dir <path>` | Migrations directory | `./migrations` |
| `--dry-run` | Show pending migrations without applying | false |

#### `migrate rollback`

Roll back the last applied migration.

```bash
dbsp migrate rollback [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --db <url>` | Database connection URL (required) | - |
| `--schema-name <name>` | Database schema name | `public` |
| `--dir <path>` | Migrations directory | `./migrations` |
| `--force` | Skip destructive-change confirmation | false |

#### `migrate status`

Show migration status (applied vs pending).

```bash
dbsp migrate status [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --db <url>` | Database connection URL (required) | - |
| `--schema-name <name>` | Database schema name | `public` |
| `--dir <path>` | Migrations directory | `./migrations` |

### Examples

```bash
# Generate a migration from schema changes
dbsp migrate dev --schema ./schema.ts --db postgresql://localhost/mydb --name "add_users_table"

# Apply pending migrations
dbsp migrate apply --db postgresql://localhost/mydb

# View pending migrations without applying
dbsp migrate apply --db postgresql://localhost/mydb --dry-run

# Roll back the last migration
dbsp migrate rollback --db postgresql://localhost/mydb

# Check migration status
dbsp migrate status --db postgresql://localhost/mydb
```

---

## REPL Command

Launch an interactive REPL for exploring your schema and executing queries.

```bash
dbsp repl [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | Auto-detect |
| `-d, --db <url>` | PostgreSQL connection URL for execution | - |
| `-e, --eval <query>` | Execute single query and exit (batch mode) | - |
| `-i, --input <file>` | Execute queries from file (batch mode) | - |
| `-f, --format <fmt>` | Output format: text, json | text |
| `-a, --assert <file>` | Assertion file for validation | - |
| `--import <files...>` | SQL files to import before queries | - |
| `--use <schema>` | PostgreSQL schema to use | - |
| `--parse` | Start REPL with parse mode enabled | false |
| `--exec` | Start REPL with exec mode enabled | false |
| `-c, --config <path>` | Custom config file path | `~/.dbsp/config.json` |

### Interactive Mode

```bash
# Start REPL with schema auto-detection
dbsp repl

# Start REPL with database connection (execution mode)
dbsp repl --db postgresql://localhost/mydb
```

### Batch Mode

```bash
# Execute single query
dbsp repl --eval 'users where active = true'

# Execute queries from file
dbsp repl --input queries.txt --db postgresql://localhost/mydb

# Execute with assertions
dbsp repl --input queries.txt --assert queries.assert.txt
```

---

## REPL Commands

Inside the REPL, use these commands:

### Navigation

| Command | Description |
|---------|-------------|
| `.help` | Show help |
| `.quit` / `.exit` | Exit REPL |

### Schema Inspection

| Command | Description |
|---------|-------------|
| `.tables` | List all tables |
| `.schema <table>` | Show table columns and types |
| `.relations <table>` | Show table relations |

### Mode Toggles

| Command | Description |
|---------|-------------|
| `.natural` | Switch to natural query language (NQL) mode |
| `.sql` | Switch to raw SQL mode |
| `.exec [on\|off]` | Toggle or set execution mode (requires `--db`) |
| `.explain [on\|off]` | Toggle EXPLAIN output for queries |
| `.parse [on\|off]` | Toggle parse tree (AST) output |
| `.output [json\|table\|csv]` | Set result output format (default: `json`) |

### Transactions

| Command | Description |
|---------|-------------|
| `.begin` | Start a transaction (BEGIN) — requires `--db` |
| `.commit` | Commit the active transaction (COMMIT) |
| `.rollback` | Rollback the active transaction (ROLLBACK) |

### Database Operations

| Command | Description |
|---------|-------------|
| `.use <schema>` | Set PostgreSQL schema (e.g., `.use tenant_1`) |
| `.import <file>` | Import and execute a SQL file (requires `--db`) |
| `.load <table> <file.csv>` | Import a CSV file into a table (requires `--db`) |
| `.dump <table> <file.csv>` | Export a table to CSV (requires `--db`) |

---

## Query Syntax

The REPL supports a natural query language:

### Basic Queries

```
# Select all from table
users

# Filter with WHERE
users where active = true
users where age > 18
users where name = 'Alice'
users where email like '%@gmail.com'

# Multiple conditions (implicit AND)
users where active = true where age > 18

# NULL checks
posts where content is null
posts where content is not null
```

### Pagination

```
# Limit results
users limit 10

# Pagination
users limit 10 offset 20
```

### Ordering

```
# Order by column
users order by createdAt desc
posts order by title asc
```

### Includes (Relations)

```
# Include related data
users include posts
posts include author

# Nested includes
authors include posts include comments

# Filtered includes
users include posts where published = true
```

### Aggregates

```
# Count
posts select count(*)

# Group by
posts select count(*) group by authorId

# With aggregates
posts select authorId, count(*), avg(views) group by authorId

# Having clause
posts select authorId, count(*) as cnt group by authorId having cnt > 5

# Distinct
posts select distinct authorId
```

### Recursive Queries

```
# Recursive include (hierarchical data)
categories include children recursive

# With depth limit
categories include children recursive maxDepth 3
```

---

## Introspect Command

Generate a schema file from an existing database.

```bash
dbsp introspect [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --db <url>` | Database connection URL (required) | - |
| `-o, --out <file>` | Output schema file | `./dbsp.schema.ts` |
| `--schema-name <name>` | Database schema name | `public` |
| `--exclude <patterns>` | Tables to exclude (glob) | `_migrations,_prisma*,pg_*` |
| `--include <patterns>` | Tables to include (glob) | - |
| `--no-db-type-comments` | Omit original DB type comments | false |
| `--db-casing <casing>` | Database column casing (snake_case, camelCase, preserve) | `snake_case` |

### Examples

```bash
# Introspect public schema
dbsp introspect --db postgresql://localhost/mydb

# Introspect specific schema
dbsp introspect --db postgresql://localhost/mydb --schema-name tenant_1

# Exclude test tables
dbsp introspect --db postgresql://localhost/mydb --exclude '*_test,*_backup'

# Custom output path
dbsp introspect --db postgresql://localhost/mydb -o ./src/schema.ts
```

---

## Verify Command

Compare your schema definition against the actual database to detect drift.

```bash
dbsp verify [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | Auto-detect |
| `-d, --db <url>` | Database connection URL (required) | - |
| `--schema-name <name>` | Database schema name | `public` |
| `--json` | Output as JSON | false |

### Examples

```bash
# Verify schema matches database
dbsp verify --schema ./schema.ts --db postgresql://localhost/mydb

# Verify specific schema
dbsp verify --schema ./schema.ts --db postgresql://localhost/mydb --schema-name tenant_1
```

### Output

```
Schema Verification Results
===========================

Tables:
  [MATCH] users
  [MATCH] posts
  [MISSING] comments  <- In schema but not in database

Columns:
  [MATCH] users.id
  [MATCH] users.email
  [TYPE MISMATCH] users.createdAt
    Schema: timestamp
    Database: timestamptz
```

---

## Configuration

### Schema Auto-Detection

The CLI looks for schema files in this order:

1. `--schema` option if provided
2. `dbsp.schema.ts` in current directory
3. `schema.ts` in current directory
4. `src/schema.ts`
5. `src/db/schema.ts`

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Default database connection URL |
| `DBSP_SCHEMA` | Default schema file path |

---

## Batch Mode Examples

### CI/CD Integration

```bash
# Verify schema in CI
dbsp verify --schema ./schema.ts --db $DATABASE_URL

# Generate DDL in CI
dbsp generate ddl --schema ./schema.ts --db $DATABASE_URL
```

### Testing

```bash
# Run queries with assertions
dbsp repl \
  --schema ./schema.ts \
  --db postgresql://localhost/testdb \
  --input ./tests/queries.txt \
  --assert ./tests/queries.assert.txt
```

### Migration Scripts

```bash
# Import seed data then run queries
dbsp repl \
  --schema ./schema.ts \
  --db postgresql://localhost/mydb \
  --import ./seeds/data.sql \
  --eval 'users'
```

---

## See Also

- [Production Deployment Guide](./PRODUCTION.md) - Connection pooling, observability, and security hardening
