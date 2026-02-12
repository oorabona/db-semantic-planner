# NQL Grammar (EBNF) — Single Source of Truth

**Status:** Canonical
**Created:** 2026-01-24
**Version:** 6.0 (E13-ALL: JSONB operators, set operations, date range expansion, range INSERT, simple CASE, multi-row INSERT)
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
line              = [ statement ] NEWLINE ;             (* Line-oriented parsing *)
statement         = command | query | mutation_pipeline ;

(* REPL commands (.help, .schema, etc.) *)
command           = "." IDENT { ANY_TOKEN } ;
```

## 2. Queries

```ebnf
(* ============================================================ *)
(* QUERY STRUCTURE                                              *)
(* ============================================================ *)

query             = table_ref { "|" query_clause } ;
table_ref         = ident_segment ;  (* Single table - relations via path expressions *)

query_clause      = where_clause
                  | select_clause
                  | group_clause
                  | having_clause
                  | order_clause
                  | limit_clause
                  | offset_clause
                  | flat_clause
                  | set_clause
                  | bind_clause
                  | lock_clause ;

(* Clauses *)
where_clause      = "where" boolean_expr ;
select_clause     = "select" [ "distinct" ] select_list ;
group_clause      = "group" "by" expr_list ;
having_clause     = "having" boolean_expr ;
order_clause      = "order" "by" order_list ;
limit_clause      = "limit" [ ident_segment ] NUMBER ;
                    (* Without ident: top-level LIMIT; with ident: per-include limit *)
offset_clause     = "offset" NUMBER ;
flat_clause       = "flat" ;  (* Forces JOIN strategy instead of json_agg *)

(* Row-level locking — E15 *)
lock_clause       = lock_strength [ lock_wait_policy ] ;
lock_strength     = "for" "update"
                  | "for" "share"
                  | "for" "no" "key" "update"
                  | "for" "key" "share" ;
lock_wait_policy  = "skip" "locked"
                  | "nowait" ;

(* Set operations — TERMINAL in pipeline: no further clauses after set_clause *)
set_clause        = set_op [ "all" ] set_operand ;
set_op            = "union" | "intersect" | "except" ;
set_operand       = "(" query ")" | ident_segment ;  (* inline sub-query or bound name *)
```

### 2.1 WHERE vs HAVING Semantics

| Position | Aggregate Allowed? | Compiles To |
|----------|-------------------|-------------|
| Before `group by` | ❌ No | SQL `WHERE` |
| After `group by` | ✅ Yes | SQL `HAVING` |

Note: Multiple `where` clauses are allowed — each compiles based on position relative to `group by`.

### 2.2 Relation Inclusion via Path Expressions (v2.1)

Relations are included automatically when referenced via path expressions in `select`:

```sql
-- Include posts relation (compiles to json_agg by default)
authors | select name, posts.*

-- Include nested relations
authors | select name, posts.title, posts.comments.*

