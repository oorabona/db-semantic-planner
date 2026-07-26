# Changelog

## [2.0.4](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v2.0.3...mcp-server-v2.0.4) (2026-07-26)


### Bug Fixes

* **deps:** One catalog for every dependency range, enforced at source and in the tarball ([#398](https://github.com/oorabona/db-semantic-planner/issues/398)) ([7db9979](https://github.com/oorabona/db-semantic-planner/commit/7db9979b82315f1348024d1a9de71e5022a3c3c7))

## [2.0.3](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v2.0.2...mcp-server-v2.0.3) (2026-07-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 3.2.0
    * @dbsp/types bumped to 3.2.0

## [2.0.2](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v2.0.1...mcp-server-v2.0.2) (2026-07-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 3.1.0
    * @dbsp/types bumped to 3.1.0

## [2.0.1](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v2.0.0...mcp-server-v2.0.1) (2026-07-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 3.0.0
    * @dbsp/types bumped to 3.0.0

## [2.0.0](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.18...mcp-server-v2.0.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* **core:** The legacy schema surface is gone. Removed from @dbsp/core: defineSchema, ResolvedSchema and its Schema* definition types, isBelongsTo, isHasMany, isManyToMany, DEFAULT_CONVENTIONS, detectForeignKeys, detectManyToMany, inferRelationsFromSchema, OrmOptionsWithSchema, GeneratedSchema and its Generated* types, ColumnTypeToTS, InferRowType, InferDBFromSchema, buildModelFromSchema, buildModelFromResolvedSchema, isGeneratedSchema, isResolvedSchema, normalizeSchema, ResolvedSchemaValidation, ValidatedResolvedSchema, SchemaConversionResult, resolvedSchemaToGeneratedSchema and assertResolvedSchemaToGeneratedSchema. Removed from @dbsp/cli: generateManifest and its manifest types. The exported name SchemaColumnType now refers to the IR column-type union, which is wider than the legacy DSL union it used to name — it gains number and datetime. Define schemas with schema() and ref() from @dbsp/core.

### Features

* **core:** Remove the legacy defineSchema and GeneratedSchema surface ([#312](https://github.com/oorabona/db-semantic-planner/issues/312)) ([f743b28](https://github.com/oorabona/db-semantic-planner/commit/f743b289200444e65e28bb6840df012d59710078))


### Bug Fixes

* **mcp-server:** Accept the same schema format as the CLI ([#311](https://github.com/oorabona/db-semantic-planner/issues/311)) ([b25fed4](https://github.com/oorabona/db-semantic-planner/commit/b25fed40fbda2e19e114b6981bc133c070322ae0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 2.0.0
    * @dbsp/types bumped to 2.0.0

## [1.0.18](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.17...mcp-server-v1.0.18) (2026-07-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.11.1

## [1.0.17](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.16...mcp-server-v1.0.17) (2026-07-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.11.0

## [1.0.16](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.15...mcp-server-v1.0.16) (2026-07-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.10.1

## [1.0.15](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.14...mcp-server-v1.0.15) (2026-07-06)


### Bug Fixes

* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.10.0

## [1.0.14](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.13...mcp-server-v1.0.14) (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.9.0

## [1.0.13](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.12...mcp-server-v1.0.13) (2026-07-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.8.0

## [1.0.12](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.11...mcp-server-v1.0.12) (2026-07-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.7.1

## [1.0.11](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.10...mcp-server-v1.0.11) (2026-07-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.7.0

## [1.0.10](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.9...mcp-server-v1.0.10) (2026-06-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.6.0

## [1.0.9](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.8...mcp-server-v1.0.9) (2026-06-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.5.0

## [1.0.8](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.7...mcp-server-v1.0.8) (2026-06-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.4.0

## [1.0.7](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.6...mcp-server-v1.0.7) (2026-06-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.3.0

## [1.0.6](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.5...mcp-server-v1.0.6) (2026-06-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.2.0

## [1.0.5](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.4...mcp-server-v1.0.5) (2026-06-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.1.0

## [1.0.4](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.3...mcp-server-v1.0.4) (2026-06-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.5

## [1.0.3](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.2...mcp-server-v1.0.3) (2026-06-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.4

## [1.0.2](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.1...mcp-server-v1.0.2) (2026-06-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.3

## [1.0.1](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v1.0.0...mcp-server-v1.0.1) (2026-06-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.2
