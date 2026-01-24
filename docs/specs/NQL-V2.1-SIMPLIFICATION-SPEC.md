---
doc-meta:
  status: canonical
  scope: nql, cli, adapter-kysely
  type: specification
  created: 2026-01-24
  updated: 2026-01-24
  completed: 2026-01-24
  complexity: COMPLEX
  time-budget: 4h
  adversarial-review: completed
  llm-consensus: Codex + Gemini + Claude
---

# Specification: NQL v2.1 — Grammar Simplification

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Spec ID | NQL-2.1 |
| Scope | nql, cli, adapter-kysely |
| Complexity | COMPLEX |
| Time budget | 4h |
| Blocks | 5 |
| BDD scenarios | 12 |
| Risk level | MEDIUM |
| Breaking change | YES (NQL v1.x → v2.1) |
| Base spec | `docs/specs/NQL-EBNF.md` v2.2 |

## 1. Problem Statement

The NQL `with` keyword is redundant when json_agg strategy is used by default:
- `authors | with posts` and `authors | select *, posts.*` express the same intent
- Path expressions (`posts.*`) already indicate which relations to include
- Having two syntaxes for the same operation increases cognitive load
- `with` has P1 bugs (nested includes with where, aggregates fail)

**Solution:** Remove `with` from grammar, use json_agg strategy by default for all relation path expressions. Add `| flat` modifier for cases requiring JOIN strategy (large datasets, exports).

## 2. User Stories

### US-1: Simplified Query Syntax (Developer)

**AS A** developer using NQL
**I WANT** to include relations via path expressions without explicit `with`
**SO THAT** queries are simpler and more intuitive

**ACCEPTANCE:**
- `authors | select name, posts.title` produces nested JSON with posts
- No `with` keyword needed
- json_agg used automatically for relations

### US-2: Large Dataset Export (Developer)

**AS A** developer exporting large datasets
**I WANT** to force JOIN strategy via `| flat` modifier
**SO THAT** I avoid memory issues with large nested JSON

**ACCEPTANCE:**
- `authors | select name, posts.title | flat` uses JOINs
- Result is flat rows (one per author-post pair)
- No json_agg, no nested JSON

### US-3: Output Format Control (REPL User)

**AS A** REPL user
**I WANT** to control output format via `.output` command
**SO THAT** I can switch between table and JSON display

**ACCEPTANCE:**
- `.output json` — display nested JSON (default)
- `.output table` — flatten JSON for table display (client-side)
- `.output csv` — flatten for CSV export
- Format is display concern, not query strategy

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01:** Path expressions with relation segments trigger automatic include
- **INV-02:** json_agg is the DEFAULT strategy for all relation includes
- **INV-03:** `| flat` forces JOIN strategy, disabling json_agg
- **INV-04:** `.output` controls display format only, not query strategy
- **INV-05:** Column aliasing in flat mode: `a.b` → `a_b`, `a.b.c` → `a_b_c` (recursive underscore join)
- **INV-06:** JOIN strategy for relations is determined by planner (LEFT JOIN, INNER JOIN, EXISTS — not fixed)
- **INV-07:** Filter on relation (`where posts.title = 'x'`) does NOT auto-include; use explicit path in select
- **INV-08:** `| flat` + `.output json` = flat result displayed as JSON (no re-nesting)

### 3.2 Preconditions (required before action)

- **PRE-01:** Dialect MUST support json_agg OR fall back to JOIN with warning
- **PRE-02:** `| flat` cannot follow another `| flat` (idempotent)
- **PRE-03:** `.output` command only valid at REPL session level

### 3.3 Effects (what changes)

- **EFF-01:** `with` keyword removed from grammar (breaking change)
- **EFF-02:** Path expressions compile to `IncludeIntent` with json_agg strategy
- **EFF-03:** `| flat` modifier sets `strategy: 'join'` on all includes
- **EFF-04:** `.output` stored in REPL session state, affects display only

### 3.4 Error Handling

