---
doc-meta:
  status: canonical
  scope: cli
  type: specification
  created: 2026-01-20
  updated: 2026-01-21
  completed: 2026-01-21
  complexity: ENTERPRISE
  time-budget: 20h
---

# Specification: CLI-NQL - Natural Query Language v1.0

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | cli |
| Complexity | ENTERPRISE |
| Time budget | ~20h |
| Blocks | 13 |
| BDD scenarios | 50+ |
| Risk level | HIGH |

## 1. Problem Statement

The current REPL parser supports basic queries and mutations, but lacks support for:
- **Relation path traversal** - Cannot express `product.category.parent.name` chains
- **Subqueries** - No `in (subquery)` or scalar subquery support
- **Existence checks** - No `has`/`not has` (EXISTS) support
- **FK lookup INSERT** - Cannot insert with foreign key looked up from another table
- **Recursive relations** - No ancestors/descendants traversal
- **Window functions** - Core supports `WindowIntent` but parser doesn't handle `over` clause

The goal is to create a formal, LL(1) parseable grammar that serves as a "new SQL" - simpler for humans and AI while being deterministic and unambiguous.

## 2. User Stories

### US-01: Relation Path Traversal
AS A developer exploring data
I WANT to filter by related table columns using dot notation
SO THAT I can express complex joins naturally

ACCEPTANCE: `products where category.parent.name = 'Electronics'` works

### US-02: FK Lookup INSERT
AS A developer inserting data
I WANT to reference related table values during INSERT
SO THAT I don't need to know foreign key IDs

ACCEPTANCE: `products insert title = 'Phone', categoryId = id from categories where name = 'Electronics'`

### US-03: Existence Checks
AS A developer querying data
I WANT to filter by existence of related records
SO THAT I can find orphans or verify relationships

ACCEPTANCE: `categories where not has products` returns empty categories

### US-04: Recursive Relations
AS A developer with hierarchical data
I WANT to traverse ancestor/descendant chains
SO THAT I can query tree structures naturally

ACCEPTANCE: `categories where ancestors has name = 'Electronics'` finds all subcategories

### US-05: Parse Tree Debug
AS A developer debugging queries
I WANT to see the parse tree of my query
SO THAT I can understand how it's interpreted

ACCEPTANCE: `.parse on` then `users where active = true` shows AST

### US-06: Window Functions
AS A developer analyzing data
I WANT to use window functions in queries
SO THAT I can compute rankings and running totals

ACCEPTANCE: `products select *, rank() over (partition by categoryId order by price desc) as priceRank`

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: Keywords are reserved (SQL standard) - use quoted identifiers `"name"` to escape
- INV-02: Resolution order for unquoted identifiers: relations first, then columns, then error
- INV-03: Quoted identifiers (`"name"`) force column/identifier interpretation, bypassing keyword/relation lookup
- INV-04: Path expressions are left-associative: `a.b.c` = `(a.b).c`
- INV-05: Subqueries always require parentheses
- INV-06: Schema defines which relations are recursive (ancestors/descendants)
- INV-07: List separators (commas) are mandatory for select, order, assignments, group by, includes

### 3.2 Preconditions (required before action)

- PRE-01: Schema must define relations with explicit types (many-to-one, one-to-many, etc.)
- PRE-02: Recursive relations must specify `through` relation in schema
- PRE-03: M:N relations must specify junction table in schema

### 3.3 Effects (what changes)

- EFF-01: Relation paths generate appropriate JOINs
- EFF-02: Recursive paths generate recursive CTEs
- EFF-03: `has`/`not has` generates EXISTS/NOT EXISTS subqueries
- EFF-04: `from` clause in INSERT generates subquery for FK lookup

### 3.4 Error Handling

- ERR-01: Unknown relation → `"foo" is not a relation on table "users". Available: posts, comments`
- ERR-02: Ambiguous path → Use quoted identifier to force column: `"parent"` instead of `parent`
- ERR-03: Invalid recursive → `"children" is not defined as recursive in schema`
- ERR-04: Scalar expected → `Subquery must return exactly one row for scalar assignment`
- ERR-05: Reserved keyword → `"where" is a reserved keyword. Use "\"where\"" to reference as identifier`

### 3.5 Design Notes (v1 scope)

- **OR conditions**: Supported with proper precedence (AND binds tighter than OR). Use parentheses for explicit grouping.
- **Expressions in assignments**: Supports literal | path_expr | subquery | `null` | `default` | arithmetic | function calls | CASE.
- **Aggregate in conditions**: `count(relation where ...)` supported for filtering by related count.
- **Existence sugar**: Both `has relation where ...` and `relation has condition` are valid (desugar to same AST).
- **Siblings**: Not first-class in v1. Workaround via parentId comparison:
  ```nql
  -- Siblings of 'Phones' (same parent, excluding Phones itself)
  category.parentId = (categories where name = 'Phones' select parentId)
  and categoryId != (categories where name = 'Phones')
  ```
- **Self-correlation ($self)**: Not in v1. Use explicit subqueries for self-referential comparisons.

### 3.6 v2 Considerations (deferred)

