# Backlog Study

> Items deferred from active development for future consideration.

---

## DDL Schema Extension (from /clarify 2025-01-18)

Items identified as out-of-scope during ColumnDef extension clarification:

| ID | Feature | Rationale | Priority |
|----|---------|-----------|----------|
| DDL-001 | Check constraints (`CHECK (price > 0)`) | Requires expression parser, complex validation | LOW |
| DDL-002 | Partial indexes / expression indexes | Advanced PostgreSQL feature, limited use cases | LOW |
| DDL-003 | Triggers and stored procedures | Outside semantic planner scope | NOT PLANNED |
| DDL-004 | Sequence/auto-increment customization | DB defaults sufficient for most cases | LOW |
| DDL-005 | Column comments (`COMMENT ON COLUMN`) | Documentation feature, not critical path | LOW |
| DDL-006 | `onUpdate` action for FKs | Uncommon in practice, can add later | LOW |

### Notes

- These can be revisited once core DDL generation is stable
- DDL-003 (triggers/procedures) explicitly excluded from project vision
- DDL-001 (check constraints) most likely candidate for future inclusion

---

## Deferred from /adversarial (2025-01-18)

Items identified during adversarial spec hardening:

| ID | Feature | Rationale | Priority |
|----|---------|-----------|----------|
| DDL-007 | Composite indexes (`indexes: [{ columns: ['a', 'b'] }]`) | Needs table-level syntax design | MEDIUM |

---
