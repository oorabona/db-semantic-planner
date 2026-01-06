---
doc-meta:
  status: draft
  scope: adapter
  type: reference
  created: 2026-01-06
  updated: 2026-01-06
---

# Adapter Documentation Index

## Overview

The **adapter** scope handles SQL compilation and execution:

- **Compiler** - Transforms query plans into SQL + parameters
- **Engine** - Execution adapters (Kysely first, extensible)
- **Multi-tenant** - Runtime schema switching (withSchema)
- **Observability** - dump() for plan + SQL + params visibility
- **Dialect** - Database-specific capabilities and SQL generation (P2)

This scope bridges the abstract query plan to concrete database execution.

## Documents

| Document | Type | Status | Description |
|----------|------|--------|-------------|
| [Overview](../plans/adapter-OVERVIEW.md) | design | draft | Adapter scope overview and architecture |

## Related Specifications

| Story | Status |
|-------|--------|
| (none yet) | - |

## Key Concepts

### SQL Compiler

- Plan-to-SQL transformation
- Parameter binding and type handling
- Identifier validation and escaping

### Engine Adapters

- Kysely adapter (PostgreSQL/MySQL/MSSQL/SQLite)
- Pluggable engine interface
- Connection/transaction management

### Multi-tenant Support

- withSchema() runtime schema switching
- Schema-per-tenant isolation
- Identifier security (allow-list validation)

### Observability

- dump() API returning {plan, sql, params}
- Optional EXPLAIN/ANALYZE (P1)
- Parameter redaction for logging (P1)

### Dialect Capabilities (P2)

- Capability-driven strategy selection
- Dialect-specific SQL generation
- Feature detection (CTEs, lateral joins, JSON aggregation)

## Backlog

- [TODO_ADAPTER.md](../../TODO_ADAPTER.md)
