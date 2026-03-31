---
doc-meta:
  status: canonical
  scope: adapter
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-27
  updated: 2026-03-27
  complexity: SIMPLE
  time-budget: 45min
---

# Specification: NOTEXISTS-MULTI-JOIN — Multi-hop JOINs in EXISTS Subqueries

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | adapter-pgsql |
| Complexity | SIMPLE |
| Time budget | 45 min |
| Blocks | 1 |
| BDD scenarios | 7 |
| Risk level | LOW |

## 1. Problem Statement

`notExists('calls', { include: { callerFile: { join: 'inner' }, project: { join: 'inner' } } })` fails on the second JOIN because `buildExistsSubquery()` always resolves FK from the root `targetTable` (`calls`). The second include `project` is a relation on `files` (the intermediate joined table), not on `calls`.

This blocks 3 astix code-health checks (deadCode, unusedExports, orphanFiles) that need multi-hop EXISTS subqueries.

## 2. User Stories

### US-1: Multi-hop EXISTS subquery
AS A developer writing complex WHERE conditions
I WANT `notExists('calls', { include: { callerFile: {join:'inner'}, project: {join:'inner'} }, where: eq('project.status', 'active') })`
SO THAT I can filter based on deeply joined relations inside EXISTS

ACCEPTANCE: SQL contains `NOT EXISTS (SELECT 1 FROM calls c INNER JOIN files callerFile ON ... INNER JOIN projects project ON callerFile.project_id = project.id WHERE ...)`

## 3. Business Rules

### 3.1 Invariants
- INV-01: Single-join EXISTS (NOTEXISTS-JOIN) MUST NOT change behavior
- INV-02: Existing 9 tests in `notexists-join.test.ts` MUST still pass
- INV-03: Include entries are processed in declaration order (Object.keys order)

### 3.2 Preconditions
- PRE-01: ModelIR must have the relation defined on the intermediate table (e.g., `files.project`)
- PRE-02: When ModelIR is unavailable, FK derivation convention applies (relation_id → table.id)

### 3.3 Effects
- EFF-01: Each include entry resolves FK from the table it logically belongs to (first from last-joined table, fallback to root)
- EFF-02: WHERE conditions can reference any joined alias (e.g., `eq('project.status', 'active')`)
- EFF-03: Supports 2+ hops in a single EXISTS subquery

### 3.4 Error Handling
- ERR-01: If relation not found on any joined table or root → FK derivation fallback (same as current single-join behavior)

## 4. Technical Design

### 4.1 Architecture Decision

**Fix approach: Track `joinedTables` map in the include loop.**

In `buildExistsSubquery()`, the include loop currently does:
```typescript
const rel = model.getRelation(`${targetTable}.${joinRelation}`);
```

After the fix, it will try resolution in order:
1. Last joined table → `model.getRelation(`${lastJoinedTable}.${joinRelation}`)`
2. Root target table → `model.getRelation(`${targetTable}.${joinRelation}`)`
3. FK derivation fallback (convention-based)

Track a `joinedTables` map: `alias → realTableName` so that subsequent joins can resolve against intermediate tables.

### 4.2 Changes

| File | Change | Migration |
|------|--------|-----------|
| `adapter-pgsql/src/handlers/where/exists.ts` | `buildExistsSubquery()`: track joinedTables, resolve FK from intermediate tables | No |
| `adapter-pgsql/src/__tests__/notexists-multi-join.test.ts` | 7 new tests | No |

### 4.3 Pseudocode

