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

### CORE-001: ModelIR Types ([spec](docs/specs/CORE-001-model-ir.md))

- [x] ✅ TableIR interface
  - name, columns, primaryKey, foreignKeys
- [x] ✅ ColumnIR interface
  - name, type, nullable, default
- [x] ✅ ForeignKeyIR interface
  - columns, references, onDelete
- [x] ✅ RelationIR interface
  - name, type, source, target, through
  - Planning hints: cardinality, optionality
  - Strategy hints: includeStrategy, filterStrategy, joinDefault
- [x] ✅ ModelIR interface
  - tables Map, relations Map
  - Helper methods: getTable, getRelation, getRelationsFrom, getRelationsTo, isAmbiguous

### Schema Builder API

- [x] ✅ defineSchema() function (thenable pattern)
- [x] ✅ .relations() chain
- [x] ✅ hasOne, hasMany, belongsTo, belongsToMany helpers
- [x] ✅ .build() to produce ModelIR (immutable after build)

### CORE-002: IntentAST Types

- [x] ✅ QueryIntent interface
  - type: 'select', from, select, where, include, orderBy, limit, offset
- [x] ✅ SelectIntent interface
  - type: 'all' | 'fields', fields array
- [x] ✅ IncludeIntent interface
  - relation, select, where, include (nested), via (disambiguation)
- [x] ✅ WhereIntent union type
  - Comparison: eq, neq, gt, gte, lt, lte
  - String: like
  - Array: in
  - Null: isNull, isNotNull
  - Logical: and, or, not
  - **Relation: exists, notExists, relationFilter** (critical for Q1)
- [x] ✅ OrderByIntent interface
  - field, direction, nulls
- [x] ✅ Type guards for all WhereIntent kinds
- [x] ✅ 35 unit tests

### CORE-003: Semantic Planner ([spec](docs/specs/CORE-003-semantic-planner.md))

- [x] ✅ PlanReport interface
  - rootTable, decisions, warnings, ctes, intent, metadata
- [x] ✅ PlanDecision interface
  - id, type, context, choice, reasoning, alternatives
- [x] ✅ PlanWarning interface
  - code (AMBIGUOUS_RELATION, POTENTIAL_ROW_EXPLOSION, CIRCULAR_INCLUDE, DEEP_NESTING), message, suggestion
- [x] ✅ CTEDefinition interface
  - name, purpose, referencedBy, sourceIntent
- [x] ✅ PlanOptions interface
  - forceFilterStrategy, forceJoinType, enableCTEs, cteThreshold, maxIncludeDepth, disambiguate
- [x] ✅ EXISTS vs JOIN decision engine
  - Default to EXISTS for to-many (avoids row explosion)
  - Enables Q1 golden test
- [x] ✅ LEFT vs INNER join inference
  - Based on cardinality + optionality + filters
- [x] ✅ Include strategy (JOIN vs separate query)
  - JOIN for to-one, separate for to-many
- [x] ✅ CTE extraction logic
  - Detect relation reuse (same relation accessed multiple times)
  - Extract to CTE with threshold control
  - Enables Q2 golden test
- [x] ✅ Ambiguity detection
  - Multiple relations to same target
  - AmbiguousPlanError with options array
  - Via hint and disambiguate option support
  - Enables Q3 golden test
- [x] ✅ 29 unit tests covering Q1, Q2, Q3 scenarios

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
- [x] How to handle circular relation definitions? → **Detected at build time, logs warning (not an error)**
- [x] Custom planning hints/overrides API? → **RelationIR strategy hints + per-query via**
