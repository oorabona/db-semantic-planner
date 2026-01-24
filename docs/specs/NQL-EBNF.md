# NQL Grammar (EBNF) — Single Source of Truth

**Status:** Canonical
**Created:** 2026-01-24
**Version:** 2.2 (reviewed, with pseudo-table extensions)
**Scope:** nql, cli

## Overview

This document is the **single source of truth** for NQL (Natural Query Language) grammar. All other documents should reference this one.

**Parser type:** LL(1) — left-factored, no left recursion
**Syntax style:** Pipe-based (`table | clause | clause`)

## 1. Top-Level Structure

```ebnf
(* ============================================================ *)
(* PROGRAM & STATEMENTS                                         *)
(* ============================================================ *)

program           = { line } ;
line              = [ let_stmt | statement ] NEWLINE ;  (* Line-oriented parsing *)
statement         = command | query | mutation_pipeline ;

(* CTE / Variable binding - defines reusable named queries *)
let_stmt          = "let" IDENT "=" query ;

(* REPL commands (.help, .schema, etc.) *)
command           = "." IDENT { ANY_TOKEN } ;
```

## 2. Queries

```ebnf
(* ============================================================ *)
(* QUERY STRUCTURE                                              *)
(* ============================================================ *)

query             = table_ref { "|" query_clause } ;
table_ref         = ident_segment ;  (* Single table only - joins via `with` *)

query_clause      = where_clause
                  | select_clause
                  | with_clause
                  | group_clause
                  | having_clause
                  | order_clause
                  | limit_clause
                  | offset_clause ;

(* Clauses *)
where_clause      = "where" boolean_expr ;
select_clause     = "select" [ "distinct" ] select_list ;
with_clause       = "with" join_spec { "," join_spec } ;
group_clause      = "group" "by" expr_list ;
having_clause     = "having" boolean_expr ;
order_clause      = "order" "by" order_list ;
limit_clause      = "limit" NUMBER ;
offset_clause     = "offset" NUMBER ;
```

### 2.1 WHERE vs HAVING Semantics

| Position | Aggregate Allowed? | Compiles To |
|----------|-------------------|-------------|
| Before `group by` | ❌ No | SQL `WHERE` |
| After `group by` | ✅ Yes | SQL `HAVING` |

Note: Multiple `where` clauses are allowed — each compiles based on position relative to `group by`.

### 2.2 Joins (`with` clause)

```ebnf
(* Joins with optional disambiguation *)
join_spec         = ident_segment [ "(" param_list ")" ] [ "via" ident_segment ] [ "on" boolean_expr ] ;
param_list        = param { "," param } ;
param             = IDENT ":" literal ;
```

### 2.3 Select

```ebnf
select_list       = select_item { "," select_item } ;
select_item       = "*"
                  | path_expr ".*"
                  | window_expr
                  | aggregate_expr [ "as" ident_segment ]
                  | expr [ "as" ident_segment ] ;

(* NOTE: pseudo_table_ref ".*" (e.g., ascendant.*) is DEFERRED to V1.1 due to
   row explosion concerns. V1.0 supports only scalar pseudo-column access. *)
```

**Parsing strategy for select_item (H1 fix):** Parser attempts `aggregate_expr` first. If successful and followed by `over`, backtrack and parse as `window_expr`. This requires limited lookahead but avoids grammar ambiguity.

## 3. Expressions

