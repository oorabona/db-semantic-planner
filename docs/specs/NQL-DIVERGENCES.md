# NQL Spec vs Implementation Divergences

**Status:** Living document
**Last updated:** 2026-01-27
**Story:** NQL-ALIGN

This document catalogs differences between the formal NQL specification and the current dbsp-nql implementation. Each divergence includes the reason for the deviation and recommended workarounds.

---

## 1. Current Limitations

### 1.1 Scoped Traversal `[N]` Syntax

**Spec:** `ascendant[3].column` limits recursive traversal to exactly N levels.
**Status:** ✅ Implemented (2026-01-27, NQL-DIVERGE)

**Implementation:**
- Grammar: `pathExpr` supports optional `[NumberLiteral]` after first segment
- AST: `NqlPathExpression.depthHint?: number`
- Compiler: passes `depth` to `PseudoColumnExpressionIntent`
- Validation: only `ascendant`/`descendant` support depth hints (1-100 range)

```nql
categories | select id, ascendant[3].name
categories | select id, descendant[5].label
```

### 1.2 COUNT(DISTINCT column)

**Spec:** `count(distinct columnName)` as aggregate function.
**Status:** ✅ Implemented (2026-01-27, NQL-DIVERGE)

**Implementation:**
- Grammar: `funcArgList` supports optional `Distinct` token before expression list
- AST: `NqlFunctionCall.distinct?: boolean`
- Compiler: propagates `distinct` to `AggregateExpressionIntent`
- Adapter: Kysely aggregate handler already supported `distinct` flag

```nql
users | select count(distinct department)
orders | select sum(distinct amount)
```

---

## 2. Correctly Implemented Features (Previously Documented as Divergences)

### 2.1 HAVING Clause ✅ WORKS

**Previous doc claimed:** "HAVING keyword parsed but ignored"
**Reality:** **Fully implemented** via position-aware WHERE routing.

The NQL compiler detects WHERE clause position relative to GROUP BY:
```typescript
// compiler/index.ts:176
if (groupByIndex >= 0 && i > groupByIndex) {
  havingConditions.push(condition);  // → SQL HAVING
} else {
  whereConditions.push(condition);   // → SQL WHERE
}
```

**Correct usage:**
```nql
# WHERE before GROUP BY → filters rows
users | where active = true | group by department | select department, count(*)

# WHERE after GROUP BY → filters aggregate results (becomes HAVING)
users | group by department | select department, count(*) | where count(*) > 5
```

### 2.2 Include Strategy Selection ✅ DOCUMENTED

The planner chooses strategy automatically, but users can force JOIN via `| flat`:

| Syntax | Strategy | Result Format |
|--------|----------|---------------|
| `posts \| select *, author.*` | json_agg (default) | Nested JSON |
| `posts \| select *, author.* \| flat` | JOIN | Flat columns |

**`flat` mode column aliasing:** `author.name` → `author_name` (underscore joining)

---

## 3. NQL v2.1 Syntax Changes

### 3.1 `with` Keyword Removed (Breaking Change)

**v2.0:** `authors | with posts`
**v2.1:** `authors | select *, posts.*`

The `with` keyword was removed because:
1. Path expressions in SELECT auto-trigger includes
2. json_agg strategy is now default (no explicit `with` needed)
3. For JOIN strategy, use `| flat` instead

### 3.2 Path Expressions for Relations

Relations are now accessed via path expressions in SELECT:

```nql
# Include all author columns
posts | select *, author.*

# Include specific author columns
posts | select title, author.name, author.email

# Nested includes
posts | select *, author.*, comments.*

# With filtering on included relation
posts | select *, author.* | where author.verified = true
```

### 3.3 Column Aliases with `as`

The `as` keyword is for **column aliases**, not relation aliases:

```nql
# Column alias
posts | select count(*) as totalPosts

# Function result alias
users | select upper(name) as upperName

# Aggregate with alias
users | group by department | select department, count(*) as headcount
```

---

## 4. Extension Features

### 4.1 CASE Expressions (NQL-ALIGN)

**Status:** ✅ Implemented (Searched CASE only)

```nql
# Searched CASE syntax
users | select case when age >= 18 then 'adult' else 'minor' end as category

# Multiple conditions
users | select case
  when status = 'active' then 'Active'
  when status = 'pending' then 'Pending'
  else 'Unknown'
end as statusLabel
```

**Not yet supported:** Simple CASE (`case status when 'A' then ...`)

### 4.2 INSERT FROM SELECT

**Status:** ✅ Implemented

```nql
# Copy rows from one table to another
archived_users | insert from users | where active = false
```

### 4.3 Global Query Limits

**Status:** ✅ Implemented

| Option | Default | Description |
|--------|---------|-------------|
| `maxDepth` | 10 | Maximum CTE recursion depth |
| `maxTableHops` | 5 | Maximum relation traversals |
| `maxNestedCase` | 10 | Maximum CASE nesting depth |

---

## 5. Warnings System

The planner generates warnings for potentially problematic queries:

| Warning Code | Trigger | Suggestion |
|--------------|---------|------------|
| `AMBIGUOUS_RELATION` | Unknown relation referenced | Check relation exists in schema |
| `POTENTIAL_ROW_EXPLOSION` | JOIN on to-many relation | Consider EXISTS strategy |
| `CIRCULAR_INCLUDE` | Circular include chain | Remove circular reference |
| `DEEP_NESTING` | Excessive depth | Reduce nesting or increase limits |
| `RAW_SQL_USAGE` | Raw SQL expression | Review for SQL injection risk |
| `INVALID_RECURSIVE_INCLUDE` | Recursive on non-self-ref | Use RecursiveIntent instead |

---

## 6. Implementation Backlog

| Feature | Priority | Effort | Notes |
|---------|----------|--------|-------|
| Scoped traversal `[N]` | MEDIUM | S | Parser syntax + intent field |
| COUNT(DISTINCT col) | MEDIUM | M | funcArgList grammar change |
| Simple CASE | LOW | M | Alternative CASE syntax |
| Window frame clauses | LOW | L | ROWS/RANGE BETWEEN |

---

## Changelog

- **2026-01-27:** Corrected HAVING documentation (was wrong - it works!)
- **2026-01-27:** Clarified `include`/`with` deprecation in v2.1
- **2026-01-27:** Added `flat` keyword documentation
- **2026-01-27:** Initial document created (NQL-ALIGN Block 6)
