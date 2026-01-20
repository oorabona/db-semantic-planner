# Component Analysis

## Component: @dbsp/core

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/core` |
| Purpose | DB-agnostic schema definition, query planning, DX layer |
| Files | 49 |
| Lines | ~25,000 |
| Dependencies | valibot |
| Dependents | @dbsp/adapter-kysely, @dbsp/cli, @dbsp/mcp-server |

### Structure

```
packages/core/src/
├── index.ts              # 369 lines - Public exports
├── adapter.ts            # 440 lines - Adapter interface definitions
├── model-ir.ts           # 258 lines - Schema representation types
├── schema-builder.ts     # 569 lines - Fluent schema DSL
├── schema-dsl.ts         # 117 lines - DSL helpers
├── schema-dsl-types.ts   # 297 lines - DSL type definitions
├── intent-ast.ts         # 1417 lines - Query intent representation
├── planner.ts            # 1475 lines - Semantic planning logic
├── conventions.ts        # 336 lines - Naming conventions
├── model-impl.ts         # 205 lines - ModelIR implementation
├── dialects/
│   └── index.ts          # 555 lines - Dialect type utilities
└── dx/
    ├── index.ts          # 186 lines - DX layer exports
    ├── orm.ts            # 2351 lines - createOrm, QueryBuilder ⚠️
    ├── types.ts          # 1479 lines - Type definitions
    ├── filters.ts        # 761 lines - eq, and, or, exists
    ├── intent-builder.ts # 643 lines - Intent construction
    ├── mutation-builders.ts # 877 lines - insert/update/delete
    ├── schema-bridge.ts  # 1079 lines - Schema type conversion
    ├── query-executor.ts # 686 lines - Execution utilities
    ├── errors.ts         # 417 lines - Error types
    └── ...               # Additional modules
```

### Responsibilities

- Define ModelIR types for schema representation
- Provide fluent schema definition DSL
- Define IntentAST for query representation
- Implement semantic planner (strategy decisions)
- Provide DX layer (createOrm, QueryBuilder, filters)
- Define Adapter interface contracts

### Quality Assessment

| Aspect | Score | Notes |
|--------|-------|-------|
| Single Responsibility | 7/10 | orm.ts handles too many concerns |
| Testability | 9/10 | 345 tests pass, good coverage |
| Documentation | 9/10 | Well-documented interfaces |
| Error Handling | 9/10 | Comprehensive error types |

### Issues Found

| ID | Issue | Severity | Recommendation |
|----|-------|----------|----------------|
| CORE-001 | `orm.ts` is 2351 lines | M | Extract QueryBuilder from execution concerns |
| CORE-002 | `intent-ast.ts` is 1417 lines | L | Acceptable for comprehensive AST |
| CORE-003 | `planner.ts` is 1475 lines | L | Consider splitting by concern |

### Tests

| Type | Count | Coverage |
|------|-------|----------|
| Unit | 345 | High |
| Integration | - | Via adapter |

---

## Component: @dbsp/adapter-kysely

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/adapter-kysely` |
| Purpose | SQL compilation, execution, streaming via Kysely |
| Files | 35 |
| Lines | ~20,000 |
| Dependencies | @dbsp/core |
| Peer Deps | kysely |
| Dependents | @dbsp/cli, @dbsp/mcp-server |

### Structure

```
packages/adapter-kysely/src/
├── index.ts              # 108 lines - Public exports
├── kysely-adapter.ts     # 529 lines - KyselyAdapter implementation
├── compiler.ts           # 4735 lines - SQL compilation ⚠️
├── dialect.ts            # 622 lines - Dialect detection & capabilities
├── ddl.ts                # 668 lines - DDL generation
├── dump.ts               # 225 lines - Query dump utilities
├── stream.ts             # 277 lines - Cursor/streaming support
├── explain.ts            # 209 lines - EXPLAIN support
├── introspection.ts      # 775 lines - Schema introspection
├── mock-adapter.ts       # 506 lines - Mock adapter for testing
├── redact.ts             # 81 lines - Parameter redaction
├── errors.ts             # 80 lines - Adapter errors
├── types.ts              # 206 lines - Type definitions
└── test-utils/           # Test utilities
```

### Responsibilities

- Compile IntentAST → SQL via Kysely
- Handle multi-dialect capabilities
- Provide execution engine (with streaming)
- Generate DDL for schema migrations
- Introspect existing database schemas
- Implement all Adapter interface contracts

### Quality Assessment

| Aspect | Score | Notes |
|--------|-------|-------|
| Single Responsibility | 6/10 | compiler.ts handles all SQL generation |
| Testability | 9/10 | 701 tests, comprehensive |
| Documentation | 8/10 | Complex logic well-commented |
| Error Handling | 9/10 | Good error propagation |

### Issues Found