| Feature | Description | v1 Workaround |
|---------|-------------|---------------|
| **Derived relations** | `siblings` as schema-defined computed relation | Explicit parentId subqueries |
| **$self correlation** | `where id != $self.id` in nested context | Explicit subquery with ID |
| **UNION/INTERSECT/EXCEPT** | Set operations on queries | Multiple queries |
| **Arbitrary FROM joins** | `from t1 join t2 on t1.x = t2.y` (non-schema) | Use path expressions via schema relations |

Note: Multi-table joins in FROM are supported via **path expressions** when relations are schema-defined.
Only arbitrary (non-schema) joins are deferred.

**Siblings macro proposal (v2):**
```typescript
// Schema definition
{
  name: 'siblings',
  type: 'derived',
  compute: (self) => `parentId = ${self}.parentId AND id != ${self}.id`
}

// NQL usage
products where category.siblings has name = 'Phones'
// Expands to: category.parentId = (categories where name = 'Phones' select parentId)
//             AND categoryId != (categories where name = 'Phones' select id)
```

## 4. Technical Design

### 4.1 Architecture Decision

Extend existing parser.ts with:
1. **Path expression parser** - handles `a.b.c` dot notation with quoted identifier support
2. **Subquery parser** - handles `(query)` in value positions
3. **Existence parser** - handles `has`/`not has` keywords
4. **FROM clause parser** - handles `from table where` for INSERT
5. **Window expression parser** - handles `over (partition by ... order by ...)`

Grammar is LL(1) - single token lookahead, no backtracking.

### 4.2 Schema Relation Types

```typescript
interface RelationDefinition {
  type: 'many-to-one' | 'one-to-many' | 'many-to-many' | 'recursive-up' | 'recursive-down';
  target: string;           // Target table name
  foreignKey?: string;      // FK column (for many-to-one, one-to-many)
  through?: string;         // Junction table (many-to-many) or relation name (recursive)
  maxDepth?: number;        // Limit for recursive traversal (default: 10)
  junction?: {              // M:N details
    table: string;
    sourceKey: string;
    targetKey: string;
  };
}
```

### 4.3 EBNF Grammar (LL(1))

