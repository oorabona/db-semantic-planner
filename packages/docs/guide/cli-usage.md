---
title: CLI Usage
---

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
| `--dir <path>` | Migrations directory | `./migrations` |
| `--json` | Output as JSON | false |

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

### JSON output schema (`--format json`)

When invoked in batch mode (`--eval` or `--input`) with `--format json`, `dbsp repl` emits a single JSON document on stdout containing the per-query results plus an optional assertion summary. The shape is stable and meant for machine consumption (CI pipelines, golden-file tests, GUI sidecars).

```json
{
  "queries": [
    {
      "query": "users where active = true",
      "type": "query",
      "success": true,
      "dbSuccess": true,
      "sql": "SELECT \"id\", \"email\" FROM \"users\" WHERE \"active\" = $1",
      "params": [true],
      "rowCount": 12,
      "columns": ["id", "email"],
      "rows": [{ "id": 1, "email": "a@example.com" }],
      "intent": {
        "type": "query",
        "table": "users",
        "with": [],
        "hasWhere": true,
        "hasGroupBy": false,
        "hasOrderBy": false,
        "ctes": []
      }
    }
  ],
  "assertions": {
    "total": 4,
    "passed": 4,
    "failed": 0,
    "skipped": 0,
    "results": []
  }
}
```

#### `queries[]` — `BatchResult` shape

| Field | Type | When present | Description |
|-------|------|--------------|-------------|
| `query` | `string` | always | The original input query (NQL, raw SQL, or `.command`). |
| `type` | `'command' \| 'query' \| 'mutation'` | always | Classification of the input. `command` covers REPL dot-commands. |
| `success` | `boolean` | always | **Compile-only success** — `true` if NQL compilation passed (or the dot-command executed). Does NOT reflect DB execution outcome. |
| `dbSuccess` | `boolean` | only when `--db` is provided | DB execution outcome. `true` = query ran without error; `false` = DB rejected the statement; absent = compile-only mode. |
| `error` | `string` | on failure | Human-readable error message. Set when `success === false` (compile error) or when `dbSuccess === false` (DB error). |
| `sql` | `string` | for `query` / `mutation` | Compiled SQL (parameterized). |
| `params` | `unknown[]` | for `query` / `mutation` | Positional parameter values bound to `$1..$N`. |
| `output` | `string` | depends on REPL `.output` mode | Pre-rendered result text (table/csv/json) — present when the engine emitted a textual rendering. |
| `rowCount` | `number` | when `dbSuccess === true` (rows affected for DML without RETURNING; 0 if none) | Number of rows returned (SELECT) or affected (DML). |
| `columns` | `string[]` | when `dbSuccess === true` (empty array for non-SELECT statements) | Column names from the DB result, in order. |
| `rows` | `unknown[]` | when `dbSuccess === true` (empty array for non-SELECT statements) | Materialized row data — used by `db.value.equals` / `db.rows.equals` assertions. |
| `intent` | `IntentSummary` | for compiled NQL queries | Structural summary of the intent (see below). |

#### `intent` — `IntentSummary` shape

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'query' \| 'insert' \| 'update' \| 'delete' \| 'upsert' \| 'setOperation'` | Intent kind. |
| `table` | `string` | Main table name. |
| `with` | `string[]` | Relation names joined via NQL `with`. |
| `hasWhere` | `boolean` | `true` if a WHERE clause is present. |
| `hasGroupBy` | `boolean` | `true` if GROUP BY is present. |
| `hasOrderBy` | `boolean` | `true` if ORDER BY is present. |
| `ctes` | `string[]` | Names of CTEs (NQL `let` bindings). |

#### `assertions` — `AssertionSummary` shape

Present only when `--assert <file>` is supplied.

| Field | Type | Description |
|-------|------|-------------|
| `total` | `number` | Total assertions evaluated. |
| `passed` | `number` | Assertions that passed. |
| `failed` | `number` | Assertions that failed (drives non-zero exit code). |
| `skipped` | `number` | Assertions skipped (typically DB-bound assertions when no `--db`). |
| `results` | `QueryAssertionResult[]` | Per-query assertion outcomes (line refs, expected vs actual). |

#### Exit codes

| Code | Condition |
|------|-----------|
| `0` | All queries compiled successfully, and (when `--db` is provided) all DB executions succeeded, and all assertions passed. |
| `1` | At least one query failed (`success === false` OR `dbSuccess === false`) **or** at least one assertion failed. |

::: tip Compile-only vs full success
`success` reflects compilation only. A query that compiles cleanly but is rejected by the DB has `success: true` and `dbSuccess: false`, and produces exit code `1`. To check end-to-end success in code, use `isOverallSuccess(r)` from `@dbsp/core` — it returns `r.success && r.dbSuccess !== false` and is hardened against malformed input.
:::

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
dbsp generate ddl --schema ./schema.ts
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

- [Production Deployment Guide](./production) - Connection pooling, observability, and security hardening
