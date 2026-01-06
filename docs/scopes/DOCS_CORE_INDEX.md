---
doc-meta:
  status: draft
  scope: core
  type: reference
  created: 2026-01-06
  updated: 2026-01-06
---

# Core Documentation Index

## Overview

The **core** scope contains the foundational components of db-semantic-planner:

- **Schema** - Thenable schema/model definition with type-safe relations
- **Query AST** - Intent-based query representation (what to fetch, not how)
- **Planner** - Semantic planning engine (EXISTS vs JOIN, LEFT vs INNER, CTE generation)

This scope is the heart of the library - it transforms declarative query intents into optimized query plans.

## Documents

| Document | Type | Status | Description |
|----------|------|--------|-------------|
| [Overview](../plans/core-OVERVIEW.md) | design | draft | Core scope overview and architecture |

## Related Specifications

| Story | Status |
|-------|--------|
| (none yet) | - |

## Key Concepts

### Schema Definition

- Thenable schema builder API
- Type-safe relation definitions (hasOne, hasMany, belongsTo)
- Multi-tenant aware (schema-per-tenant support)

### Intent AST

- Declarative query builder (select, include, where)
- Relation traversal expressions
- Filter/ordering/pagination intents

### Semantic Planner

- Intent-first strategy selection
- EXISTS vs JOIN decision engine
- LEFT vs INNER join inference
- CTE generation for complex queries

## Backlog

- [TODO_CORE.md](../../TODO_CORE.md)