-- Force JOIN strategy (flat result, potential row explosion)
authors | select name, posts.* | flat
```

**Default strategy:** `json_agg` (nested JSON, no row explosion)
**With `| flat`:** JOIN strategy (flat rows, may cause row explosion)

**Column aliasing in flat mode:**
| Path Expression | Flat Alias |
|-----------------|------------|
| `posts.title` | `posts_title` |
| `posts.comments.content` | `posts_comments_content` |

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
                  | is_null_check
                  | quantified_relation_check       (* SPEC-002: cross-table filtering *)
                  | explicit_quantifier ;            (* SPEC-002: some/none/every *)

(* SPEC-002: Quantified relation checks *)
quantified_relation_check
                  = [ "not" | "all" ] relation_path_expr comp_op expr ;
explicit_quantifier
                  = ( "some" | "none" | "every" ) "(" relation_path ")" "." ident_segment comp_op expr ;
relation_path     = ident_segment { "." ident_segment } ;        (* relation.relation... *)
relation_path_expr= relation_path "." ident_segment ;            (* ends with column *)

(* Relation alias for complex conditions *)
relation_alias    = relation_path "as" IDENT "," boolean_expr ;  (* author as a, a.name = 'X' and a.active = true *)

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
(* JSON OPERATORS (v6.0)                                        *)
(* ============================================================ *)

(* JSON field access operators — PostgreSQL JSONB semantics *)
json_extract      = expr "->" ( STRING | NUMBER ) ;     (* -> returns json *)
json_extract_text = expr "->>" ( STRING | NUMBER ) ;    (* ->> returns text *)
json_path_op      = expr "#>" STRING ;                  (* #> path returns json *)
json_path_text_op = expr "#>>" STRING ;                 (* #>> path returns text *)
json_contains     = expr "@>" expr ;                    (* containment: left @> right *)
json_contained_by = expr "<@" expr ;                    (* contained by: left <@ right *)
json_exists       = expr "?" STRING ;                   (* key existence *)
(* NOTE: ?| (any key) and ?& (all keys) are deferred to v7.0 *)

(* JSON functions — portable notation (alternative to operators) *)
json_func         = ( "json_extract" | "json_extract_text"
                    | "json_path" | "json_path_text"
                    | "json_contains" | "json_contained_by"
                    | "json_exists" ) "(" expr { "," expr } ")" ;

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
(* Searched CASE: CASE WHEN bool THEN expr ... END *)
(* Simple CASE:   CASE expr WHEN val THEN expr ... END (normalized to searched) *)
case_expr         = "case" ( searched_case_body | simple_case_body )
                    [ else_clause ] "end" ;
searched_case_body = searched_when { searched_when } ;
searched_when     = "when" boolean_expr "then" expr ;
simple_case_body  = expr simple_when { simple_when } ;
simple_when       = "when" expr "then" expr ;
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

## 5. Cross-Table Relations (SPEC-002)

**Feature:** V1.0 — filtering and selection via cross-table relation paths

Cross-table pseudo-columns enable intuitive access to related table data via dotted path expressions: `posts.author.name`, `orders.customer.address.city`.

### 5.1 Relation Path Expressions

```ebnf
(* Relation path - traverses named relations *)
relation_path     = ident_segment { "." ident_segment } ;
relation_path_expr= relation_path "." ident_segment ;
```

**Examples:**
```sql
-- belongsTo (to-one)
posts | where author.name = 'Alice'                      -- EXISTS (optimized: JOIN)
posts | select title, author.name

-- hasMany (to-many)
authors | where posts.published = true                   -- EXISTS (default: SOME)
authors | where NOT posts.published = true               -- NOT EXISTS (NONE)
authors | where ALL posts.published = true               -- NOT EXISTS + EXISTS (EVERY)

-- Chained relations
orders | where items.product.category.name = 'Electronics'
```

### 5.2 Quantifiers for To-Many Relations

| Syntax | Meaning | SQL Pattern |
|--------|---------|-------------|
| `relation.col = val` | SOME (default) | `EXISTS (SELECT 1 FROM relation WHERE col = val)` |
| `NOT relation.col = val` | NONE | `NOT EXISTS (SELECT 1 FROM relation WHERE col = val)` |
| `ALL relation.col = val` | EVERY | `NOT EXISTS (...WHERE NOT col = val) AND EXISTS (...)` |

**Explicit quantifier functions:**
```sql
-- Equivalent to implicit forms but more readable
authors | where some(posts).published = true             -- same as posts.published = true
authors | where none(posts).published = true             -- same as NOT posts.published = true
authors | where every(posts).published = true            -- same as ALL posts.published = true
```

### 5.3 Relation Alias

For complex conditions on the same relation:

```sql
-- Without alias (verbose)
posts | where author.name = 'Alice' and author.active = true

-- With alias (concise)
posts | where author as a, a.name = 'Alice' and a.active = true

-- Complex: filter and aggregate
authors | where posts as p, p.published = true and p.views > 1000
```

### 5.4 Combined WHERE + SELECT Optimization

When the same relation appears in both WHERE and SELECT:

```sql
posts | where author.name = 'Alice' | select title, author.*
```

**Optimization:** Reuse the JOIN from WHERE, apply `to_jsonb()` for SELECT.

### 5.5 Cross-Table + Self-Referential Chains

Combine cross-table and self-referential traversal:

```sql
-- Posts by authors in any subcategory of 'Electronics'
posts | where author.category.ascendant.name = 'Electronics'

-- Products in categories managed by Alice's team
products | where category.manager.ascendant.name = 'Alice'
```

**SQL:** Cross-table JOINs + WITH RECURSIVE for self-ref.

### 5.6 M:N Relations

M:N relations use the same syntax — resolved via junction table:

```sql
-- Posts with tag named 'TypeScript' (posts ↔ tags via post_tags)
posts | where tags.name = 'TypeScript'
-- SQL: EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = posts.id AND t.name = ?)
```

### 5.7 `| flat` with Cross-Table Relations

```sql
-- Default: json_agg for hasMany in select
authors | select name, posts.*
-- Result: { name: "Alice", posts: [{...}, {...}] }