```ebnf
(* ============================================== *)
(* NQL v1.0 - Natural Query Language Grammar      *)
(* LL(1) parseable                                *)
(* ============================================== *)

(* ============================================== *)
(* LEXICAL SPECIFICATION                          *)
(* ============================================== *)

(* Case sensitivity:
   - Keywords: case-INSENSITIVE (where = WHERE = Where)
   - Identifiers: case-SENSITIVE (preserved as-is)
   - String literals: case-SENSITIVE
*)

(* String literals - SINGLE QUOTES ONLY (SQL standard) *)
string_lit          = "'" { string_char } "'" ;
string_char         = any_char_except_single_quote | escape_seq ;
escape_seq          = "\\" ( "'" | "\\" | "n" | "r" | "t" ) | "''" ;  (* '' = escaped single quote *)

(* Quoted identifiers - DOUBLE QUOTES ONLY (SQL standard) *)
(* Force identifier interpretation: escape keywords, force column over relation *)
quoted_identifier   = '"' identifier '"' ;  (* Must be non-empty valid identifier *)
(* Examples:
   - "where" as column name (escapes keyword)
   - "children" forces column (not relation)
   - "Parent" preserves case (identifiers are case-sensitive)
*)

(* Comments *)
comment             = line_comment | block_comment ;
line_comment        = ( "--" | "#" ) { any_char_except_newline } newline ;
block_comment       = "/*" { any_char } "*/" ;

(* Numbers *)
number_lit          = [ "-" ] digits [ "." digits ] ;
digits              = digit { digit } ;
digit               = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;

(* Booleans *)
boolean_lit         = "true" | "false" ;

(* Identifiers *)
identifier          = letter { letter | digit | "_" } ;
identifier_chars    = { letter | digit | "_" } ;
letter              = "a" | ... | "z" | "A" | ... | "Z" ;

(* Contextually reserved (only after table_name in position 2) *)
mutation_keywords   = "insert" | "update" | "delete" | "upsert" ;

(* Clause keywords (start new clause) *)
clause_keywords     = "where" | "include" | "select" | "order" | "group"
                    | "having" | "limit" | "offset" | "from" | "on" | "set" ;

(* Compound operators (multi-token, handled at parser level) *)
(* "is not", "not in", "not has", "order by", "group by",
   "for update", "skip locked", "do nothing", "do update",
   "partition by" *)


(* ============================================== *)
(* TOP LEVEL                                      *)
(* ============================================== *)

statement           = command | table_statement ;
table_statement     = table_name statement_body ;
statement_body      = mutation_body | query_body ;

(* Lookahead: if token[1] in {insert,update,delete,upsert} → mutation, else query *)


(* ============================================== *)
(* COMMANDS (dot-prefixed)                        *)
(* ============================================== *)

command             = "." command_name [ command_args ] ;
command_name        = "tables" | "use" | "import" | "alias" | "explain"
                    | "split" | "exec" | "dialect" | "include" | "parse" ;
command_args        = { token } ;


(* ============================================== *)
(* QUERIES                                        *)
(* ============================================== *)

query_body          = [ where_clause ]
                      [ include_clause ]
                      [ select_clause ]
                      [ group_clause ]
                      [ having_clause ]
                      [ order_clause ]
                      [ limit_clause ]
                      [ offset_clause ] ;


(* ============================================== *)
(* WHERE CLAUSE                                   *)
(* ============================================== *)

where_clause        = "where" condition_expr ;

(* Precedence: AND binds tighter than OR *)
condition_expr      = condition_term { "or" condition_term } ;
condition_term      = condition_factor { "and" condition_factor } ;
condition_factor    = condition_atom | "(" condition_expr ")" ;

condition_atom      = comparison | existence_check | in_check | aggregate_condition ;

comparison          = comparable comp_operator value_expr ;
comparable          = path_expr | aggregate_expr ;
comp_operator       = "=" | "!=" | ">" | "<" | ">=" | "<="
                    | "like"
                    | "is" [ "not" ]
                    | "overlaps" | "contains" | "containedBy" ;

existence_check     = [ "not" ] "has" relation_path [ where_clause ]
                    | path_expr [ "not" ] "has" condition_expr ;
(* Sugar: "category.ancestors has name = 'X'" ≡ "has category.ancestors where name = 'X'" *)

in_check            = path_expr [ "not" ] "in" ( subquery | literal_list ) ;
literal_list        = "(" literal { "," literal } ")" ;

(* Aggregate in condition: count(relation where ...) >= N *)
aggregate_condition = aggregate_expr comp_operator value_expr ;
aggregate_expr      = agg_function "(" [ "distinct" ] ( "*" | path_expr | relation_filter ) ")" ;
relation_filter     = relation_path [ where_clause ] ;


(* ============================================== *)
(* PATH EXPRESSIONS                               *)
(* ============================================== *)

path_expr           = path_segment { "." path_segment } ;
path_segment        = identifier | quoted_identifier ;

(* Resolution rules:
   - Unquoted: check relations first, then columns, then error
   - Quoted ("name"): columns ONLY, bypass relation lookup
*)

relation_path       = identifier { "." identifier } ;
(* Semantic constraint: ALL segments must be relations (validated against schema) *)


(* ============================================== *)
(* VALUE EXPRESSIONS                              *)
(* ============================================== *)

value_expr          = expr | subquery | "null" | "default" ;
(* Note: expr is defined in EXPRESSIONS section below *)

literal             = string_lit | number_lit | boolean_lit | range_lit ;

range_lit           = left_bound range_value "," range_value right_bound ;
left_bound          = "[" | "(" ;
right_bound         = "]" | ")" ;
range_value         = date_lit | number_lit ;
date_lit            = digit digit digit digit "-" digit digit "-" digit digit ;  (* YYYY-MM-DD *)


(* ============================================== *)
(* SUBQUERIES                                     *)
(* ============================================== *)

subquery            = "(" table_name query_body ")" ;

(* Scalar subquery: implicitly selects PRIMARY KEY column
   If explicit column needed: (table where x = y select col) *)


(* ============================================== *)
(* INCLUDE CLAUSE                                 *)
(* ============================================== *)

include_clause      = "include" include_list ;
include_list        = include_spec { "," include_spec } ;  (* comma-separated for CONSISTENCY *)
include_spec        = relation_name [ where_clause ] [ include_clause ] ;

(* Include semantics:

   NESTING via repeated "include" keyword:
   - "include category include tags" = tags nested IN category (category.tags)

   MULTIPLE ROOTS via comma:
   - "include category, tags" = two separate root includes

   COMBINED:
   - "include category include tags, assets" = category.tags + root assets

   Examples:
   | NQL | Structure |
   |-----|-----------|
   | include posts | [posts] |
   | include posts, comments | [posts, comments] |
   | include posts include author | [posts → author] |
   | include posts include author, tags | [posts → author, tags] |
   | include posts where published = true include author | [posts(filtered) → author] |
*)
relation_name       = identifier ;


(* ============================================== *)
(* SELECT CLAUSE                                  *)
(* ============================================== *)

select_clause       = "select" [ "distinct" ] select_list ;
select_list         = select_item { "," select_item } ;  (* comma-separated MANDATORY *)
select_item         = "*"
                    | window_expr
                    | aggregate_expr [ "as" alias ]
                    | expr [ "as" alias ] ;

(* aggregate_expr defined in WHERE CLAUSE section - supports relation_filter *)
agg_function        = "count" | "sum" | "avg" | "min" | "max" ;


(* ============================================== *)
(* WINDOW FUNCTIONS                               *)
(* ============================================== *)

window_expr         = window_source "over" "(" window_spec ")" [ "as" alias ] ;
window_source       = aggregate_expr | window_only_function ;
window_only_function = ( "rank" | "dense_rank" | "row_number" ) "(" ")"
                     | ( "lag" | "lead" ) "(" path_expr [ "," number_lit [ "," literal ] ] ")" ;

window_spec         = [ partition_clause ] [ window_order_clause ] ;
partition_clause    = "partition" "by" path_expr { "," path_expr } ;
window_order_clause = "order" "by" order_list ;


(* ============================================== *)
(* GROUP BY / HAVING                              *)
(* ============================================== *)

group_clause        = "group" "by" group_list ;
group_list          = path_expr { "," path_expr } ;  (* comma-separated MANDATORY *)
(* Supports: column, relation.column (e.g., category.id) *)

having_clause       = "having" condition_expr ;


(* ============================================== *)
(* ORDER BY                                       *)
(* ============================================== *)

order_clause        = "order" "by" order_list ;
order_list          = order_item { "," order_item } ;  (* comma-separated MANDATORY *)
order_item          = ( path_expr | aggregate_expr | alias ) [ "asc" | "desc" ] ;
(* Order by supports: column, relation.column, aggregate, or SELECT alias *)


(* ============================================== *)
(* LIMIT / OFFSET                                 *)
(* ============================================== *)

limit_clause        = "limit" number_lit ;
offset_clause       = "offset" number_lit ;


(* ============================================== *)
(* MUTATIONS                                      *)
(* ============================================== *)

mutation_body       = insert_body | update_body | delete_body | upsert_body ;

(* INSERT with optional FROM clause for FK lookup *)
insert_body         = "insert" assignment_list [ from_clause ] [ "!" ] ;

from_clause         = "from" [ "each" ] table_name [ "as" alias ]
                      [ where_clause ] [ for_update_clause ] ;
for_update_clause   = "for" "update" [ "skip" "locked" ] ;

(* FROM clause semantics:

   - WITHOUT "each": Scalar source - must return 0 or 1 row
     - 0 rows → ERR-04 "Scalar subquery returned no rows"
     - 1 row  → path_expr in assignments resolve from source context

   - WITH "each": Bulk insert - source may return multiple rows
     - Each source row generates one INSERT

   - Path expressions in assignments resolve via source's schema relations:
     - "id" → source.id (direct column)
     - "category.id" → source.category.id (relation traversal, generates JOIN)
     - "category.parent.name" → N-level traversal (multiple JOINs)

   Examples:
   -- Scalar: single category lookup
   products insert title='Phone', categoryId=id from categories where name='Electronics'

   -- Bulk with relation traversal (planner generates JOIN)
   orderItems insert
     orderId=id,
     productId=product.id,
     categoryName=product.category.name
   from each lineItems where status='pending'
   -- Resolves: lineItems JOIN products ON lineItems.productId = products.id
   --           JOIN categories ON products.categoryId = categories.id

   - Alias is optional - when omitted, source table name is used as implicit alias
*)

(* UPDATE *)
update_body         = "update" "set" assignment_list where_clause [ "!" ] ;

(* DELETE *)
delete_body         = "delete" where_clause [ "!" ] ;

(* UPSERT *)
upsert_body         = "upsert" assignment_list "on" conflict_target "do" conflict_action [ "!" ] ;
conflict_target     = identifier | "(" identifier { "," identifier } ")" ;
conflict_action     = "nothing" | "update" "set" assignment_list ;


(* ============================================== *)
(* ASSIGNMENTS                                    *)
(* ============================================== *)

assignment_list     = assignment { "," assignment } ;  (* comma-separated MANDATORY *)
assignment          = column_name "=" assignment_value ;
assignment_value    = expr | subquery | "default" | "null" ;

column_name         = identifier ;
alias               = identifier ;
table_name          = identifier ;


(* ============================================== *)
(* EXPRESSIONS (for assignments and comparisons)  *)
(* ============================================== *)

expr                = add_expr ;
add_expr            = mul_expr { ( "+" | "-" | "||" ) mul_expr } ;
mul_expr            = unary_expr { ( "*" | "/" | "%" ) unary_expr } ;
unary_expr          = [ "-" | "not" ] primary_expr ;
primary_expr        = literal
                    | path_expr
                    | function_call
                    | "(" expr ")"
                    | case_expr ;

function_call       = identifier "(" [ expr_list ] ")" ;
expr_list           = expr { "," expr } ;

case_expr           = "case" { when_clause } [ else_clause ] "end" ;
when_clause         = "when" condition_expr "then" expr ;
else_clause         = "else" expr ;
```

