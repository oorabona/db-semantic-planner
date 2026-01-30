# Project Gotchas - db-semantic-planner

## TypeScript

### exactOptionalPropertyTypes Requires Conditional Assignment (2026-01-07)

**Issue:** When building objects with optional properties under `exactOptionalPropertyTypes`, assigning `undefined` explicitly fails type checking.

**Cause:** TypeScript distinguishes between "property is missing" and "property is undefined".

**Solution:** Use conditional property assignment:
```typescript
// WRONG - fails exactOptionalPropertyTypes
const intent: QueryIntent = {
  type: 'select',
  from: this.from,
  where: this.whereIntent,  // Error if whereIntent is undefined
};

// CORRECT - only add property if defined
const intent: QueryIntent = {
  type: 'select',
  from: this.from,
};
if (this.whereIntent !== undefined) {
  (intent as { where: WhereIntent }).where = this.whereIntent;
}
```

**Location:** `packages/dx/src/orm.ts` lines 54-79, 156-173

---

## Planner Behavior

### Via Hint Uses Relation Name Lookup (2026-01-07)

**Issue:** When `via` option is provided, the planner uses it as the relation name to look up directly.

**Cause:** The planner treats `via` as a relation name, not just a disambiguation hint. If the relation doesn't exist, it adds a warning and skips the include rather than throwing an error.

**Implication:** Invalid `via` hints don't throw - they result in warnings in `PlanReport.warnings`.

**Location:** `packages/dx/src/strict-mode.test.ts` Scenario 7

---

### Relation Hints Must Clone Object for Immutability (2026-01-07)

**Issue:** When implementing per-query relation hints with an immutable builder pattern, the hints object must be cloned on each `clone()` call.

**Cause:** If the same object reference is shared, calling `withRelationHint()` on one builder modifies all clones.

**Solution:** Clone the hints object in the builder's `clone()` method:
```typescript
private clone(): QueryBuilderImpl {
  const builder = new QueryBuilderImpl(
    this.model,
    this.strictMode,
    this.from,
    { ...this.relationHints }  // <-- Clone here
  );
  // ... copy other fields
  return builder;
}
```

**Location:** `packages/dx/src/orm.ts` line 313

---

## Kysely

### CompiledQuery.raw() for EXPLAIN Prefix (2026-01-07)

**Issue:** Need to execute EXPLAIN on an already-compiled Kysely query without re-building from scratch.

**Solution:** Use `CompiledQuery.raw(sql, params)` factory method to create a new CompiledQuery with modified SQL while preserving the original parameters.

```typescript
import { CompiledQuery } from 'kysely';

const compiled = query.compile(); // Original query
const explainSql = `EXPLAIN (FORMAT JSON) ${compiled.sql}`;
const explainQuery = CompiledQuery.raw(explainSql, compiled.parameters as unknown[]);
const result = await db.executeQuery(explainQuery);
```

**Key insight:** `CompiledQuery.raw()` is the proper way to construct arbitrary SQL that Kysely can execute while maintaining type safety at the execution layer.

**Location:** `packages/adapter-kysely/src/explain.ts` lines 35-45

---

## Architecture

### Ports and Adapters Strict Dependency Order (2026-01-07)

**Rule:** packages/core MUST NOT import from packages/adapter-* or packages/dx

**Order:** core -> adapter-kysely -> dx

**Enforcement:** Use tsconfig project references or ESLint no-restricted-imports

**Location:** CLAUDE.md, Architecture section

---

## E2E Testing

### Testcontainers in WSL2/Podman Requires Ryuk Disabled (2026-01-07)

**Issue:** When running Testcontainers with Podman in WSL2, container cleanup via Ryuk fails with connection errors.

