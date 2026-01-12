# CORE-006: Smart Include Strategies

## Status: 🟡 IN PROGRESS

## Overview

Implement intelligent "auto" strategy selection and all include strategies (join, separate, cte, lateral, json_agg) with dialect capability awareness.

## BDD Scenarios

### Scenario 1: Auto selects JOIN for to-one relations
```gherkin
Given a schema with a hasOne relation "user → profile"
And dialect is any
When I query users with include("profile") and strategy "auto"
Then the planner should select "join" strategy
And reasoning should mention "to-one relation"
```

### Scenario 2: Auto selects best strategy for hasMany on PostgreSQL
```gherkin
Given a schema with a hasMany relation "user → posts"
And dialect is PostgreSQL
When I query users with include("posts") and strategy "auto"
Then the planner should select "json_agg" or "lateral" strategy
Because PostgreSQL supports these efficient aggregation methods
```

### Scenario 3: Auto falls back to SEPARATE on limited dialects
```gherkin
Given a schema with a hasMany relation "user → posts"
And dialect is SQLite
When I query users with include("posts") and strategy "auto"
Then the planner should select "separate" strategy
Because SQLite doesn't support lateral joins or JSON aggregation
```

### Scenario 4: Validation rejects incompatible strategy
```gherkin
Given dialect is SQLite
When I request strategy "lateral"
Then an error should be thrown
And error message should mention "lateral not supported by sqlite"
```

### Scenario 5: belongsToMany always uses SEPARATE
```gherkin
Given a schema with a belongsToMany relation "post ↔ tags"
And dialect is any
When I query posts with include("tags") and strategy "auto"
Then the planner should select "separate" strategy
Because M:N relations cause quadratic row explosion with JOIN
```

## Implementation Plan

### Block 1: Extend DialectCapabilities (core)
- Add `supportsLateralJoin: boolean`
- Add `supportsJsonAgg: boolean`
- Update all dialect definitions

### Block 2: Extend IncludeStrategy type (core)
- Change from `'join' | 'separate' | 'auto'` to include `'cte' | 'lateral' | 'json_agg'`
- Update PlanOptions type

### Block 3: Smart determineIncludeStrategy (core/planner)
- Implement decision matrix based on relation type + dialect
- Add dialect validation for requested strategy
- Generate meaningful reasoning in plan report

### Block 4: Implement LATERAL strategy (adapter-kysely)
- PostgreSQL-specific lateral subquery compilation
- Handle LIMIT in lateral context

### Block 5: Implement JSON_AGG strategy (adapter-kysely)
- PostgreSQL: `json_agg(to_jsonb(row))`
- MySQL: `JSON_ARRAYAGG(JSON_OBJECT(...))`
- DuckDB: Similar to PostgreSQL

### Block 6: Implement CTE strategy (adapter-kysely)
- CTE-based include for complex hierarchical queries
- Useful for recursive relations

### Block 7: Update REPL (cli)
- Update query-executor to pass dialect to planner
- Validate strategy selection

### Block 8: Tests
- Unit tests for determineIncludeStrategy
- Integration tests for each strategy × dialect combination
- Golden tests for SQL output

## Technical Notes

### Dialect Strategy Support Matrix

| Strategy | PostgreSQL | MySQL | SQLite | MSSQL | DuckDB |
|----------|------------|-------|--------|-------|--------|
| join | ✅ | ✅ | ✅ | ✅ | ✅ |
| separate | ✅ | ✅ | ✅ | ✅ | ✅ |
| cte | ✅ | ✅ | ✅ | ✅ | ✅ |
| lateral | ✅ | ❌ | ❌ | ✅* | ✅ |
| json_agg | ✅ | ✅ | ❌ | ❌ | ✅ |

*MSSQL uses CROSS APPLY instead of LATERAL

### Auto Strategy Selection Algorithm

```typescript
function selectAutoStrategy(relation: RelationIR, dialect: DialectCapabilities): IncludeStrategy {
  // 1. To-one relations: always JOIN
  if (relation.type === 'hasOne' || relation.type === 'belongsTo') {
    return 'join';
  }

  // 2. M:N relations: always SEPARATE (avoid quadratic explosion)
  if (relation.type === 'belongsToMany') {
    return 'separate';
  }

  // 3. hasMany: depends on dialect capabilities
  if (dialect.supportsJsonAgg) {
    return 'json_agg'; // Best: single query, no row explosion
  }
  if (dialect.supportsLateralJoin) {
    return 'lateral'; // Good: handles LIMIT well
  }

  // 4. Fallback: separate queries
  return 'separate';
}
```