-- With flat: JOIN expansion (row explosion)
authors | select name, posts.* | flat
-- Result: { name: "Alice", posts_id: 1, posts_title: "..." }, { name: "Alice", posts_id: 2, ... }
```

### 5.8 Name Collision Resolution

When a relation name matches a real column:

```sql
-- 'author' is a real column (string)
posts | where "author" = 'legacy-field'                  -- real column (quoted)

-- 'author' is also a relation
posts | where author.name = 'Alice'                      -- relation (unquoted path)
```

**Resolution order:** Quoted → real column; Unquoted path → relation → column.

## 6. Mutations

```ebnf
(* ============================================================ *)
(* MUTATIONS (with optional pipeline for RETURNING)             *)
(* ============================================================ *)

mutation_pipeline = mutation { "|" mutation_clause } ;
mutation_clause   = select_clause | bind_clause ;

(* bind captures mutation result into a variable for chaining *)
bind_clause       = "bind" IDENT ;

mutation          = insert_stmt | update_stmt | delete_stmt | upsert_stmt
                  | insert_from_stmt | upsert_from_stmt ;

insert_stmt       = "insert" "into" ident_segment
                    ( "set" assignment_list { "|" "set" assignment_list }
                    | "values" "(" assignment_list ")" { "," "(" assignment_list ")" } )
                    [ from_clause ] [ "!" ] ;
update_stmt       = "update" ident_segment "set" assignment_list
                    [ "where" boolean_expr ] [ "!" ] ;
(* L3 FIX: delete requires WHERE unless "!" force flag is used *)
delete_stmt       = "delete" "from" ident_segment ( "where" boolean_expr [ "!" ] | "!" ) ;
upsert_stmt       = "upsert" "into" ident_segment "on" "(" ident_list ")"
                    "set" assignment_list [ "!" ] ;

(* Bulk insert from source table or bound CTE *)
insert_from_stmt  = "insert" "into" ident_segment "from" ident_segment
                    [ where_clause ] [ limit_clause ] ;

(* Bulk upsert from source table or bound CTE *)
upsert_from_stmt  = "upsert" "into" ident_segment "on" ident_list
                    "from" ident_segment [ where_clause ] [ limit_clause ] ;

(* INSERT FROM clause for FK lookup and bulk inserts *)
from_clause       = "from" [ "each" ] ident_segment [ "as" ident_segment ]
                    [ where_clause ] [ lock_clause ] ;
                    (* lock_clause defined in § Query clauses above *)

