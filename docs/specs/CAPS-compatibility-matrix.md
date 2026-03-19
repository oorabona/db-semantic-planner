---
doc-meta:
  status: published
  scope: types
  type: reference
  created: 2026-03-19
---

# DDL Feature Compatibility Matrix

## Tier Classification

| Tier | Databases | Support Level |
|------|-----------|---------------|
| **Tier 1** (full support target) | PostgreSQL, MySQL 8+, SQLite 3.35+, DuckDB | Full adapter planned |
| **Tier 2** (best-effort) | Oracle, MSSQL | Community/contrib adapters |
| **Tier 3** (document-only) | CouchDB | Document DB, no DDL |

## Feature × Database Matrix

| Feature | Flag | PostgreSQL | MySQL 8+ | SQLite 3.35+ | DuckDB | Oracle | MSSQL | CouchDB |
|---------|------|-----------|----------|-------------|--------|--------|-------|---------|
| ENUM types | `supportsDDLEnumTypes` | ✅ `CREATE TYPE` | ✅ inline `ENUM()` | ❌ (translate: `CHECK IN(...)`) | ✅ `CREATE TYPE` | ❌ (translate: `CHECK`) | ❌ (translate: `CHECK`) | N/A |
| Sequences | `supportsDDLSequences` | ✅ `CREATE SEQUENCE` | ❌ (`AUTO_INCREMENT`) | ❌ (`AUTOINCREMENT`) | ✅ `CREATE SEQUENCE` | ✅ `CREATE SEQUENCE` | ✅ `CREATE SEQUENCE` | N/A |
| Extensions | `supportsDDLExtensions` | ✅ `CREATE EXTENSION` | ❌ | ⚠️ `load_extension()` | ❌ | ❌ | ❌ | N/A |
| Partitioning | `supportsDDLPartitioning` | ✅ `PARTITION BY` | ✅ `PARTITION BY` | ❌ | ❌ | ✅ `PARTITION BY` | ✅ `PARTITION` | N/A |
| CHECK constraints | `supportsDDLCheckConstraints` | ✅ `CHECK` | ✅ `CHECK` (8.0.16+) | ✅ `CHECK` | ✅ `CHECK` | ✅ `CHECK` | ✅ `CHECK` | N/A |
| ON UPDATE FK | `supportsDDLOnUpdateFK` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A |
| Deferred FK | `supportsDDLDeferredFK` | ✅ `DEFERRABLE` | ❌ | ✅ `DEFERRABLE` | ❌ | ✅ `DEFERRABLE` | ❌ | N/A |
| Identity columns | `supportsDDLIdentityColumns` | ✅ `GENERATED AS IDENTITY` | ❌ (`AUTO_INCREMENT`) | ❌ (`AUTOINCREMENT`) | ✅ `GENERATED` | ✅ `GENERATED` | ✅ `IDENTITY` | N/A |
| Collation | `supportsDDLCollation` | ✅ `COLLATE` | ✅ `COLLATE` | ✅ `COLLATE` | ✅ `COLLATE` | ⚠️ `NLS_SORT` | ✅ `COLLATE` | N/A |
| Comments | `supportsDDLComments` | ✅ `COMMENT ON` | ✅ inline `COMMENT` | ❌ | ✅ `COMMENT ON` | ✅ `COMMENT ON` | ⚠️ `sp_addextendedproperty` | N/A |
| Index methods | `supportsDDLIndexMethods` | ✅ GIN, GiST, HASH, BRIN | ⚠️ BTREE, HASH only | ❌ | ❌ | ⚠️ BITMAP | ❌ | N/A |
| Index opclass | `supportsDDLIndexOpclass` | ✅ per-column | ❌ | ❌ | ❌ | ❌ | ❌ | N/A |
| INCLUDE columns | `supportsDDLIndexInclude` | ✅ PG11+ | ❌ | ❌ | ❌ | ✅ Oracle 18c+ | ✅ SQL Server 2016+ | N/A |
| Partial indexes | `supportsDDLPartialIndexes` | ✅ `WHERE` | ❌ | ✅ `WHERE` (3.9+) | ❌ | ❌ | ✅ `WHERE` | N/A |
| Expression indexes | `supportsDDLExpressionIndexes` | ✅ | ✅ (8.0.13+) | ✅ | ✅ | ⚠️ function-based | ⚠️ computed columns | N/A |

### Legend