### 4.4 Resolution Rules

**Rule 1: Path Expression Resolution**
```
Given path "x.y.z" starting from table T:
1. If x is quoted ("x"): x is column, ERROR if multi-segment
2. Look up "x" in T's relations → if found, continue from relation's target
3. If "x" not in relations and single-segment: "x" is column
4. If "x" not in relations and multi-segment: ERROR
5. Repeat for "y", "z" from new context
```

**Rule 2: Quoted Identifier Escape**
```
"children" in path position → always interpreted as column, never as relation
Use this when column name conflicts with relation name
```

**Rule 3: Recursive Relation Expansion**
```
Given "ancestors" defined as { type: 'recursive-up', through: 'parent' }:
- Generate recursive CTE traversing "parent" relation
- Each level follows parent FK until null
- Depth limited by maxDepth (default 10)
```

**Rule 4: M:N Traversal**
```
Given "tags" defined as { type: 'many-to-many', through: 'postTags' }:
- Generate JOIN through junction table
- postTags.postId → posts.id, postTags.tagId → tags.id
```

**Rule 5: Scalar Subquery Column Selection**
```
Given: categoryId = (categories where name = 'X')
- Implicitly selects PRIMARY KEY of categories
- Equivalent to: categoryId = (categories where name = 'X' select id)
```

### 4.5 Lowering: NQL AST → IntentAST

#### Path Expression → JoinIntent

| NQL | Intent |
|-----|--------|
| `a.b.c` (unquoted) | Chain of JoinIntents following relations |
| `"col"` (quoted) | Direct ColumnIntent (no join) |