| Error Code | When | Response |
|------------|------|----------|
| **ERR-PARSE-001** | `with` keyword used | "Parse error: 'with' is not a valid keyword. Use path expressions: `posts.*`" |
| **ERR-DIALECT-001** | json_agg not supported | "WARNING: json_agg not supported, using JOIN fallback (row explosion possible)" |
| **ERR-FLAT-001** | `flat` on query without relations | "WARNING: 'flat' has no effect without relation path expressions" |
| **ERR-AMBIGUOUS-001** | Path segment ambiguous (relation vs column) | "Ambiguous path 'x.y': 'y' is both a column and relation. Use explicit syntax." |

## 4. Technical Design

### 4.1 Architecture Decision

**Choice:** json_agg by default, `| flat` escape hatch

**Why:**
- json_agg prevents row explosion (N×M problem)
- Flattening JSON (client-side) is O(n) and trivial
- Reconstructing tree from flat rows is complex and error-prone
- ORM API already uses json_agg — consistency

**Trade-offs accepted:**
- NQL loses "pure SQL" mode (use raw SQL if needed)
- Large nested results can cause memory pressure (use `| flat` or pagination)

**LLM Consensus:**
- Codex: "json_agg great for small/medium, add escape hatch for large"
- Gemini: Concerns about JOINs resolved by json_agg default
- Claude: Flatten is trivial, reconstruct is complex

### 4.2 Grammar Changes

**Removed:**
```ebnf
(* REMOVED in v2.1 *)
with_clause       = "with" join_spec { "," join_spec } ;
```

**Added:**
```ebnf
(* NEW in v2.1 *)
query_clause      = ... | flat_clause ;
flat_clause       = "flat" ;

(* Path expressions now trigger automatic include *)
path_expr         = ident_segment { "." ident_segment } ;
(* If any segment is a relation → emit IncludeIntent *)
```

### 4.3 REPL `.output` Command

**Syntax:**
```
.output [json|table|csv]
.output             # Show current mode
```

**Storage:** Session state in REPL context

**Implementation:** Output formatter in `packages/cli/src/repl/output-formatter.ts`

### 4.4 Compiler Changes

| Component | Change |
|-----------|--------|
| `packages/nql/src/lexer/tokens.ts` | Add `FLAT` token |
| `packages/nql/src/parser/grammar.ts` | Add `flat_clause` rule, remove `with_clause` |
| `packages/nql/src/compiler/index.ts` | Detect relation paths → emit `IncludeIntent` |
| `packages/adapter-kysely/src/compiler.ts` | Respect `strategy` on `IncludeIntent` |
| `packages/cli/src/repl/commands.ts` | Add `.output` command handler |
| `packages/cli/src/repl/output-formatter.ts` | New file for JSON/table/CSV formatting |

### 4.5 Strategy Selection Flow

```
┌────────────────────────────────────────────────────────────────┐
│ NQL Query: "authors | select name, posts.title"                │
└───────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ Compiler detects: path "posts.title" → relation "posts"        │
│ Emits: IncludeIntent { relation: "posts", strategy: "auto" }   │
└───────────────────────────┬────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │ Has `| flat` modifier?    │
              └─────────────┬─────────────┘
                    │               │
                   NO              YES
                    │               │
                    ▼               ▼
          ┌─────────────┐   ┌─────────────┐
          │strategy:auto│   │strategy:join│
          │→ json_agg   │   │→ planner    │
          └─────────────┘   └─────────────┘
                    │               │
                    ▼               ▼
          ┌─────────────────────────────────┐
          │ Planner decides optimal JOIN:   │
          │ LEFT JOIN, INNER, EXISTS, etc.  │
          │ based on relation cardinality   │
          └─────────────────────────────────┘
```

### 4.6 Clarifications (Post-Review)

Based on LLM review (Codex), these edge cases are explicitly defined:

#### 4.6.1 Relation Segment Resolution

A path segment is a **relation** if and only if:
1. It exists in the schema's `relations` map for the current table
2. It is NOT a column name on the current table

**Ambiguity rule:** If a name is BOTH a relation AND a column, emit `ERR-AMBIGUOUS-001`.