assignment_list   = assignment { "," assignment } ;
assignment        = ident_segment "=" ( expr | "default" | "null" | range_literal ) ;
```

### 5.1 Trailing `!` (Force Execution)

The `!` suffix forces execution without safety checks (e.g., `update without where`).

## 7. Literals and Tokens

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

(* Date range literal — expanded at compile time to date comparisons *)
(* Supported formats: 'YYYY', 'YYYY-QN', 'YYYY-MM', 'YYYY-WNN' *)
(* Example: `where created_at in '2024-Q1'` expands to *)
(*   WHERE created_at >= '2024-01-01' AND created_at < '2024-04-01' *)
date_range_literal = STRING ;  (* Semantic layer validates format *)

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

## 8. Semantic Rules

These rules are enforced after parsing:

### 8.1 Position-Aware Aggregates

| Position | Aggregates Allowed? | Compiles To |
|----------|-------------------|-------------|
| `where` before `group by` | ❌ No | SQL `WHERE` |
| `where` after `group by` | ✅ Yes | SQL `HAVING` |
| `having` clause | ✅ Yes | SQL `HAVING` |

### 8.2 Validation Rules

| Rule | Error |
|------|-------|
| `where` before `group by` contains aggregate | "Aggregate functions not allowed before GROUP BY" |
| Duplicate `bind` name | "Binding 'X' already defined" |
| Unknown column/table | "Column 'X' not found. Did you mean 'Y'?" |
| `select` with aggregate + non-grouped column | "Column 'X' must be in GROUP BY or aggregate" |
| Mixed direction pseudo-chain | "Cannot mix parent and child in same traversal chain" |
| Multi-FK without explicit roles | "Multiple self-referential FKs require parentRole/childRole" |

### 8.3 Resolution Order

For path expressions:
1. Quoted identifier (`"parent"`) → always real column
2. Match against pseudo-column names from schema → pseudo-table
3. Match against relation names → join path
4. Fallback → real column

### 8.4 Limits (Configurable)

| Limit | Default | Rationale |
|-------|---------|-----------|
| Max identifier length | 128 | PostgreSQL default |
| Max path depth | 10 | Prevent deep traversal |
| Max recursive depth | 100 | Default `ascendant`/`descendant` limit |

## 9. Parser Notes

### 9.1 LL(1) Compatibility

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

### 9.2 Lookahead Points

| Position | Lookahead | Decision |
|----------|-----------|----------|
| After table ref | 1 token | `insert`/`update`/`delete`/`upsert` → mutation |
| After IDENT | 1 token | `(` → function call; `.` → path |
| After `not` | 1 token | `exists` → exists check; `in` → in check; `relation.col` → quantified check |
| After `(` | bounded | Scan for `\|` to decide subquery vs expr |
| After aggregate | 1 token | `over` → window_expr; else → aggregate_expr |
| After `all` | 1 token | `relation.col` → ALL quantifier |

### 9.3 Semantic Resolution (H3)

Pseudo-table keywords (`parent`, `child`, `ascendant`, `descendant`) and custom roles are **not reserved keywords**. Resolution order:

1. Quoted identifier (`"parent"`) → always real column
2. Check schema for pseudo-table/role match → pseudo-table
3. Check schema for relation match → join path
4. Fallback → real column

This allows schemas with columns named `parent` while still supporting pseudo-table syntax via unquoted access.

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 6.0 | 2026-02-07 | **E13-ALL:** Added set operations (`union`/`intersect`/`except` with `all`), JSONB operators (`->`/`->>`/`@>`/`<@`/`?`/`#>`/`#>>`), JSON functions (`json_extract`, `json_path`, etc.), `IN date_range_literal` expansion (`'2024-Q1'`→date range), range literals in INSERT assignments, multi-row INSERT (`values (...)` + pipe continuation `| set`), simple CASE expression, per-include `limit`, window `lag`/`lead` offset/default. Deferred: `?\|` and `?&` operators |
| 5.0 | 2026-02-04 | **NQL-BIND:** Removed `let` keyword (dead code), generalized `bind` clause to queries (CTE capture), added `insert_from_stmt` and `upsert_from_stmt` for bulk insert/upsert from source table or bound CTE |
| 4.0 | 2026-01-25 | **SPEC-002 Cross-Table Relations:** Added quantified relation checks (`NOT`/`ALL` prefixes), explicit quantifiers (`some()`/`none()`/`every()`), relation aliases, Section 5 for cross-table patterns |
| 3.0 | 2026-01-24 | **NQL v2.1 Grammar Simplification:** Removed `with` keyword entirely (BREAKING), added `flat` clause for JOIN strategy, relations now via path expressions in select |
| 2.2 | 2026-01-24 | Multi-LLM review fixes: H1 (select_item parsing), H2 (subquery disambiguation), H3 (custom tokens), H4 (defer pseudo_table.*), L1 (case requires when), L3 (delete !), M7 (IN literal_list) |
| 2.1 | 2026-01-24 | Added pseudo-table extensions (V1.0 filtering, V1.1 aggregate/projection) |
| 2.0 | 2026-01-20 | Pipe syntax, `with` instead of `include`, position-aware WHERE |
| 1.0 | 2026-01-06 | Initial grammar from CLI-NQL spec |

## References

- [NQL v2.1 Grammar Simplification](NQL-V2.1-SIMPLIFICATION-SPEC.md) — current specification
- [Cross-Table Pseudo-Columns Spec](CROSS-TABLE-PSEUDO-COLUMNS-SPEC.md) — SPEC-002, cross-table relations
- [Self-Ref Pseudo-Columns Spec](SELF-REF-PSEUDO-COLUMNS-SPEC.md) — SPEC-001, pseudo-table feature
- [CLI-NQL Natural Query Language](../plans/CLI-NQL-natural-query-language.md) — original specification (historical)
- [NQL Parser Audit](../plans/NQL-PARSER-AUDIT-2026-01.md) — audit and v2.0 design (historical)