**Algorithm:**
```typescript
function lowerPath(path: PathSegment[], context: Table): Intent {
  if (path.length === 1) {
    const seg = path[0];
    if (seg.quoted) return ColumnIntent(seg.name);
    if (hasRelation(context, seg.name)) return JoinIntent(getRelation(context, seg.name));
    if (hasColumn(context, seg.name)) return ColumnIntent(seg.name);
    throw `Unknown: ${seg.name}`;
  }
  // Multi-segment: first N-1 must be relations
  const [head, ...tail] = path;
  if (head.quoted) throw `Quoted identifier cannot start multi-segment path`;
  const relation = getRelation(context, head.name);  // throws if not relation
  const joinIntent = JoinIntent(relation);
  return joinIntent.nested(lowerPath(tail, relation.target));
}
```

#### has/not has → ExistsIntent

| NQL | Intent |
|-----|--------|
| `has relation` | ExistsIntent(relation, filter=null) |
| `has relation where x = y` | ExistsIntent(relation, filter=FilterIntent) |
| `not has relation` | NotExistsIntent(...) |

**Key difference from JOIN:**
- `has` → EXISTS subquery (no columns selected from relation)
- `include` → JOIN (columns selected, data returned)

#### Subquery → SubqueryIntent

| NQL | Intent | SQL |
|-----|--------|-----|
| `= (table where x = y)` | ScalarSubqueryIntent | `= (SELECT id FROM table WHERE x = y)` |
| `in (table where x = y)` | InSubqueryIntent | `IN (SELECT id FROM table WHERE x = y)` |

**Rule:** Subqueries implicitly select **primary key** column unless explicit `select` clause.

#### Recursive relations → RecursiveCTEIntent

| NQL | Intent |
|-----|--------|
| `ancestors` | RecursiveCTEIntent(direction='up', through='parent') |
| `descendants` | RecursiveCTEIntent(direction='down', through='children') |

#### Window expressions → WindowIntent

| NQL | Intent |
|-----|--------|
| `rank() over (partition by x order by y)` | WindowIntent(function='rank', partitionBy=['x'], orderBy=['y']) |
| `sum(price) over (order by date)` | WindowIntent(function='sum', field='price', orderBy=['date']) |

### 4.6 Parse Tree Output (`.parse` command)

When `.parse on`:
```
dbsp> products where category.name = 'Electronics'
─────────────────────────────────────────────────
ParsedQuery {
  table: "products"
  where: [
    Condition {
      path: [
        { segment: "category", quoted: false },
        { segment: "name", quoted: false }
      ]
      operator: "="
      value: { type: "string", value: "Electronics" }
    }
  ]
}
```

## 5. Current Parser Conformance Audit

### 5.1 Implemented ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Basic query (`table where ...`) | ✅ | Full support |
| WHERE with operators | ✅ | =, !=, >, <, >=, <=, like, in, is |
| Range operators | ✅ | overlaps, contains, containedBy |
| INCLUDE | ✅ | Nested includes supported |
| LIMIT / OFFSET | ✅ | Full support |
| ORDER BY | ✅ | ASC/DESC support |
| SELECT aggregates | ✅ | count, sum, avg, min, max |
| GROUP BY / HAVING | ✅ | Full support |
| DISTINCT | ✅ | Full support |
| Qualified columns (1 level) | ✅ | `table.column` distributed to includes |
| INSERT | ✅ | `table insert col = val` |
| UPDATE | ✅ | `table update set col = val where ...` |
| DELETE | ✅ | `table delete where ...` |
| UPSERT | ✅ | `table upsert ... on col do nothing/update` |

### 5.2 Missing ❌ (V1 Required)

| Feature | Priority | Block |
|---------|----------|-------|
| Quoted identifiers (column escape) | P0 | 2 |
| Relation path traversal (N levels) | P0 | 2 |
| Subquery in value position | P0 | 3 |
| `has` / `not has` (EXISTS) | P0 | 4 |
| `in (subquery)` / `not in (subquery)` | P0 | 5 |
| INSERT ... FROM (FK lookup) | P0 | 6 |
| INSERT ... FROM EACH (bulk) | P1 | 6 |
| FOR UPDATE clause | P1 | 6 |
| Recursive relations (ancestors/descendants) | P1 | 7 |
| Window functions (`over` clause) | P1 | 8 |
| Schema relation type definitions | P0 | 1 |
| `.parse` command | P2 | 12 |
| Mandatory comma separators | P1 | 2 |

### 5.3 Grammar Gaps Analysis

**Gap 1: Single-level qualified columns only**
- Current: `table.column` (exactly 2 segments)
- Target: `a.b.c.d` (N segments with relation resolution)

**Gap 2: No quoted identifier support**
- Current: All identifiers treated same
- Target: `"name"` forces column interpretation

**Gap 3: No subquery support**
- Current: Values are literals only
- Target: `= (subquery)` and `in (subquery)` support

**Gap 4: No existence keywords**
- Current: No `has`/`not has`
- Target: `where has relation` and `where not has relation where ...`

**Gap 5: No FROM in INSERT**
- Current: INSERT values are literals only
- Target: `id from table where ...` for FK lookup

