# Core Scope Backlog (`packages/core`)

**Package:** `packages/core`
**Phase:** MVP ✅ Complete
**Dependencies:** None (DB-agnostic)

## Architecture Constraint

```
⚠️  MUST NOT import from adapter-kysely or dx packages
⚠️  Zero database-specific code
```

---

## Completed - Architecture

### ARCH-001: Dialect-Agnostic Recursive CTE - Core Changes ✅ (2026-01-08)

**Spec:** [docs/specs/ARCH-001-dialect-agnostic-recursive.md](docs/specs/ARCH-001-dialect-agnostic-recursive.md)

- [x] ✅ Block 1: Extend `RecursiveTrackOptions.path` with `separator?: string` (2026-01-08)
  - Added `separator` option to intent-ast.ts
  - TypeScript compilation verified
  - Backward compatible (existing code unchanged)

---

## Pending - P3 (Advanced Features)

**ADR:** [ADR-001: Typed Intents for Advanced Features](docs/adrs/ADR-001-typed-intents-for-advanced-features.md)

### P3-A: WindowIntent (HIGH priority - Kysely native API)

- [ ] `WindowIntent` type in intent-ast.ts
  - function: row_number, rank, dense_rank, sum, avg, count, min, max, lag, lead
  - over: partitionBy, orderBy, frame
  - alias: string
- [ ] `isWindowIntent` type guard
- [ ] Planner support for window functions in SELECT

### P3-B: FTSIntent (PostgreSQL Full-Text Search)

- [ ] `FTSIntent` type in intent-ast.ts
  - field, query, config (language)
  - operator: match, phrase, prefix, negation
  - ranking options (weights, normalization)
- [ ] `isFTSIntent` type guard
- [ ] Planner support for FTS in WHERE clause

### P3-C: RangeIntent (PostgreSQL Range Types)

- [ ] `RangeIntent` type in intent-ast.ts
  - type: daterange, tsrange, tstzrange, int4range, int8range, numrange
  - operator: overlaps, contains, contained_by, adjacent, left_of, right_of
  - value: { lower, upper, bounds }
- [ ] `isRangeIntent` type guard

---

## Completed - MVP ✅ (119 tests)

### RFC-001: Recursive CTE Support ✅ (2026-01-08)

**RFC:** [docs/rfcs/RFC-001-recursive-cte.md](docs/rfcs/RFC-001-recursive-cte.md)

- [x] ✅ Block 1: Add `RecursiveIntent` + traversal types to intent-ast.ts (2026-01-08)
- [x] ✅ Block 2: Add shape validation + `recursive-cte` decision type to planner (2026-01-08)
- [x] ✅ Unit tests for recursive intent creation and planning (2026-01-08) - 13 tests

---


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
  - type: 'select', from, select, where, include, orderBy, limit, offset, groupBy
- [x] ✅ SelectIntent interface
  - type: 'all' | 'fields' | 'aggregate', fields array
  - AggregateFunction: count, sum, avg, min, max
  - AggregateIntent: function, field?, as?
  - SelectAggregateIntent: aggregates array + optional fields
  - isSelectAggregate type guard
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
