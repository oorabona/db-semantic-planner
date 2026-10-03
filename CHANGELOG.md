# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-24

### Features

- SEO meta, roadmap page, adapter-agnostic database section
- VitePress documentation site, fix comparison accuracy, fix CI
- SEO plugins — llms.txt, robots.txt, sitemap, lastUpdated
- Interactive NQL playground (Phase D)
- Enhanced playground — editable schema + live Mermaid ER + smart NQL
- Bloom index method + @-modifier collations (#54)


### Bug Fixes

- Correct GitHub URLs, fix code examples accuracy, format typedoc.json
- Resolve typecheck errors (SetOperationIntent narrowing, RLS drift types)
- Correct tokenizer, CTE parsing, and WHERE expressions (#45)
- WASM test init for CI, exclude VitePress cache from biome
- **(ci)** E2e test script is at root, not in adapter package
- Unify dbType metadata, tighten CompileOnlyAdapter, preserve adapter config (#46)
- Playground function bindings (biome renamed Vue SFC exports)
- Playground styling + create 4 missing guide pages
- Correctness fixes and extract DDL phases + WHERE handlers (#47)
- Validate extension names and check expressions across every DDL path (#48)
- Retro-audit 2026-04-20 (22 findings + 7 senior follow-up) (#51)
- Retro-audit 2026-04-21 (7 bundles, 35 S/M findings) (#52)
- Close tier 2 semantic hygiene items across dx layer (#58)
- Tighten codegen, history permissions, and loader error handling (#57)


### Refactors

- Landing page — clean hero, fixed terminal, alternating why cards
- Move LoadedSchema + isValidSchema to @dbsp/types (#61)
- SOLID bundle 8 — OCP registry, ctx struct, pagination+stream extraction (#53)
- Tighten hygiene across planner, filters, paginator (#56)


### Documentation

- Enrich schema docs with Mermaid ER diagrams and ref() options
- Stabilize sanitizeErrorMessage contract, tighten JSDoc (#55)


### Testing

- Pin originalDbType-cast session state to a single pool client (#60)
- Harden migrate destructive-flag coverage and document --json path (#59)


### CI/CD

- Add CI (test+lint+typecheck+e2e) and publish (npm on tag) workflows


### Miscellaneous

- Publication Phase A+B, full dependency upgrade, CI fix
## [1.0.0-rc.1] - 2026-04-24

### Bug Fixes

- Landing page UI overhaul — CTA visibility, SVG icons, avatars, layout
- Light mode design overhaul — cards, hero, badges, CTAs


### Testing

- **(core,adapter)** 95% branches. 6403 tests pass.
- **(core,adapter)** 153 branch coverage tests — pg.Pool mock (33), assertion-runner (37), orm/planner/mutation strict branches (83), hook-utils (7). Target 95% branches.
- **(core)** 70 branch coverage tests — caseWhen builder (17), expressions (21), cte builders (12), planner joinDefault+CTE (2), raw-cte set operations (7). Core branches 91.6→93.2%.


### Miscellaneous

- Publication readiness — MIT LICENSE (root + 6 packages), CODE_OF_CONDUCT, 6 READMEs, all package.json v1.0.0 with metadata (author, description, keywords, repository, publishConfig), 0 dep vulnerabilities
## [0.9.0] - 2026-04-24

### Features

- Assertion runner + post-MVP polish
- **(gui)** Schema diff (live DB vs schema.ts)
- Query history + sidecar wiring fixes
- DOWN migrations, schema versioning, and GUI schema diff
- Add application log panel
- Add IPC request/response logging with timing (GUI-016b)
- SQLite log backend with filters, persistence, export (GUI-016a+c)
- Toast notifications, configurable log retention, virtualized log panel
- Project mode with per-project SQLite, wizard, schema editor
- App logs modal with filter/search
- Server-side pagination, auto-column sizing, column virtualization
- PageStore TTL, infinite scroll, keyset pagination
- Connection UX redesign with auto-connect and profile management
- Add dbType escape hatch for custom DB column types
- Add FILTER clause support in aggregate expressions
- Emit FK constraints and indexes for new tables in compareSchemata
- Add ANY() operator and batch INSERT via unnest (blocks 1-2)
- Add batch UPDATE via unnest FROM strategy (block 3)
- **(adapter,core,types)** Add CTE with unnest builder and WITH ORDINALITY (block 5)
- Add CHECK constraint support (block 1/8)
- Add ENUM type support (block 2/8)
- **(core)** Extend schema DSL — method, opclass, with, where on indexes + CHECK + sequences + extensions
- Add advanced index support (block 3/8)
- Add FK onUpdate, deferred, auto-index (block 4/8)
- Add collation, identity, comments (block 5/8)
- Add sequences and extensions (block 6/8)
- Add partitioning support (block 7/8)
- Parallelize introspection queries (block 8/8)
- Add multi-adapter capability negotiation (CAPS)
- Add version-aware dialect capabilities
- Remove WASM + internalize pgsql-deparser (#21)
- Add generic expression primitives and pgvector extension (#23)
- Add ParadeDB extension + fix nested op parenthesization (#24)
- Batch TRIVIAL/SIMPLE tasks — 6 features + docs (#28)
- Add Row-Level Security policy support (#29)
- Add NamedArgExpr support for PG named parameters (#31)
- Add join type to include() — inner/left (#32)
- Add .filter() to ExpressionRef for aggregate FILTER clause (#36)
- Add star() and array() expression primitives (#38)
- Add table-scoped DDL helpers — truncate, vacuum, alterColumn, indexes
- Add catalog helpers — indexes.exists(), indexes.list(pattern), storageSize()
- Add caseWhen() expression builder for CASE WHEN in columns/orderBy
- AggOrderBy in fn() + arrayAgg/stringAgg helpers
- Add .join() API — manual joins with explicit ON condition
- BatchValues, vector search, fullTextSearch, recursive CTE
- **(adapter)** Aggregate shortcuts support dotted column refs for JOINed tables. count('rel.col') now produces COUNT("rel"."col"). 6 tests.
- **(adapter)** Multi-hop JOINs in EXISTS subqueries with intermediate FK resolution. 7 tests.
- **(nql)** CTE syntax (WITH name AS (query) mainQuery). SimpleCteIntent type, lexer With token, parser grammar, visitor, compiler with ColumnValidator CTE bypass, adapter simpleCte handler. 10 tests.
- TypeScript codegen, enhanced DSL, copy button
- Animated terminal demo page + enhanced getting-started guide
- Enhanced landing page — terminal demo, pipeline visualization, animations
- WebGL gradient shader hero + fix CTA WCAG contrast + reduced-motion
- Landing page — install bar, why section, testimonials, PG badges, stats


### Bug Fixes

- Replace sidecar stub with direct Rust child process spawning
- Add timeout to IPC request queue to prevent infinite spinner
- Use padding-spacer for virtual table rows instead of absolute positioning
- Cmd+Enter uses stale onRun closure — wire through ref
- **(gui)** Validate file size (512KB cap), empty content, max 200 assertion blocks - F006: 30s timeout on assertion runner via withTimeout() wrapper - F007: edge case tests for empty files, mid-run disconnect, timeout handling
- Remove sidecar_kill from transport close to fix reload race
- Ignore stale sidecar-exit during boot to survive webview reload
- Register schemaApply stub to prevent sidecar crash on startup
- Show sidecar boot/error status in schema tree
- Project mode hardening — 5 review findings
- Restructure status bar — move app logs to app bar, fix Results tab enable
- Harden project creation wizard and SQLite lifecycle
- Add fs:allow-mkdir permission for app config directory
- **(nql)** Add type narrowing in coverage tests for discriminated union access
- Resolve 4 review findings (F-001 to F-003, F-006)
- Add 14 new ChangeKind handlers to verifier CHANGE_TO_DRIFT
- Resolve E2E DDL provisioning failures
- Address 6 retroactive audit findings (security + correctness)
- **(core)** Re-expose select() on OrmInstance type — fixes 683 TSC errors across test files. Remove 29 (orm as any) casts.
- **(adapter,core)** Validate RLS policy expressions against SQL injection (P1) + export createDialectCapabilities in public API. 5 security regression tests.
- Fix 2 P0 bugs — (#33)
- Make wCount() field optional for COUNT(*) OVER() (#34)
- Fix oidvector → oid[] cast in index introspection query (#35)
- Fix 6 integration bugs blocking astix ORM migration (#39)
- Fix 3 more astix integration bugs (2HOP-WHERE,) (#40)
- Bridge WhereIntent.field to CompilerDecision.column for comparison/null kinds
- **(adapter)** Fix TSC errors — CompilerDecision→Decision rename, readonly array casts
- Synthesize LEFT JOIN when include alias is camelCase of snake_case relation (#41)
- Synthesize missing JOIN for camelCase include aliases (Issue 15)
- Suppress join hydration columns when .columns() is explicit (Issue 16)
- Resolve merge conflicts + delegate DDL to adapter (fix)
- Review findings — JSDoc accuracy, toContain→toEqual in FTS+vector tests
- 6 security/correctness bugs from multi-LLM review
- BatchSet() now propagates .where() guard (Gap 1) + rawExists/rawNotExists types (Gap 2 partial)
- 7 astix gaps — rawExists, JOIN ON aliases/expressions, CTE+JOINs, selectExpression, op(subquery)
- Review fixes — 6 E2E assertions, 43 TSC errors, Gap 1 test, like() overload
- **(core)** Cascade LEFT JOIN in multi-hop flat include chains — prevent INNER JOIN on required relations from dropping parent rows when ancestor used LEFT JOIN. 3 regression tests.
- **(core)** Reset LEFT JOIN cascade after explicit join override (Codex P2) — simplify cascade logic to use actual emitted join type, replace old tests with focused q4Schema regression tests
- **(adapter)** Deduplicate EXISTS intent matching — multiple exists() on same relation now get distinct params instead of duplicating the first intent's values. 2 regression tests. TODO updated with /code-health findings.
- **(adapter)** Wrap IN clause List node in parentheses — fixes syntax error in subquery include strategy. 3 E2E tests unblocked.
- **(adapter)** Quote timestamp reserved keyword — add to PG_RESERVED + SQL_RESERVED_KEYWORDS, update iam Q29 assertion
- **(adapter)** Suppress false DROP INDEX for implicit unique column indexes in compareSchemata — adds autoUniqueIndexKeys filter. 4 regression tests.
- Schema output as tabs (Diagram/TypeScript), WCAG contrast
- Retro-audit 2026-04-19 realign across nql, types, adapter-pgsql (#49)
- Cli retro-audit 2026-04-20 (8 thematic commits, 43 S/M findings) (#50)
- **(adapter)** Parenthesize OR inside AND in SQL deparser — prevents operator precedence bug where include-where AND condition silently consumed OR branch. 4 regression tests.
- **(core)** Remove | undefined from hook composition return types — fixes TSC build errors
- **(adapter)** InSubquery inside or() now compiles to ANY(SELECT ...) — convertIn emits inSubquery operator directly instead of relying on normalizeToDecision early-return bypass. Regression test.
- **(docs)** Update CTE examples to use iam schema tables
- Hero shader CSS opacity leaked to entire page (blank page bug)


### Refactors

- Extract select expression handlers from convertSelect
- Batch S-priority cleanup — DRY helpers, type mappings, DDL fixes (#25)
- Consolidate duplicate handler methods via factory functions (#26)
- Decompose compileExpression into 8 handler functions (#27)
- **(core,adapter)** Cleanup — PlanDecision type guards (16 tests), expressions.ts ordering comment, CompileSubqueryFn named type, shared requireAdapter(), mark TSC/cleanup items done
- **(adapter)** Decompose compileSelect 416→181 lines — extract 7 helpers (propagateExistsConditions, stripJoinColumnsForAggregation, buildRelationColumnsMap, injectAndValidateRelationColumns, enrichRangeDecisions, buildSimplifiedPlanReport). 3204 tests pass.
- **(core,adapter)** Decompose buildTables 213→37 lines (8 helpers) + convertWhereCondition 398→70 lines (9 handlers). Pure refactoring, 5486 tests pass.
- **(core)** Decompose buildTableDDL 247→60 lines — extract 8 helpers (quoteIdent, buildQualifiedTable, 5 SQL generators, buildIndexAPI). Pure refactoring.
- **(adapter)** Decompose introspect 581→53 lines — extract 11 helpers (queryAllCatalogs, buildPartitionMap, buildCheckMap, buildIndexMap, buildColumnMap, buildPKMap, buildFKMap, buildEnumMap, buildCommentMaps, buildRLSMaps, buildTableIR). Pure refactoring, 3204 tests pass.
- **(adapter)** Decompose changeToUpSQL 311→99 lines — extract 16 handlers (upAddColumn, upAlterColumnType, upCreateIndex, upCreateEnum, etc.). Pure refactoring, 3204 tests pass.
- Unify WHERE compilation pipeline — compileWhereIntent replaces dual paths
- **(adapter,core)** P2 cleanup — named type casts in compile-where, rawExists/rawNotExists DX helpers (9 tests), extract shared makeCtx test utility (8 files deduplicated)
- **(adapter)** Decompose compileSelect(compiler) 202→89 lines — extract 5 helpers (compileFromClause, compileIncludeWhereConditions, compileJoinDecision, compileOrderByDecision, compileGroupByDecision). 3204 tests pass.


### Documentation

- Add RLS usage guide, decisions, and CLAUDE.md DDL section
- Add RLS usage guide, decisions, and CLAUDE.md DDL section (#30)
- Finalize session — archive 22 completed tasks, update decisions
- Add expression primitives + extensions guides, update CLAUDE.md
- Hydration design doc, hook composition utilities (26 tests), schema versioning guide, PATTERNS.md (8 patterns)
- Add guides for DDL helpers + CASE expressions, update CLAUDE.md
- Add guides for .join(), recursive CTE, batchValues, fullTextSearch


### Testing

- Add multi-byte size and block marker edge case tests
- **(adapter)** Add batch upsert test suite (block 4)
- Add regression tests for (not bugs) (#37)
- Add dx-to-sql integration TNR — 14 end-to-end tests with exact SQL matching
- **(adapter)** 56 strict edge case tests covering 40 uncovered execution paths — compileSelect limit/offset/distinctOn edge cases, deparseBoolExpr null args + precedence, compileWhereIntent range/LIKE/escape/empty logical groups. All assertions use toEqual/toBe, zero toContain.
- **(core,adapter)** 514 strict branch coverage tests — deparser (167), compiler-utils (100), WHERE handlers (57), orm-instance/builders (96), planner+query-builder (94). All toEqual/toBe, zero toContain. 6062 tests pass.


### Miscellaneous

- Finalize — archive decisions, update TODO
- Finalize — archive decisions, update TODO, archive completed tasks
- Finalize — archive decisions, update TODO, archive completed tasks


### Other

- **(adapter)** Biome format + import organization across test files
## [0.5.0] - 2026-04-24

### Features

- Add namingConvention to Adapter interface (Block 1)
- Phase 2 blocks 1-2 - PgsqlAdapter + comparison mode
- Complete Phase 2 - parity validation + DDL generation
- Add intent-to-decisions converter for E2E integration
- **(adapter-pgsql)** Fix nested AND/OR/NOT condition compilation (87 → 40 failures)
- **(adapter-pgsql)** Fix COALESCE using proper CoalesceExpr AST node (87 → 35 failures)
- Achieve E2E parity - 291/291 tests passing (87 → 0 failures)
- Add db.output table assertions with full column coverage
- Complete sql.equals migration and db.output coverage for all assert files
- **(cli)** Add --casing flag to REPL command for column name transformation
- **(cli)** Rich plan output + multiline input in REPL
- Tabbed panel, paste fix, and conversation UX improvements
- **(cli)** Silently ignore comment-only lines in REPL
- Configurable PK/FK naming conventions
- Require adapter in createOrm, shared MockAdapter
- Per-include LIMIT syntax and ScalarSubquery limit propagation
- Anchored inspection panel, layout modes, and rich plan output
- Add AdapterLogger interface + replace 61 throw new Error with NqlSemanticException (3.4, 3.7)
- Unify ScalarSubqueryIntent → QueryIntent, add IN→EXISTS optimization
- Propagate relation columns to include strategies
- **(adapter)** Implement compileWithIncludes + restore deriveForeignKey helper
- Implement PostgreSQL introspection + dbCasing codegen (Phase 4C)
- Anchored inspection panel + compact output layout
- Deep lateral nesting, CTE bridge, explicit type mapper
- Wire unified include handler dispatch, fix | flat
- Implement IN (subquery) + restore bug fixes
- Close NQL compile gaps, add arithmetic handler, ARCHITECTURE.md
- Consolidate WHERE paths, add FieldRef for alias-scoped column references
- Add compile-time column validation to NQL compiler
- Generalize bind to queries, add upsert-from, remove let
- Extensible singularize() with overrides + FK naming docs
- Add .exists() query shortcut and NQL multi-row INSERT
- Implement getSchemaFromDb() for DB introspection (E07, E07b)
- Add soft delete convention + P2 quick wins
- E06c MCP tests + E10 injectable logger
- E17b query/mutation hook system
- E13c CASE expression enhancements
- PG14 CYCLE clause + compileWithIncludes stale cleanup
- NQL language features batch
- E16d set operations in REPL + E16f mutation bind
- E16c transactions + E16/E16e CSV load/dump
- E15 FOR UPDATE SKIP LOCKED — row-level locking for job queue pattern (#11)
- DDL provisioning — push, migrate, verify commands
- DBSP GUI Desktop Database Explorer — MVP (#12)


### Bug Fixes

- Resolve streaming afterAll hook timeout
- Properly serialize nested objects in assertion output
- Fix LATERAL JOIN schema qualification
- Compile relation-path filters as EXISTS subqueries
- Align E2E tests with adapter-pgsql post-sunset cleanup
- Add missing await on compileNqlToSql and remove non-null assertions
- Remove schema qualification from alias columnRef and fix JoinExpr wrapping
- ScalarSubquery delegates to query rule, fixing IN subquery parse
- IN subquery WHERE used wrong column (fallback to 'id')
- Wildcard column propagation, defaultPk, REPL input scrolling
- Json_agg column projection via jsonb_build_object
- 5 compiler bugs, audit script, doc enrichment
- Resolve via hint ambiguity bug and remove E2E skip
- **(core)** Infer composite PK from FK columns and allow optional primaryKey on TableIR
- **(nql)** Support deep dotted relation paths in SELECT via nested IncludeIntent tree
- **(adapter)** Improve recursive CTE compiler and update E2E tests
- **(cli)** Guard optional primaryKey in schema-codegen after TableIR change
- Resolve subquery include hydration bugs + add E2E tests
- Convert table names + ref() targets to camelCase with dbCasing + add E2E pipeline test
- Emit type-cast for range columns in INSERT/UPDATE
- Resolve 8 audit vulnerabilities
- Nested json_agg for deep relation traversal (4+ levels)
- **(test)** Resolve exactOptionalPropertyTypes errors in lateral tests
- Resolve 4 NQL compilation bugs (#)
- Make RefDefinition and ref() generic to preserve literal types
- Resolve all 497 typecheck errors across codebase
- Update .assert.dbsp files for current compiler output
- Support camelCase/snake_case bidirectional column matching in validator
- Pass innerAlias to json_agg shared filter WHERE clause
- Bang-suffix stripping with string-literal awareness
- Enrich all queries in multi-query blocks, add labels
- Expand IN(subquery) to inline SQL in mutation WHERE clauses
- Resolve bound CTE refs in mutation WHERE as subqueries
- Update @modelcontextprotocol/sdk to 1.26.0
- Resolve P1 bugs E01, E02, E03
- Implement WhereSubqueryIntent conversion (E05)
- Support external DATABASE_URL, skip testcontainers when provided
- Expression handler bugs + A-24 clone cleanup
- F-001 validate column count in UNION/INTERSECT/EXCEPT
- Set operations execute as queries + E16 E2E assertions


### Refactors

- Sunset adapter-kysely, adapter-pgsql becomes sole adapter
- Extract shared helpers and clean stale TODOs
- Extract ReplEngine + conversational TUI
- DRY batch mode via ReplEngine
- DRY visitor guards via requireFirst/requireFields/unreachable
- Unify input parsing in ReplEngine, delete dbsp-parser
- **(adapter)** Add DbCasing type with intuitive semantics alongside legacy NamingConvention
- Phase 3 quick wins — DRY helpers, security, cleanup
- Extract SRP modules from large files (Phase 5 M-items)
- Extract condition compilation from PlanCompiler (Phase 5 Block 1)
- Extract plan decision extractors from PgsqlAdapter (Phase 5 Block 2a)
- Extract getColumnName() into shared column-utils (DRY)
- Extract buildColumnRef/buildParamRef into where/utils (DRY)
- Remove deprecated namingConvention, migrate to dbCasing (#26)
- DRY consolidation (Axis 1) + lint/typecheck cleanup
- Remove sql.contains, migrate all assertions to sql.equals
- Consolidate normalizeSQL, remove format() stub, integrate audit backlog
- Reduce public API surface, remove internal-only exports
- DRY consolidation — extract base class, shared helpers, fix clone bugs (#13,#14,#15,#22,#32,#35)
- Delete dead QueryExecutor code (E04)
- R01 type rationalization — centralize contracts, eliminate casts, split god file
- R02 eliminate remaining 33 as {} casts across codebase
- DRY case-value, CASE tests, SOLID evaluation
- Route selectFunction + selectWindow through handler registry
- DRY batch — normalizeSQL to core, FK direction dedup, E2E globalSetup fix
- **(types)** Split intent-ast.ts into 10 focused modules (SRP Phase 1)
- **(nql)** Split NqlCstVisitor into domain modules (SRP Phase 2)
- Split NqlCompiler into domain modules (SRP Phase 3)
- Split orm.ts into domain modules (SRP Phase 4)
- Dead code cleanup + types public/internal separation


### Documentation

- Add comprehensive IAM/RBAC example with 9 tables and 29 queries
- Add pedagogical API guides (ORM + NQL reference)
- **(nql)** Replace phantom table examples with real schema tables
- **(nql)** Split schema section into 3 files + add schema badges per section
- **(adapter)** Add @example JSDoc tags to methods
- Update audit, P0 docs, spec statuses, and consolidate TODO
- **(nql)** Separate code blocks by schema for copy-paste safety
- Document undocumented features with E2E verification
- Add Quick Start section with install, schema, query, and compile-only examples
- Comprehensive NQL reference with verified db.output assertions
- Advanced patterns examples + E2E test fixes


### Testing

- Add NQL→SQL e2e tests for upsert (ON CONFLICT)
- Add nested json_agg + extractor tests, add flat bug to backlog
- Add test-strategies fixture exercising all include strategies
- Error path coverage for adapter, core, and nql (283 tests)
- CLI batch parsing + nql-executor integration tests (57 tests)
- Nql-executor error path tests (Block 6 complete)
- Error-path coverage for DDL modules
- Branch coverage push — 54 coverage test files (69.5% → 83.1%)
- Branch coverage Phase 6 — global 90.2% reached (87.5% → 90.2%)
- Per-package coverage push — NQL 90.7%, CLI 90.2%


### Miscellaneous

- Resolve stale source TODOs and mark completed capabilities
- Remove dead code (#24,#25,#27), suppress NQL biome warnings
- **(todo)** Mark #30 ISP QueryBuilder as WON'T FIX
- Review fixes — biome import ordering + lint suppressions
- Add @vitest/coverage-v8 dev dependency


### Other

- Auto-fix lint issues in extracted SRP modules (F-002/F-003)
## [0.3.0] - 2026-04-24

### Features

- Add convention mismatch and drift detection (F-003/F-004)
- Align NQL spec with implementation
- Implement scoped [N] traversal and COUNT(DISTINCT)
- **(types,nql,core)** Introduce 'flat' include strategy as alternative to 'join'
- WITH RECURSIVE scalar subquery for hierarchy pseudo-columns
- Programmatic batch execution + json_agg phase ordering fix
- Composite FK/indexes in schema() API + test scripts
- Complete PostgreSQL native adapter Phase 1


### Bug Fixes

- Simplify createOrm API to accept model directly
- Prevent double JOIN in flat include with relation.* select
- Fix all E2E failures, eliminate all test skips, DRY hydration


### Testing

- Add e2e tests for getSchemaFromDb (F-004/F-005)
- Migrate tests to createOrm({ schema }) API
## [0.2.0] - 2026-04-24

### Features

- Implement SQL compiler and Dump API
- Implement strict mode for ambiguous relation handling
- Implement Override API
- Implement Compat Layer - filter helpers and execution
- Implement PostgreSQL Validation
- Implement aggregates and GROUP BY support
- Implement cursor/streaming support
- Add schema name validation to forTenant()
- Implement expression helpers with selectWithExpressions API
- Implement Recursive CTE Support
- Implement dialect-agnostic recursive CTE
- Implement IAM/RBAC Recursive CTE Validation
- Implement RecursiveQueryBuilder for CTE composition
- Implement Zero-Config ORM
- Implement Actionable Errors + API Shortcuts
- Implement RecursiveBuilder Integration + Renaming
- Implement Mutations (insert/update/delete)
- Implement Phase 2 PIM/DAM scenarios + lint fixes
- Complete Q8 ambiguity coverage with junction+role pattern
- Add strict mode ambiguity E2E tests
- Implement API improvements
- Implement API Ergonomics - subquery builder
- Implement Window Functions
- Unified columns() API - remove columnsWithExpressions()
- Replace .window() with fluent builder pattern
- Implement Recursive via include() Option
- Implement recursive via include() option (BREAKING)
- Implement Lightweight ModelIR with shorthand relations
- Implement orderBy() shorthand
- Implement Planner → Compiler Contract
- Implement M:N through table support
- Edge cases and plan coherence
- Merge dx into core for adapter-agnostic architecture
- Raw SQL escape hatch
- Add upsert() and returning() support
- Migrate tests to adapter-agnostic API + fix and streaming
- Pagination helpers
- Complete codegen-first architecture
- Better error messages with suggestions
- Dialect capabilities registry
- Evaluate Ink vs vue-termui for REPL
- Add --output alias to generate command
- ResolvedSchema to GeneratedSchema converter
- Interactive REPL for query testing
- Include execution with hydration
- Introduce SchemaConfigInput for new hybrid API and deprecate SchemaDefinitionInput
- Fix type inference for createOrm
- +002 bootstrap @dbsp/mcp-server package
- +103+104 schema unification, adapter ISP split, and QueryBuilder SRP
- Add aliasing mode switch in REPL
- Add aliasing mode switch + fix React runtime
- Enhance dialect capabilities and include strategy options
- Implement real CTE-based includes
- CLI-012c unified recursive CTE in includes
- Enhanced REPL status line with dialect/strategy/aliasing
- Include WHERE filter parsing
- Qualified column routing to target tables
- Add terminal keyboard shortcuts to REPL input
- Implement include strategy hydration for json_agg and join
- Add nested include support to REPL parser
- **(compiler)** Support nested includes in applyIncludeJoins and collectAllRelations functions
- Add distinct aggregates, HAVING clause, and SELECT DISTINCT support
- Add aggregate support to REPL parser
- Add recursive include syntax with 'all' keyword
- Add depth options for recursive includes
- Type-safe schema with full inference chain
- Type-safe schema + rename packages to @dbsp/*
- Add RAW_SQL_USAGE warning for security observability
- Rename forTenant to withSchema
- Add batch mode assertion system
- Add rich ColumnDef for DDL generation
- Support shorthand ColumnDef format with normalization
- Add dbsp generate ddl and dbsp introspect commands
- Add PIM/DAM example and .import REPL command
- Implement 9 REPL improvements
- Add --casing and --dialect options to DDL generation
- Add unique, onDelete, and index DDL support
- Add fkAutoIndex convention at model level
- Add dialect type safety (compile-time + runtime)
- Add autoIncrement support and sequence management
- Implement REPL mutation syntax
- Implement NQL v1.0 - Natural Query Language
- Add .parse command to interactive REPL
- Add .explain command to interactive REPL
- Show parse/explain mode in REPL status line
- Add relation column auto-JOIN and column aliasing
- Improve REPL UX with Delete key fix, standalone flags, Ctrl+R search
- Add NQL v2.0 parser package (@dbsp/nql)
- Migrate REPL to @dbsp/nql and remove legacy parser (NQLM)
- Add AggregateExpressionIntent handler
- Implement logical/physical naming separation
- Add window functions, range operators, and fix UPSERT multi-column
- Add typed assertion system with automatic db detection
- Add intent.* assertions and scalar contains operator
- Self-referential pseudo-columns V1.0
- NQL v2.1 grammar simplification - remove with, add flat (.1)
- Cross-table pseudo-columns for relation filters
- Unified schema API with schema() + ref()
- **(adapter-pgsql)** Improve E2E test compatibility (87 to 50 failures)
- Chained pseudo-columns, PlanOptions, dynamic keywords, hierarchy examples
- Simplify ORM entry point
- Add type inference from Schema<T> to OrmInstance
- Implement Type-Safe Query API


### Bug Fixes

- Thread schemaName through EXISTS subquery compilation
- Path tracking strategy tests
- Schema filtering in introspection + cleanup skipped tests
- Align documentation with implementation
- Parse qualified columns as main table filters
- Fix recursive include flow and DRY refactor
- Fix Home/End/Backspace key handling in REPL input
- Require DOCKER_HOST env for Podman testcontainers
- Migrate to rich ColumnDef format across codebase
- Use log-based wait strategy for Podman compatibility
- DDL output to stdout by default, --output for file
- Enable execution mode when --db is provided in batch mode
- Add CamelCasePlugin for consistent column casing
- Improve DDL drops and batch mode error handling
- Propagate schema name to dump.meta via adapter.createDump()
- Add mutation support to batch mode
- Add schemaName to handleSubmit dependencies
- Add 'is not null' operator support to NQL parser
- Add missing dot commands to completion suggestions
- Separate Delete and Backspace key handling in REPL
- Robust key handling and include column filtering
- Resolve P2 compiler bugs from Codex review
- Display proper error message when .import fails
- Support range operators in include.where and use sql.ref
- Pseudo-column JOINs now applied correctly
- Preserve hasOne cardinality through schema conversion
- Update assertion aliases for schema-scoped queries
- Add DROP SCHEMA and fix assertion row counts
- Migrate assertions to sql.equals and fix json_agg strategy
- Migrate CLI to LoadedSchema API
- Add pseudoColumns generation and relation inverse names
- Align assertions with seed data and add test runner script
- Lazy-load pgsql adapter to resolve ESM dynamic require issue
- Add dotted-field EXISTS conversion, self-ref aliasing, and json_agg filter propagation
- Update unit test assertions for unquoted identifiers


### Refactors

- Remove unused 'global' dedupe strategy from RecursiveDedupe type
- Rename API methods for SQL verb consistency
- Typecheck and lint audit across all packages
- Merge @dbsp/schema into @dbsp/core
- Fix DRY violations
- Clarify ambiguous function names
- Extract hydration methods to ResultHydrator class
- Rename MockAdapter to CompileOnlyAdapter and fix DRY
- Create @dbsp/types package and unify type definitions
- Json_agg default for all relations


### Documentation

- Refine MVP documentation and create README
- Add Adapter Rules - use native Kysely APIs, never raw SQL
- Add comprehensive comparison with 16 database tools
- +107 clarify include syntax and add security warnings
- Update minimal example with DDL features
- Add autoIncrement to all example schemas
- Update QUICKSTART.md with batch mode examples
- Complete documentation batch update
- Add SECURITY.md policy
- Complete P3 tasks and fix biome lint errors
- Add mutation syntax to QUICKSTART guide
- Add mutation examples to all .dbsp files and QUICKSTART
- Add detailed JSDoc for InferRefColumn limitation (F-002)


### Testing

- Add unit tests and E2E round-trip test
- Convert aggregate .todo tests to real tests
- Add compile-time type assertions with vitest expectTypeOf (F-001)


### Miscellaneous

- Finalize and consolidate backlogs
- Config, docs, examples, and sprint cleanup
- Update dependencies to latest versions
- Update Stack section + adapter-pgsql roadmap
## [0.1.0] - 2026-01-07

### Features

- Implement ModelIR types and schema builder
- Implement IntentAST types
- Implement Semantic Planner


### Other

- Initial commit :rocket:
<!-- generated by git-cliff -->
