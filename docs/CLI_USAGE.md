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
| `manifest` | `schema.json` | ModelIR manifest (JSON-serializable) |
| `ddl` | SQL | CREATE TABLE statements |

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | Auto-detect |
| `-o, --out <dir>` | Output directory | `./generated/<target>` |
| `--dialect <name>` | Database dialect: postgresql, mysql, sqlite, mssql | postgresql |
| `--casing <type>` | Column naming: snake, camel, none | Based on dialect |
| `--drop` | Include DROP TABLE statements (ddl only) | false |
| `--schema-name <name>` | Database schema name (ddl only) | - |

### Examples

```bash
# Generate DDL for PostgreSQL
dbsp generate ddl --schema ./schema.ts --drop

# Generate DDL with custom schema name
dbsp generate ddl --schema ./schema.ts --schema-name myapp

# Generate JSON manifest
dbsp generate manifest --schema ./schema.ts -o ./src/schema.json
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

### Query Execution

| Command | Description |
|---------|-------------|
| `.sql` | Toggle SQL output (show generated SQL) |
| `.exec` | Execute query on database (requires `--db`) |

### Database Operations

| Command | Description |
|---------|-------------|
| `.use <schema>` | Set PostgreSQL schema (e.g., `.use tenant_1`) |
| `.import <file>` | Import and execute SQL file |

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

# Generate DDL manifest in CI
dbsp generate manifest --schema ./schema.ts -o ./src/schema.json
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