**Example:**
```
authors.posts.title     → "posts" is relation, "title" is column
authors.name            → "name" is column (no relation)
authors.avatar.url      → "avatar" could be relation OR jsonb column → check schema
```

#### 4.6.2 Deep Aliasing Rules (Flat Mode)

| Path Expression | Flat Alias | Rule |
|-----------------|------------|------|
| `posts.title` | `posts_title` | Single underscore join |
| `posts.comments.content` | `posts_comments_content` | Recursive join |
| `posts.comments.author.name` | `posts_comments_author_name` | 4 levels |

**Wildcard aliasing:** NOT supported in v2.1. `select * as foo` is a parse error.
- `select *` → all columns from root table
- `select posts.*` → all columns from relation, aliased with `posts_` prefix

#### 4.6.3 Multi-Relation Flat Mode

When multiple relations in flat mode:
```nql
authors | select name, posts.title, awards.name | flat
```

**Behavior:** Cartesian product of all relations (M × N rows for M posts × N awards per author).

**JOIN order:** Determined by planner based on:
1. Relation cardinality hints in schema
2. Filter predicates (if present)
3. Left-to-right order as fallback

#### 4.6.4 Order/Limit with json_agg

| Clause | Applies to | Example |
|--------|-----------|---------|
| `\| order by name` | Parent rows | Authors sorted by name |
| `\| limit 10` | Parent rows | First 10 authors (each with ALL posts) |

**Child ordering:** Use path in order by: `| order by posts.created_at` (within json_agg).

#### 4.6.5 Filter vs Include

**Rule:** Filter on relation does NOT auto-include.

```nql
# This filters but does NOT include posts in result:
authors | where posts.published = true | select name

# This filters AND includes posts:
authors | where posts.published = true | select name, posts.title
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Grammar Simplification

```gherkin
@priority:high @type:nominal
Scenario: Path expression auto-includes relation with json_agg
  Given NQL query "authors | select name, posts.title"
  When compiled
  Then IncludeIntent is emitted for "posts"
  And strategy is "auto" (json_agg default)
  And SQL contains "json_agg" or "jsonb_build_object"

@priority:high @type:nominal
Scenario: Flat modifier forces JOIN strategy
  Given NQL query "authors | select name, posts.title | flat"
  When compiled
  Then IncludeIntent has strategy "join"
  And SQL contains "LEFT JOIN posts"
  And SQL does NOT contain "json_agg"

@priority:high @type:error
Scenario: Removed with keyword causes parse error
  Given NQL query "authors | with posts"
  When parsed
  Then parse error is thrown: "with is not a valid keyword"
  And query does NOT execute

@priority:medium @type:edge
Scenario: Nested relation path auto-includes all levels
  Given NQL query "authors | select name, posts.comments.content"
  When compiled
  Then IncludeIntent emitted for "posts" AND "comments"
  And nested json_agg structure generated
```

### Scenario Group: Flat Mode Behavior

```gherkin
@priority:high @type:nominal
Scenario: Flat mode produces aliased columns
  Given NQL query "posts | select id, author.id | flat"
  When compiled
  Then column "id" maps to "posts.id"
  And column "author.id" maps to alias "author_id"

@priority:medium @type:edge
Scenario: Flat mode on query without relations is no-op
  Given NQL query "authors | select name | flat"
  When compiled
  Then warning shown: "flat has no effect without relations"
  And query compiles normally

@priority:medium @type:nominal
Scenario: Flat mode row explosion produces correct data
  Given author "Alice" has 3 posts
  When NQL query "authors | where name = 'Alice' | select name, posts.title | flat"
  Then result has 3 rows
  And each row has name = "Alice"
  And post titles are distinct
```

### Scenario Group: Output Command

```gherkin
@priority:high @type:nominal
Scenario: Output json displays nested structure
  Given REPL session with ".output json"
  And NQL query "authors | select name, posts.title" returns nested data
  When executed
  Then display shows nested JSON format

@priority:high @type:nominal
Scenario: Output table flattens nested results
  Given REPL session with ".output table"
  And NQL query "authors | select name, posts.title" returns nested data
  When executed
  Then display shows tabular format
  And nested posts are flattened to rows

