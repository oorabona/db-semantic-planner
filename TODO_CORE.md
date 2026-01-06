# Core Scope Backlog (`packages/core`)

**Package:** `packages/core`
**Phase:** MVP
**Dependencies:** None (DB-agnostic)

## Architecture Constraint

```
⚠️  MUST NOT import from adapter-kysely or dx packages
⚠️  Zero database-specific code
```

---

## In Progress

(none)

## Pending - MVP

### CORE-001: ModelIR Types ([spec](docs/specs/CORE-001-model-ir.md))

- [ ] :red_circle: [HIGH] TableIR interface
  - name, columns, primaryKey, foreignKeys
- [ ] :red_circle: [HIGH] ColumnIR interface
  - name, type, nullable, default
- [ ] :red_circle: [HIGH] ForeignKeyIR interface
  - columns, references, onDelete
- [ ] :red_circle: [HIGH] RelationIR interface
  - name, type, source, target, through
  - Planning hints: cardinality, optionality
  - Strategy hints: includeStrategy, filterStrategy, joinDefault
- [ ] ModelIR interface
  - tables Map, relations Map
  - Helper methods: getTable, getRelation, getRelationsFrom, getRelationsTo

### CORE-002: IntentAST Types

- [ ] :red_circle: [HIGH] QueryIntent interface
  - type: 'select', from, select, where, include, orderBy, limit, offset
- [ ] SelectIntent interface
  - type: 'all' | 'fields', fields array
- [ ] IncludeIntent interface
  - relation, select, where, include (nested), via (disambiguation)
- [ ] :red_circle: [HIGH] WhereIntent union type
  - Comparison: eq, neq, gt, gte, lt, lte
  - String: like
  - Array: in
  - Null: isNull, isNotNull
  - Logical: and, or, not
  - **Relation: exists, relationFilter** (critical for Q1)
- [ ] OrderByIntent interface
  - field, direction, nulls

### CORE-003: Semantic Planner

- [ ] :red_circle: [HIGH] PlanReport interface
  - rootTable, decisions, warnings, ctes
- [ ] PlanDecision interface
  - id, type, context, choice, reasoning, alternatives
- [ ] PlanWarning interface
  - code, message, suggestion
- [ ] CTEDefinition interface
  - name, purpose, referencedBy
- [ ] :red_circle: [HIGH] EXISTS vs JOIN decision engine
  - Default to EXISTS for to-many (avoids row explosion)
  - Enables Q1 golden test
- [ ] LEFT vs INNER join inference
  - Based on cardinality + optionality + filters
- [ ] :red_circle: [HIGH] CTE extraction logic
  - Detect alias reuse (same subquery multiple times)
  - Extract to CTE, reference by name
  - Enables Q2 golden test
- [ ] Ambiguity detection
  - Multiple relations to same target
  - Return options array for DX layer
  - Enables Q3 golden test (throws in dx)

### Schema Builder API

- [ ] defineSchema() function
  - Thenable pattern
- [ ] .relations() chain
  - hasOne, hasMany, belongsTo, belongsToMany helpers
- [ ] .build() to produce ModelIR

### Query Builder API

- [ ] query() function accepting model reference
- [ ] .select() chain
- [ ] .where() chain
- [ ] .include() chain (with nested support)
- [ ] .orderBy() chain
- [ ] .limit() / .offset() chains
- [ ] Intent extraction (.toIntent())

---

## Completed

(none)

## Blocked / Deferred

(none)

---

## Golden Tests Enabled by Core

| Test | Core Component | Validation |
|------|----------------|------------|
| Q1 | WhereIntent.exists + Planner | filter-strategy = exists |
| Q2 | CTEDefinition + Planner | cte-extraction for ratios |
| Q3 | Planner ambiguity detection | Returns options array |

## Open Questions

- [x] Should schema be immutable after construction? → **Yes, immutable after .build()**
- [ ] How to handle circular relation definitions? → Defer to validation step
- [x] Custom planning hints/overrides API? → **RelationIR strategy hints + per-query via**