**Gap 6: No recursive schema definitions**
- Current: Relations are simple FK mappings
- Target: `recursive-up`/`recursive-down` types with `through`

**Gap 7: No window function parsing**
- Current: Parser doesn't recognize `over (partition by ...)`
- Target: Full window expression support (Core already has WindowIntent)

**Gap 8: Comma separators are optional**
- Current: Tokenizer strips commas, whitespace-separated
- Target: Commas mandatory for select, order, assignments, group by

## 6. Acceptance Criteria (BDD)

### Scenario Group: Relation Path Traversal

```gherkin
@priority:high @type:nominal
Scenario: SC-01 - Two-level relation path in WHERE
  Given schema with products -> categories -> parent relation chain
  When I execute "products where category.parent.name = 'Electronics'"
  Then SQL contains JOIN from products to categories to parent_categories
  And WHERE clause filters on parent_categories.name

@priority:high @type:nominal
Scenario: SC-02 - N-level relation path
  Given schema with 4-level relation chain
  When I execute "a where b.c.d.name = 'X'"
  Then SQL contains 3 JOINs following the relation chain
  And final WHERE filters on d.name

@priority:high @type:nominal
Scenario: SC-03 - Quoted identifier forces column
  Given table with column "parent" AND relation "parent"
  When I execute 'categories where "parent" = 5'
  Then column interpretation is used (no JOIN)
  And SQL filters on categories.parent = 5

@priority:medium @type:error
Scenario: SC-04 - Invalid relation in path
  Given schema without "foo" relation on products
  When I execute "products where foo.name = 'X'"
  Then error: '"foo" is not a relation on table "products"'
```

### Scenario Group: Subqueries

```gherkin
@priority:high @type:nominal
Scenario: SC-05 - Scalar subquery in comparison
  Given categories table with id and name
  When I execute "products where categoryId = (categories where name = 'Electronics')"
  Then SQL contains scalar subquery selecting id (PK)
  And parameters include 'Electronics'

@priority:high @type:nominal
Scenario: SC-06 - IN subquery
  Given products and categories tables
  When I execute "products where categoryId in (categories where active = true)"
  Then SQL contains IN (SELECT id FROM categories WHERE active = true)

@priority:high @type:nominal
Scenario: SC-07 - NOT IN subquery
  Given products and categories tables
  When I execute "products where categoryId not in (categories where deprecated = true)"
  Then SQL contains NOT IN subquery

@priority:medium @type:error
Scenario: SC-08 - Scalar subquery returns multiple rows
  Given subquery that returns multiple ids
  When executed at runtime
  Then database error: subquery returned more than one row
```

### Scenario Group: Existence Checks

```gherkin
@priority:high @type:nominal
Scenario: SC-09 - Simple existence check
  Given categories with products relation
  When I execute "categories where has products"
  Then SQL contains EXISTS (SELECT 1 FROM products WHERE products.categoryId = categories.id)

@priority:high @type:nominal
Scenario: SC-10 - Negated existence check
  Given categories with products relation
  When I execute "categories where not has products"
  Then SQL contains NOT EXISTS subquery

@priority:high @type:nominal
Scenario: SC-11 - Existence with nested condition
  Given categories -> products -> reviews chain
  When I execute "categories where has products where rating > 4"
  Then SQL contains EXISTS with nested WHERE on products.rating
```

### Scenario Group: INSERT FROM

```gherkin
@priority:high @type:nominal
Scenario: SC-12 - INSERT with FK lookup
  Given products and categories tables
  When I execute "products insert title = 'Phone', categoryId = id from categories where name = 'Electronics'"
  Then SQL contains INSERT with subquery for categoryId
  And subquery selects id from categories

@priority:high @type:nominal
Scenario: SC-13 - INSERT FROM with FOR UPDATE
  Given products and categories tables
  When I execute "products insert title = 'Phone', categoryId = id from categories where name = 'Electronics' for update"
  Then SQL contains SELECT ... FOR UPDATE in subquery

@priority:medium @type:nominal
Scenario: SC-14 - INSERT FROM EACH (bulk)
  Given products table and source table
  When I execute "products insert title = name, categoryId = cat_id from each source_data where active = true"
  Then SQL contains INSERT ... SELECT with JOIN to source
```

### Scenario Group: Recursive Relations

```gherkin
@priority:high @type:nominal
Scenario: SC-15 - Ancestors traversal
  Given categories with parentId and schema defining ancestors relation
  When I execute "categories where ancestors has name = 'Electronics'"
  Then SQL contains recursive CTE traversing parent chain
  And checks if any ancestor has name 'Electronics'

@priority:high @type:nominal
Scenario: SC-16 - Descendants traversal
  Given categories with children and schema defining descendants relation
  When I execute "categories where id = 1 include descendants"
  Then SQL contains recursive CTE collecting all children

@priority:medium @type:edge
Scenario: SC-17 - Depth-limited recursion
  Given categories with maxDepth: 5 in schema
  When I execute "categories where ancestors has name = 'Root'"
  Then recursive CTE includes depth counter
  And stops at depth 5
```

### Scenario Group: Window Functions