| ID | Issue | Severity | Recommendation |
|----|-------|----------|----------------|
| ADAPT-001 | `compiler.ts` is 4735 lines | H | Split into focused modules (select, mutations, recursive) |
| ADAPT-002 | 21 compile* functions in one file | M | Extract into separate files by concern |
| ADAPT-003 | Some functions have 100+ lines | L | Consider further decomposition |

### Tests

| Type | Count | Coverage |
|------|-------|----------|
| Unit | 701 | Very high |
| Todo/Skipped | 5 | Known EXISTS schema bug |

---

## Component: @dbsp/cli

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/cli` |
| Purpose | REPL interface, code generation |
| Files | 33 |
| Lines | ~8,000 |
| Dependencies | @dbsp/core, @dbsp/adapter-kysely, ink, commander |
| Peer Deps | tsx, kysely, pg (optional) |
| Dependents | None |

### Structure

```
packages/cli/src/
├── index.ts              # 24 lines - Entry point
├── verifier.ts           # 309 lines - Schema verification
├── commands/
│   └── ...               # CLI commands
├── generators/
│   ├── kysely.ts         # Kysely type generation
│   ├── manifest.ts       # Manifest generation
│   └── schema-codegen.ts # Schema code generation
├── repl/
│   ├── parser.ts         # 1085 lines - REPL parser
│   ├── batch.ts          # 669 lines - Batch mode
│   ├── completion.ts     # Autocomplete
│   ├── history.ts        # Command history
│   ├── assertion-parser.ts # Test assertions
│   ├── assertion-runner.ts # Assertion execution
│   └── ...               # Additional REPL modules
└── utils/
    └── ...               # CLI utilities
```

### Responsibilities

- Provide interactive REPL for query testing
- Generate TypeScript types from schema
- Generate Kysely types
- Verify schema definitions
- Support batch mode for scripting

### Quality Assessment

| Aspect | Score | Notes |
|--------|-------|-------|
| Single Responsibility | 8/10 | Clear separation of concerns |
| Testability | 9/10 | 297 tests pass |
| Documentation | 7/10 | Could use more inline docs |
| Error Handling | 8/10 | Good user-facing errors |

### Issues Found

| ID | Issue | Severity | Recommendation |
|----|-------|----------|----------------|
| CLI-001 | `parser.ts` is 1085 lines | L | Acceptable for complex parser |
| CLI-002 | No user guide | L | Add CLI usage documentation |

### Tests

| Type | Count | Coverage |
|------|-------|----------|
| Unit | 297 | Good |

---

## Component: @dbsp/mcp-server

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/mcp-server` |
| Purpose | MCP protocol for AI tools |
| Files | 4 |
| Lines | ~500 |
| Dependencies | @dbsp/core, @dbsp/adapter-kysely, @modelcontextprotocol/sdk |
| Peer Deps | tsx (optional) |
| Dependents | None |

### Structure

```
packages/mcp-server/src/
├── index.ts              # 153 lines - Entry point + exports
├── server.ts             # 88 lines - MCP server setup
├── schema-loader.ts      # 195 lines - Schema loading
├── resources/
│   └── ...               # MCP resources
└── tools/
    └── ...               # MCP tools
```

### Responsibilities

- Expose schema to AI tools via MCP
- Provide query planning capabilities
- Load and parse schema files

### Quality Assessment

| Aspect | Score | Notes |
|--------|-------|-------|
| Single Responsibility | 8/10 | Focused on MCP integration |
| Testability | 3/10 | Only 1 test ⚠️ |
| Documentation | 5/10 | Brief overview only |
| Error Handling | 6/10 | Basic error handling |

### Issues Found

| ID | Issue | Severity | Recommendation |
|----|-------|----------|----------------|
| MCP-001 | Only 1 test | H | Add comprehensive tests |
| MCP-002 | Incomplete implementation | H | Complete tools/resources |
| MCP-003 | Missing API documentation | M | Document MCP capabilities |

### Tests

| Type | Count | Coverage |
|------|-------|----------|
| Unit | 1 | Very low ⚠️ |

---

## Summary: Component Health

| Component | Files | LOC | Tests | Health | Main Issue |
|-----------|-------|-----|-------|--------|------------|
| @dbsp/core | 49 | ~25K | 345 | 🟢 | orm.ts size |
| @dbsp/adapter-kysely | 35 | ~20K | 701 | 🟢 | compiler.ts size |
| @dbsp/cli | 33 | ~8K | 297 | 🟢 | Minor |
| @dbsp/mcp-server | 4 | ~500 | 1 | 🟡 | Incomplete |

### Key Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| Largest file | compiler.ts (4735 lines) | ⚠️ Consider splitting |
| Second largest | orm.ts (2351 lines) | ⚠️ Consider extraction |
| Test coverage | 1344/1349 | ✅ Excellent |
| Package isolation | Clean dependencies | ✅ Good architecture |