- ✅ Full support — adapter can generate standard DDL
- ⚠️ Partial support — different syntax or limited functionality (translation needed)
- ❌ Not supported — feature skipped or translated to alternative (via `FeatureTranslator`)
- N/A — Not applicable (document database, no DDL)

## Translation Notes

### ENUM Types
- **PostgreSQL**: `CREATE TYPE "status" AS ENUM ('active', 'inactive')`
- **MySQL**: Inline column type `status ENUM('active', 'inactive')`
- **SQLite/Oracle/MSSQL**: Translate to `CHECK (status IN ('active', 'inactive'))`
- **DuckDB**: `CREATE TYPE status AS ENUM ('active', 'inactive')` (PG-compatible)

### Sequences
- **PostgreSQL/DuckDB/Oracle/MSSQL**: `CREATE SEQUENCE` with standard options
- **MySQL**: No sequences — uses `AUTO_INCREMENT` on column (no separate object)
- **SQLite**: No sequences — uses `AUTOINCREMENT` keyword on INTEGER PRIMARY KEY

### Extensions
- **PostgreSQL**: `CREATE EXTENSION IF NOT EXISTS "pgvector"` — first-class extension system
- **SQLite**: Runtime `load_extension()` — different mechanism, not DDL
- **Others**: No extension system — functionality must be built-in or unavailable

### Identity Columns
- **PostgreSQL**: `GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY` (SQL:2003 standard)
- **MySQL**: `AUTO_INCREMENT` — different semantics (one per table, always by-default)
- **SQLite**: `AUTOINCREMENT` on `INTEGER PRIMARY KEY` — implicit rowid alias
- **MSSQL**: `IDENTITY(1,1)` — non-standard syntax, similar to by-default

### Collation
- **Most databases**: `COLLATE "en_US.utf8"` on column definition
- **Oracle**: Uses `NLS_SORT` session parameter or `NLSSORT()` function — different paradigm

### Comments
- **PostgreSQL/DuckDB/Oracle**: `COMMENT ON TABLE/COLUMN ... IS '...'` (separate statement)
- **MySQL**: Inline `COMMENT '...'` in column/table definition
- **MSSQL**: `sp_addextendedproperty` stored procedure — non-standard

### Index Methods
- **PostgreSQL**: GIN, GiST, HASH, BRIN, SP-GiST + extensions (HNSW, IVFFlat)
- **MySQL**: BTREE (default), HASH (MEMORY/NDB only) — limited selection
- **Oracle**: B-tree, BITMAP — different optimization targets

## Capability Flag Defaults

When building a new adapter, use `createDialectCapabilities()` from `@dbsp/core`:

```typescript
import { createDialectCapabilities } from '@dbsp/core';

const MYSQL_DDL_CAPABILITIES = createDialectCapabilities({
  name: 'mysql',
  identifierQuote: '`',
  parameterStyle: 'question',
  limitStyle: 'limit-offset',
  booleanStyle: 'native',
  recursivePathStyle: 'string',
  stringConcatStyle: 'function',
  // DDL features
  supportsDDLEnumTypes: true,      // inline ENUM()
  supportsDDLCheckConstraints: true, // MySQL 8.0.16+
  supportsDDLOnUpdateFK: true,
  supportsDDLCollation: true,
  supportsDDLComments: true,        // inline COMMENT
  supportsDDLPartitioning: true,
  supportsDDLExpressionIndexes: true, // MySQL 8.0.13+
  // Not supported:
  // supportsDDLSequences — uses AUTO_INCREMENT
  // supportsDDLExtensions — no extension system
  // supportsDDLDeferredFK — not supported
  // supportsDDLIdentityColumns — uses AUTO_INCREMENT
  // supportsDDLIndexMethods — BTREE/HASH only (limited)
  // supportsDDLIndexOpclass — not supported
  // supportsDDLIndexInclude — not supported
  // supportsDDLPartialIndexes — not supported
});
```

## Version Dependencies

Some features require minimum database versions:

| Database | Feature | Minimum Version |
|----------|---------|-----------------|
| MySQL | CHECK constraints | 8.0.16 |
| MySQL | Expression indexes | 8.0.13 |
| SQLite | Partial indexes (WHERE) | 3.9.0 |
| SQLite | Generated columns | 3.31.0 |
| PostgreSQL | INCLUDE columns | 11.0 |
| Oracle | INCLUDE columns | 18c |
| MSSQL | INCLUDE columns | SQL Server 2016 |

> **Note:** Version-aware capabilities (`CAPS-VERSION`) are deferred — not needed until the second adapter is implemented. When needed, flags can be made version-conditional.