@priority:medium @type:nominal
Scenario: Output csv exports flattened data
  Given REPL session with ".output csv"
  And NQL query "authors | select name, posts.title"
  When executed
  Then output is CSV format
  And nested data is flattened

@priority:low @type:nominal
Scenario: Output without args shows current mode
  Given REPL session with ".output json" previously set
  When ".output" executed
  Then shows "Current output mode: json"
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01: Path auto-include | ✓ | | | |
| SC-02: Flat modifier | ✓ | | | |
| SC-03: Deprecated with | | | ✓ | |
| SC-04: Nested paths | | ✓ | | |
| SC-05: Aliased columns | ✓ | | | |
| SC-06: Flat no-op | | ✓ | | |
| SC-07: Flat row explosion | ✓ | | | |
| SC-08: Output json | ✓ | | | |
| SC-09: Output table | ✓ | | | |
| SC-10: Output csv | ✓ | | | |
| SC-11: Output show | | ✓ | | |

## 6. Implementation Plan

### Block 1: Grammar Changes — 45min
**Type:** Parser modification
**Dependencies:** None
**Packages:** nql

**Files:**
- `packages/nql/src/lexer/tokens.ts` — Add `FLAT` token, remove `WITH` token
- `packages/nql/src/parser/grammar.ts` — Add `flat_clause`, remove `with_clause` entirely
- `packages/nql/src/parser/ast.ts` — Add `FlatModifier` AST node, remove `WithClause`

**Exit criteria:**
- [ ] `FLAT` token recognized by lexer
- [ ] `| flat` parses successfully
- [ ] `| with posts` throws parse error (not recognized)
- [ ] Unit tests for new grammar

### Block 2: Compiler — Relation Path Detection — 1h
**Type:** Compiler modification
**Dependencies:** Block 1
**Packages:** nql

**Files:**
- `packages/nql/src/compiler/index.ts` — Detect relation segments in paths
- `packages/nql/src/compiler/include-detector.ts` — New: extract relations from select list

**Exit criteria:**
- [ ] `posts.title` detected as relation "posts"
- [ ] `posts.comments.content` detected as ["posts", "comments"]
- [ ] `IncludeIntent` emitted with strategy based on `| flat` presence
- [ ] Compiler tests pass

### Block 3: Adapter — Strategy Enforcement — 1h
**Type:** Adapter modification
**Dependencies:** Block 2
**Packages:** adapter-kysely

**Files:**
- `packages/adapter-kysely/src/compiler.ts` — Respect `strategy` field on IncludeIntent
- `packages/adapter-kysely/src/compiler/handlers/include/json-agg.ts` — Ensure default
- `packages/adapter-kysely/src/compiler/handlers/include/join.ts` — Force when strategy=join

**Exit criteria:**
- [ ] `strategy: 'auto'` → json_agg (default)
- [ ] `strategy: 'join'` → LEFT JOIN
- [ ] Dialect fallback when json_agg not supported
- [ ] Integration tests pass

### Block 4: REPL Output Command — 45min
**Type:** New feature
**Dependencies:** None (parallel with Block 1-3)
**Packages:** cli

**Files:**
- `packages/cli/src/repl/commands.ts` — Add `.output` handler
- `packages/cli/src/repl/output-formatter.ts` — New: JSON/table/CSV formatters
- `packages/cli/src/repl/context.ts` — Add `outputMode` to session state

**Exit criteria:**
- [ ] `.output json|table|csv` changes mode
- [ ] `.output` shows current mode
- [ ] Nested JSON flattens correctly for table/csv
- [ ] REPL tests pass

### Block 5: E2E & Documentation — 30min
**Type:** Testing + docs
**Dependencies:** Blocks 1-4
**Packages:** tests/e2e, docs

**Files:**
- `tests/e2e/nql-v2.1.test.ts` — New E2E test file
- `docs/specs/NQL-EBNF.md` — Update to v2.3 (remove `with`, add `flat`)
- `docs/CLI_USAGE.md` — Document `.output` command
- `TODO_NQL.md` — Mark completed