```gherkin
@priority:high @type:nominal
Scenario: SC-18 - Rank with partition
  Given products table with categoryId and price
  When I execute "products select *, rank() over (partition by categoryId order by price desc) as priceRank"
  Then SQL contains RANK() OVER (PARTITION BY category_id ORDER BY price DESC)

@priority:high @type:nominal
Scenario: SC-19 - Running total
  Given orders table with total and createdAt
  When I execute "orders select orderNumber, total, sum(total) over (order by createdAt) as runningTotal"
  Then SQL contains SUM(total) OVER (ORDER BY created_at)

@priority:medium @type:nominal
Scenario: SC-20 - Row number without partition
  Given users table
  When I execute "users select *, row_number() over (order by createdAt) as rowNum"
  Then SQL contains ROW_NUMBER() OVER (ORDER BY created_at)
```

### Scenario Group: Parse Tree Output

```gherkin
@priority:medium @type:nominal
Scenario: SC-21 - Enable parse mode
  Given REPL is running
  When I execute ".parse on"
  Then subsequent queries show parse tree

@priority:medium @type:nominal
Scenario: SC-22 - Parse tree format
  Given parse mode is on
  When I execute "users where active = true"
  Then output shows ParsedQuery structure
  And shows table, where clauses, operators, values

@priority:medium @type:nominal
Scenario: SC-23 - Parse tree with path expression
  Given parse mode is on
  When I execute "products where category.name = 'X'"
  Then output shows path segments with quoted flags
```

### Scenario Group: Comma Separators

```gherkin
@priority:medium @type:nominal
Scenario: SC-24 - Select with commas
  Given users table
  When I execute "users select id, name, email"
  Then parses as 3 select items

@priority:medium @type:error
Scenario: SC-25 - Select without commas (strict mode)
  Given strict parsing mode
  When I execute "users select id name email"
  Then error: expected comma between select items
```

### Scenario Group: Complex Combinations (Validation)

```gherkin
@priority:high @type:nominal
Scenario: SC-26 - IN with literal list
  Given products and tags tables
  When I execute "products where has tags where name in ('premium', 'featured')"
  Then SQL contains IN ('premium', 'featured')

@priority:high @type:nominal
Scenario: SC-27 - OR conditions with parentheses
  Given assets table with locale and approved columns
  When I execute "assets where approved = true and (locale = 'fr' or locale = 'en')"
  Then SQL contains AND (locale = 'fr' OR locale = 'en')

@priority:high @type:nominal
Scenario: SC-28 - Aggregate in WHERE condition
  Given products with assets relation
  When I execute "products where count(assets where approved = true) >= 2"
  Then SQL contains (SELECT COUNT(*) FROM assets WHERE approved = true AND product_id = products.id) >= 2

@priority:high @type:nominal
Scenario: SC-29 - CASE expression in UPDATE
  Given products table with price column
  When I execute "products update set price = case when price > 1000 then price * 0.90 else price * 1.05 end where active = true !"
  Then SQL contains CASE WHEN price > 1000 THEN price * 0.90 ELSE price * 1.05 END

@priority:high @type:nominal
Scenario: SC-30 - Function call in assignment
  Given products table with updatedAt column
  When I execute "products update set updatedAt = now() where active = true !"
  Then SQL contains NOW() in SET clause

@priority:high @type:nominal
Scenario: SC-31 - Siblings via parentId workaround
  Given categories table with parentId
  When I execute "products where category.parentId = (categories where name = 'Phones' select parentId) and categoryId != (categories where name = 'Phones')"
  Then SQL contains two scalar subqueries for sibling comparison

@priority:critical @type:integration
Scenario: SC-32 - Full complex query (ancestors + siblings + M:N + aggregates + CASE)
  Given PIM/DAM schema with products, categories, tags, assets
  When I execute:
    """
    products
    update set
      price = case
        when price > 1000 then price * 0.90
        else price * 1.05
      end,
      updatedAt = now()
    where
      has category.ancestors where name = 'Electronics'
      and category.parentId = (categories where name = 'Phones' select parentId)
      and categoryId != (categories where name = 'Phones')
      and has tags where name = 'clearance'
      and count(assets where approved = true and (locale = 'fr' or locale = 'en')) >= 2
    !
    """
  Then SQL contains:
    - Recursive CTE for ancestors
    - Two scalar subqueries for siblings
    - EXISTS for tags
    - Correlated COUNT for assets with OR
    - CASE expression in SET
    - NOW() function
  And mutation executes without dry-run (! suffix)
```

## 7. Implementation Plan

### Block 1: Schema Relation Types — 2h
**Type:** Infrastructure
**Dependencies:** None
**Files:**
- `packages/core/src/schema/types.ts` — Add RelationDefinition with type field
- `packages/cli/src/repl/types.ts` — Import new relation types

**Exit criteria:**
- [ ] RelationDefinition interface has type discriminant
- [ ] Types exported from @dbsp/core
- [ ] Unit tests for type guards

### Block 2: Path Expression Parser — 3h
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parsePathExpression()`, quoted identifier support
- `packages/cli/src/repl/parser.test.ts` — Path parsing tests

**Exit criteria:**
- [ ] `parsePathExpression()` returns array of segments with quoted flags
- [ ] Quoted identifiers `"name"` parsed correctly
- [ ] Resolution checks relations then columns (unquoted) or columns only (quoted)
- [ ] Comma separators enforced for select, order, group by
- [ ] SC-01 to SC-04, SC-24, SC-25 scenarios pass

### Block 3: Subquery Parser — 2h
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseSubquery()`
- `packages/cli/src/repl/types.ts` — Add SubqueryValue type

