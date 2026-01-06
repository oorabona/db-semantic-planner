---
doc-meta:
  status: draft
  scope: dx
  type: reference
  created: 2026-01-06
  updated: 2026-01-06
---

# DX (Developer Experience) Documentation Index

## Overview

The **dx** scope provides developer-friendly APIs and safety features:

- **Ambiguity** - Strict mode for ambiguous relations + override API (P1)
- **Compat** - Drizzle-like compatibility facade for easier migration (P1)

This scope focuses on making the library approachable and safe to use.

## Documents

| Document | Type | Status | Description |
|----------|------|--------|-------------|
| [Overview](../plans/dx-OVERVIEW.md) | design | draft | DX scope overview and features |

## Related Specifications

| Story | Status |
|-------|--------|
| (none yet) | - |

## Key Concepts

### Ambiguity Handling (P1)

- Strict mode: fail on ambiguous relation paths
- Override API: per-relation and per-query disambiguation
- Clear error messages with suggestions

### Compatibility Layer (P1)

- Drizzle-like helpers: eq(), and(), or()
- Query shortcuts: findMany(), findFirst(), findOneOrThrow()
- Familiar API for developers migrating from other ORMs

## Backlog

- [TODO_DX.md](../../TODO_DX.md)
