# Architecture Decisions

Decisions archived from workflow — newest first.

---

## DX-050 — dbType escape hatch for schema DSL (2026-03-18)

- Reuse existing `ColumnIR.originalDbType` field (populated by introspection) — no new IR field needed
- Case-insensitive comparison in schema-diff via `.toLowerCase()`
- Fallback to base type comparison when `originalDbType` absent on either side
- Used `areTypesEquivalent()` for base type fallback (existing function handles type aliases)
- No `dbType` validation — developer-only input, same trust level as table/column names
