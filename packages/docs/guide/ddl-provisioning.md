---
title: DDL Provisioning
---

# DDL Provisioning Guide

This guide explains how to manage your database schema lifecycle using the `dbsp` CLI. Use it when you need to push schema changes to a database, generate versioned migration files, or verify that a live database matches your schema definition.

## Overview

Three CLI commands manage your database schema lifecycle:

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `dbsp push` | Apply schema directly to database | Development, prototyping |
| `dbsp migrate` | Version-controlled migration files | Staging, production |
| `dbsp verify` | Compare schema with live database | CI/CD, pre-deploy checks |

## Quick Start

```bash
# Push schema directly (development)
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb

# Generate a migration file
dbsp migrate dev -s dbsp.schema.ts -d postgresql://localhost/mydb -n add_users

# Apply pending migrations
dbsp migrate apply -d postgresql://localhost/mydb

# Verify schema matches database
dbsp verify -s dbsp.schema.ts -d postgresql://localhost/mydb
```

## Commands

### `dbsp push`

Applies schema changes directly to the database. Two modes:

**Additive mode** (default): Only applies non-destructive changes (CREATE TABLE, ADD COLUMN, etc.). Destructive changes (DROP TABLE, DROP COLUMN) are skipped and displayed as warnings.

```bash
# Apply additive changes only
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb

# Preview changes without applying
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb --dry-run

# Include destructive changes (drops)
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb --drop

# Target a specific schema
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb --schema-name app

# JSON output for scripting
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb --json
```

**Drop mode** (`--drop`): Generates full DDL including DROP statements. The `_dbsp_migrations` tracking table is always protected from drops.

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | `dbsp.schema.ts` |
| `-d, --db <url>` | Database connection URL | **required** |
| `--schema-name <name>` | PostgreSQL schema name | `public` |
| `--drop` | Include destructive changes | `false` |
| `--dry-run` | Preview without executing | `false` |
| `--json` | JSON output | `false` |

### `dbsp migrate dev`

Generates a migration file from schema differences. Compares your TypeScript schema against the live database and writes a numbered SQL migration file.

```bash
# Generate migration
dbsp migrate dev -s dbsp.schema.ts -d postgresql://localhost/mydb -n create_users

# Output: migrations/0001_create_users.sql
```

Migration files follow the naming convention `NNNN_description.sql` (zero-padded 4-digit sequence + sanitized description).

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --schema <path>` | Path to schema file | `dbsp.schema.ts` |
| `-d, --db <url>` | Database connection URL | **required** |
| `--schema-name <name>` | PostgreSQL schema name | `public` |
| `--dir <path>` | Migrations directory | `migrations` |
| `-n, --name <desc>` | Migration description | `migration` |
| `--allow-destructive` | Include DROP statements | `false` |

### `dbsp migrate apply`

Applies pending migration files in order. Uses advisory locking for concurrent safety and checksum validation for tamper detection.

```bash
# Apply all pending migrations
dbsp migrate apply -d postgresql://localhost/mydb

# Preview pending migrations
dbsp migrate apply -d postgresql://localhost/mydb --dry-run
```

**Workflow:**
1. Acquires PostgreSQL advisory lock (`pg_advisory_lock`)
2. Reads `_dbsp_migrations` tracking table
3. Scans migration files directory
4. Validates checksums for already-applied migrations
5. Applies pending migrations in order (within transactions)
6. Records each migration in the tracking table
7. Releases advisory lock

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --db <url>` | Database connection URL | **required** |
| `--dir <path>` | Migrations directory | `migrations` |
| `--dry-run` | List pending without applying | `false` |

### `dbsp migrate status`

Shows the current migration status — applied, pending, checksum mismatches, and orphaned records.

```bash
# Show status
dbsp migrate status -d postgresql://localhost/mydb

# JSON output for scripting
dbsp migrate status -d postgresql://localhost/mydb --json
```

**Status codes:**

| Status | Icon | Meaning |
|--------|------|---------|
| `applied` | ✅ | Migration applied, checksum matches |
| `pending` | ⏳ | File exists but not yet applied |
| `checksum_mismatch` | ⚠️ | File modified after being applied |
| `missing_file` | ❓ | Applied but file no longer exists |

### `dbsp verify`

Compares your TypeScript schema against the live database and reports drift.

```bash
# Verify schema matches database
dbsp verify -s dbsp.schema.ts -d postgresql://localhost/mydb

# Strict mode (exit 1 on any drift)
dbsp verify -s dbsp.schema.ts -d postgresql://localhost/mydb --strict

# JSON output
dbsp verify -s dbsp.schema.ts -d postgresql://localhost/mydb --json
```

**Drift types detected:**

| Drift Type | Severity | Example |
|------------|----------|---------|
| `missing_table` | error | Table in schema but not in DB |
| `extra_table` | warning | Table in DB but not in schema |
| `missing_column` | error | Column in schema but not in DB |
| `extra_column` | warning | Column in DB but not in schema |
| `type_mismatch` | error | Column type differs |
| `nullable_mismatch` | warning | Nullability differs |
| `default_mismatch` | info | Default value differs |
| `missing_fk` | warning | Foreign key in schema but not in DB |
| `extra_fk` | info | Foreign key in DB but not in schema |
| `missing_index` | info | Index in schema but not in DB |
| `extra_index` | info | Index in DB but not in schema |

## Migration Tracking

Applied migrations are tracked in the `_dbsp_migrations` table:

```sql
CREATE TABLE "_dbsp_migrations" (
  "id" serial PRIMARY KEY,
  "name" varchar(255) NOT NULL UNIQUE,
  "checksum" varchar(64) NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now()
);
```

This table is automatically created on first `migrate apply` or `migrate status`. It is protected from `push --drop` operations.

## Concurrency Safety

The `migrate apply` command uses PostgreSQL advisory locks to prevent concurrent migration execution:

```sql
SELECT pg_advisory_lock(hashtext('dbsp_migrate'));
-- ... apply migrations ...
SELECT pg_advisory_unlock(hashtext('dbsp_migrate'));
```

This is a session-level lock released automatically if the connection drops.

## Typical Workflows

### Development (fast iteration)

```bash
# Edit schema → push directly
dbsp push -s dbsp.schema.ts -d postgresql://localhost/mydb
```

### Staging / Production (migration files)

```bash
# 1. Generate migration from schema diff
dbsp migrate dev -s dbsp.schema.ts -d postgresql://localhost/mydb -n add_comments

# 2. Review generated SQL
cat migrations/0003_add_comments.sql

# 3. Commit migration file to version control
git add migrations/0003_add_comments.sql && git commit -m "migration: add comments table"

# 4. Apply on target environment
dbsp migrate apply -d postgresql://staging/mydb
```

### CI/CD (verification)

```bash
# Verify schema matches after deployment
dbsp verify -s dbsp.schema.ts -d $DATABASE_URL --strict --json

# Exit code: 0 = match, 1 = drift detected
```