```ebnf
(* ============================================================ *)
(* BOOLEAN EXPRESSIONS                                          *)
(* Precedence: NOT > AND > OR                                   *)
(* ============================================================ *)

boolean_expr      = or_expr ;
or_expr           = and_expr { "or" and_expr } ;
and_expr          = not_expr { "and" not_expr } ;
not_expr          = [ "not" ] primary_cond ;

primary_cond      = "(" boolean_expr ")"
                  | comparison
                  | range_comparison
                  | between_check
                  | exists_check
                  | in_check
                  | is_null_check ;

(* ============================================================ *)
(* COMPARISONS                                                  *)
(* ============================================================ *)

comparison        = expr comp_op expr ;
comp_op           = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like" ;

(* Range operators - literal uses ( which conflicts with grouped expr *)
(* Range literals ONLY appear after range operators, so ( is unambiguous *)
range_comparison  = expr range_op range_literal ;
range_op          = "overlaps" | "contains" | "containedBy" ;
range_literal     = ( "[" | "(" ) range_value "," range_value ( "]" | ")" ) ;
range_value       = NUMBER | RANGE_DATE_TIME ;
(* Bound semantics: [ or ] = inclusive, ( or ) = exclusive *)

(* BETWEEN: ternary operator *)
between_check     = expr "between" expr "and" expr ;

(* EXISTS *)
exists_check      = [ "not" ] "exists" "(" scalar_subquery ")" ;

(* IN: supports literal list, single subquery, or date range literal *)
(* M7 FIX: value list restricted to literals only (not arbitrary expr) for SQL compatibility *)
in_check          = expr [ "not" ] "in" ( "(" literal_list ")"
                                        | "(" scalar_subquery ")"
                                        | date_range_literal ) ;
literal_list      = literal { "," literal } ;

(* IS NULL *)
is_null_check     = expr "is" [ "not" ] "null" ;

(* ============================================================ *)
(* ARITHMETIC EXPRESSIONS                                       *)
(* Precedence: unary > * / % > + - ||                           *)
(* ============================================================ *)

expr              = add_expr ;
add_expr          = mul_expr { ( "+" | "-" | "||" ) mul_expr } ;
mul_expr          = unary_expr { ( "*" | "/" | "%" ) unary_expr } ;
unary_expr        = [ "-" ] primary_expr ;

primary_expr      = literal
                  | column_ref                    (* includes pseudo-table columns *)
                  | func_call
                  | case_expr
                  | "(" expr ")"
                  | "(" scalar_subquery ")" ;

(* Scalar subquery MUST have at least one pipe to disambiguate from (expr) *)
scalar_subquery   = table_ref "|" query_clause { "|" query_clause } ;

(* H2 DISAMBIGUATION: When parser sees "(", it scans ahead for "|" to decide:
   - If "|" found before ")" → scalar_subquery
   - Otherwise → grouped expr
   This requires bounded lookahead but is unambiguous. *)
```

### 3.1 Column References

```ebnf
(* Column reference - real or pseudo-table *)
column_ref        = quoted_ident                  (* real column, escaped *)
                  | pseudo_column_expr            (* pseudo-table traversal *)
                  | path_expr ;                   (* real column or relation path *)

path_expr         = ident_segment { "." ident_segment } ;
quoted_ident      = QUOTED_IDENT ;                (* "column" - forces column semantics *)
```

### 3.2 Functions

```ebnf
func_call         = IDENT "(" [ func_arg_list ] ")" ;
func_arg_list     = "*" | [ "distinct" ] expr_list ;

(* Aggregate functions *)
aggregate_expr    = agg_function "(" [ "distinct" ] ( "*" | expr | pseudo_table_ref "." ident_segment ) ")" ;
agg_function      = "count" | "sum" | "avg" | "min" | "max" ;

(* Window expressions *)
window_expr       = window_source "over" "(" window_spec ")" [ "as" ident_segment ] ;
window_source     = aggregate_expr | window_only_function ;
window_only_function = ( "rank" | "dense_rank" | "row_number" ) "(" ")"
                     | ( "lag" | "lead" ) "(" path_expr [ "," NUMBER [ "," literal ] ] ")" ;
window_spec       = [ partition_clause ] [ window_order_clause ] ;
partition_clause  = "partition" "by" path_expr { "," path_expr } ;
window_order_clause = "order" "by" order_list ;

(* CASE expression - L1 FIX: requires at least one WHEN clause *)
case_expr         = "case" when_clause { when_clause } [ else_clause ] "end" ;
when_clause       = "when" boolean_expr "then" expr ;
else_clause       = "else" expr ;
```

## 4. Pseudo-Tables (Self-Referential Hierarchies)

**Feature:** V1.0 (filtering, scalar column access) + V1.1 (aggregation, full projection)

Pseudo-tables (`parent`, `child`, `ascendant`, `descendant`) provide intuitive traversal of self-referential hierarchies without explicit relation configuration.