**Cause:** Ryuk (Testcontainers' resource reaper) has compatibility issues with Podman's Docker socket emulation in WSL2.

**Solution:** Set `TESTCONTAINERS_RYUK_DISABLED=true` in vitest config env:
```typescript
// vitest.config.e2e.ts
export default defineConfig({
  test: {
    env: {
      TESTCONTAINERS_RYUK_DISABLED: 'true',
    },
  },
});
```

**Alternative:** Explicitly stop container in globalTeardown (which we do anyway).

**Location:** `tests/e2e/vitest.config.e2e.ts`

---

### PostgreSQL EXPLAIN Cannot Use Parameterized Queries (2026-01-07)

**Issue:** Running `EXPLAIN (FORMAT JSON) SELECT ... WHERE col = $1` with parameters fails with "there is no parameter $1".

**Cause:** PostgreSQL's EXPLAIN command parses the SQL but doesn't actually prepare it, so parameter placeholders are not resolved.

**Solution:** For EXPLAIN tests, only test non-parameterized queries or inline literal values:
```typescript
// Works - no parameters
const sql = 'SELECT * FROM products WHERE active = true';
await sql.raw(`EXPLAIN (FORMAT JSON) ${sql}`).execute(db);

// Fails - parameterized
const sql = 'SELECT * FROM products WHERE active = $1';
await sql.raw(`EXPLAIN (FORMAT JSON) ${sql}`, [true]).execute(db); // ERROR
```

**Workaround:** Test EXPLAIN functionality separately from parameterized query execution.

**Location:** `tests/e2e/explain.integration.test.ts`

---

### EXISTS Subqueries Need Schema Prefix in Multi-tenant (2026-01-07) — RESOLVED

**Issue:** When using `forTenant('schema')`, EXISTS subqueries reference tables without schema prefix, causing "relation does not exist" errors.

**Cause:** The compiler adds schema prefix to main table references but not to tables inside EXISTS subqueries.

**Impact:** Multi-tenant EXISTS queries fail at runtime. Unit tests pass because they don't execute against real PostgreSQL.

**Solution (2026-01-07):** Thread `schemaName` parameter through the compiler call chain:
- `compile()` → `addWhere()` → `compileWhere()` → `compileExists()` / `compileRelationFilter()`
- Apply schema prefix in `compileExists()` using same pattern as root table: `const targetTable = schemaName ? \`${schemaName}.${relation.target}\` : relation.target`
- Forward `schemaName` to nested `compileWhere()` calls for deeply nested EXISTS

**Location:** `packages/adapter-kysely/src/compiler.ts` lines 64, 128, 144, 166, 173, 179, 183, 186, 189, 245, 307-310, 328, 351, 364, 376, 394

---

### Streaming stream() Must Throw Synchronously for Missing DB (2026-01-07)

**Issue:** When implementing `stream()` on QueryBuilder, the method returns `AsyncIterableIterator` but should throw `ExecutionError` synchronously if db is not configured.

**Cause:** Unlike `findMany()` which returns a Promise and can reject asynchronously, `stream()` returns an iterator. If we check db inside the generator, the error would only surface when `.next()` is called.

**Solution:** Check db configuration synchronously before returning the iterator:
```typescript
stream(options?: StreamOptions): AsyncIterableIterator<unknown> {
  const db = this.getConfiguredDb();  // Throws synchronously
  const dumpResult = this.dump();
  return streamQuery(db, dumpResult, options);
}
```

**Test Implication:** Tests must expect synchronous throw, not async rejection:
```typescript
// WRONG - expects async error
await expect(async () => {
  for await (const _row of orm.query('users').stream()) {}
}).rejects.toThrow(ExecutionError);

// CORRECT - expects sync throw
expect(() => orm.query('users').stream()).toThrow(ExecutionError);
```

**Location:** `packages/dx/src/orm.ts` lines 341-348, `packages/dx/src/orm-execution.test.ts`

---

### Build Order Critical When Adding New Exports (2026-01-07)

**Issue:** When adding new types to `packages/core` and using them in `packages/adapter-kysely`, TypeScript compilation fails with "Module has no exported member" errors.

**Cause:** TypeScript in a pnpm monorepo reads compiled `.d.ts` files from dist/ directories. Adding a new export to a source file doesn't make it visible to dependent packages until the package is rebuilt.

**Solution:** Always rebuild upstream packages before running typecheck on downstream:
```bash
# After adding exports to core
pnpm -C packages/core build

# Then typecheck adapter (which depends on core)
pnpm -C packages/adapter-kysely typecheck
```

**Build order for this project:**
```
packages/core → packages/adapter-kysely → packages/dx
```

**Location:** Encountered when adding `AggregateFunction`, `AggregateIntent`, `SelectAggregateIntent` to `packages/core/src/intent-ast.ts`

---

## Adapter Implementation

### NEVER Use Raw SQL Templates in Adapter Code (2026-01-08)

**Issue:** Using `sql` template literals (e.g., `` sql`COALESCE(...)` ``) instead of Kysely's native expression builder APIs.

**Cause:** Habit from writing raw SQL, or not knowing Kysely has native functions.

**Why it's wrong:**
1. **Dialect portability:** Kysely's `eb.fn('coalesce')` adapts per dialect; raw SQL doesn't
2. **Type safety:** Native APIs provide TypeScript inference; raw templates lose types
3. **Security:** Native APIs handle escaping properly
4. **Maintainability:** Expression builders are more readable and refactorable

**Solution:** Always use Kysely expression builder methods:

```typescript
// ❌ WRONG - raw SQL template
const refs = fields.map((f) => sql.ref(`${alias}.${f}`));
const coalesceExpr = sql`COALESCE(${sql.join(refs, sql`, `)})`;
return query.select(coalesceExpr.as(resultAlias));

// ✅ CORRECT - native expression builder
return query.select((eb) =>
  eb.fn('coalesce', fields.map((f) => eb.ref(`${alias}.${f}`))).as(resultAlias)
);

// ❌ WRONG - literal via sql
query.select(sql`1`)

// ✅ CORRECT - native literal
query.select((eb) => eb.lit(1).as('_exists'))
```

**Exception:** The ONLY valid use of `sql` is for:
1. `RawExpressionIntent` — the explicit user escape hatch for SQL that cannot be expressed via intents
2. PostgreSQL array operations in recursive CTEs — `ARRAY[id]::text[]` path tracking via `sql.lit()` (Kysely lacks native PG array type support)

**Location:** `packages/adapter-kysely/src/compiler.ts`, `CLAUDE.md` (Adapter Rules section)

---

### Recursive CTE: Bidirectional Edge Detection Requires edgeStorageHint (2026-01-08)

**Issue:** When implementing recursive CTEs with edge-table traversal, need to distinguish between edges stored as symmetric pairs vs single rows requiring dual lookup.

**Cause:** Two common edge storage patterns:
- **Symmetric pairs:** Each edge stored twice (A→B, B→A) - use `UNION ALL`, no self-join
- **Single row, dual lookup:** One row per edge (A↔B) - requires self-join of CTE in recursive step

**Solution:** `edgeStorageHint: 'edges_symmetric' | 'edges_bidir'` in EdgeTableTraversal:

```typescript
// 'edges_symmetric' (default): UNION ALL, edges stored as pairs
// Node 1→2 exists as: (parent_id=1, child_id=2) AND (parent_id=2, child_id=1)
// SQL: ... UNION ALL SELECT ...

// 'edges_bidir': UNION, single row with dual lookup
// Node 1↔2 exists as single row: (from_id=1, to_id=2) OR lookup via (to_id=1, from_id=2)  
// SQL: ... UNION SELECT ... (deduplicates via UNION)
```

**Key insight:** The `bidirectional-edges` decision in PlanReport triggers `UNION` instead of `UNION ALL` to prevent duplicates from dual lookup.

**Location:** `packages/core/src/intent-ast.ts` EdgeTableTraversal, `packages/adapter-kysely/src/compiler.ts` compileRecursive()

---

### TypeScript: Underscore Prefix for Reserved/Unused Parameters (2026-01-08)

**Issue:** Biome lint error `noUnusedFunctionParameters` for parameters reserved for future use.

**Cause:** Function signature includes parameter that's not used in current implementation but will be needed later.

**Solution:** Prefix with underscore and add comment explaining purpose:

```typescript
// ❌ WRONG - lint error
function compileRecursive(plan: Plan, model: ModelIR): Result {
  // model not used yet
}

// ✅ CORRECT - lint passes, intent documented
function compileRecursive(
  plan: Plan,
  _model: ModelIR, // Reserved for future use (e.g., relation metadata lookups)
): Result {
  // _model available when needed
}
```

**Location:** `packages/adapter-kysely/src/compiler.ts:126`

---

### Introspection: Don't Transform Data From Source (2026-01-08)

**Issue:** Attempted to pluralize table names for hasMany relations. `pluralize('posts')` returned `'postses'`.

**Root cause:** Over-engineering. Tried to be "smart" by transforming table names instead of using them as-is.

**Lesson learned:**
1. Introspection gives real names → use them directly
2. Don't invent data that doesn't exist
3. If manual schema definition, developer provides real names
4. Transformations are fragile and will break on edge cases

**Solution:** Use source data directly, no transformation:

```typescript
// ❌ WRONG - over-engineering
const hasManyName = pluralize(fk.sourceTable);

// ✅ CORRECT - use as-is
const hasManyName = fk.sourceTable;
```

**Location:** `packages/adapter-kysely/src/introspection.ts` - `inferRelations()`

---

### defineSchema().build() Required for Full ModelIR (2026-01-09)

**Issue:** Test using `defineSchema({...})` directly as model fails with "model.getTable is not a function".

**Cause:** `defineSchema()` returns a schema builder object, not a full ModelIR. The `.build()` method must be called to produce a ModelIR with methods like `getTable()`, `getRelationsTo()`, etc.

**Wrong pattern:**
```typescript
const testSchema = defineSchema({
  products: { id: 'integer', name: 'string' }
});
// testSchema is SchemaBuilder, NOT ModelIR
orm.query('products')  // Fails: "model.getTable is not a function"
```

**Solution:** Always call `.build()` on defineSchema:
```typescript
const testModel = defineSchema({
  products: { id: 'integer', name: 'string' }
}).build();
// testModel is now a proper ModelIR with all methods
```

**Location:** `packages/dx/src/window-functions.test.ts` line 15-35

---

### Biome: Use Helper Functions for Array Access (2026-01-09)

**Issue:** Biome's `noNonNullAssertion` rule flags `array[0]!` patterns even when logic guarantees non-empty array.

**Cause:** TypeScript's type system can't prove array access is safe. `arr[0]!` bypasses type checking, which Biome prohibits.

**Wrong pattern:**
```typescript
const pkColumns = metadata.primaryKey!.columns;
const firstCol = pkColumns[0]!;  // Biome error: noNonNullAssertion
```

**Solution:** Create helper functions with explicit checks:

```typescript
function first<T>(arr: readonly T[], fallback: T): T {
  const element = arr[0];
  return element !== undefined ? element : fallback;
}

function firstOrThrow<T>(arr: readonly T[], context: string): T {
  const element = arr[0];
  if (element === undefined) {
    throw new Error(`Expected non-empty array in ${context}`);
  }
  return element;
}

// Usage
const firstCol = first(pkColumns, 'id');  // With fallback
const required = firstOrThrow(fk.sourceColumns, 'FK source columns');  // Throws if empty
```

**Key insight:** The `element !== undefined` check satisfies both TypeScript and Biome because it proves the element exists at runtime.

**Location:** `packages/adapter-kysely/src/introspection.ts` lines 16-31

---

### Runtime Type Detection: Use Marker Property Pattern (2026-01-09)

**Issue:** Need to distinguish between primitive values (strings) and objects in a union type at runtime, e.g., `ColumnSpec = string | ExpressionSpec`.

**Cause:** TypeScript types are erased at runtime. Cannot use `instanceof` for interfaces. Duck typing with `typeof === 'object'` is not robust for extensibility.

**Solution:** Use a marker property pattern with a boolean literal type:

```typescript
// Define marker interface
export interface ExpressionSpec {
  readonly __expr: true;  // Marker property with literal type
  readonly intent: ExpressionIntent;
}

export type ColumnSpec = string | ExpressionSpec;

// Type guard with all safety checks
export function isExpressionSpec(spec: ColumnSpec): spec is ExpressionSpec {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    '__expr' in spec &&
    spec.__expr === true
  );
}
```

**Why this works:**
1. `__expr: true` is impossible for strings
2. `in` operator safely checks property existence
3. Value check `=== true` prevents false positives from objects with `__expr: false` or `__expr: 'something'`
4. Pattern is extensible - can add more marker types later

**Usage in unified columns() API:**
```typescript
for (const col of columns) {
  if (isExpressionSpec(col)) {
    expressions.push(col.intent);  // TypeScript knows col.intent exists
  } else {
    fields.push(col);  // TypeScript knows col is string
  }
}
```

**Location:** `packages/dx/src/types.ts` lines 19-49, `packages/dx/src/orm.ts` columns() implementation

---

### WhereIntent LIKE Uses Separate Kind, Not Operator (2026-01-09)

**Issue:** Tests fail with "Unknown comparison operator: like" when using `{ kind: 'comparison', operator: 'like' }`.

**Cause:** WhereIntent has a dedicated `kind: 'like'` with its own structure, separate from comparison operators.

**Wrong pattern:**
```typescript
const where: WhereIntent = {
  kind: 'comparison',
  field: 'content',
  operator: 'like',  // ERROR: 'like' is not a ComparisonOperator
  value: '%great%',
};
```

**Solution:** Use the dedicated WhereLikeIntent structure:
```typescript
const where: WhereIntent = {
  kind: 'like',
  field: 'content',
  pattern: '%great%',  // Note: 'pattern', not 'value'
};
```

**Location:** `packages/core/src/intent-ast.ts` WhereLikeIntent type, `packages/adapter-kysely/src/golden.test.ts`

---

### relationFilter vs exists: Intent Kind Controls Strategy Decision (2026-01-09)

**Issue:** Using `kind: 'exists'` always generates EXISTS SQL regardless of relation cardinality, even for belongsTo.

**Cause:** The WhereIntent `kind` determines which compiler path is taken:
- `kind: 'exists'` → Forces EXISTS subquery compilation
- `kind: 'relationFilter'` → Planner decides JOIN or EXISTS based on cardinality

**When to use which:**
```typescript
// Use 'relationFilter' when you want planner to decide based on cardinality
const where: WhereIntent = {
  kind: 'relationFilter',  // Planner decides: belongsTo→JOIN, hasMany→EXISTS
  relation: 'author',
  mode: 'some',
  where: { kind: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
};

// Use 'exists' only when you explicitly want EXISTS regardless of cardinality
const where: WhereIntent = {
  kind: 'exists',  // Always generates EXISTS subquery
  relation: 'comments',
  where: { kind: 'comparison', field: 'status', operator: 'eq', value: 'approved' },
};
```

**Key insight:** The CORE-001 planner-compiler contract relies on `kind: 'relationFilter'` to let the planner make strategy decisions. Using `kind: 'exists'` bypasses the planner's filter-strategy decision.

**Location:** `packages/adapter-kysely/src/golden.test.ts` Q4 tests, `packages/adapter-kysely/src/compiler.ts` compileRelationFilter()

---

### Include Alias Format: Dot Separator, Not Double Underscore (2026-01-09)

**Issue:** Test expected `author__id` in SQL but actual was `author.id`.

**Cause:** Include JOIN compilation uses dot (`.`) as separator for aliased columns, not double underscore.

**Column naming convention:**
```sql
-- Actual format generated by compileIncludeJoin()
SELECT
  "t0"."id" AS "id",
  "t0"."title" AS "title",
  "t1"."id" AS "author.id",      -- Dot separator
  "t1"."name" AS "author.name"   -- Not author__name
FROM "posts" AS "t0"
LEFT JOIN "users" AS "t1" ON "t0"."authorId" = "t1"."id"
```

**Test assertion correction:**
```typescript
// WRONG
expect(compiled.sql).toContain('author__');

// CORRECT
expect(compiled.sql).toContain('author.');
```

**Location:** `packages/adapter-kysely/src/compiler.ts` compileIncludeJoin(), `packages/adapter-kysely/src/golden.test.ts` Q5 tests

---

### Test Assertions: Use Pattern Matching for Table Aliases (2026-01-10)

**Issue:** Tests expecting specific table aliases like `t1.postId` fail because alias order varies with internal state counter.

**Cause:** The compiler generates aliases like `t0`, `t1`, `t2` based on an incrementing counter. In M:N through joins, whether junction table gets `t1` or `t2` depends on when `getNextAlias()` is called during compilation.

**Wrong pattern:**
```typescript
// FRAGILE - assumes specific alias assignment
expect(compiled.sql).toMatch(/"t1"\."postId"/);
expect(compiled.sql).toMatch(/"t2"\."tagId"/);
```

**Solution:** Match the column name pattern without specific alias:
```typescript
// ROBUST - checks column exists in correct context
expect(compiled.sql).toContain('"postId"');
expect(compiled.sql).toContain('"tagId"');
// Or for more precision:
expect(compiled.sql).toMatch(/inner join.*"postTags".*"postId"/i);
```

**Key insight:** What matters is that the correct columns appear in the correct JOIN structure, not which specific alias number they get.

**Location:** `packages/adapter-kysely/src/golden.test.ts` Q7 M:N tests

---

## Serena MCP Tools

### Use replace_content Regex Mode with Wildcards (2026-01-11)

**Issue:** Literal mode requires exact match of full content, which is verbose and error-prone for multi-line replacements.

**Cause:** `mode: "literal"` matches character-for-character, including whitespace. For long code blocks, this wastes tokens and risks mismatches.

**Solution:** Use `mode: "regex"` with wildcards to match patterns without quoting full content:

```typescript
// ❌ WRONG - literal mode requires exact text
mcp__plugin_serena_serena__replace_content(
  relative_path="file.ts",
  needle="function foo() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}",  // All exact!
  repl="function foo() { return 3; }",
  mode="literal"
)

// ✅ CORRECT - regex with wildcards
mcp__plugin_serena_serena__replace_content(
  relative_path="file.ts",
  needle="function foo\\(\\).*?\\nreturn.*?\\n\\}",  // Non-greedy match
  repl="function foo() { return 3; }",
  mode="regex"
)
```

**Key insight:** Use `.*?` (non-greedy) to match content between known anchors. Escape special regex chars (`()`, `{}`, `[]`).

---

### Limit search_for_pattern Scope to Avoid Token Overflow (2026-01-11)

**Issue:** `search_for_pattern` on root directory returns too many matches, exceeding `max_answer_chars` limit.

**Cause:** Without `relative_path` constraint, the tool searches entire codebase. Large monorepos easily hit the 15K default char limit.

**Solution:** Always constrain search scope:

```typescript
// ❌ WRONG - searches everything
search_for_pattern(substring_pattern="TODO")

// ✅ CORRECT - constrained to relevant directory
search_for_pattern(
  substring_pattern="TODO",
  relative_path="packages/core/src",
  context_lines_before=2,
  context_lines_after=2
)
```

**Alternative:** For simple searches, use Bash + grep which has unlimited output:
```bash
grep -rn "TODO" packages/core/src
```

---

### find_symbol Doesn't Find Plain Functions (2026-01-11)

**Issue:** `find_symbol(name_path_pattern="myFunction")` returns empty results for standalone functions.

**Cause:** Serena's symbol analysis works best with classes and their methods. Plain exported functions may not be indexed as symbols depending on the language server.

**Solution:** For finding plain functions, use pattern search instead:

```typescript
// ❌ MAY NOT WORK for plain functions
find_symbol(name_path_pattern="injectAdvancedRecursiveClauses")

// ✅ WORKS - pattern search
search_for_pattern(
  substring_pattern="export function injectAdvancedRecursiveClauses",
  relative_path="packages/adapter-kysely/src"
)
```

**When find_symbol works well:**
- Class definitions: `find_symbol(name_path_pattern="MyClass")`
- Class methods: `find_symbol(name_path_pattern="MyClass/myMethod")`
- TypeScript interfaces and types

---

### Prefer Bash for Quick Searches, Serena for Edits (2026-01-11)

**Rule of thumb:** Use the right tool for the job:

| Task | Best Tool | Why |
|------|-----------|-----|
| Simple text search | `Bash + grep` | No token limits, faster |
| Find files by pattern | `Bash + find` or `ls` | Simple, fast |
| Read specific file | `read_file` (Serena) | Line range support |
| Replace in file | `replace_content` (Serena) | Regex mode powerful |
| Symbol-level edit | `replace_symbol_body` | Preserves structure |

**Example workflow:**
```bash
# 1. Find files with Bash
find packages -name "*.test.ts" -exec grep -l "CYCLE" {} \;

# 2. Read specific file with Serena (line range)
read_file(relative_path="packages/adapter-kysely/src/dialect.test.ts", start_line=100, end_line=150)

# 3. Edit with Serena regex
replace_content(needle="supportsCycleDetection: false", repl="supportsCycleDetection: true", mode="literal")
```

**Token savings:** ~10-15% when using Bash for discovery + Serena for targeted edits vs using Serena for everything.

---

### Multi-task feedback = COMPLEX, not SIMPLE (2026-01-19)

**Symptoms:** User provides multiple feedback items (e.g., 9 tasks) and you classify as SIMPLE or skip workflow entirely.

**Cause:** Assuming "small fixes" = SIMPLE. Even if each fix is small, multiple files + multiple concerns = COMPLEX.

**Solution:**
- Count the distinct tasks/files affected
- 3+ files OR 5+ distinct tasks = COMPLEX
- COMPLEX = mandatory /workflow → /review → /finalize
- Never skip /review even if "just UI changes"

**Impact if ignored:** Missing tests, lint errors discovered late, no proper quality gate.

**Prevention:** When user gives numbered list of feedback → immediately classify as COMPLEX.

---

### Marking TodoWrite items "completed" without invoking skills (2026-01-19)

**Symptoms:** Todo list shows /review and /finalize as "completed" but skills were never invoked.

**Cause:** Rationalization: "it's a simple task, I don't really need to run /finalize". This is the classic productivity illusion - feeling like you're being efficient by skipping steps.

**Solution:**
- NEVER mark a skill-invocation todo as "completed" without actually calling the Skill tool
- If /review is in the todo list → invoke /review
- If /finalize is in the todo list → invoke /finalize
- The workflow exists for a reason - even SIMPLE tasks benefit from formal completion

**Impact if ignored:**
- No metrics captured for the workflow
- No learning loop closure (/skills update not run)
- User loses trust in the process
- Quality gates bypassed

**Prevention:** Before marking any skill todo as completed, ask: "Did I actually invoke this skill?" If not → invoke it now.

### Schema Type Hierarchy: ColumnDefInput vs SchemaColumnDefinition (2026-01-19)

**Symptoms:** TypeScript errors like "Property 'type' does not exist on type 'string'" when working with schema types in generators.

**Cause:** Using the wrong type for the context. The DSL has a type hierarchy:
- `ColumnDefInput` is a union that accepts both shorthand strings (like 'uuid') and full objects
- `SchemaColumnDefinition` is always an object with properties like type, nullable, primaryKey

When writing generators that process resolved schemas, the data is always in object form, but using `ColumnDefInput` as the type includes the string case which TypeScript correctly flags.

**Solution:**
- For DSL input types (what users write): use `ColumnDefInput`
- For resolved/compiled schema types (what generators process): use `SchemaColumnDefinition`
- Similarly for relations: use `SchemaRelationDefinition` not any input union type

**Prevention:** When writing code that processes resolved schemas (after defineSchema runs), always use the `Schema*` prefixed types from core which represent the normalized object form.

---

## PostgreSQL SERIAL vs autoIncrement API (2026-01-19)

**Symptoms:** Kysely's `.autoIncrement()` method doesn't produce `serial` type for PostgreSQL - it produces `integer identity(1,1) always`.

**Cause:** PostgreSQL has two ways to handle auto-increment:
1. `serial`/`bigserial` - pseudo-types that expand to `integer + sequence + default`
2. `GENERATED ALWAYS AS IDENTITY` - SQL standard approach

Kysely's `addColumn().autoIncrement()` uses the IDENTITY approach which is more portable, but some projects prefer SERIAL for PostgreSQL compatibility.

**Solution:** For SERIAL support, use dialect detection and set the column type directly:
- PostgreSQL: Use `serial` or `bigserial` as the column type instead of `integer` + autoIncrement()
- MySQL: Use `.autoIncrement()` method
- SQLite: Use `.autoIncrement()` method
- MSSQL: Use `IDENTITY(1,1)` approach

**Pattern:** Detect dialect with `detectDialect(db)` helper, then branch column type selection based on dialect and autoIncrement flag.

**Prevention:** When implementing auto-increment features for multi-dialect support, always test the generated DDL across all target dialects. PostgreSQL's SERIAL pseudo-type is a common expectation.

## Kysely

### CamelCasePlugin Must Be Consistent Across All Kysely Instances (2026-01-19)

**Symptoms:** SQL queries generate camelCase column names (e.g., `"userId"`) but database has snake_case columns (`user_id`). INCLUDE/JOIN queries fail or return no data.

**Cause:** DDL generation uses CamelCasePlugin to transform schema column names to snake_case, but MockAdapter and db-connection.ts create Kysely instances WITHOUT the plugin.

**Solution:** Add CamelCasePlugin to ALL Kysely instance creation points:
- mock-adapter.ts for SQL compilation in eval mode
- db-connection.ts for real database connections

**Prevention:** Whenever creating a new Kysely instance, check if DDL generation uses CamelCasePlugin. If yes, all runtime instances must use it too.

**Location:** `packages/adapter-kysely/src/mock-adapter.ts`, `packages/cli/src/repl/db-connection.ts`

## Schema Validation

### Schema-bridge Validation Must Match All defineSchema Properties (2026-01-19)

**Symptoms:** REPL fails with cryptic error "Invalid type: Expected Object but received Object" when loading schemas with PostgreSQL range types or other extended features.

**Cause:** The ResolvedSchemaValidation valibot schema in schema-bridge.ts didn't include all properties that defineSchema can produce, specifically: range types (daterange, tstzrange, int4range), onDelete on FK references, index on columns, and indexes at schema level.

**Solution:** When adding new features to defineSchema, ALWAYS update schema-bridge.ts validation schemas:
- GeneratedColumnType type union
- SchemaColumnTypeSchema picklist
- mapColumnType and mapSchemaColumnType switch statements
- Any new properties on ForeignKeyReferenceSchema or ColumnDefinitionSchema
- Any new top-level schema properties in ResolvedSchemaValidation

**Prevention:** When extending defineSchema with new column types or properties, immediately test with REPL to catch validation mismatches early. The improved error messages now show the exact path and expected vs received values.

**Location:** `packages/core/src/dx/schema-bridge.ts` (lines 34-49, 619-638, 649-667, 773-799)

## DDL Generation

### DROP TABLE IF EXISTS CASCADE Is Safer Than Individual Constraint Drops (2026-01-20)

**Symptoms:** DDL generation with --drop option fails with "relation does not exist" when trying to drop constraints or indexes on tables that don't exist yet.

**Cause:** Using `ALTER TABLE table DROP CONSTRAINT IF EXISTS constraint` fails if the table itself doesn't exist. The IF EXISTS only applies to the constraint, not the table.

**Solution:** Use `DROP TABLE IF EXISTS table CASCADE` instead of individual constraint drops. CASCADE automatically handles:
- Foreign key constraints referencing the table
- Indexes on the table
- Any dependent objects

**Pattern:** In Kysely, use `schemaBuilder.dropTable(tableName).ifExists().cascade()` which generates the proper PostgreSQL syntax.

**Prevention:** When implementing DDL cleanup, prefer CASCADE over manual dependency management. Let the database handle transitive dependencies.

**Location:** `packages/adapter-kysely/src/ddl.ts` (generateDDL function)

## Schema Scoping

### dump.meta.schema Requires adapter.createDump() Not Manual Meta Construction (2026-01-20)

**Symptoms:** When using orm.withSchema() or MockAdapter with schemaName option, the SQL is correctly schema-qualified but dump.meta.schema is undefined.

**Cause:** Both QueryExecutor.dump() and QueryBuilderImpl.dump() were building their own meta object directly instead of using adapter.createDump(). The adapter knows its schemaName but wasn't being asked to populate meta.

**Solution:** Always use adapter.createDump(planReport, compiled) to create the dump. The adapter will include its schemaName in meta.schema. If the adapter doesn't set it, fall back to the context's schemaName.

**Pattern:** When ORM wraps adapter functionality, delegate to adapter methods rather than reimplementing logic. The adapter has private state (like schemaName) that only it can properly expose.

**Prevention:** When adding observability features, verify the full chain: adapter.createDump() creates meta, ORM passes it through, dump output includes all expected fields.

**Location:** `packages/core/src/dx/query-executor.ts` and `packages/core/src/dx/orm.ts` (dump methods)

## Biome Lint

### Biome: Empty Interfaces Trigger noEmptyInterface Rule (2026-01-20)

**Issue:** Biome lint error `noEmptyInterface` when defining an interface with no members.

**Cause:** Empty interfaces are semantically equivalent to the empty object type, which is confusing and rarely intentional.

**Solution:** Use a type alias with `Record<string, never>` instead of an empty interface:
- Bad: `export interface EmptyHelpers {}`
- Good: `export type EmptyHelpers = Record<string, never>;`

**When applicable:** Placeholder types for handler helpers that don't currently require any injected dependencies but might in the future.

**Location:** `packages/adapter-kysely/src/compiler/handlers/include/index.ts`

## Refactoring

### Check for Existing Extraction Classes Before Refactoring (2026-01-20)

**Symptoms:** TypeScript errors about missing exports after creating "new" extracted files during a refactoring session.

**Cause:** Previous work (like DX-103) may have already created extraction classes (e.g., ResultHydrator, QueryExecutor) that other files depend on. Creating a new file with the same name but different structure breaks imports.

**Solution:** Before extracting code during refactoring:
1. Check if extraction target files already exist
2. If they exist, examine their structure and adapt to it
3. Add missing methods to existing classes rather than replacing them
4. Run typecheck immediately after changes to catch import issues

**Pattern:** Work WITH existing code structure. If DX-103 created a class-based ResultHydrator, add methods to that class rather than replacing it with pure functions.

**Prevention:** Always run `git status` and `ls` on target directories before creating new files. Check if the extraction was partially done in a previous story.

**Location:** `packages/core/src/dx/result-hydrator.ts`, `packages/core/src/dx/query-executor.ts`

### Use Serena rename_symbol for Symbol Renaming (2026-01-20)

**Symptoms:** Manual renaming of classes/functions across multiple files is tedious and error-prone, with risk of missing references.

**Cause:** Attempting to rename symbols by manually editing each file instead of using Serena's semantic tools.

**Solution:** For renaming exported classes, functions, or types across the codebase:
1. Use `rename_symbol` tool which handles all references automatically
2. It updates imports, exports, and usages in one operation
3. Preserves backward compatibility aliases if needed separately

**Pattern:** When renaming `MockAdapter` to `CompileOnlyAdapter`, use `mcp__plugin_serena_serena__rename_symbol` with name_path and new_name parameters. Then manually add legacy aliases in index.ts if backward compatibility is needed.

**Prevention:** Before doing any rename refactoring, check if Serena's rename_symbol can handle it - it's faster and safer than manual find-replace.

**Applies to:** Any symbol renaming across files (classes, functions, types, interfaces)

### Verify Options Are Actually Used, Not Just Plumbed (2026-01-20)

**Symptoms:** A feature toggle exists in CLI/REPL but changing it has no effect on output.

**Cause:** Option was plumbed through the call chain (CLI → adapter → compiler) but the final function that should use it ignored the parameter completely. TODO.md marked feature as DONE because the plumbing existed.

**Example:** `aliasIncludedColumns: 'onCollision'` was passed to `addIncludeSelectColumns()` but the function always aliased all columns regardless. The REPL had a working toggle that did nothing.

**Solution:** When implementing options that affect behavior:
1. Trace the option from consumer (API caller, CLI, REPL) to the producer (function that generates output)
2. Verify the producer function reads and acts on the parameter
3. Run tests that verify different option values produce different outputs

**Prevention:** Mark feature as DONE only after tests confirm different option values produce different results. Plumbing from consumer to producer is not implementation - the producer must actually use the option.

**Location:** `packages/adapter-kysely/src/compiler.ts` - `addIncludeSelectColumns()` function

---

## REPL/Parser

### MutationValue Needs `raw` Flag for Literal vs Column Reference Detection (2026-01-21)

**Symptoms:** In `INSERT FROM` queries, unquoted identifiers (column refs like `id`) were being treated the same as quoted string literals (`"Phone"`).

**Cause:** Parser produced MutationValue objects with just `value` and `as` fields. When executing `products insert title = "Phone", categoryId = id from categories where name = "Electronics"`, both `"Phone"` and `id` had the same structure, making it impossible for the executor to distinguish them.

**Solution:** Add `raw: boolean` flag to MutationValue type:
```typescript
interface MutationValue {
  value: string;
  as?: string;
  raw?: boolean;  // true = unquoted identifier (column ref), false/undefined = quoted literal
}
```

Parser sets `raw: true` for unquoted identifiers, executor uses this to decide:
- `raw: true` → use `eb.ref()` for column reference
- `raw: false/undefined` → use `eb.val()` or `eb.lit()` for literal value

**Pattern:** When parsing DSL syntax that has both literals and identifiers, always track which is which at parse time. Don't try to infer later.

**Location:** `packages/cli/src/repl/types.ts` (MutationValue type), `packages/cli/src/repl/query-executor.ts` (INSERT FROM execution)

---

### New Handler Not Found: "Unknown expression kind" Runtime Error

**Symptom:** After adding a new handler in adapter-kysely source, get runtime error like `Unknown expression kind: columnAlias` even though the code looks correct.

**Root cause:** The adapter-kysely package was not rebuilt after adding the handler. The handler registration function exists in source but the compiled bundle in `dist/` doesn't include it.

**Solution:**
1. Always rebuild the package after adding new handlers: `pnpm -C packages/adapter-kysely build`
2. Verify the handler is in the bundle: `grep -l "handlerName" packages/adapter-kysely/dist/*.js`
3. If CLI uses the adapter, rebuild CLI too: `pnpm -C packages/cli build`

**Why this happens:** tsup bundles everything into chunk files. Registration happens at module load time via the bundled code, not the source.

**Pattern:** After modifying handler registrations in adapter-kysely, ALWAYS rebuild before testing. Tests using vitest with source may pass while runtime fails because vitest reads source directly.

**Location:** `packages/adapter-kysely/src/compiler/handlers/expression/index.ts` (handler registration)

---

### Ink Terminal Key Detection: Backspace vs Delete Confusion

**Symptom:** In Ink REPL, pressing Backspace deletes forward (like Delete), or Delete doesn't work at all.

**Root cause:** Ink's `useInput` hook inconsistently reports key events across terminals:
- Some terminals send `\x7f` (DEL char) for Backspace
- Some set `key.delete = true` with empty input for Backspace
- Some terminals have `key.backspace` correctly set
- Delete key sends escape sequence `\x1b[3~` but `key.delete` flag may be unreliable

**Solution:** Use multi-condition detection for Backspace and ONLY trust Delete escape sequence:

```typescript
// Backspace - comprehensive detection
const isBackspace =
  key.backspace ||
  input === '\x7f' ||
  input === '\x08' ||
  (key.delete && input === '');

// Delete - ONLY trust the escape sequence
if (input === '\x1b[3~') { /* forward delete */ }
```

**Why this happens:** Terminal emulators have inconsistent key mappings. Ink's abstraction layer doesn't normalize all variations.

**Pattern:** Never rely solely on `key.delete` flag - always check the actual input character or escape sequence.

**Location:** `packages/cli/src/repl/components/EnhancedTextInput.tsx` (lines 196-217)

---

### ModelIR API: Use getTable()/getRelation() not direct property access (2026-01-21)

**Issue:** GROUP BY relation path fails with "Unknown table: X" or "Cannot read properties of undefined".

**Cause:** Direct property access (`model.tables[tableName]`, `model.relations[relationKey]`) bypasses ModelIR's lookup methods and fails when tables/relations are stored with different key formats.

**Wrong pattern:**
```typescript
// ❌ WRONG - direct property access
const tableDef = model.tables[tableName];
const relDef = model.relations[`${table}.${relation}`];
```

**Correct pattern:**
```typescript
// ✅ CORRECT - use ModelIR API methods
const tableDef = model.getTable(tableName);
const relDef = model.getRelation(`${table}.${relation}`);
```

**Location:** `packages/adapter-kysely/src/compiler.ts` - any code handling GROUP BY or relation path resolution.

---

### lookupRelation must check getRecursiveRelationInfo before throwing errors (2026-01-21)

**Issue:** `lookupRelation()` throws "Unknown relation: X.ancestors" when using auto-inferred recursive relations like `categories where ancestors.name = 'Root'`.

**Cause:** The function threw an error immediately when a relation wasn't found in the schema, without checking if it could be auto-inferred from `parent`/`children` relations.

**Wrong pattern:**
```typescript
// ❌ WRONG - throws immediately without checking for inferred relations
const relDef = schema.relations.get(qualifiedKey);
if (!relDef) {
  throw new Error(`Unknown relation: ${qualifiedKey}`);
}
```

**Correct pattern:**
```typescript
// ✅ CORRECT - check for inferred recursive relations first
const relDef = schema.relations.get(qualifiedKey);
if (!relDef) {
  const relLower = rel.toLowerCase();
  if (relLower === 'ancestors' || relLower === 'descendants') {
    const recursiveInfo = getRecursiveRelationInfo(qualifiedKey, schema);
    if (recursiveInfo) {
      // Relation can be auto-inferred - don't throw
      return { relName: rel, qualifiedKey };
    }
  }
  throw new Error(`Unknown relation: ${qualifiedKey}`);
}
```

**Location:** `packages/cli/src/repl/parser.ts` - `lookupRelation()` function (lines 1898-1907)

---

## Ink Terminal: Delete vs Backspace Key Detection (2026-01-21)

**Symptom:** Delete key behaves like Backspace (deletes character before cursor instead of after)

**Cause:** Ink's `parse-keypress.ts` maps BOTH `\x7f` (DEL character = Backspace on modern terminals) AND `\x1b[3~` (Delete escape sequence) to `key.delete`. This makes them indistinguishable through the standard `useInput` hook.

**Why this is confusing:**
- On modern terminals (iTerm2, VSCode terminal, Windows Terminal), pressing Backspace sends `\x7f`
- Ink interprets `\x7f` as "delete", setting `key.delete = true`
- Delete key sends `\x1b[3~`, which Ink ALSO maps to `key.delete = true`
- Result: Both keys look identical to `useInput`

**Solution:** Use `useStdin` hook to capture raw bytes BEFORE Ink processes them:

```tsx
const lastRawInputRef = useRef<string>('');
const { stdin } = useStdin();

useEffect(() => {
  if (!stdin || isDisabled || !isFocused) return;
  const handleRawData = (data: Buffer) => {
    lastRawInputRef.current = data.toString();
  };
  stdin.on('data', handleRawData);
  return () => { stdin.off('data', handleRawData); };
}, [stdin, isDisabled, isFocused]);

// In key handler:
const rawInput = lastRawInputRef.current;
if (rawInput === '\x1b[3~' || rawInput.startsWith('\x1b[3~')) {
  // This is Delete key - forward delete
  if (cursor < value.length) {
    const newValue = value.slice(0, cursor) + value.slice(cursor + 1);
    updateValue(newValue, cursor);
  }
  return;
}
// Backspace - \x7f or \x08
const isBackspace = rawInput === '\x7f' || rawInput === '\x08';
```

**Key insight:** Check raw input for `\x1b[3~` FIRST, before any other key handling. The escape sequence is unambiguous.

**Location:** `packages/cli/src/repl/components/EnhancedTextInput.tsx`

---

## External LLM Tools

### Codex Review Requires Minimum 10 Minutes (2026-01-23)

**Issue:** Killing Codex review before it completes loses valuable analysis.

**Cause:** `codex review --commit <sha>` performs deep reasoning with high effort. It explores the codebase, traces dependencies, and analyzes potential bugs thoroughly. This takes time.

**Solution:** Always allow minimum 10 minutes for Codex review to complete:
```bash
# Run with generous timeout (10+ min)
timeout 600 codex review --commit <sha>

# Or run in background and check later
codex review --commit <sha> &
```

**Symptoms of premature termination:**
- Output shows "thinking" blocks but no final summary
- Analysis loops visible but no conclusion

**Key insight:** Codex's thoroughness is its value. The 3-5 minute mark often shows only exploration, not conclusions. Wait for the full analysis.

---

## NQL Migration

### CLI Dialect Must Map to Adapter Dialect (2026-01-23)

**Issue:** TypeScript error when CLI's `DialectMode` (includes 'duckdb') is passed to `CompileOnlyAdapter` which expects `MockDialect` (postgresql|mysql|sqlite|mssql only).

**Cause:** CLI exposes a broader dialect type to users (DialectMode includes duckdb), but the adapter has a narrower type. This creates a type mismatch at the boundary.

**Solution:** Create a mapping function at the boundary layer:
```typescript
// nql-executor.ts
export type CliDialect = MockDialect | 'duckdb';

function toMockDialect(dialect: CliDialect | undefined): MockDialect {
  if (dialect === 'duckdb') return 'postgresql';  // DuckDB uses PG-compatible SQL
  return dialect ?? 'postgresql';
}

// Usage
const adapter = createCompileOnlyAdapter({
  dialect: toMockDialect(options?.dialect),
});
```

**Key insight:** When two layers have different type contracts, create an explicit mapping at the boundary. The adapter layer shouldn't know about CLI-specific dialects, and the CLI shouldn't be constrained by adapter internals.

**Location:** `packages/cli/src/repl/nql-executor.ts` lines 241-259

---

### NQL AST Types Are Structurally Compatible But Nominally Different (2026-01-23)

**Issue:** @dbsp/nql's `QueryIntent` and @dbsp/core's `QueryIntent` are structurally identical but TypeScript treats them as different types.

**Cause:** Each package defines its own intent types. While structurally the same, TypeScript's nominal typing prevents direct assignment.

**Solution:** Use type assertion helper functions to bridge the gap:
```typescript
// Type compatibility helpers
function asQueryIntent(intent: NqlQueryIntent): QueryIntent {
  return intent as unknown as QueryIntent;
}

function asInsertIntent(intent: NqlMutationIntent): InsertIntent {
  return intent as unknown as InsertIntent;
}
```

**Key insight:** When packages share structural contracts but have separate type definitions, explicit cast functions document the boundary and prevent scattered `as unknown as X` throughout the code.

**Location:** `packages/cli/src/repl/nql-executor.ts` lines 38-56

---

### Chevrotain Lexer Token Regex Must Be Carefully Ordered and Scoped (2026-01-23)

**Issue:** Adding a `RangeLiteral` token with regex `/[[(]-?[\w.:-]+\s*,\s*-?[\w.:-]+[\])]/` caused UPSERT `ON (col1, col2)` to fail parsing.

**Cause:** The regex matched identifier lists like `(user_id, event_type)` because:
1. `[[(]` matches `(`
2. `[\w.:-]+` matches identifiers (letters, underscores)
3. The pattern is too greedy for what should only match range literals

**Solution:** Use lookahead to ensure values start with digits:
```regex
/[[(](?=\d|-?\d)(?:-?\d[\w.:-]*)\s*,\s*(?:-?\d[\w.:-]*)[\])]/
```

The `(?=\d|-?\d)` lookahead ensures the first character after the bracket is a digit, which range literals have (dates start with year, times start with hour, numbers start with digit) but identifiers don't.

**Key insight:** When adding tokens that use common delimiters like parentheses, brackets, or commas, ensure the regex won't match unrelated grammar constructs. Use lookahead/lookbehind to scope precisely.

**Location:** `packages/nql/src/lexer/tokens.ts` line 77-80

---

### Grammar-Based Parsing > Complex Regex for Ambiguous Syntax (2026-01-23)

**Issue:** Even with lookahead fixes, the `RangeLiteral` regex still caused conflicts:
1. `/-?\d+(?:[-:.T]\d+)+/` (date/time pattern) matched decimal numbers like `99.99`
2. Adding `(` for exclusive bounds created ambiguity with grouped expressions `(a + b)`

**Cause:** Single-token regex approach tries to handle all cases, but complex syntax with shared delimiters (`(`, `)`, `.`) creates cascading conflicts.

**Solution:** Replace complex regex with grammar-based parsing:

1. **Simpler tokens:** `LBracket`, `RBracket`, `RangeValue` (no `(` as range opener at lexer level)
2. **Dedicated grammar rules:**
   ```
   range_comparison = expr range_op range_literal
   range_op         = "overlaps" | "contains" | "containedBy"
   range_literal    = ( "[" | "(" ) range_value "," range_value ( "]" | ")" )
   ```
3. **Context-sensitive parsing:** `(` is only valid as range opener AFTER a range operator
4. **Separate `compOp` from `rangeOp`:** Avoids `(` being parsed as grouped expression

**Why grammar > regex:**
- Context-sensitive: `(` after `overlaps` = range bound, `(` elsewhere = grouping
- No decimal conflicts: `RangeValue` token only matches date/time patterns
- EBNF-documentable: Clear grammar rules vs opaque regex
- Extensible: Easy to add new range operators without regex surgery

**Key insight:** When a token's syntax overlaps with other language constructs, promote to grammar-level parsing. Let the parser (which has context) disambiguate, not the lexer (which is context-free).

**Location:** `packages/nql/src/parser/grammar.ts` (`rangeOpSuffix` rule)

---

### Type-Prefix Convention > Manual Mode Directive for Assertion Categories (2026-01-24)

**Issue:** Initial design for typed assertions used a manual `mode: db` or `mode: dry-run` directive in assertion files to specify which assertions require a database.

**Cause:** Over-engineering. The assumption was that explicit mode declaration would be clearer.

**Solution:** Automatic detection via type prefix convention:
- `sql.*` assertions (sql.table, sql.contains, sql.matches) → always run (no DB needed)
- `db.*` assertions (db.rows.equals, db.column.exists) → require database connection
- Detection: `type.startsWith('db.')` in `requiresDatabase()` function
- Skip logic: if `!hasDb && requiresDatabase(type)` → mark as skipped with reason

**Why type-prefix > manual mode:**
- Zero configuration: No extra syntax to learn or forget
- Self-documenting: Assertion type name reveals its requirements
- Impossible to misconfigure: No "mode: db" with "sql.contains" mismatch
- Cleaner assertion files: No boilerplate header needed

**Key insight:** When categories can be unambiguously derived from identifiers, avoid explicit categorization. Convention over configuration reduces cognitive load and eliminates misconfiguration bugs.

**Location:** `packages/cli/src/repl/assertion-parser.ts` (`requiresDatabase()` function)

---

### NQL Compiler Output Must Match IntentAST Kind Names Exactly (2026-01-24)

**Issue:** NQL range operators (`overlaps`, `contains`, `containedBy`) failed with "Unknown where kind: rangeOp" even though range operators were implemented.

**Root cause:** NQL compiler emitted `kind: 'rangeOp'` but the Kysely adapter expected `kind: 'range'`. The adapter has a switch statement that matches specific `kind` values - a typo or mismatch silently falls through.

**Discovery process:**
1. Assertion `scheduling.assert.dbsp` query 9 failed: `"Unknown where kind: rangeOp"`
2. Traced through NQL compiler → found it emits `{ kind: 'rangeOp', ... }`
3. Checked Kysely adapter `switch(where.kind)` → found `case 'range':` (not 'rangeOp')
4. Fix: Changed NQL compiler to emit `kind: 'range'` instead of `kind: 'rangeOp'`

**Prevention:** When adding new IntentAST kinds:
1. Check existing kinds in `packages/core/src/intent-ast.ts`
2. Verify exact string match in both emitter and consumer
3. Run integration tests that actually execute through the full pipeline

**Related gotcha:** Tests that only check `toBe('rangeOp')` passed because they tested the wrong intermediate value. Always trace a new feature end-to-end through SQL generation.

**Location:** `packages/nql/src/compiler/index.ts` (emit side), `packages/adapter-kysely/src/compiler/handlers/where/` (consume side)

---

### Intent Assertions Are More Robust Than SQL String Matching (2026-01-24)

**Pattern discovered:** When testing NQL compilation, `intent.*` assertions are more robust than `sql.*` assertions.

**Why SQL assertions are fragile:**
1. SQL formatting changes (whitespace, quoting) break `sql.contains` tests
2. Physical vs logical naming (ARCH-003) means `sql.contains: "product_images"` fails if you use logical name
3. JOIN order/type changes in optimizer break `sql.contains: left join`

**Better approach - intent.* assertions:**
```
# Instead of fragile SQL matching:
sql.contains: left join "products"

# Use semantic intent verification:
intent.type: query
intent.table: products
intent.with: category
intent.hasWhere: true
```

**Key insight:** Intent assertions test the _semantic_ query structure before SQL generation, making them immune to adapter-level formatting changes. Use `sql.*` only when verifying specific SQL syntax is critical (dialect-specific features).

**Assertion types available:**
- `intent.type` — query/insert/update/delete/upsert
- `intent.table` — logical table name
- `intent.with` — relations joined via `with` keyword
- `intent.hasWhere` / `intent.hasGroupBy` / `intent.hasOrderBy` — boolean flags

**Location:** `packages/cli/src/repl/assertion-parser.ts`, `assertion-runner.ts`

---

## Type Management

### Type Shadowing Causes Silent Bugs (2026-01-24)

**Issue:** When a type is defined locally with the same name as an imported type, the local definition shadows the import. If the definitions differ (even slightly), runtime behavior becomes unpredictable.

**Cause:** In ARCH-004, `CompilerState` was defined both in `compiler.ts:72` and `compiler/types.ts:24`. The local interface had different properties, causing the SPEC-001 JOIN bug where pseudo-column JOINs weren't being applied.

**Solution:**
1. Never duplicate type definitions — import from a single source
2. Create a shared types package (`@dbsp/types`) for cross-package types
3. Use TypeScript's `export type { X } from 'module'` for re-exports
4. When re-exporting AND using locally, you MUST import first:
   ```typescript
   // WRONG - X is not available locally
   export type { X } from 'module';
   const foo: X = ...; // Error: Cannot find name 'X'

   // CORRECT - import then export
   import type { X } from 'module';
   export type { X } from 'module';
   const foo: X = ...; // Works
   ```

**Prevention:** During /review, grep for duplicate type definitions across packages

**Location:** `packages/types/` (new shared types package)

---

### Vitest Caching After Package Changes (2026-01-24)

**Issue:** After modifying types in one package (e.g., @dbsp/core), tests in dependent packages (e.g., @dbsp/cli) may still fail even though the types are correct.

**Cause:** Vitest caches compiled modules. When you change a dependency, the cache may not invalidate properly.

**Solution:** Rebuild the changed package before running tests in dependent packages:
```bash
pnpm --filter @dbsp/core build
pnpm --filter @dbsp/cli test
```

**Prevention:** When changing types in core packages, always rebuild before running dependent package tests.

**Location:** Discovered during ARCH-004 type rationalization

---

### Valibot Schema Must Match TypeScript Type (2026-01-24)

**Issue:** When updating a TypeScript type (e.g., adding `number | boolean` to a union), the corresponding Valibot validation schema must also be updated.

**Cause:** Valibot validates at runtime. If the TS type accepts more values than the schema, runtime validation fails.

**Example:**
```typescript
// schema-dsl-types.ts
default?: string | number | boolean;  // TS type

// schema-bridge.ts - MUST MATCH
default: v.optional(v.union([v.string(), v.number(), v.boolean()]));
```

**Prevention:** When modifying types that have validation schemas, search for all Valibot/Zod schemas that validate that type.

**Location:** `packages/core/src/dx/schema-bridge.ts:758`

---

## NQL v2.1

### NQL Path Expressions Trigger Automatic Includes (2026-01-24)

**Issue:** In NQL v2.1, using a relation path like `posts.*` in select clause automatically registers an include, unlike explicit `with` keyword in v2.0.

**Cause:** The grammar was simplified to derive intent from syntax. Path expressions (dot notation) now signal "include this relation" implicitly.

**How it works:** Compiler detects `relation.*` patterns in select columns and adds them to `intent.include` array with default strategy.

**Prevention:** When migrating from v2.0, replace `| with relation` with `| select *, relation.*` - they produce equivalent IncludeIntent.

**Location:** `packages/nql/src/compiler/index.ts` - `extractIncludesFromSelect()`

---

### NQL Flat Mode Changes Include Strategy Not Filter Semantics (2026-01-24)

**Issue:** Adding `| flat` to an NQL query changes the join strategy from json_agg (nested) to JOIN (flat rows), but does NOT change filter semantics.

**Cause:** User expected `where posts.published = true | flat` to produce flat rows with only published posts. But pseudo-column filters use EXISTS, filtering the parent (authors), not the relation data.

**Semantic difference:**
- `where posts.published = true` → EXISTS filter, keeps only authors WHO HAVE published posts
- Old `with posts | where published = true` → filtered the posts INCLUDED, not the authors

**Solution:** For filtered includes (subset of relation data), use ORM API with `where` option on include, not NQL pseudo-column syntax.

**Location:** Documented in `examples/blog.dbsp` section 2.6c

---

### PlanDecision Uses reasoning Not reason (2026-01-24)

**Issue:** TypeScript error when accessing `decision.reason` on PlanDecision interface.

**Cause:** The interface property is named `reasoning`, not `reason`.

**Solution:** Use `decision.reasoning` to access the human-readable rationale for a planner decision.

**Location:** `packages/core/src/intent-ast.ts` - PlanDecision interface

---

### hasOne Cardinality Lost in TypedSchema→ModelIR Conversion (2026-01-25)

**Issue:** E2E test "should auto-select JOIN for hasOne relation" failed - strategy returned `json_agg` instead of `join`.

**Symptoms:** Unit test using `plan()` directly passed, but E2E test through full ORM chain failed.

**Cause:** In `typedSchemaToModelIR`, the hasOne relation was being converted to a hasMany internally WITHOUT preserving the cardinality marker. The planner checks `relation.type === 'hasOne'` to decide strategy, but this info was lost.

**Solution:**
1. Add `cardinality: 'one'` when converting hasOne to the internal hasMany representation in `typedSchemaToModelIR`
2. Update `GeneratedHasMany` interface to include optional `cardinality?: 'one' | 'many'`
3. Read cardinality in `buildRelationIR` and set `relationType = 'hasOne'` when appropriate

**Prevention:** When converting between schema representations, always verify cardinality/type information is preserved through each layer. Add tests that verify the ModelIR has correct relation types, not just the final SQL.

**Location:** `packages/core/src/dx/orm.ts` (typedSchemaToModelIR), `packages/core/src/dx/schema-bridge.ts` (buildRelationIR)

---

### Build Cache Causes E2E vs Unit Test Discrepancy (2026-01-25)

**Issue:** Unit test passed but E2E test failed with the same logic.

**Symptoms:** After fixing TypeScript code, unit tests (same package) pass immediately, but E2E tests (cross-package) still fail with old behavior.

**Cause:** The pnpm monorepo build cache wasn't invalidated. E2E tests import from compiled `dist/` directories, not source. Changes to TypeScript source require `pnpm build` to propagate.

**Solution:** Run `pnpm build` after modifying TypeScript source when E2E tests show unexpected failures.

**Prevention:** When debugging discrepancies between unit and E2E tests, always check if a rebuild is needed. Add this to debugging checklist: "Did I run `pnpm build`?"

**Location:** Monorepo-wide pattern

---

### belongsTo JSON-Agg Correlation Uses Different Direction (2026-01-25)

**Issue:** When switching to json_agg for belongsTo relations, query failed with "column __t__.author_id does not exist".

**Symptoms:** hasMany json_agg worked fine, but belongsTo produced invalid SQL referencing wrong column.

**Cause:** The json-agg handler used a single correlation pattern for all relation types. hasMany and hasOne use `target.fk = source.pk` (e.g., posts.author_id = authors.id). But belongsTo is the INVERSE: `source.fk = target.pk` (e.g., posts.author_id = authors.id from the post's perspective).

**Solution:** In json-agg.ts, check `relation.type === 'belongsTo'` and use `target.pk = source.fk` instead of `target.fk = source.pk`.

**Prevention:** When implementing a handler for multiple relation types, explicitly consider the JOIN direction for each type. Create a decision matrix: hasMany (parent→children), hasOne (parent→child), belongsTo (child→parent).

**Location:** `packages/adapter-kysely/src/compiler/handlers/include/json-agg.ts`

---

### resolveFieldAlias Must Detect Subquery Context (2026-01-25) — SPEC-002

**Issue:** PostgreSQL error "missing FROM-clause entry for table posts_json" when using WHERE relation filter with SELECT on same relation using json_agg.

**Symptoms:** Query like `users | select id, posts | where some(posts).featured = true` failed. The EXISTS subquery tried to resolve `posts` alias to the CTE alias `posts_json`, but CTEs don't exist in subquery scope.

**Cause:** `resolveFieldAlias()` was designed for main query context where CTEs are available. In subquery context (EXISTS, json_agg correlated subquery), the alias resolution logic incorrectly tried to use CTE aliases that don't exist in that scope.

**Solution:** In `resolveFieldAlias()`, detect subquery context by checking if the current expression is inside an EXISTS or json_agg subquery (identifiable by alias patterns like `__t__` or `_exists`). When in subquery context, return the direct alias without CTE transformation.

**Prevention:** When writing SQL generation code that works at different query levels (main query vs subquery), always consider whether helper functions assume main query context. Add explicit context detection or pass context as parameter.

**Location:** `packages/adapter-kysely/src/compiler/helpers.ts` → `resolveFieldAlias()`

### Export Name Conflicts Between Schema and Subquery APIs (2026-01-25) — ARCH-005

**Issue:** ARCH-005 spec required exporting `ref()` for FK declaration, but a `ref()` function already existed in subquery-builder for correlated subqueries.

**Symptoms:** Initially exported `ref as fk` to avoid conflict, but this broke CLI codegen which generated `import { schema, ref } from '@dbsp/core'`.

**Cause:** Two different semantic concepts used the same function name:
- `ref('users')` → FK declaration (ARCH-005 schema API)
- `ref('id')` → Parent column reference in subquery (DX-012 subquery API)

**Solution:** Renamed subquery's `ref()` to `outerRef()` to clearly indicate "reference to outer/parent query column". This follows the naming convention used by Drizzle ORM and other ORMs for correlated subqueries.

**Prevention:** When designing new APIs, search codebase for existing exports with same name. Consider semantic clarity - `outerRef` is clearer than `ref` for its purpose anyway.

**Location:** `packages/core/src/dx/subquery-builder.ts` → `outerRef()` (formerly `ref()`)

---

## adapter-pgsql: Planner always sets choice='exists' for both EXISTS and NOT EXISTS (2026-01-29)

**Symptoms:** NOT EXISTS queries generate EXISTS instead of NOT EXISTS in SQL output.
**Cause:** The planner's filter-strategy decision always sets choice to 'exists' regardless of whether the intent is exists or notExists. The differentiation is only in the intent's kind field.
**Solution:** Use the matching intent's kind field to determine the operator, not the planner decision's choice field. Check matchingIntent.kind === 'notExists' instead of d.choice === 'notExists'.
**Prevention:** When bridging planner decisions to compiler decisions, always verify which field carries the actual semantic distinction. Don't assume the choice field captures all nuances.
**Location:** packages/adapter-pgsql/src/pgsql-adapter.ts — extractExistsDecisions method

---

## adapter-pgsql: deriveFK convention fails for aliased inverse relations (2026-01-29)

**Symptoms:** EXISTS subquery uses wrong FK column — e.g. bundle_components.product_id instead of bundle_components.bundle_id for the 'components' inverse relation.
**Cause:** The deriveFK method singularizes the source table name to derive the FK column (products → productId). This convention fails when the relation uses an aliased FK like bundleId with inverse 'components'.
**Solution:** Resolve the FK from the model's RelationIR by looking up the relation via model.getRelation(sourceTable.relationName). Pass the model to extractExistsDecisions and include foreignKey in the decision.
**Prevention:** Never rely solely on naming conventions for FK resolution. Always prefer explicit FK metadata from the model when available, falling back to convention only as last resort.
**Location:** packages/adapter-pgsql/src/pgsql-adapter.ts — extractExistsDecisions, packages/adapter-pgsql/src/compiler.ts — compileExistsCondition

---

## adapter-pgsql: Double parameter push for range operators (2026-01-29)

**Symptoms:** PostgreSQL error "could not determine data type of parameter $1" for range queries. The SQL has two parameters ($1 and $2) where only $2 has a type cast.
**Cause:** The generic value compilation in compileCondition pushes the raw JS object as $1, then compileRangeOperator pushes the formatted range string as $2 with the correct type cast. PostgreSQL cannot infer the type of the uncast $1.
**Solution:** Add an early return for range operators (contains, containedBy, overlaps) in compileCondition BEFORE the generic value compilation code runs. This prevents the double-push.
**Prevention:** When adding specialized operator compilation, ensure the generic compilation path is bypassed. Consider using a registry pattern where each operator type has exclusive ownership of its parameter handling.
**Location:** packages/adapter-pgsql/src/compiler.ts — compileCondition (early return before line 682)

---

## adapter-pgsql: model.getTable() expects logical names, not database names (2026-01-29)

**Symptoms:** Range type enrichment fails silently — getTable returns undefined because it receives snake_case names (booking_period) instead of camelCase (bookingPeriod).
**Cause:** The NamingPlugin.toDatabase() converts camelCase to snake_case, but model.getTable() indexes tables and columns by their logical (camelCase) names. Calling toDatabase() before getTable() double-converts the name.
**Solution:** Use the logical table name directly from the plan (plan.rootTable is already in camelCase). Don't pass through NamingPlugin.toDatabase() when looking up model metadata.
**Prevention:** Model lookups always use logical names. Database naming conversion should only happen at the final SQL generation step (in AST node builders like rangeVar and columnRef).
**Location:** packages/adapter-pgsql/src/pgsql-adapter.ts — range enrichment in compile()

---

## adapter-pgsql: pgsql-deparser does not quote lowercase identifiers (2026-01-29)

**Symptoms:** Test assertions expecting quoted identifiers like "users" or "public"."users" fail because the deparser outputs users or public.users.
**Cause:** The pgsql-deparser follows PostgreSQL convention: only quote identifiers that contain uppercase letters, spaces, reserved words, or special characters. Lowercase-only identifiers are valid without quotes.
**Solution:** Update test assertions to accept both quoted and unquoted forms using regex patterns like /from\s+"?users"?/ instead of exact string matches.
**Prevention:** When writing SQL assertion tests for the pgsql adapter, use regex or normalize both expected and actual to the same quoting convention. Never assume identifiers will be quoted.
**Location:** packages/adapter-pgsql/src/__tests__/compiler.test.ts

---

## adapter-pgsql: Range enrichment code can be lost between editing sessions (2026-01-29)

**Symptoms:** Range queries fail after a session where other code was edited in the same area. The dataType enrichment loop is silently absent from the compile() method.
**Cause:** During multi-session editing with sed/regex replacements, code blocks can be accidentally removed when surrounding code is modified. The enrichment loop has no compile-time check — its absence produces runtime errors only for range queries.
**Solution:** After any editing session touching compile() or nearby code, verify the range enrichment block is present by searching for "dataType" or "endsWith('range')" in the adapter.
**Prevention:** Consider extracting the enrichment into a named method (enrichRangeDecisions) that is explicitly called and whose absence would be noticed. Add a unit test that specifically validates range decisions have dataType set.
**Location:** packages/adapter-pgsql/src/pgsql-adapter.ts — compile() method, range enrichment block

---

## Biome post-edit hook removes "unused" fields before usage is added (2026-01-30)

**Symptoms:** A newly declared class field (e.g. `pendingJoins`) gets renamed to `_pendingJoins` or removed entirely by the linter before you can add the code that uses it.
**Cause:** The post-edit-lint hook runs `biome check --write --unsafe` after every Edit tool call. If a field is declared in one edit but its usage is added in a subsequent edit, biome sees it as unused and auto-prefixes with underscore or removes it.
**Solution:** Add the field declaration AND at least one usage in the same edit operation. Alternatively, use Serena's `replace_content` tool which does not trigger the post-edit hook.
**Prevention:** When adding new class fields or variables that will be used later, always include at least a minimal usage (e.g. reset in constructor) in the same edit.
**Location:** Any file with class fields — specifically hit on compiler.ts `pendingJoins` array field