**Exit criteria:**
- [ ] `parseSubquery()` handles `(table query_body)` syntax
- [ ] Integrates with `parseValue()` for scalar subqueries
- [ ] SC-05 to SC-08 scenarios pass

### Block 4: Existence Parser — 1.5h
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseExistenceCheck()`

**Exit criteria:**
- [ ] `has`/`not has` keywords recognized
- [ ] Optional nested WHERE parsed
- [ ] SC-09 to SC-11 scenarios pass

### Block 5: IN/NOT IN Subquery — 1h
**Type:** Feature slice
**Dependencies:** Block 3
**Files:**
- `packages/cli/src/repl/parser.ts` — Extend `parseWhereCondition()`

**Exit criteria:**
- [ ] `in (subquery)` parsed correctly
- [ ] `not in (subquery)` parsed correctly
- [ ] Integrates with condition_list

### Block 6: INSERT FROM Parser — 2h
**Type:** Feature slice
**Dependencies:** Block 3
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseFromClause()` to INSERT

**Exit criteria:**
- [ ] `from table where` syntax parsed
- [ ] `from each` bulk syntax parsed
- [ ] `for update [skip locked]` clause parsed
- [ ] SC-12 to SC-14 scenarios pass

### Block 7: Recursive Relations Parser — 2h
**Type:** Feature slice
**Dependencies:** Block 1, Block 2
**Files:**
- `packages/cli/src/repl/parser.ts` — Handle recursive relation types

**Exit criteria:**
- [ ] `ancestors`/`descendants` detected from schema
- [ ] Recursive path validation
- [ ] SC-15 to SC-17 scenarios pass

### Block 8: Window Expression Parser — 2h
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseWindowExpression()`
- `packages/cli/src/repl/types.ts` — Add ParsedWindowExpr type

**Exit criteria:**
- [ ] `over (partition by ... order by ...)` parsed
- [ ] Window-only functions (rank, dense_rank, row_number, lag, lead) recognized
- [ ] Aggregate functions with over clause recognized
- [ ] SC-18 to SC-20 scenarios pass

### Block 9: Query Executor - Path Resolution — 2h
**Type:** Feature slice
**Dependencies:** Blocks 2-8
**Files:**
- `packages/cli/src/repl/query-executor.ts` — JOIN generation for paths

**Exit criteria:**
- [ ] N-level JOINs generated correctly
- [ ] Recursive CTEs generated for ancestors/descendants
- [ ] Integration tests pass

### Block 10: Query Executor - Subqueries — 1.5h
**Type:** Feature slice
**Dependencies:** Block 9
**Files:**
- `packages/cli/src/repl/query-executor.ts` — Subquery SQL generation

**Exit criteria:**
- [ ] Scalar subqueries in WHERE
- [ ] IN/NOT IN subqueries
- [ ] EXISTS/NOT EXISTS subqueries

### Block 11: INSERT FROM Executor — 1h
**Type:** Feature slice
**Dependencies:** Block 6
**Files:**
- `packages/cli/src/repl/query-executor.ts` — FROM clause SQL generation

**Exit criteria:**
- [ ] INSERT with subquery for FK lookup
- [ ] FOR UPDATE clause in subquery
- [ ] SC-12 to SC-14 integration tests pass

### Block 12: .parse Command — 1h
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/cli/src/repl/batch.ts` — Add `.parse` command
- `packages/cli/src/repl/types.ts` — Add parseMode to state

**Exit criteria:**
- [ ] `.parse on/off/toggle` works
- [ ] Parse tree displayed when enabled
- [ ] SC-21 to SC-23 scenarios pass

### Block 13: Documentation & Tests — 1h
**Type:** Documentation
**Dependencies:** All blocks
**Files:**
- `examples/QUICKSTART.md` — Add NQL v1 examples
- `TODO_CLI.md` — Update with completed tasks

**Exit criteria:**
- [ ] QUICKSTART has relation path examples
- [ ] All .dbsp files updated with new syntax examples
- [ ] TODO updated with completion dates

## 8. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~70 | Parser functions, path resolution, quoted identifiers |
| Integration | ~35 | SQL generation, query execution |
| E2E | ~20 | Full REPL scenarios with real DB |

### Test Data Requirements

**Fixtures:**
- Hierarchical categories (3+ levels)
- Products with categories
- Tags with M:N through postTags
- Self-referential employees table
- Table with column name = relation name (for quoted identifier tests)

**Mocks:**
- Schema with all relation types defined

## 9. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Grammar ambiguity discovered | H | M | LL(1) formal verification, extensive tests |
| Performance with deep recursion | M | M | Depth limits in schema (maxDepth) |
| Breaking existing queries | H | L | Backward compat tests, comma separators opt-in initially |
| Complex CTE generation bugs | M | M | Golden test snapshots |
| Quoted identifier context ambiguity | M | L | Clear lexical rules, position-based detection |

## 10. Definition of Done

- [ ] All 13 blocks implemented
- [ ] All 50+ BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] Documentation updated
- [ ] /review clean (no blocking findings)
