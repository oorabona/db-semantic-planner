# packages/core — Doc-code coherence snapshot (2026-04-21)

## Coherence score: 82/100

Score computed from doc-coherence concern: 25 findings (0 S, 7 M, 18 L). M findings represent actual code-doc drift that could mislead developers or users; L findings are minor wording, missing notes, or low-impact inconsistencies.

## Drift table (M-severity findings)

| Doc file:line | Doc says | Code says | Fix |
|---------------|----------|-----------|-----|
| `CLAUDE.md:149` (DOC-1) | `adapter.compile(planReport, { model, schemaName })` returns destructured object | `compile()` returns `CompiledQuery<T>`; idiomatic usage is via `orm.select().dump()` | Replace compile-only example with `createOrm({ schema, adapter })` → `orm.select('users').dump()` pattern |
| `CLAUDE.md:200` (DOC-2) | Query Features table lists ParadeDB as `bm25Search()`, `score()` — no mention of `fullTextSearch` | `fullTextSearch()` + `textScore()` exported from `@dbsp/core` as the recommended high-level API; guide explicitly says "Prefer fullTextSearch for new code" | Add `fullTextSearch(), textScore()` row to Query Features table with link to `how-to-use-full-text-search.md` |
| `CLAUDE.md:209` (DOC-3) | Guides row does not list `how-to-use-full-text-search.md` or `how-to-understand-result-hydration.md` | Both files exist on disk (334 and 397 lines respectively) | Add both guides to the Guides row in the Query Features table |
| `docs/guides/how-to-use-case-expressions.md:14` (DOC-4) | Documents `.when(condition: string, result)` as the only API form | Two separately exported overloads: `caseWhen()` (no-arg fluent builder, `functions.ts`) and `caseWhen(condition: WhereIntent, value)` (two-arg form, `case-when-builder.ts`) | Clarify both forms in the guide; recommend fluent builder for most users; distinguish import paths |
| `docs/guides/how-to-use-joins.md:59` (DOC-8) | Generated SQL `FROM (calls JOIN symbols AS caller ON ...) caller` presented without explanation | Parenthesized FROM + outer alias is unusual but valid PostgreSQL compiler output | Add note clarifying this is exact compiler output and why the outer alias is present |
| `docs/guides/how-to-use-recursive-cte.md:19` (DOC-13) | `.execute()` documented as "Alias for .all()" | Cannot confirm via structural search — `.execute()` may not exist or may behave differently on `RawCteQueryBuilder` | Verify `.execute()` in `raw-cte-builder.ts`; update API table if not an alias |
| `packages/adapter-pgsql/README.md:39` (DOC-23) | `const { sql, parameters } = adapter.compile(planReport, { model, schemaName })` | `compile()` returns `CompiledQuery<T>`; `.params` vs `.parameters` naming may differ; ORM dump() is the idiomatic pattern | Update to ORM-based pattern: `const dump = await orm.select('users').dump(); console.log(dump.sql, dump.params)` |

## Missing-docs list

Exported symbols with no JSDoc or guide coverage (from API concern and SOLID/code structural analysis):

| Symbol | Location | Type | Missing |
|--------|----------|------|---------|
| `NegotiationResult` | `negotiate-features.ts` | Interface | JSDoc description of fields and when it's relevant to callers |
| `FromBuilder` | `typed-query-builder.ts` | Interface | Exported but no callers — no guide coverage; candidate for removal |
| `TypedOrm` | `typed-query-builder.ts` | Interface | Same as above |
| `RecursiveQueryBuilder` | `typed-query-builder.ts` | Class | Exported but no external callers found |
| `IntentBuilder` | `dx/index.ts` | Class | No `@internal` tag; no guide coverage; used internally for NQL compilation |
| `OrmInstanceInternal` | `dx/index.ts` | Interface | Tagged `@internal` in JSDoc but public via wildcard re-export — no usage guidance for what consumers should use instead |

## Outdated examples