### V1.0 vs V1.1 Scope

| Feature | V1.0 | V1.1 |
|---------|------|------|
| `parent.name` in WHERE | ✅ | ✅ |
| `ascendant.name` in WHERE | ✅ | ✅ |
| `sum(descendant.price)` in HAVING | ❌ | ✅ |
| `parent.name` in SELECT | ✅ (scalar) | ✅ |
| `parent.*` in SELECT | ❌ | ✅ (with defined semantics) |
| `ascendant.*` in SELECT | ❌ | 🔶 (row explosion - requires JSON agg or LATERAL) |

**H4 NOTE:** Recursive pseudo-table projection (`ascendant.*`, `descendant.*`) is deferred to V1.1 because it produces multiple rows per source row, requiring either:
- JSON aggregation: `json_agg(ascendant.*)`
- LATERAL join semantics with explicit documentation
- Or explicit prohibition with clear error message

```ebnf
(* ============================================================ *)
(* PSEUDO-TABLE EXPRESSIONS                                     *)
(* ============================================================ *)

(* Pseudo-column expression - access column via pseudo-table *)
pseudo_column_expr
    : traversal_chain "." ident_segment
    ;

(* Pseudo-table reference - for aggregates and projections (V1.1) *)
pseudo_table_ref
    : traversal_chain
    ;

(* Traversal chain - MUST be single direction *)
traversal_chain
    : upward_chain                                (* parent direction only *)
    | downward_chain                              (* child direction only *)
    | scoped_bounded_traversal                    (* for multi-FK: role.ascendant *)
    ;

(* Upward chain: parent, parent.parent, manager.manager, etc. *)
upward_chain
    : parent_traversal { "." parent_traversal }
    | "ascendant" [ "[" POSITIVE_INTEGER "]" ]
    ;

(* Downward chain: child, child.child, reports.reports, etc. *)
downward_chain
    : child_traversal { "." child_traversal }
    | "descendant" [ "[" POSITIVE_INTEGER "]" ]
    ;

(* Scoped bounded traversal for multi-FK tables *)
scoped_bounded_traversal
    : CUSTOM_ROLE_NAME "." ( "ascendant" | "descendant" ) [ "[" POSITIVE_INTEGER "]" ]
    ;

(* Parent direction traversal (depth=1) *)
parent_traversal
    : "parent"                                    (* default name *)
    | CUSTOM_PARENT_ROLE                          (* from schema: manager, mentor, etc. *)
    ;

(* Child direction traversal (depth=1) *)
child_traversal
    : "child"                                     (* default name *)
    | CUSTOM_CHILD_ROLE                           (* from schema: reports, mentees, etc. *)
    ;

(* Depth bound for recursive traversal *)
POSITIVE_INTEGER  = /[1-9][0-9]*/ ;
```

### 4.1 Direction Constraint

**Critical:** Mixed direction chains are **forbidden**.

| Syntax | Valid | Reason |
|--------|-------|--------|
| `parent.parent.name` | ✅ | Same direction (up, up) |
| `child.child.name` | ✅ | Same direction (down, down) |
| `parent.child.name` | ❌ | Mixed (up, down) — ambiguous |
| `manager.manager.name` | ✅ | Custom role, same direction |
| `manager.ascendant.name` | ✅ | Scoped recursive (multi-FK) |

### 4.2 Usage Examples

```sql
-- V1.0: Filtering
categories | where parent.name = 'Electronics'           -- depth=1
categories | where parent.parent.name = 'Root'           -- depth=2
categories | where ascendant.name = 'Root'               -- any depth
categories | where ascendant[3].name = 'Root'            -- up to depth 3
categories | where descendant.active = true              -- any child

-- V1.1: Aggregation (pseudo-table in aggregate function)
categories | group by id | having sum(descendant.price) > 1000

-- V1.1: Projection (pseudo-table in select)
categories | select name, parent.name as parentName
categories | select *, parent.*
```

### 4.3 Keyword Escaping

When a real column is named `parent`, `child`, etc.:

```sql
categories | where "parent" = 'some value'               -- real column (quoted)
categories | where parent.name = 'Electronics'           -- pseudo-table (unquoted)
categories | where "parent" = 'x' and parent.name = 'y'  -- both in same query
```

## 5. Mutations

```ebnf
(* ============================================================ *)
(* MUTATIONS (with optional pipeline for RETURNING)             *)
(* ============================================================ *)

mutation_pipeline = mutation { "|" mutation_clause } ;
mutation_clause   = select_clause | bind_clause ;

(* bind captures mutation result into a variable for chaining *)
bind_clause       = "bind" IDENT ;

mutation          = insert_stmt | update_stmt | delete_stmt | upsert_stmt ;

insert_stmt       = "insert" "into" ident_segment "set" assignment_list
                    [ from_clause ] [ "!" ] ;
update_stmt       = "update" ident_segment "set" assignment_list
                    [ "where" boolean_expr ] [ "!" ] ;
(* L3 FIX: delete requires WHERE unless "!" force flag is used *)
delete_stmt       = "delete" "from" ident_segment ( "where" boolean_expr [ "!" ] | "!" ) ;
upsert_stmt       = "upsert" "into" ident_segment "on" "(" ident_list ")"
                    "set" assignment_list [ "!" ] ;

(* INSERT FROM clause for FK lookup and bulk inserts *)
from_clause       = "from" [ "each" ] ident_segment [ "as" ident_segment ]
                    [ where_clause ] [ for_update_clause ] ;
for_update_clause = "for" "update" [ "skip" "locked" ] ;

assignment_list   = assignment { "," assignment } ;
assignment        = ident_segment "=" ( expr | "default" | "null" ) ;
```

### 5.1 Trailing `!` (Force Execution)

The `!` suffix forces execution without safety checks (e.g., `update without where`).

## 6. Literals and Tokens

```ebnf
(* ============================================================ *)
(* LITERALS                                                     *)
(* ============================================================ *)

literal           = STRING | NUMBER | "true" | "false" | "null" ;
value_list        = expr { "," expr } ;
expr_list         = expr { "," expr } ;
ident_list        = ident_segment { "," ident_segment } ;
order_list        = order_item { "," order_item } ;
order_item        = expr [ "asc" | "desc" ] ;

(* Date range literal for natural language dates *)
date_range_literal = STRING ;  (* e.g., 'last 7 days', 'this month' *)
                               (* Semantic layer validates format *)

(* ============================================================ *)
(* IDENTIFIERS & TOKENS                                         *)
(* ============================================================ *)

(* Identifiers can be bare or quoted *)
ident_segment     = IDENT | QUOTED_IDENT ;

(* Token definitions (regex) *)
IDENT             = /[a-zA-Z_][a-zA-Z0-9_]*/ ;
QUOTED_IDENT      = /"([^"]|"")*"/ ;             (* Double quotes, escape via "" *)
STRING            = /'([^']|'')*'/ ;             (* Single quotes, escape via '' *)
NUMBER            = /[0-9]+(\.[0-9]+)?/ ;        (* No leading sign - negative via unary_expr *)
RANGE_DATE_TIME   = /-?[0-9]+(?:[-:T][0-9]+)+/ ; (* Date/time: 2024-01-01, 08:00, 2024-01-01T08:00:00 *)
NEWLINE           = /\n|\r\n/ ;                  (* Line terminator *)

(* H3 FIX: Custom role tokens - resolved at semantic level from schema *)
(* These are NOT lexical tokens but semantic identifiers validated against schema *)
CUSTOM_PARENT_ROLE = IDENT ;  (* e.g., "manager", "mentor" - from schema.parentRole *)
CUSTOM_CHILD_ROLE  = IDENT ;  (* e.g., "reports", "mentees" - from schema.childRole *)
CUSTOM_ROLE_NAME   = IDENT ;  (* Any custom role name for scoped traversal *)

(* Resolution: Parser treats all as IDENT; semantic layer checks against schema
   to determine if IDENT is a pseudo-table keyword or regular identifier. *)
```

## 7. Semantic Rules

These rules are enforced after parsing:

### 7.1 Position-Aware Aggregates

| Position | Aggregates Allowed? | Compiles To |
|----------|-------------------|-------------|
| `where` before `group by` | ❌ No | SQL `WHERE` |
| `where` after `group by` | ✅ Yes | SQL `HAVING` |
| `having` clause | ✅ Yes | SQL `HAVING` |

### 7.2 Validation Rules

| Rule | Error |
|------|-------|
| `where` before `group by` contains aggregate | "Aggregate functions not allowed before GROUP BY" |
| Duplicate `let` binding name | "Variable 'X' already defined" |
| Circular `let` reference | "Circular reference detected: X → Y → X" |
| Unknown column/table | "Column 'X' not found. Did you mean 'Y'?" |
| `select` with aggregate + non-grouped column | "Column 'X' must be in GROUP BY or aggregate" |
| Mixed direction pseudo-chain | "Cannot mix parent and child in same traversal chain" |
| Multi-FK without explicit roles | "Multiple self-referential FKs require parentRole/childRole" |

### 7.3 Resolution Order

For path expressions:
1. Quoted identifier (`"parent"`) → always real column
2. Match against pseudo-column names from schema → pseudo-table
3. Match against relation names → join path
4. Fallback → real column

### 7.4 Limits (Configurable)

| Limit | Default | Rationale |
|-------|---------|-----------|
| Max identifier length | 128 | PostgreSQL default |
| Max path depth | 10 | Prevent deep traversal |
| Max recursive depth | 100 | Default `ascendant`/`descendant` limit |

## 8. Parser Notes

### 8.1 LL(1) Compatibility

The grammar is **mostly LL(1)** with documented exceptions requiring bounded lookahead:

**LL(1) compliant:**
- Left-factored productions
- No left recursion
- Most decisions require single-token lookahead

**Exceptions requiring bounded lookahead:**

| Case | Lookahead Required | Strategy |
|------|-------------------|----------|
| `( expr )` vs `( subquery )` | Scan for `\|` before `)` | Bounded scan |
| `aggregate_expr` vs `window_expr` | Check for `over` after aggregate | 1-token post-parse |
| `column_ref` alternatives | Semantic resolution | Post-parse |

### 8.2 Lookahead Points

| Position | Lookahead | Decision |
|----------|-----------|----------|
| After table ref | 1 token | `insert`/`update`/`delete`/`upsert` → mutation |
| After IDENT | 1 token | `(` → function call; `.` → path |
| After `not` | 1 token | `exists` → exists check; `in` → in check |
| After `(` | bounded | Scan for `\|` to decide subquery vs expr |
| After aggregate | 1 token | `over` → window_expr; else → aggregate_expr |

### 8.3 Semantic Resolution (H3)

Pseudo-table keywords (`parent`, `child`, `ascendant`, `descendant`) and custom roles are **not reserved keywords**. Resolution order:

1. Quoted identifier (`"parent"`) → always real column
2. Check schema for pseudo-table/role match → pseudo-table
3. Check schema for relation match → join path
4. Fallback → real column

This allows schemas with columns named `parent` while still supporting pseudo-table syntax via unquoted access.

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 2.2 | 2026-01-24 | Multi-LLM review fixes: H1 (select_item parsing), H2 (subquery disambiguation), H3 (custom tokens), H4 (defer pseudo_table.*), L1 (case requires when), L3 (delete !), M7 (IN literal_list) |
| 2.1 | 2026-01-24 | Added pseudo-table extensions (V1.0 filtering, V1.1 aggregate/projection) |
| 2.0 | 2026-01-20 | Pipe syntax, `with` instead of `include`, position-aware WHERE |
| 1.0 | 2026-01-06 | Initial grammar from CLI-NQL spec |

## References

- [CLI-NQL Natural Query Language](../plans/CLI-NQL-natural-query-language.md) — original specification (historical)
- [NQL Parser Audit](../plans/NQL-PARSER-AUDIT-2026-01.md) — audit and v2.0 design (historical)
- [Self-Ref Pseudo-Columns Spec](SELF-REF-PSEUDO-COLUMNS-SPEC.md) — pseudo-table feature
