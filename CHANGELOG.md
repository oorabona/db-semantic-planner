# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Clarified ambiguous function names across core and adapter packages (NAME-001..004)
- Fixed DRY violations by consolidating duplicate functions (DUP-001..003)
- Updated documentation to reflect ARCH-002/003 package structure

### Fixed
- Schema name now correctly propagates to `dump.meta` via `adapter.createDump()`
- DDL drops and batch mode error handling improvements
- CamelCasePlugin for consistent column casing in CLI

## [1.0.0] - 2026-01-18

### Added
- **ARCH-002: One Ring Architecture** - Codegen-first approach with unified schema definition
- **ARCH-003: Schema Merge** - Merged `@dbsp/schema` into `@dbsp/core`
- Auto-increment support and sequence management
- Dialect type safety (compile-time + runtime)
- `fkAutoIndex` convention at model level
- DDL features: `unique`, `onDelete`, `index` constraints
- CLI options: `--casing` and `--dialect` for DDL generation
- REPL: 9 DX improvements including `.import` command
- PIM/DAM example with realistic e-commerce schema

### Changed
- DDL output defaults to stdout (use `--output` for file)
- Improved Podman compatibility with log-based wait strategy

### Fixed
- CLI execution mode when `--db` is provided in batch mode

## [0.9.0] - 2026-01-10

### Added
- **DX-026: Upsert Support** - `INSERT ... ON CONFLICT` with `doUpdate()` / `doNothing()`
- **DX-027: Raw SQL Escape Hatch** - `raw` tagged template for arbitrary SQL
- **DX-028: Pagination Helpers** - `paginate()` and `cursorPaginate()` methods
- **DX-025: Transaction Wrapper** - `orm.transaction()` for atomic operations
- **P3-C: Range Types** - `rangeOverlaps`, `rangeContains`, `rangeContainedBy` helpers

### Changed
- DX layer merged into `packages/core` (ARCH-001)

## [0.8.0] - 2026-01-09

### Added
- **P3-A: Window Functions** - `row_number`, `rank`, `dense_rank`, `sum`, `avg`, etc.
- **DX-021: Window Functions Builder** - Fluent API for window function queries
- **DX-022: Recursive via include()** - Recursive CTEs through include API
- **DX-023: Lightweight ModelIR** - Simplified schema definition
- **DX-024: orderBy() Shorthand** - Simplified ordering syntax

## [0.7.0] - 2026-01-08

### Added
- **RFC-001: Recursive CTE Support** - Full recursive query support
- **ARCH-001: Dialect-Agnostic Recursive** - Cross-dialect recursive CTEs
- **DX-005: Recursive Query Builder** - Fluent API for hierarchical queries

## [0.6.0] - 2026-01-07

### Added
- **DIALECT-001: Multi-dialect Capabilities** - Runtime capability detection
- **STREAMING-001: Cursor/Streaming Support** - AsyncIterableIterator for large results
- **DX-001: Strict Mode** - Ambiguity detection with `AmbiguousPlanError`
- **DX-003: Compat Layer** - `eq`, `and`, `or`, `all`, `first` helpers

## [0.5.0] - 2026-01-06

### Added
- **E2E-001: PostgreSQL Validation** - Real database integration tests
- **E2E-002: PIM/DAM Scenarios** - Realistic e-commerce test suite
- **ADAPTER-004: Enhanced Observability** - Detailed plan reports
- **ADAPTER-006: Schema Introspection** - Runtime schema discovery

## [0.4.0] - 2026-01-05

### Added
- **ADAPTER-001: Kysely Dump/Compile/Execute** - Full query lifecycle
- **ADAPTER-002: Multi-tenant** - Schema prefix support with `forTenant()`
- Golden query tests Q1, Q2, Q3 (EXISTS vs JOIN, CTE extraction, ambiguity)

## [0.3.0] - 2026-01-04

### Added
- **CORE-003: Semantic Planner** - Decision engine for query optimization
- EXISTS vs JOIN decision logic
- CTE extraction for relation reuse

## [0.2.0] - 2026-01-03

### Added
- **CORE-002: IntentAST** - Query intent representation
- WhereIntent union types (comparison, string, array, null, logical, relation)
- IncludeIntent for eager loading

## [0.1.0] - 2026-01-02

### Added
- **CORE-001: ModelIR** - Schema definition types
- TableIR, ColumnIR, ForeignKeyIR, RelationIR interfaces
- `defineSchema()` builder API
- Planning hints: cardinality, optionality, strategy

[Unreleased]: https://github.com/your-org/db-semantic-planner/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/your-org/db-semantic-planner/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/your-org/db-semantic-planner/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/your-org/db-semantic-planner/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/your-org/db-semantic-planner/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/your-org/db-semantic-planner/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/your-org/db-semantic-planner/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/your-org/db-semantic-planner/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/your-org/db-semantic-planner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/your-org/db-semantic-planner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/your-org/db-semantic-planner/releases/tag/v0.1.0