**Exit criteria:**
- [ ] E2E tests for all BDD scenarios
- [ ] Grammar doc updated
- [ ] CLI usage doc updated
- [ ] All tests pass

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 15 | Lexer (FLAT token), Parser (flat_clause), Compiler (relation detection) |
| Integration | 8 | NQL → IntentAST → SQL compilation |
| E2E | 5 | Full REPL execution with output modes |

### Test Data Requirements

**Fixtures:**
- Blog schema (authors, posts, comments) — existing
- Multi-level nesting (3+ levels) — add fixture

**Mocks:**
- Dialect capabilities (with/without json_agg support)

### Test Files

| File | Tests | Focus |
|------|-------|-------|
| `packages/nql/tests/lexer.test.ts` | +3 | FLAT token |
| `packages/nql/tests/parser.test.ts` | +4 | flat_clause, with parse error |
| `packages/nql/tests/compiler.test.ts` | +8 | relation detection, strategy |
| `packages/adapter-kysely/src/compiler.test.ts` | +5 | strategy enforcement |
| `packages/cli/src/repl/commands.test.ts` | +5 | .output command |
| `tests/e2e/nql-v2.1.test.ts` | +5 | full scenarios |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking change disrupts users | HIGH | MEDIUM | Clear migration guide, search/replace `with` → path expressions |
| json_agg memory pressure on large datasets | MEDIUM | LOW | `\| flat` escape hatch, document limits |
| Dialect without json_agg support | LOW | LOW | Fallback to JOIN with warning |
| Nested path detection edge cases | MEDIUM | MEDIUM | Comprehensive test coverage |
| Relation vs column ambiguity | MEDIUM | LOW | Schema-aware resolver + ERR-AMBIGUOUS-001 |

## 9. Migration Guide

### From NQL v2.0 to v2.1

| Before (v2.0) | After (v2.1) | Notes |
|---------------|--------------|-------|
| `authors \| with posts` | `authors \| select *, posts.*` | Explicit path expression |
| `authors \| with posts \| select name` | `authors \| select name, posts.*` | Combine select + relation |
| N/A | `authors \| select *, posts.* \| flat` | New: force JOIN strategy |
| N/A | `.output table` | New: display format |

### Breaking Change Policy

**No backward compatibility.** The `with` keyword is removed entirely in v2.1.0.

**Migration script (optional):**
```bash
# Find and report queries using 'with'
grep -rn "| with " *.nql *.dbsp
# Manual replacement required: `| with posts` → `| select *, posts.*`
```

## 10. Definition of Done

- [ ] All blocks implemented
- [ ] All 12 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] Grammar doc (NQL-EBNF.md) updated to v2.3
- [ ] CLI usage doc updated with `.output` command
- [ ] TODO_NQL.md updated
- [ ] /review clean (no blocking findings)

## 11. Deferred Items

| Item | Reason | Track In |
|------|--------|----------|
| `batch(N)` streaming | Database-dependent, needs separate design | TODO_NQL.md |
| Cursor support | Complex, dialect-specific | TODO_NQL.md |
| Per-relation pagination | Requires subquery strategy | TODO_NQL.md |
| `.output raw` (no formatting) | Nice-to-have | TODO_CLI.md |

## Appendix A: LLM Review Summary

### Codex (gpt-5.2-codex)

> "json_agg is great for small/medium nested reads and a clean mental model, but it's a risky universal default for large sets. Keep it as default but add escape hatch and safety limits."

**Key points:**
- json_agg materializes full aggregate before returning
- Cursor doesn't help with json_agg
- Need explicit opt-out (`| flat`)
- Add guardrails (max depth, limits)

### Gemini

> "If NQL forces flat SQL-style joins, it stops being a faithful representation of the ORM's intent. JSON output is significantly more human-readable for hierarchical data."

**Key points:**
- Concerns were about JOINs (Proposal 1), resolved by json_agg default (Proposal 2)
- Mental model alignment between ORM and NQL important
- JSON better for CLI readability

### Claude

**Key points:**
- Flatten JSON → trivial (O(n))
- Reconstruct tree from flat → complex
- json_agg default + `| flat` escape hatch is optimal balance