| Guide | Line | Outdated content | Current canonical form |
|-------|------|-----------------|----------------------|
| `CLAUDE.md` | 149 | `adapter.compile(planReport, { model, schemaName })` | `orm.select('users').dump()` |
| `packages/adapter-pgsql/README.md` | 39 | `const { sql, parameters } = adapter.compile(...)` | `const dump = await orm.select('users').dump()` |
| `docs/guides/how-to-use-case-expressions.md` | 175 | Lists `CaseBuilderImpl` in Key Files as if public | `CaseBuilderImpl` is not exported — remove from Key Files |
| `docs/guides/how-to-use-extensions.md` | 41 | HNSW params shown as strings: `m: '16'` | Numbers: `m: 16, ef_construction: 64` |
| `CLAUDE.md` | 205 | "IN subquery" label with `WHERE id IN (SELECT ...)` comment | Actual SQL output is `WHERE id = ANY(SELECT ...)` — label should be "IN subquery (ANY)" |
| `docs/guides/how-to-use-full-text-search.md` | 330 | Sentence cut off: "Prefer fullTextSearch for new code — it is" | Complete: "...it is more explicit, type-safe, and consistent with the ORM pattern." |

## Guide status

| Guide | Referenced in CLAUDE.md | Exists on disk | Content coherent |
|-------|------------------------|----------------|-----------------|
| `how-to-use-expression-primitives.md` | Yes | Yes | Yes (minor L: isDistinctFrom variable-vs-function note) |
| `how-to-use-extensions.md` | Yes | Yes | Mostly (HNSW param string vs number inconsistency — DOC-18) |
| `how-to-use-rls-policies.md` | Yes | Yes | Yes |
| `how-to-use-case-expressions.md` | Yes | Yes | Drift on caseWhen two-form ambiguity (DOC-4) |
| `how-to-use-ddl-helpers.md` | Yes | Yes | Mostly (buildTableDDL attribution to orm-instance.ts needs verification — DOC-6, DOC-16) |
| `how-to-use-joins.md` | Yes | Yes | Mostly (raw intent object in Example 5 — DOC-24; parenthesized FROM explanation — DOC-8) |
| `how-to-use-recursive-cte.md` | Yes | Yes | DOC-13: .execute() alias unverified; DOC-21: dump() returns `intent` not in standard Dump type |
| `how-to-use-batch-values.md` | Yes | Yes | Minor (return type caveat — DOC-12) |
| `how-to-use-schema-versioning.md` | Yes (Guides row) | Yes | Missing cross-reference from DDL Features section |
| `how-to-use-full-text-search.md` | **No** (not in Guides row) | Yes | Truncated sentence at line 330 (DOC-9); inconsistent SQL quoting (DOC-20) |
| `how-to-understand-result-hydration.md` | **No** (not in Guides row) | Yes | Not audited in this pass — guide is 397 lines |

## Recommendations

1. **Fix compile-only example in CLAUDE.md and adapter-pgsql/README.md** (DOC-1, DOC-23 — both M): Replace `adapter.compile(...)` pattern with `orm.select().dump()` in both files. This is the most visible documentation gap and directly contradicts what new users will copy.

2. **Add fullTextSearch / textScore to CLAUDE.md Query Features table** (DOC-2 — M): The high-level API from `@dbsp/core` is not mentioned at all. Guide explicitly directs users to it ("Prefer fullTextSearch for new code") but CLAUDE.md still shows only the adapter-level `bm25Search`.

3. **Add two missing guides to CLAUDE.md Guides row** (DOC-3 — M): `how-to-use-full-text-search.md` (334 lines) and `how-to-understand-result-hydration.md` (397 lines) are both substantive guides not indexed.

4. **Disambiguate caseWhen() guide** (DOC-4 — M): Two separate exports with different signatures (`functions.ts` fluent builder vs `case-when-builder.ts` two-arg form) are conflated in the guide. Users calling the wrong import will get type errors.

5. **Complete truncated sentence in how-to-use-full-text-search.md** (DOC-9 — L): Guide ends mid-sentence at line 330; quick fix.

6. **Verify .execute() on RawCteQueryBuilder** (DOC-13 — M): If the method does not exist or is not an alias for .all(), the guide's API table is wrong.