```typescript
// In buildExistsSubquery(), inside the include loop:
const joinedTables = new Map<string, string>(); // alias → realTableName

for (const inc of includeDecisions) {
  const joinRelation = inc.relation;
  if (!joinRelation) continue;

  let joinTargetTable = joinRelation;
  let joinSourceCol: string | undefined;
  let joinTargetCol: string | undefined;
  let resolvedFromTable = targetTable; // default: root

  if (model) {
    // Try resolution chain: last joined tables (reverse order) → root
    let rel = null;
    // Try each previously joined table
    for (const [alias, realTable] of joinedTables) {
      rel = model.getRelation(`${realTable}.${joinRelation}`);
      if (rel) { resolvedFromTable = alias; break; }
    }
    // Fallback to root
    if (!rel) rel = model.getRelation(`${targetTable}.${joinRelation}`);

    if (rel) {
      joinTargetTable = rel.target;
      // ... existing FK direction logic (belongsTo vs hasMany)
      // Use resolvedFromTable as sourceAlias for the ON condition
    }
  }

  // ... build JOIN node using resolvedFromTable as the source alias
  const joinAlias = joinRelation;
  joinedTables.set(joinAlias, joinTargetTable); // track for next iteration
}
```

## 5. Acceptance Criteria (BDD)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Two JOINs inside NOT EXISTS
  Given a query with notExists('callee_calls', { include: { calleeFile: {join:'inner'}, calleeProject: {join:'inner'} } })
  When compiled to SQL
  Then SQL has NOT EXISTS (SELECT 1 FROM callee_calls ... JOIN files AS calleeFile ON ... JOIN projects AS calleeProject ON calleeFile.project_id = calleeProject.id ...)

@priority:high @type:nominal
Scenario: SC-02 — WHERE across multiple joined tables
  Given a multi-join EXISTS with where: and(eq('calleeFile.path', '/src'), eq('calleeProject.name', 'myapp'))
  When compiled
  Then SQL has WHERE ... AND calleeFile.path = $1 AND calleeProject.name = $2

@priority:high @type:nominal
Scenario: SC-03 — Three JOINs (3-hop chain)
  Given an EXISTS with 3 include entries chaining through relations
  When compiled
  Then SQL has 3 JOIN clauses with correct FK resolution at each hop

@priority:medium @type:edge
Scenario: SC-04 — Single JOIN regression (INV-01)
  Given existing single-join notExists
  When compiled
  Then SQL unchanged from NOTEXISTS-JOIN behavior

@priority:medium @type:edge
Scenario: SC-05 — No include (plain EXISTS regression)
  Given notExists('callee_calls', { where: eq('kind', 'function') })
  When compiled
  Then SQL has no JOINs, just correlation + WHERE

@priority:medium @type:edge
Scenario: SC-06 — FK fallback without ModelIR
  Given multi-join EXISTS without ModelIR available
  When compiled
  Then FK derivation convention applies (relation_id convention)

@priority:medium @type:edge
Scenario: SC-07 — exists() (not just notExists) with multi-join
  Given exists() with 2 include entries
  When compiled
  Then SQL has EXISTS (not NOT EXISTS) with correct JOINs
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error |
|----------|---------|------|-------|
| SC-01 | ✓ | | |
| SC-02 | ✓ | | |
| SC-03 | ✓ | | |
| SC-04 | | ✓ | |
| SC-05 | | ✓ | |
| SC-06 | | ✓ | |
| SC-07 | | ✓ | |

## 6. Implementation Plan

### Block 1: Fix buildExistsSubquery + Tests — 45min

**Type:** Feature enhancement
**Dependencies:** None
**Files:**
- `packages/adapter-pgsql/src/handlers/where/exists.ts` — track joinedTables, resolve FK from intermediate tables
- `packages/adapter-pgsql/src/__tests__/notexists-multi-join.test.ts` — 7 tests

**Exit criteria:**
- [ ] 2-join and 3-join EXISTS compile correctly
- [ ] WHERE conditions reference any joined alias
- [ ] FK resolves from intermediate joined tables
- [ ] Single-join and no-include EXISTS unchanged
- [ ] All 3175+ adapter tests pass

## 7. Test Strategy

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 7 | Compiled SQL assertions |
| Integration | 0 | N/A |
| E2E | 0 | Covered when astix migrates |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| FK resolution order matters | M | L | Try intermediate tables first (most recent → oldest), then root |
| Alias collision between EXISTS joins | L | L | Each include uses relation name as alias (already unique per EXISTS) |

## 9. Definition of Done

- [ ] Block 1 implemented
- [ ] All 7 BDD scenarios passing
- [ ] All adapter tests pass
- [ ] Lint/typecheck pass
