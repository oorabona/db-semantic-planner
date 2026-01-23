---
doc-meta:
  status: canonical
  scope: cli
  type: audit
  created: 2026-01-23
  author: claude-opus-4-5
  complexity: ENTERPRISE
---

# NQL Parser Audit & Improvement Roadmap

## Executive Summary

This document presents a comprehensive audit of the Natural Query Language (NQL) parser in `@dbsp/cli`, comparing the formal EBNF grammar specification against the actual implementation. It identifies critical gaps, structural issues, and provides a detailed roadmap for improvements including architectural recommendations for Phase 3 refactoring.

**🤖 Multi-LLM Collaborative Review (2026-01-23):**
This audit was cross-validated by three independent LLM analyses:
- **Claude Opus 4.5** - Initial comprehensive audit
- **Google Gemini 2.5 Pro** - Agentic codebase exploration
- **OpenAI Codex gpt-5.2** - Deep EBNF rule-by-rule analysis (191k tokens)

**Key Findings:**
- 67% of EBNF productions fully implemented
- 7 critical features missing (OR, parentheses, arithmetic, CASE, etc.)
- **6 additional bugs** identified by Codex (BUG-08 to BUG-13)
- Structural issues in tokenizer and parser architecture causing recurring bugs
- **Consensus:** All 3 LLMs recommend incremental refactor over full rewrite
- **Documentation outdated:** Gemini found many "missing" features are actually implemented

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Flow Documentation](#2-flow-documentation)
3. [EBNF Conformance Audit](#3-ebnf-conformance-audit)
4. [Gap Analysis](#4-gap-analysis)
5. [Structural Issues](#5-structural-issues)
6. [Grammar Improvement Recommendations](#6-grammar-improvement-recommendations)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Phase 3 Architecture Decisions](#8-phase-3-architecture-decisions)
9. [Appendices](#9-appendices)
10. [Multi-LLM Collaborative Analysis](#10-multi-llm-collaborative-analysis)
11. [NQL v2.0 Language Design](#11-nql-v20-language-design) ⭐ NEW

---

## 1. Architecture Overview

### 1.1 Current Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INPUT                                      │
│  "products where category.name = 'Electronics' include tags limit 10"       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
         ┌──────────────────┐                ┌──────────────────┐
         │   TOKENIZER      │                │   COMMAND        │
         │   (parser.ts)    │                │   HANDLER        │
         │   Line 1509      │                │   (.help, .use)  │
         └────────┬─────────┘                └──────────────────┘
                  │
                  ▼
         ┌──────────────────┐
         │   PARSER         │
         │   (parser.ts)    │
         │   Line 2407      │
         │                  │
         │   parseNatural   │
         │   Query()        │
         └────────┬─────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│ ParsedQuery   │   │ParsedMutation │
│ {             │   │ {             │
│   table,      │   │   type,       │
│   where,      │   │   table,      │
│   include,    │   │   assignments,│
│   select,     │   │   where,      │
│   orderBy,    │   │   fromClause  │
│   groupBy,    │   │ }             │
│   limit       │   └───────┬───────┘
│ }             │           │
└───────┬───────┘           │
        │                   │
        └─────────┬─────────┘
                  ▼
         ┌──────────────────┐
         │   EXECUTOR       │
         │ (query-executor) │
         │   Line 532       │
         │                  │
         │  Transforms to   │
         │  IntentAST       │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │   ORM BUILDER    │
         │   (@dbsp/core)   │
         │                  │
         │  orm.select()    │
         │     .where()     │
         │     .include()   │
         │     .dump()      │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │   ADAPTER        │
         │ (adapter-kysely) │
         │                  │
         │  Compiles to SQL │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │   SQL OUTPUT     │
         │                  │
         │  + Parameters    │
         │  + Plan Report   │
         └──────────────────┘
```

### 1.2 File Locations

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Tokenizer | `packages/cli/src/repl/parser.ts` | 1509-1606 | String → Token[] |
| Parser | `packages/cli/src/repl/parser.ts` | 2407-2847 | Token[] → ParsedQuery |
| Types | `packages/cli/src/repl/types.ts` | 1-440 | Type definitions |
| Executor | `packages/cli/src/repl/query-executor.ts` | 532-729 | ParsedQuery → IntentAST |
| Tests | `packages/cli/src/repl/parser.test.ts` | 1-4055 | 276 test cases |

---

## 2. Flow Documentation

### 2.1 Tokenization Phase

**Entry:** `tokenize(input: string): string[]` (line 1509)

**Algorithm:**
```
1. Initialize: currentToken = '', tokens = [], inQuote = false
2. For each character:
   a. If whitespace and not in quote → flush token
   b. If quote character → toggle quote state, preserve " for identifiers
   c. If comma → SKIP (destructive - see Issue #5.1)
   d. If operator char (=, <, >, !) → check for multi-char (!=, >=, <=)
   e. If [ → start range mode until ] or )
   f. Otherwise → append to currentToken
3. Return tokens array
```

**Transformations:**

| Input | Output | Notes |
|-------|--------|-------|
| `where active = true` | `["where", "active", "=", "true"]` | Space-split |
| `"quoted col"` | `["\"quoted col\""]` | Quotes preserved |
| `'string val'` | `["string val"]` | Quotes stripped |
| `category.parent.name` | `["category.parent.name"]` | Path kept whole |
| `[2024-01-01, 2024-12-31)` | `["[2024-01-01, 2024-12-31)"]` | Range literal |
| `id, name, email` | `["id", "name", "email"]` | ⚠️ Commas stripped |

### 2.2 Parsing Phase

**Entry:** `parseNaturalQuery(input: string, schema: ResolvedSchema): ParsedQuery | ParsedMutation`

**Strategy:** Linear token consumption with keyword-driven dispatch (NOT recursive descent)

```typescript
// Simplified structure (line 2407-2847)
const tokens = tokenize(input);
const tableName = tokens[0];
let i = 1;

// Check for mutation keywords
if (isMutationKeyword(tokens[1])) {
  return parseMutation(input, schema);
}

// Query parsing loop
while (i < tokens.length) {
  const token = tokens[i]?.toLowerCase();

  switch (token) {
    case 'where':   /* parse WHERE conditions */ break;
    case 'include': /* parse INCLUDE chain */ break;
    case 'select':  /* parse SELECT columns */ break;
    case 'order':   /* parse ORDER BY */ break;
    case 'group':   /* parse GROUP BY */ break;
    case 'having':  /* parse HAVING */ break;
    case 'limit':   /* parse LIMIT */ break;
    case 'offset':  /* parse OFFSET */ break;
    case 'and':     /* continue previous clause */ break;
    default:        throw ParseError(`Unexpected: ${token}`);
  }
}
```

### 2.3 Execution Phase

**Entry:** `executeQuery(query: ParsedQuery, schema: ResolvedSchema): QueryExecutionResult`

**Key Transformations:**

| ParsedQuery Field | Executor Function | IntentAST Output |
|-------------------|-------------------|------------------|
| `where[].column` (simple) | `createComparisonFilter()` | `WhereComparisonIntent` |
| `where[].column` (path) | `pathToRelationFilter()` | `WhereRelationFilterIntent` (nested) |
| `where[].value` (subquery) | `subqueryToWhereIntent()` | `WhereSubqueryIntent` |
| `existenceChecks[]` | `existenceCheckToIntent()` | `WhereExistsIntent` / `WhereNotExistsIntent` |
| `include[]` | Direct ORM `.include()` | Join strategy in planner |
| `columns[]` (path) | `relationColumn()` | Auto-JOIN with column selection |

### 2.4 Complete Example Trace

**Input:** `products where category.parent.name = 'Electronics' include tags limit 5`

```
TOKENIZE:
  → ["products", "where", "category.parent.name", "=", "'Electronics'",
     "include", "tags", "limit", "5"]

PARSE:
  i=0: tableName = "products"
  i=1: token="where"
    i=2: parseWhereCondition(tokens, 2)
      column = "category.parent.name"
      operator = "="
      value = "Electronics"
      → { column, operator, value }, nextIndex=5
  i=5: token="include"
    i=6: parseIncludeChain(tokens, 6, "products", schema)
      relation = "tags"
      → [{ relation: "tags" }], nextIndex=7
  i=7: token="limit"
    i=8: limit = parseInt("5") = 5

  → ParsedQuery {
      table: "products",
      where: [{ column: "category.parent.name", operator: "=", value: "Electronics" }],
      include: [{ relation: "tags" }],
      limit: 5
    }

EXECUTE:
  1. whereClauseToFilter({ column: "category.parent.name", ... })
  2. isPathExpression("category.parent.name") → true
  3. pathToRelationFilter() builds nested structure:
     → WhereRelationFilterIntent {
         relation: "category",
         where: WhereRelationFilterIntent {
           relation: "parent",
           where: WhereComparisonIntent {
             field: "name",
             operator: "eq",
             value: "Electronics"
           }
         }
       }
  4. ORM builder chain:
     orm.select("products")
        .where(relationFilter)
        .include("tags")
        .limit(5)
        .dump()

SQL OUTPUT:
  SELECT "t0".* FROM "products" "t0"
  LEFT JOIN "categories" "t1" ON "t0"."categoryId" = "t1"."id"
  LEFT JOIN "categories" "t2" ON "t1"."parentId" = "t2"."id"
  WHERE "t2"."name" = $1
  LIMIT $2

  params: ['Electronics', 5]
```

---

## 3. EBNF Conformance Audit

### 3.1 Grammar Reference

The formal grammar is defined in `docs/plans/CLI-NQL-natural-query-language.md` (lines 190-372).

### 3.2 Conformance Matrix

| Production | Grammar Line | Parser Location | Status | Notes |
|------------|--------------|-----------------|--------|-------|
| `statement` | 200 | 2407 | ✅ | Entry point |
| `table_statement` | 201 | 2418 | ✅ | Table name extraction |
| `query_body` | 208 | 2440-2786 | ✅ | Main query loop |
| `where_clause` | 214 | 2444-2484 | ⚠️ | Missing OR, parentheses |
| `boolean_expr` | 242 | - | ❌ | Not implemented |
| `or_term` | 243 | - | ❌ | Not implemented |
| `and_factor` | 244 | 2476 | ⚠️ | Only AND, no NOT prefix |
| `primary_condition` | 245 | - | ❌ | No parentheses support |
| `condition_atom` | 247 | 1749 | ✅ | parseWhereCondition |
| `comparison` | 249 | 1749-1849 | ✅ | All operators |
| `comp_op` | 250 | 1771-1818 | ✅ | Full operator set |
| `in_check` | 252 | 1804-1841 | ⚠️ | Subquery only, no literal list |
| `literal_list` | 253 | - | ❌ | Not implemented |
| `existence_check` | 264-265 | 488-621 | ✅ | Both forms |
| `path_expr` | 273 | 156-181 | ✅ | N-level paths |
| `path_segment` | 274 | 128-138 | ✅ | Quoted/unquoted |
| `subquery` | 280 | 255-389 | ✅ | Full support |
| `include_clause` | 286 | 2487-2501 | ✅ | With nesting |
| `select_clause` | 292 | 2619-2711 | ✅ | Columns, aggregates |
| `aggregate_expr` | 298 | 1683-1744 | ✅ | count/sum/avg/min/max |
| `window_expr` | 304 | 2130-2189 | ✅ | Full OVER support |
| `group_clause` | 313 | 2714-2740 | ✅ | GROUP BY |
| `having_clause` | 314 | 2742-2774 | ✅ | HAVING |
| `order_clause` | 316 | 2533-2579 | ✅ | ORDER BY |
| `limit_clause` | 320 | 2503-2515 | ✅ | LIMIT |
| `offset_clause` | 321 | 2517-2531 | ✅ | OFFSET |
| `mutation_body` | 325 | 1360-1395 | ✅ | Dispatch |
| `insert_body` | 326 | 852-902 | ✅ | With FROM clause |
| `from_clause` | 327 | 904-1037 | ✅ | FK lookup, bulk |
| `update_body` | 331 | 1044-1128 | ✅ | SET + WHERE |
| `delete_body` | 332 | 1132-1198 | ✅ | WHERE required |
| `upsert_body` | 333 | 1202-1356 | ✅ | ON CONFLICT |
| `expr` | 345 | - | ❌ | Not implemented |
| `add_expr` | 346 | - | ❌ | Not implemented |
| `mul_expr` | 347 | - | ❌ | Not implemented |
| `function_call` | 350 | 710-711 | ⚠️ | Mutations only |
| `case_expr` | 352 | - | ❌ | Not implemented |

### 3.3 Summary Statistics

```
Total Productions:     ~45
Fully Implemented:     ~30 (67%)
Partially Implemented: ~8  (18%)
Not Implemented:       ~7  (15%)
```

---

## 4. Gap Analysis

### 4.1 Critical Gaps (Breaking BDD Scenarios)

#### GAP-01: OR Operator

**Grammar:**
```ebnf
boolean_expr = or_term { "or" or_term } ;
```

**Current Behavior:**
```
Input:  products where id = 1 or id = 2
Error:  ParseError: Unexpected token: "or"
```

**Impact:** Cannot express disjunctive conditions. BDD scenario SC-27 fails.

**Location:** Parser only handles `and` at line 2476.

---

#### GAP-02: Parenthesized Boolean Expressions

**Grammar:**
```ebnf
primary_condition = LPAREN boolean_expr RPAREN | condition_atom ;
```

**Current Behavior:**
```
Input:  products where (category = 'A' or category = 'B') and active = true
Error:  ParseError: Expected operator after "("
```

**Impact:** Cannot control operator precedence. Critical for complex queries.

**Location:** `parseWhereCondition()` (line 1749) has no LPAREN branch.

---

#### GAP-03: Arithmetic Expressions

**Grammar:**
```ebnf
expr     = add_expr ;
add_expr = mul_expr { ( PLUS | MINUS | "||" ) mul_expr } ;
mul_expr = unary_expr { ( STAR | SLASH | PERCENT ) unary_expr } ;
```

**Current Behavior:**
```
Input:  products update set price = price * 0.9 where sale = true
Error:  ParseError: Unknown operator: *
```

**Impact:** Cannot express calculated values. BDD scenarios SC-29, SC-32 fail.

**Location:** Operators tokenized (1570-1595) but never parsed as expressions.

---

#### GAP-04: CASE Expressions

**Grammar:**
```ebnf
case_expr   = "case" { when_clause } [ else_clause ] "end" ;
when_clause = "when" boolean_expr "then" expr ;
else_clause = "else" expr ;
```

**Current Behavior:**
```
Input:  products update set status = case when stock > 0 then 'in_stock' else 'out' end
Error:  ParseError: Unexpected token: "case"
```

**Impact:** Cannot express conditional logic. BDD scenarios SC-29, SC-32 fail.

**Location:** No `parseCaseExpression()` function exists.

---

#### GAP-05: IN with Literal List

**Grammar:**
```ebnf
in_check     = path_expr [ "not" ] "in" ( subquery | literal_list ) ;
literal_list = LPAREN literal { COMMA literal } RPAREN ;
```

**Current Behavior:**
```
Input:  products where id in (1, 2, 3)
Result: Tokenizer strips commas → becomes ["id", "in", "(1", "2", "3)"]
Error:  Parsing fails
```

**Impact:** Must use subqueries for simple value lists. Inconvenient.

**Location:** Tokenizer line 1593 strips commas; no `parseLiteralList()`.

---

#### GAP-06: Functions in WHERE Conditions

**Grammar:**
```ebnf
function_call = IDENT LPAREN [ expr_list ] RPAREN ;
```

**Current Behavior:**
```
Input:  products where length(name) > 10
Error:  ParseError on "(" - tries to parse as column
```

**Impact:** Cannot use SQL functions in conditions.

**Location:** `parseWhereCondition()` doesn't detect function call pattern.

---

#### GAP-07: Comma Enforcement (INV-07)

**Grammar Invariant:**
```
INV-07: List separators (commas) are mandatory for select, order, assignments, group by, includes
```

**Current Behavior:**
```
Input:  products select id name email  (no commas)
Result: Parses successfully - commas optional
```

**Impact:** Grammar violation. Cannot enforce strict syntax.

**Location:** Tokenizer line 1593: `if (char === ',') continue;`

---

### 4.2 Partial Implementations

| Feature | What Works | What's Missing |
|---------|------------|----------------|
| NOT operator | `not has`, `not in`, `is not` | `not (condition)` |
| Function calls | In mutations (raw pass-through) | Argument parsing, WHERE usage |
| Quoted identifiers | Parsing, executor resolution | Parser-level enforcement |
| Range operators | `overlaps`, `contains`, `containedBy` | Case consistency |

### 4.3 Impact Assessment

| Gap | Severity | Workaround | BDD Impact |
|-----|----------|------------|------------|
| OR operator | 🔴 Critical | Multiple queries | SC-27 FAIL |
| Parentheses | 🔴 Critical | None | SC-27 FAIL |
| Arithmetic | 🔴 Critical | Raw SQL escape | SC-29, SC-32 FAIL |
| CASE | 🔴 Critical | Raw SQL escape | SC-29, SC-32 FAIL |
| IN literals | 🟡 Medium | Use subquery | Inconvenient |
| WHERE functions | 🟡 Medium | Use subquery/raw | Limited |
| Comma enforce | 🟢 Low | Documentation | Style only |

---

## 5. Structural Issues

### 5.1 Destructive Tokenization

**Problem:** Commas are stripped during tokenization.

```typescript
// parser.ts:1593
if (char === ',') continue;  // Commas destroyed
```

**Consequences:**
1. Cannot enforce mandatory comma separators (INV-07)
2. Cannot distinguish `IN (1, 2, 3)` from `IN (1 2 3)`
3. Grammar compliance impossible

**Root Cause:** Design decision to treat commas as whitespace.

---

### 5.2 Linear vs Recursive Parsing

**Problem:** Parser uses linear token consumption, not recursive descent.

```typescript
// Current: Linear switch-case
while (i < tokens.length) {
  switch (token) {
    case 'where': /* consume tokens */ break;
    case 'and':   /* consume more */ break;
  }
}

// Needed: Recursive descent for expressions
function parseBooleanExpr(): BooleanExpr {
  let left = parseOrTerm();
  while (match('or')) {
    left = { type: 'or', left, right: parseOrTerm() };
  }
  return left;
}
```

**Consequences:**
1. Cannot handle nested expressions `(a AND (b OR c))`
2. Cannot implement operator precedence properly
3. Adding new expression types requires invasive changes

---

### 5.3 Parser-Schema Coupling

**Problem:** Many parsing functions require schema parameter.

```typescript
// Schema required for validation
parseExistenceCheck(tokens, i, schema, tableName)  // Schema needed
parseIncludeChain(tokens, i, tableName, schema, filters)  // Schema needed
```

**Consequences:**
1. Cannot parse without valid schema
2. Unit testing requires mock schemas
3. Parsing and validation conflated

**Better Pattern:** Parse first (syntax), validate later (semantics).

---

### 5.4 Deferred Filter Distribution

**Problem:** Qualified filters stored then distributed post-parsing.

```typescript
// During parsing
const pendingQualifiedFilters: QualifiedFilter[] = [];
// e.g., "category.name = 'X'" stored as pending

// After main loop (lines 2790-2844)
for (const qf of pendingQualifiedFilters) {
  if (qf.targetTable === result.table) {
    result.where.push(qf.clause);  // Main WHERE
  } else if (relationExists) {
    result.include.push({ relation: qf.targetTable, where: [qf.clause] });  // Include
  }
}
```

**Consequences:**
1. Complex logic prone to bugs (multiple bugfixes in this area)
2. Filter placement depends on include order
3. Hard to reason about final query structure

---

### 5.5 Inconsistent Error Handling

**Problem:** Error messages vary in quality and position tracking.

```typescript
// Good: Position included
throw new ParseError(`Invalid limit: "${token}"`, i);

// Bad: No position
throw new ParseError(`Expected column after WHERE`);

// Inconsistent: Sometimes uses token index, sometimes character position
```

**Consequences:**
1. Difficult debugging for users
2. IDE integration limited
3. No error recovery possible

---

## 6. Grammar Improvement Recommendations

### 6.1 Simplifications

#### R-01: Unify Boolean Expression Handling

**Current (fragmented):**
```ebnf
where_clause = "where" condition { "and" condition } ;
condition = comparison | existence_check | in_check ;
```

**Proposed (unified):**
```ebnf
where_clause = "where" boolean_expr ;
boolean_expr = or_expr ;
or_expr      = and_expr { "or" and_expr } ;
and_expr     = not_expr { "and" not_expr } ;
not_expr     = [ "not" ] primary_expr ;
primary_expr = "(" boolean_expr ")" | atom ;
atom         = comparison | existence | in_expr ;
```

**Benefits:**
- Single recursive descent function
- Proper precedence: NOT > AND > OR
- Parentheses naturally supported

---

#### R-02: Explicit Expression Grammar

**Proposed:**
```ebnf
expr         = ternary_expr ;
ternary_expr = or_expr [ "?" expr ":" expr ] ;  (* Future: ternary *)
or_expr      = and_expr { "or" and_expr } ;
and_expr     = cmp_expr { "and" cmp_expr } ;
cmp_expr     = add_expr [ comp_op add_expr ] ;
add_expr     = mul_expr { ( "+" | "-" | "||" ) mul_expr } ;
mul_expr     = unary_expr { ( "*" | "/" | "%" ) unary_expr } ;
unary_expr   = [ "-" | "not" ] postfix_expr ;
postfix_expr = primary_expr { call_suffix | index_suffix } ;
primary_expr = literal | path | "(" expr ")" | case_expr | subquery ;

call_suffix  = "(" [ expr { "," expr } ] ")" ;
index_suffix = "[" expr "]" ;  (* Future: array indexing *)
```

**Benefits:**
- Standard expression parsing
- Easy to extend with new operators
- Proper precedence encoded in grammar

---

#### R-03: Preserve Tokens, Validate Later

**Current:** Tokenizer makes semantic decisions (strips commas).

**Proposed:** Tokenizer produces ALL tokens:
```typescript
type Token = {
  type: 'IDENT' | 'STRING' | 'NUMBER' | 'OPERATOR' | 'COMMA' | 'LPAREN' | 'RPAREN' | ...;
  value: string;
  position: { line: number; column: number; offset: number };
};
```

**Benefits:**
- Grammar enforcement possible
- Better error messages with positions
- Syntax highlighting support

---

### 6.2 Extensions

#### R-04: Add RETURNING Clause

```ebnf
returning_clause = "returning" ( "*" | column_list ) ;
insert_body = "insert" assignments [ from_clause ] [ returning_clause ] [ "!" ] ;
update_body = "update" "set" assignments where_clause [ returning_clause ] [ "!" ] ;
delete_body = "delete" where_clause [ returning_clause ] [ "!" ] ;
```

---

#### R-05: Add Common Table Expressions (WITH)

```ebnf
statement = [ with_clause ] ( query | mutation ) ;
with_clause = "with" cte_def { "," cte_def } ;
cte_def = IDENT "as" "(" query ")" ;
```

**Example:**
```
with active_users as (users where active = true)
products where authorId in (active_users select id)
```

---

#### R-06: Add Set Operations

```ebnf
query = simple_query [ set_op simple_query ] ;
set_op = "union" [ "all" ] | "intersect" | "except" ;
```

---

### 6.3 Clarifications

#### R-07: Document Precedence Rules

Add explicit precedence table to grammar:

| Precedence | Operators | Associativity |
|------------|-----------|---------------|
| 1 (lowest) | OR | Left |
| 2 | AND | Left |
| 3 | NOT | Right (prefix) |
| 4 | =, !=, <, >, <=, >=, LIKE, IN, IS | Non-assoc |
| 5 | +, -, \|\| | Left |
| 6 | *, /, % | Left |
| 7 | - (unary), NOT | Right (prefix) |
| 8 (highest) | (), function call | Left |

---

#### R-08: Formalize Identifier Rules

```ebnf
IDENT  = LETTER { LETTER | DIGIT | "_" } ;
QIDENT = '"' { CHAR - '"' | '\"' } '"' ;  (* Escaped quotes *)

(* Resolution order for unquoted IDENT *)
(* 1. If matches reserved keyword → keyword *)
(* 2. If matches relation in current context → relation reference *)
(* 3. Otherwise → column reference *)

(* QIDENT always resolves to column/identifier, never keyword/relation *)
```

---

## 7. Implementation Roadmap

### 7.1 Phase 1: Critical Fixes (2-3 days)

**Goal:** Pass all BDD scenarios. Minimal invasive changes.

| Task | File | Function | Effort | Priority |
|------|------|----------|--------|----------|
| P1-01: Implement OR | parser.ts | `parseWhereClause()` | S | 🔴 |
| P1-02: Implement parentheses | parser.ts | `parseWhereCondition()` | M | 🔴 |
| P1-03: IN literal list | parser.ts | `parseInExpression()` | S | 🔴 |
| P1-04: Preserve commas | parser.ts | `tokenize()` | S | 🟡 |

**P1-01: OR Implementation**

```typescript
// In parseWhereClause() around line 2444
case 'where': {
  i++;
  const conditions: WhereClause[] = [];
  const orGroups: WhereClause[][] = [];

  while (i < tokens.length) {
    // Parse condition
    const { clause, nextIndex } = parseWhereCondition(tokens, i);
    conditions.push(clause);
    i = nextIndex;

    const nextToken = tokens[i]?.toLowerCase();
    if (nextToken === 'and') {
      i++;
      continue;
    } else if (nextToken === 'or') {
      i++;
      orGroups.push([...conditions]);
      conditions.length = 0;
      continue;
    } else {
      break;
    }
  }

  if (orGroups.length > 0) {
    orGroups.push(conditions);
    result.whereOr = orGroups;  // New field for OR groups
  } else {
    result.where = conditions;
  }
}
```

**P1-02: Parentheses Implementation**

```typescript
// In parseWhereCondition() at line 1749
function parseWhereCondition(tokens: string[], index: number): ParseResult {
  // Check for opening parenthesis
  if (tokens[index] === '(') {
    return parseParenthesizedCondition(tokens, index);
  }
  // ... existing logic
}

function parseParenthesizedCondition(tokens: string[], index: number): ParseResult {
  let i = index + 1;  // Skip '('
  const conditions: WhereClause[] = [];
  const orGroups: WhereClause[][] = [];
  let depth = 1;

  while (i < tokens.length && depth > 0) {
    if (tokens[i] === '(') depth++;
    if (tokens[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
    // Parse inner conditions with AND/OR
    // ... similar to P1-01
  }

  return {
    clause: { type: 'group', conditions, orGroups },
    nextIndex: i + 1
  };
}
```

---

### 7.2 Phase 2: Expression Support (1-2 weeks)

**Goal:** Full arithmetic and CASE expression support.

| Task | Description | Effort | Priority |
|------|-------------|--------|----------|
| P2-01: Expression parser | Recursive descent for expr grammar | L | 🔴 |
| P2-02: CASE expression | case/when/then/else/end | M | 🔴 |
| P2-03: Function calls | IDENT "(" args ")" in expressions | M | 🟡 |
| P2-04: Unary operators | -expr, NOT expr | S | 🟡 |

**P2-01: Expression Parser Architecture**

```typescript
// New file: packages/cli/src/repl/expression-parser.ts

export interface Expr {
  type: 'literal' | 'column' | 'binary' | 'unary' | 'call' | 'case' | 'subquery';
}

export interface BinaryExpr extends Expr {
  type: 'binary';
  operator: '+' | '-' | '*' | '/' | '%' | '||' | 'and' | 'or' | '=' | '!=' | ...;
  left: Expr;
  right: Expr;
}

export interface CaseExpr extends Expr {
  type: 'case';
  whens: { condition: Expr; result: Expr }[];
  else?: Expr;
}

// Recursive descent parser
export function parseExpr(tokens: Token[], index: number): { expr: Expr; nextIndex: number } {
  return parseOrExpr(tokens, index);
}

function parseOrExpr(tokens: Token[], index: number): ParseResult<Expr> {
  let { expr: left, nextIndex: i } = parseAndExpr(tokens, index);

  while (tokens[i]?.value.toLowerCase() === 'or') {
    i++;
    const { expr: right, nextIndex } = parseAndExpr(tokens, i);
    left = { type: 'binary', operator: 'or', left, right };
    i = nextIndex;
  }

  return { expr: left, nextIndex: i };
}

function parseAndExpr(tokens: Token[], index: number): ParseResult<Expr> {
  // Similar pattern...
}

// Continue with precedence levels...
```

---

### 7.3 Phase 3: Architecture Refactoring (2-4 weeks)

**Goal:** Clean separation of concerns, maintainable codebase.

See [Section 8](#8-phase-3-architecture-decisions) for detailed analysis.

---

## 8. Phase 3 Architecture Decisions

### 8.1 Decision Framework

| Approach | Effort | Risk | Maintainability | Performance |
|----------|--------|------|-----------------|-------------|
| A: Incremental Refactor | M | Low | Medium | Same |
| B: Internal Rewrite | XL | Medium | High | Same |
| C: External Parser Lib | L-M | Medium | High | Better |
| D: Parser Generator | M | Low | Very High | Better |

### 8.2 Option A: Incremental Refactor

**Description:** Keep current architecture, fix specific issues.

**Changes:**
1. Extract tokenizer to separate module
2. Add proper Token type with positions
3. Refactor parseWhereCondition to be recursive
4. Separate parsing from validation

**Pros:**
- Low risk, can be done gradually
- No new dependencies
- Preserves existing tests

**Cons:**
- Doesn't solve fundamental linear parsing issue
- Technical debt accumulates
- Limited extensibility

**Effort:** M (2-3 weeks)

**Recommendation:** ✅ Good for short-term. Do this first.

---

### 8.3 Option B: Internal Rewrite

**Description:** Rewrite parser from scratch using proper recursive descent.

**Architecture:**
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Lexer     │ ──▶ │   Parser    │ ──▶ │  Validator  │
│             │     │  (RD)       │     │  (Semantic) │
│ string→     │     │ Token[]→    │     │ AST→        │
│ Token[]     │     │ AST         │     │ ValidAST    │
└─────────────┘     └─────────────┘     └─────────────┘
```

**Implementation:**

```typescript
// lexer.ts - Clean tokenization
export interface Token {
  type: TokenType;
  value: string;
  pos: Position;
}

export function lex(input: string): Token[] {
  // Proper lexer with position tracking
}

// parser.ts - Pure recursive descent
export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  parse(): AST {
    return this.parseStatement();
  }

  private parseStatement(): Statement {
    if (this.check('DOT')) return this.parseCommand();
    return this.parseTableStatement();
  }

  private parseExpr(): Expr {
    return this.parseOrExpr();
  }

  private parseOrExpr(): Expr {
    let left = this.parseAndExpr();
    while (this.match('OR')) {
      left = new BinaryExpr('or', left, this.parseAndExpr());
    }
    return left;
  }

  // ... etc
}

// validator.ts - Semantic analysis
export function validate(ast: AST, schema: Schema): ValidatedAST {
  // Check table exists
  // Check columns exist
  // Check relations valid
  // Check types compatible
}
```

**Pros:**
- Clean architecture
- Proper separation of concerns
- Easy to extend
- Better error messages

**Cons:**
- High effort (XL)
- Risk of introducing bugs
- Need to rewrite all tests
- Parallel maintenance during transition

**Effort:** XL (4-6 weeks)

**Recommendation:** ⚠️ Consider only if major grammar extensions planned.

---

### 8.4 Option C: External Parser Library

**Description:** Use established parsing library for expression handling.

**Candidates:**

| Library | Type | Size | Stars | Pros | Cons |
|---------|------|------|-------|------|------|
| [chevrotain](https://chevrotain.io/) | Parser combinator | 180KB | 2.3K | Fast, TypeScript, great errors | Learning curve |
| [nearley](https://nearley.js.org/) | Earley parser | 50KB | 3.5K | Any grammar, easy | Slower |
| [ohm-js](https://ohmjs.org/) | PEG | 200KB | 4.8K | Beautiful syntax, incremental | Different paradigm |
| [moo](https://github.com/no-context/moo) | Lexer only | 15KB | 800 | Tiny, fast | Only lexing |
| [peggy](https://peggyjs.org/) | PEG | 100KB | 800 | PEG.js successor | Bundle size |

**Recommended: Chevrotain**

Why Chevrotain:
1. **TypeScript-first** - Native types, no codegen
2. **Performance** - Faster than PEG parsers
3. **Error recovery** - Built-in mechanisms
4. **Incremental** - Can parse parts independently
5. **Active** - Well maintained

**Implementation Sketch:**

```typescript
// nql-grammar.ts
import { createToken, Lexer, CstParser } from 'chevrotain';

// Tokens
const Select = createToken({ name: 'Select', pattern: /select/i });
const Where = createToken({ name: 'Where', pattern: /where/i });
const And = createToken({ name: 'And', pattern: /and/i });
const Or = createToken({ name: 'Or', pattern: /or/i });
const Identifier = createToken({ name: 'Identifier', pattern: /[a-zA-Z_][a-zA-Z0-9_]*/ });
// ... more tokens

const allTokens = [WhiteSpace, Select, Where, And, Or, /* ... */, Identifier];
const NqlLexer = new Lexer(allTokens);

// Parser
class NqlParser extends CstParser {
  constructor() {
    super(allTokens);
    this.performSelfAnalysis();
  }

  statement = this.RULE('statement', () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.command) },
      { ALT: () => this.SUBRULE(this.tableStatement) }
    ]);
  });

  whereClause = this.RULE('whereClause', () => {
    this.CONSUME(Where);
    this.SUBRULE(this.booleanExpr);
  });

  booleanExpr = this.RULE('booleanExpr', () => {
    this.SUBRULE(this.andExpr);
    this.MANY(() => {
      this.CONSUME(Or);
      this.SUBRULE2(this.andExpr);
    });
  });

  // ... more rules matching EBNF exactly
}

// Visitor to build AST
class NqlVisitor extends BaseCstVisitor {
  statement(ctx: any): Statement {
    if (ctx.command) return this.visit(ctx.command);
    return this.visit(ctx.tableStatement);
  }

  booleanExpr(ctx: any): BooleanExpr {
    const terms = ctx.andExpr.map((t: any) => this.visit(t));
    if (terms.length === 1) return terms[0];
    return { type: 'or', terms };
  }
}
```

**Migration Strategy:**

```
Week 1: Add chevrotain, implement expression parser only
        Keep existing parser for statements

Week 2: Route expression parsing through chevrotain
        Existing: parseWhereCondition → new: chevrotain expr parser

Week 3: Migrate WHERE clause parsing
        Existing: parseNaturalQuery → hybrid

Week 4: Migrate remaining clauses
        Full chevrotain parser

Week 5: Remove old parser code
        Cleanup
```

**Pros:**
- Battle-tested parsing
- Grammar-driven (matches EBNF)
- Excellent error messages
- CST/AST separation built-in

**Cons:**
- New dependency (180KB)
- Team learning curve
- Different debugging experience

**Effort:** M (2-3 weeks for hybrid, 4-5 for full)

**Recommendation:** ✅ **Best option for medium-term**. Start with expression parsing.

---

### 8.5 Option D: Parser Generator

**Description:** Generate parser from grammar definition.

**Tools:**
- [ANTLR4](https://www.antlr.org/) - Industry standard, TypeScript target
- [tree-sitter](https://tree-sitter.github.io/) - Incremental, used by editors
- [langium](https://langium.org/) - TypeScript-native DSL framework

**ANTLR4 Approach:**

1. Write grammar file (`NQL.g4`):
```antlr
grammar NQL;

statement: command | tableStatement;

tableStatement: IDENT statementBody;

statementBody: queryBody | mutationBody;

queryBody: whereClause? includeClause? selectClause?
           groupClause? havingClause? orderClause?
           limitClause? offsetClause?;

whereClause: WHERE booleanExpr;

booleanExpr: orExpr;
orExpr: andExpr (OR andExpr)*;
andExpr: notExpr (AND notExpr)*;
notExpr: NOT? primaryExpr;
primaryExpr: LPAREN booleanExpr RPAREN | atom;

// ... etc

// Lexer rules
WHERE: [Ww][Hh][Ee][Rr][Ee];
AND: [Aa][Nn][Dd];
OR: [Oo][Rr];
IDENT: [a-zA-Z_][a-zA-Z0-9_]*;
STRING: '\'' (~'\'')* '\'';
```

2. Generate TypeScript parser:
```bash
antlr4 -Dlanguage=TypeScript NQL.g4
```

3. Use generated parser:
```typescript
import { NQLLexer, NQLParser, NQLVisitor } from './generated';

const input = "products where category.name = 'Electronics'";
const lexer = new NQLLexer(CharStreams.fromString(input));
const tokens = new CommonTokenStream(lexer);
const parser = new NQLParser(tokens);
const tree = parser.statement();

const visitor = new MyNQLVisitor();
const ast = visitor.visit(tree);
```

**Pros:**
- Grammar IS the source of truth
- Auto-generates lexer + parser
- Proven at scale (used by major languages)
- Great tooling (syntax highlighting, testing)

**Cons:**
- External tool dependency
- Generated code harder to debug
- Build step complexity
- ~400KB runtime

**Effort:** M (3-4 weeks)

**Recommendation:** ⚠️ Consider if grammar will evolve significantly.

---

### 8.6 Recommendation Matrix

| Scenario | Recommended Approach |
|----------|---------------------|
| Fix critical gaps ASAP | A: Incremental |
| Add expressions + maintain 1yr | C: Chevrotain hybrid |
| Major grammar evolution planned | D: ANTLR4 |
| Limited resources, fix bugs only | A: Incremental |
| New team, greenfield | B or D |

### 8.7 Proposed Path

```
┌─────────────────────────────────────────────────────────────────┐
│  NOW: Phase 1 (Incremental)                    [2-3 days]       │
│  • Fix OR operator                                              │
│  • Fix parentheses                                              │
│  • Fix IN literals                                              │
│  • Preserve comma tokens                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  NEXT: Phase 2 (Expression Parser)             [1-2 weeks]      │
│  • Add Chevrotain for expression parsing only                   │
│  • Keep existing statement parser                               │
│  • Implement arithmetic, CASE, functions                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LATER: Phase 3 (Optional Full Migration)      [3-4 weeks]      │
│  • If grammar changes significantly                             │
│  • Migrate full parser to Chevrotain                            │
│  • OR evaluate ANTLR4 if tooling needed                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Appendices

### 9.1 EBNF Grammar (Complete)

See `docs/plans/CLI-NQL-natural-query-language.md` lines 190-372.

### 9.2 Parser Function Index

| Function | Line | Purpose |
|----------|------|---------|
| `tokenize` | 1509 | String → Token[] |
| `parseNaturalQuery` | 2407 | Main entry point |
| `parsePathExpression` | 156 | a.b.c paths |
| `parseSubquery` | 255 | (table where...) |
| `parseExistenceCheck` | 488 | has/not has |
| `parseWhereCondition` | 1749 | Single condition |
| `parseWindowExpression` | 2130 | OVER clause |
| `parseIncludeChain` | 2222 | Include nesting |
| `parseAggregateExpression` | 1683 | count/sum/etc |
| `parseMutation` | 1360 | INSERT/UPDATE/DELETE |
| `parseInsert` | 852 | INSERT with FROM |
| `parseUpdate` | 1044 | UPDATE SET |
| `parseDelete` | 1132 | DELETE WHERE |
| `parseUpsert` | 1202 | ON CONFLICT |

### 9.3 IntentAST Mapping Reference

| NQL Construct | Executor Function | IntentAST Type |
|---------------|-------------------|----------------|
| `col = value` | `createComparisonFilter` | `WhereComparisonIntent` |
| `col.path = value` | `pathToRelationFilter` | `WhereRelationFilterIntent` |
| `col in (subquery)` | `subqueryToWhereIntent` | `WhereSubqueryIntent` |
| `has relation` | `existenceCheckToIntent` | `WhereExistsIntent` |
| `not has relation` | `existenceCheckToIntent` | `WhereNotExistsIntent` |
| `include relation` | Direct ORM call | Join in planner |
| `relation.column` | `relationColumn()` | Auto-JOIN intent |

### 9.4 Test Coverage Map

| Feature | Test File | Test Count | Coverage |
|---------|-----------|------------|----------|
| Path expressions | parser.test.ts | 45 | ✅ |
| Subqueries | parser.test.ts | 28 | ✅ |
| Existence checks | parser.test.ts | 32 | ✅ |
| Window functions | parser.test.ts | 18 | ✅ |
| Mutations | parser.test.ts | 67 | ✅ |
| OR conditions | - | 0 | ❌ |
| Parentheses | - | 0 | ❌ |
| Arithmetic | - | 0 | ❌ |
| CASE | - | 0 | ❌ |

### 9.5 References

1. [Chevrotain Documentation](https://chevrotain.io/docs/)
2. [ANTLR4 TypeScript Target](https://github.com/tunnelvisionlabs/antlr4ts)
3. [Crafting Interpreters](https://craftinginterpreters.com/) - Excellent parsing tutorial
4. [Engineering a Compiler](https://www.cs.rice.edu/~keith/EMBED/book.pdf) - Academic reference
5. [PEG Parsing](https://bford.info/packrat/) - Bryan Ford's original paper

---

## 10. Multi-LLM Collaborative Analysis

This section consolidates findings from multiple LLM analyses (Gemini 2.5 Pro and OpenAI Codex gpt-5.2) conducted on 2026-01-23 to provide a comprehensive, cross-validated assessment.

### 10.1 Analysis Methodology

Three independent analyses were performed:
1. **Claude Opus 4.5** (this document author) - Initial comprehensive audit
2. **Google Gemini 2.5 Pro** - Independent codebase analysis with agentic exploration
3. **OpenAI Codex gpt-5.2** - Deep rule-by-rule EBNF conformance analysis (191k tokens)

### 10.2 Consensus Findings

All three LLMs agreed on these key points:

| Finding | Claude | Gemini | Codex |
|---------|--------|--------|-------|
| Tokenizer is the root cause of many bugs | ✅ | ✅ | ✅ |
| Parser is monolithic (~3000 lines) | ✅ | ✅ | ✅ |
| Boolean expressions (OR/NOT/parentheses) missing | ✅ | ✅ | ✅ |
| Recommend incremental refactor over full rewrite | ✅ | ✅ | ✅ |
| Window functions exist but not wired end-to-end | ✅ | ✅ | ✅ |

### 10.3 Gemini Unique Findings

**Documentation Status Alert:**
Gemini noted that `docs/plans/CLI-NQL-natural-query-language.md` lists several features as "Missing" which are actually **implemented and tested**:

| Feature | Doc Status | Actual Status | Evidence |
|---------|------------|---------------|----------|
| Relation Path Traversal | Missing (P0) | ✅ Implemented | `parser.test.ts` validates `author.name = 'John'` |
| Subqueries | Missing (P0) | ✅ Implemented | `parseSubquery` exists, tests cover IN (subquery) |
| Existence Checks | Missing (P0) | ✅ Implemented | `parseExistenceCheck` handles has/not has |
| Recursive Relations | Missing (P1) | ✅ Implemented | `depth`/`max` keywords in `parseIncludeChain` |
| Window Functions | Missing (P1) | ✅ Implemented | `parseWindowExpression` exists |
| INSERT FROM | Missing (P0) | ✅ Implemented | `parseFromClause` in insert parsing |

**Recommendation:** Update `CLI-NQL-natural-query-language.md` to reflect current implementation status.

### 10.4 Codex Unique Findings

Codex performed a rule-by-rule EBNF analysis with specific bug identification:

#### NEW Bugs Identified

| Bug ID | Description | Location | Impact |
|--------|-------------|----------|--------|
| BUG-08 | `select distinct count(*)` skips distinct token | parser.ts:2626-2673 | DISTINCT ignored on aggregates |
| BUG-09 | `IN`/`NOT IN` subqueries mapped to equality | query-executor.ts:400-481 | Wrong semantics |
| BUG-10 | `is true/false` becomes `IS NOT NULL`/`IS NULL` | query-executor.ts:252-263 | Boolean check fails |
| BUG-11 | `sourceRelation` parsed but never executed | parser.ts:501-533, executor:429-464 | Cross-table existence broken |
| BUG-12 | Quoted path segments not respected | query-executor.ts:215-227 | `"user.name"` splits incorrectly |
| BUG-13 | `parseMutationValue` function calls become strings | parser.ts:710-731 | `now()` treated as literal |

#### Detailed EBNF Token Analysis

| Token | EBNF | Implementation | Issue |
|-------|------|----------------|-------|
| COMMA | Separator | Discarded in tokenizer | Lists work without commas |
| DOT | Path separator | Not tokenized | Paths stay as single tokens |
| LPAREN/RPAREN | Grouping | Not tokenized | Parsers inconsistently expect them |
| DEFAULT | Value keyword | Not implemented | Cannot use DEFAULT in inserts |

### 10.5 Reconciled Recommendations

Based on all three analyses, the consolidated priority list:

#### P0 - Critical (1-2 weeks)

| ID | Task | Effort | Source |
|----|------|--------|--------|
| P0-01 | Fix tokenizer to emit COMMA, LPAREN, RPAREN | L | All 3 |
| P0-02 | Fix IN/NOT IN subquery handling | M | Codex |
| P0-03 | Fix `is true/false` boolean semantics | S | Codex |
| P0-04 | Implement or remove `sourceRelation` | M | Codex |
| P0-05 | Fix `select distinct count(*)` | S | Codex |
| P0-06 | Update outdated documentation | S | Gemini |

#### P1 - Important (2-4 weeks)

| ID | Task | Effort | Source |
|----|------|--------|--------|
| P1-01 | Implement boolean expressions (OR/NOT/parentheses) | L | All 3 |
| P1-02 | Add literal list parsing for IN | M | All 3 |
| P1-03 | Wire window expressions end-to-end | M | All 3 |
| P1-04 | Integrate `parsePathExpression` properly | M | Codex |
| P1-05 | Respect quoted identifiers in paths | S | Codex |

#### P2 - Refactoring (4-8 weeks)

| ID | Task | Effort | Source |
|----|------|--------|--------|
| P2-01 | Split parser.ts into modules | M | Gemini |
| P2-02 | Decouple syntax from schema validation | M | Gemini |
| P2-03 | Add explicit "unsupported feature" errors | S | Codex |
| P2-04 | Consider Chevrotain/Peggy migration | XL | All 3 |

### 10.6 Architecture Decision Consensus

**Question:** Should we do incremental refactor or full rewrite?

| Option | Claude | Gemini | Codex |
|--------|--------|--------|-------|
| Incremental refactor | ✅ Recommended | ✅ Recommended | ✅ Recommended |
| Full rewrite | Not recommended | Not urgent | Lower risk with refactor |

**Rationale (shared across all):**
- Current pipeline (ParsedQuery → Intent → Plan → Compile) is **stable**
- Replacing lexer + gradually adding expression parser is lower risk
- Full rewrite only justified if grammar complexity grows significantly

**If a parser library is chosen:**

| Library | Claude Score | Gemini | Codex |
|---------|--------------|--------|-------|
| Chevrotain | ⭐⭐⭐⭐⭐ (recommended) | Mentioned | Not specified |
| Peggy/PEG.js | ⭐⭐⭐⭐ | Mentioned | Not specified |
| ANTLR4 | ⭐⭐⭐ | - | - |

### 10.7 Validation Required

Before implementing P0 fixes, the following should be manually verified:

1. **Test `select distinct count(*)` in REPL** - Confirm BUG-08
2. **Test `id in (users where active)` in REPL** - Confirm BUG-09
3. **Test `active is true` in REPL** - Confirm BUG-10
4. **Test `products where category has ancestors where name = 'Root'`** - Confirm BUG-11
5. **Test `select "user.email" from users`** - Confirm BUG-12

---

## 11. NQL v2.0 Language Design

This section defines the next-generation NQL language, incorporating insights from multi-LLM analysis and industry best practices (KQL, SQL).

### 11.1 Design Principles

| Principle | Description |
|-----------|-------------|
| **Pipeline-first** | Reads use `table \| clause \| clause` syntax (KQL-inspired) |
| **SQL-familiar mutations** | Mutations use operation-first syntax (`insert into`, `update`, `delete from`) |
| **Minimal keywords** | No redundant keywords (`summarize`, `extend`, `project`) |
| **Explicit joins** | `with` for relations, `via` for disambiguation when multiple FKs exist |
| **Intent-first joins** | Planner auto-infers LEFT/INNER from schema (nullable FK → LEFT, required FK → INNER) |
| **CTE support** | `let` for variable binding and query reuse (not `with` to avoid SQL CTE confusion) |
| **Strict mode** | Canonical keywords only, no aliases (recommended for LLM usage) |
| **LLM-friendly** | Deterministic, self-describing, good error messages |

### 11.2 Syntax Overview

#### Reads (Table-first, Pipeline)

```
# Simple query
products

# Filtered
products | where active = true

# Full pipeline
products
| where category.name = 'Electronics'
| where price between 100 and 500
| select name, price, category.name as cat
| order by price desc
| limit 10

# With aggregation
orders
| where created in 'last 30 days'
| group by customer.name
| select customer.name, sum(amount) as revenue, count(*) as cnt
| order by revenue desc
| limit 10
```

#### Joins (`with` for relations)

```
# Implicit join via relation (schema-defined)
# Join type auto-inferred: LEFT if FK nullable, INNER if required
products
| with category
| select name, category.name

# Explicit join condition (when no FK defined)
products
| with orders on orders.product_id = id
| select name, orders.total

# Disambiguation with `via` (when multiple FKs to same table)
# Example: orders has created_by_id and assigned_to_id both → users
orders
| with users via created_by
| select id, users.name as creator

# Recursive relations
categories
| with ancestors(depth: 3)
| select name, ancestors.name

# Wildcard for all relation columns
products | select name, category.*
```

#### CTEs with `let`

```
# Define reusable query
let active_users = users | where active = true

# Use in subsequent queries
orders
| where user_id in (active_users | select id)
| select id, total

# Multiple let bindings
let premium = active_users | where plan = 'premium'
let recent_orders = orders | where created in 'last 30 days'

recent_orders
| where user_id in (premium | select id)
| select *
```

#### Aggregation with Position-Aware `where`

```
# Single where after group by → compiles to HAVING
orders
| group by customer_id
| where sum(amount) > 1000
| select customer_id, sum(amount) as total, count(*) as cnt

# Combined: where/group by/where → WHERE + HAVING
orders
| where status = 'completed'       # → SQL WHERE (pre-aggregation)
| group by customer_id
| where count(*) > 5               # → SQL HAVING (post-aggregation)
| select customer_id, count(*) as order_count

# Compiles to:
# SELECT customer_id, COUNT(*) as order_count
# FROM orders
# WHERE status = 'completed'
# GROUP BY customer_id
# HAVING COUNT(*) > 5
```

#### Quoted Identifiers

```
# Use double quotes for reserved words or special characters
"order"                          # Table named 'order' (reserved word)
| where "user-id" = 5            # Column with hyphen
| select "order".id, "group"     # Disambiguate reserved words

# Escape quotes by doubling
| where name = 'O''Brien'        # String: O'Brien
| select "col""name"             # Identifier: col"name
```

#### Scalar Subqueries (must have pipe)

```
# LEGAL: subquery with at least one pipe
insert into products
set name = 'iPhone',
    category_id = (categories | where name = 'Phones' | select id)

# ILLEGAL: bare table in expression context
# category_id = (categories)  ← PARSE ERROR
```

#### Mutations (Operation-first, SQL-like)

```
# INSERT (returns inserted row by default)
insert into products
set name = 'iPhone 15', price = 999, category_id = 5

# INSERT with FK lookup
insert into products
set name = 'iPhone 15', price = 999,
    category = (categories | where name = 'Phones' | select id)

# UPDATE
update products
set price = price * 0.9
where category.name = 'Electronics' and stock > 100

# DELETE
delete from products
where id = 5

# UPSERT
upsert into products on (sku)
set name = 'iPhone 15', price = 999, sku = 'IPH15'
```

#### Mutation with Pipeline (returning)

```
# Insert and select specific columns from result
insert into products
set name = 'iPhone 15', price = 999
| select id, name

# Insert product then create variants using result
insert into products
set name = 'iPhone 15', price = 999
| bind product
| insert into variants set product_id = product.id, color = 'black'

# Update and return affected rows
update products
set price = price * 0.9
where category_id = 5
| select id, name, price
```

### 11.3 Keyword Reference

#### Kept from SQL/KQL

| Keyword | Usage | Example |
|---------|-------|---------|
| `where` | Filter (position-aware: WHERE before group by, HAVING after) | `where active = true` |
| `select` | Choose columns + aggregates | `select name, count(*)` |
| `group by` | Grouping for aggregates | `group by category` |
| `order by` | Sorting | `order by price desc` |
| `limit` | Row limit | `limit 10` |
| `offset` | Skip rows | `offset 20` |
| `with` | Join relations | `with category` |
| `via` | Disambiguate join path | `with users via created_by` |
| `let` | Define CTE (reusable query) | `let active = users \| where active` |
| `bind` | Capture mutation result | `insert ... \| bind result` |
| `as` | Alias | `sum(x) as total` |
| `and` / `or` | Boolean logic | `where a = 1 or b = 2` |
| `not` | Negation | `where not active` |
| `in` / `not in` | Set membership | `where status in ('a', 'b')` |
| `between` | Range | `where price between 10 and 100` |
| `like` | Pattern matching | `where name like '%phone%'` |
| `is null` / `is not null` | Null check | `where deleted_at is null` |
| `distinct` | Unique rows | `select distinct category` |
| `asc` / `desc` | Sort direction | `order by price desc` |

#### Removed (KQL-isms not needed)

| KQL Keyword | Replacement | Reason |
|-------------|-------------|--------|
| `summarize` | `group by` + `select` | Redundant |
| `extend` | `select *, computed` | Redundant |
| `project` | `select` | Same thing |
| `project-away` | `select * except (col)` | If needed later |
| `take` | `limit` | SQL standard |

#### Removed (NQL v1 cleanup)

| v1 Keyword | Replacement | Reason |
|------------|-------------|--------|
| `include` | `with` + `select relation.*` | Confusing, implicit |
| `has` / `not has` | `exists` / `not exists` | SQL standard naming |
| `depth` / `max` (standalone) | `ancestors(depth: N)` | Parameterized |

### 11.4 Natural Language Features

#### Relative Dates

```
# Human-friendly date expressions
orders | where created in 'last 7 days'
orders | where created in 'this month'
orders | where created > '2 days ago'
orders | where due in 'next week'
```

#### Fuzzy Keywords (Aliases) - Permissive Mode Only

> **Note:** Aliases are only accepted in **permissive mode**.
> **Strict mode** (default, recommended for LLMs) rejects aliases and requires canonical keywords.

| Canonical | Aliases (permissive only) |
|-----------|---------------------------|
| `not in` | `excluding` |
| `not exists` | `has no`, `doesn't have` |
| `where` | `filter` |
| `order by` | `sort by` |
| `limit` | `top`, `first` |

### 11.5 LLM Compatibility Features

| Feature | Description | Example |
|---------|-------------|---------|
| **Strict mode** | Canonical keywords only, no aliases | Deterministic LLM output |
| **Schema introspection** | `.schema`, `.tables`, `.columns` | `.columns products` |
| **Explain** | Show parsed AST | `.parse products \| where x` |
| **Suggestions** | Fuzzy column matching | `"Did you mean 'status'?"` |
| **Multi-error** | Report all errors, not just first | Better LLM self-correction |
| **Canonical format** | Pretty-printer for normalization | Consistent LLM output |
| **Intent-first joins** | No LEFT/INNER decision needed | Schema determines join type |

### 11.6 Grammar (EBNF)

```ebnf
(* ============================================================ *)
(* TOP-LEVEL                                                    *)
(* ============================================================ *)

program       = { let_stmt | statement } ;  (* Supports interleaving let and statements *)
statement     = query | mutation_pipeline ;

(* CTE / Variable binding - defines reusable named queries *)
let_stmt      = "let" IDENT "=" query ;

(* ============================================================ *)
(* QUERIES                                                      *)
(* ============================================================ *)

query         = table_ref { "|" query_clause } ;
table_ref     = ident_segment ;  (* Single table only - joins via `with` *)

query_clause  = where_clause
              | select_clause
              | with_clause
              | group_clause
              | order_clause
              | limit_clause
              | offset_clause ;

(* Clauses *)
(* Note: `where` serves as both WHERE and HAVING depending on position:
   - before `group by` → compiles to SQL WHERE (aggregates forbidden)
   - after `group by`  → compiles to SQL HAVING (aggregates allowed)
   Multiple `where` clauses allowed: each compiles per its position *)
where_clause  = "where" boolean_expr ;
select_clause = "select" [ "distinct" ] select_list ;
with_clause   = "with" join_spec { "," join_spec } ;
group_clause  = "group" "by" expr_list ;
order_clause  = "order" "by" order_list ;
limit_clause  = "limit" NUMBER ;
offset_clause = "offset" NUMBER ;

(* Joins - with optional `via` for disambiguation *)
join_spec     = ident_segment [ "(" param_list ")" ] [ "via" ident_segment ] [ "on" boolean_expr ] ;
param_list    = param { "," param } ;
param         = IDENT ":" literal ;

(* Select *)
select_list   = select_item { "," select_item } ;
select_item   = "*"
              | path_expr ".*"
              | expr [ "as" ident_segment ] ;

(* ============================================================ *)
(* EXPRESSIONS                                                  *)
(* ============================================================ *)

boolean_expr  = or_expr ;
or_expr       = and_expr { "or" and_expr } ;
and_expr      = not_expr { "and" not_expr } ;
not_expr      = [ "not" ] primary_cond ;
primary_cond  = "(" boolean_expr ")"
              | comparison
              | between_check
              | exists_check
              | in_check
              | is_null_check ;

(* Comparisons *)
comparison    = expr comp_op expr ;
comp_op       = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like" ;

(* BETWEEN: ternary operator (not binary!) *)
between_check = expr "between" expr "and" expr ;

(* EXISTS *)
exists_check  = [ "not" ] "exists" "(" scalar_subquery ")" ;

(* IN: supports value list, subquery, or date range literal *)
in_check      = expr [ "not" ] "in" ( "(" value_list ")"
                                    | "(" scalar_subquery ")"
                                    | date_range_literal ) ;

(* IS NULL *)
is_null_check = expr "is" [ "not" ] "null" ;

(* Arithmetic expressions *)
expr          = add_expr ;
add_expr      = mul_expr { ("+" | "-") mul_expr } ;
mul_expr      = unary_expr { ("*" | "/" | "%") unary_expr } ;
unary_expr    = [ "-" ] primary_expr ;
primary_expr  = literal
              | path_expr
              | func_call
              | "(" expr ")"
              | "(" scalar_subquery ")" ;

(* Scalar subquery MUST have at least one pipe to disambiguate from (expr) *)
(* e.g., (categories | where name='Phones' | select id) is OK *)
(* but (categories) alone is ILLEGAL in expression context *)
scalar_subquery = table_ref "|" query_clause { "|" query_clause } ;

path_expr     = ident_segment { "." ident_segment } ;
func_call     = IDENT "(" [ func_arg_list ] ")" ;
func_arg_list = "*" | expr_list ;  (* Star for count(*), expr_list for all other functions *)
(* Note: Window functions (OVER clause) deferred to v2.1 *)

(* ============================================================ *)
(* MUTATIONS (with optional pipeline for RETURNING)             *)
(* ============================================================ *)

mutation_pipeline = mutation { "|" mutation_clause } ;
mutation_clause   = select_clause | bind_clause ;

(* bind captures mutation result into a variable for chaining *)
bind_clause   = "bind" IDENT ;

mutation      = insert_stmt | update_stmt | delete_stmt | upsert_stmt ;

insert_stmt   = "insert" "into" ident_segment "set" assignment_list ;
update_stmt   = "update" ident_segment "set" assignment_list [ "where" boolean_expr ] ;
delete_stmt   = "delete" "from" ident_segment "where" boolean_expr ;
upsert_stmt   = "upsert" "into" ident_segment "on" "(" ident_list ")"
                "set" assignment_list ;

assignment_list = assignment { "," assignment } ;
assignment      = ident_segment "=" expr ;

(* ============================================================ *)
(* LITERALS & TOKENS                                            *)
(* ============================================================ *)

literal       = STRING | NUMBER | "true" | "false" | "null" ;
value_list    = expr { "," expr } ;
expr_list     = expr { "," expr } ;
ident_list    = ident_segment { "," ident_segment } ;
order_list    = order_item { "," order_item } ;
order_item    = expr [ "asc" | "desc" ] ;

(* Date range literal for natural language dates *)
date_range_literal = STRING ;  (* e.g., 'last 7 days', 'this month' *)
                               (* Semantic layer validates format *)

(* ============================================================ *)
(* IDENTIFIERS & STRINGS                                        *)
(* ============================================================ *)

(* Identifiers can be bare or quoted (for reserved words/special chars) *)
ident_segment   = IDENT | QUOTED_IDENT ;

(* Tokens *)
IDENT           = /[a-zA-Z_][a-zA-Z0-9_]*/ ;
QUOTED_IDENT    = /"([^"]|"")*"/ ;   (* Double quotes, escape via "" *)
STRING          = /'([^']|'')*'/ ;   (* Single quotes, escape via '' *)
NUMBER          = /[0-9]+(\.[0-9]+)?/ ;  (* No leading sign - negative via unary_expr *)
```

### 11.7 Semantic Rules

These rules are enforced by the semantic layer after parsing:

#### Position-Aware `where` (WHERE vs HAVING)

| `where` Position | Aggregate Allowed? | Compiles To |
|------------------|-------------------|-------------|
| Before `group by` | ❌ No | SQL `WHERE` |
| After `group by` | ✅ Yes | SQL `HAVING` |

Multiple `where` clauses are allowed. Each is compiled based on its position relative to `group by`.

#### Validation Rules

| Rule | Error |
|------|-------|
| `where` before `group by` contains aggregate | "Aggregate functions not allowed before GROUP BY. Move after GROUP BY." |
| Duplicate `let` binding name | "Variable 'X' already defined" |
| Circular `let` reference | "Circular reference detected: X → Y → X" |
| Unknown column/table | "Column 'X' not found. Did you mean 'Y'?" |
| `select` with aggregate + non-grouped column | "Column 'X' must be in GROUP BY or aggregate" |

#### Limits (Configurable)

| Limit | Default | Rationale |
|-------|---------|-----------|
| Max identifier length | 128 | PostgreSQL default |
| Max subquery depth | 10 | Prevent stack overflow |
| Max clauses per query | 20 | Reasonable complexity |
| Max joins per query | 10 | Performance guard |

#### `let` Evaluation Semantics

- `let` bindings are **lazily evaluated** (CTE semantics)
- Not materialized unless referenced multiple times
- Scope: visible to all subsequent statements in the program

#### Clause Stacking Rules

When the same clause type appears multiple times in a query:

| Clause | Behavior | Example |
|--------|----------|---------|
| Multiple `where` | ANDed together | `where a \| where b` → `WHERE a AND b` |
| Multiple `select` | Last wins | `select a \| select b` → `SELECT b` |
| Multiple `order by` | Last wins | `order by a \| order by b` → `ORDER BY b` |
| Multiple `limit` | Last wins | `limit 10 \| limit 5` → `LIMIT 5` |
| Multiple `group by` | Error | Not allowed - ambiguous semantics |

#### Security Constraints

| Constraint | Description |
|------------|-------------|
| Identifier validation | Reject identifiers matching suspicious patterns (e.g., `--`, `/*`, `;`) |
| String literal validation | Parameterized - never interpolated into SQL |
| Error sanitization | Production mode: generic errors without internal details |
| Query complexity | Enforce limits to prevent DoS via complex queries |

### 11.8 Package Structure: `@dbsp/nql`

New dedicated package for NQL v2.0 parser:

```
packages/nql/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # Public API
│   ├── lexer/
│   │   ├── tokens.ts      # Token definitions
│   │   └── lexer.ts       # Chevrotain lexer
│   ├── parser/
│   │   ├── grammar.ts     # Chevrotain grammar
│   │   ├── ast.ts         # NQL AST types
│   │   └── visitor.ts     # CST → AST visitor
│   ├── semantic/
│   │   ├── validator.ts   # Schema validation
│   │   └── resolver.ts    # Name resolution
│   ├── compiler/
│   │   └── to-intent.ts   # NQL AST → IntentAST
│   ├── features/
│   │   ├── dates.ts       # Relative date parsing
│   │   ├── fuzzy.ts       # Keyword aliases
│   │   └── suggest.ts     # Error suggestions
│   └── utils/
│       ├── pretty.ts      # Pretty printer
│       └── errors.ts      # Error formatting
└── tests/
    ├── lexer.test.ts
    ├── parser.test.ts
    ├── semantic.test.ts
    └── e2e.test.ts
```

### 11.8.1 Current Implementation Status

**Fully Implemented (Lexer → Parser → Compiler):**
- All pipeline clauses: `where`, `select`, `with`, `group by`, `order by`, `limit`, `offset`
- All comparison operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `like`
- All logical operators: `and`, `or`, `not`
- `between` expressions
- `in` with value lists
- `is null` / `is not null`
- Aggregate functions: `count`, `sum`, `avg`, `min`, `max` (single argument)
- Arithmetic expressions: `+`, `-`, `*`, `/`, `%`
- All mutations: `insert`, `update`, `delete`, `upsert`

**Parsed but Not Compiled (Known Limitations):**

| Feature | Status | Notes |
|---------|--------|-------|
| `exists (subquery)` | Parser ✅ Compiler ❌ | Deferred: requires subquery compilation |
| Unary minus in WHERE | Parser ✅ Compiler ❌ | `where price < -5` → use workaround: `where price < 0 - 5` |
| Multi-arg aggregates | Parser ✅ Compiler ⚠️ | `string_agg(name, ',')` loses separator arg |
| Scalar subqueries | Parser ✅ Compiler ❌ | `(subquery)` in expressions not yet supported |
| Variable references | Parser ⚠️ Compiler ❌ | `let` bindings parsed but variables not resolved |

**Not Yet Implemented:**
- Window functions (`OVER` clause) — deferred to v2.1
- `distinct on` — deferred to v2.1

### 11.9 Migration Path

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **Phase 1** | `@dbsp/nql` scaffold | Package, Chevrotain setup, basic lexer |
| **Phase 2** | Core parser | Query parsing with full boolean expressions |
| **Phase 3** | Mutations | INSERT/UPDATE/DELETE/UPSERT |
| **Phase 4** | Semantic layer | Schema validation, suggestions |
| **Phase 5** | Integration | CLI uses `@dbsp/nql`, deprecate old parser |
| **Phase 6** | Cleanup | Remove old parser from CLI |

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-23 | claude-opus-4-5 | Initial audit and recommendations |
| 2026-01-23 | claude-opus-4-5 + gemini-2.5-pro + codex-gpt-5.2 | Multi-LLM collaborative review (Section 10) |
| 2026-01-23 | claude-opus-4-5 | NQL v2.0 Language Design (Section 11) |
| 2026-01-23 | claude-opus-4-5 + gemini + codex + lmstudio | Spec review: EBNF fixes (`between`, `in`), `let` CTEs, `having`, `via`, strict mode, pipeline mutations |
| 2026-01-23 | claude-opus-4-5 | v2.1 refinements: scalar_subquery requires `\|`, quoted identifiers (`"ident"`), string escapes (`''`), `bind` for mutation capture |
| 2026-01-23 | claude-opus-4-5 | v2.2: Merge `where`/`having` → position-aware `where`, add semantic rules section, add limits |
| 2026-01-23 | claude-opus-4-5 | v2.3 (adversarial hardening): Remove window functions, add clause stacking rules, add security constraints |
