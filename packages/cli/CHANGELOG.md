# Changelog

## [3.0.1](https://github.com/oorabona/db-semantic-planner/compare/cli-v3.0.0...cli-v3.0.1) (2026-09-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 5.0.0

## [3.0.0](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.2.0...cli-v3.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** SequenceIR and schema DSL sequence fields (startWith, incrementBy, minValue, maxValue) accept number | string; strict decimal strings carry exact int64 values.
* **adapter-pgsql:** dbsp push and dbsp migrate removed. Use apply <run-id> to execute recorded plans or apply for unrecorded intents. CLI version 3.0.0.

### Features

* **adapter-pgsql:** Address-free v3 postconditions with explicit target binding ([#665](https://github.com/oorabona/db-semantic-planner/issues/665)) ([aa5daa8](https://github.com/oorabona/db-semantic-planner/commit/aa5daa899cc95640d92a90ebb3b4217b1e34a426))
* **adapter-pgsql:** Canonical payload digests and exact int64 sequence contracts ([#672](https://github.com/oorabona/db-semantic-planner/issues/672)) ([afa6d24](https://github.com/oorabona/db-semantic-planner/commit/afa6d24f6902cd68ced15e02aefe737ad4cc362a))
* **adapter-pgsql:** Managed-state ledger delivery 2 — admission, recovery, destructive authority ([#516](https://github.com/oorabona/db-semantic-planner/issues/516)) ([d5979c0](https://github.com/oorabona/db-semantic-planner/commit/d5979c0d7184ffb8b66ca4f9ddc1b148dd2c22b9))
* **cli:** Let dbsp generate ddl target a PostgreSQL version ([#482](https://github.com/oorabona/db-semantic-planner/issues/482)) ([477544b](https://github.com/oorabona/db-semantic-planner/commit/477544bc9d9daf0fa71385a95e4c41ef9fb82833)), closes [#468](https://github.com/oorabona/db-semantic-planner/issues/468)
* **core:** Execute a reviewed plan against a target it can prove is the one ([#479](https://github.com/oorabona/db-semantic-planner/issues/479)) ([e89f2be](https://github.com/oorabona/db-semantic-planner/commit/e89f2bee7206aeb4f21e8b06adde18aa984beb58)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)


### Bug Fixes

* **adapter-pgsql:** Defaults compare in the server representation and serial defaults are expected ([fcb9fb1](https://github.com/oorabona/db-semantic-planner/commit/fcb9fb16d6ee92617e86d480eef59764c823759f)), closes [#566](https://github.com/oorabona/db-semantic-planner/issues/566)
* **adapter-pgsql:** Emit CREATE INDEX without IF NOT EXISTS ([#483](https://github.com/oorabona/db-semantic-planner/issues/483)) ([b1c1863](https://github.com/oorabona/db-semantic-planner/commit/b1c1863a30b8944b687f63b4213700ad1b9702ec)), closes [#419](https://github.com/oorabona/db-semantic-planner/issues/419)
* **adapter-pgsql:** Ledger recovery outcomes are explicit, attempt-bound, and session-safe ([#548](https://github.com/oorabona/db-semantic-planner/issues/548)) ([0bab857](https://github.com/oorabona/db-semantic-planner/commit/0bab857d2434f88234ce07cb105fdcb7852202e1))
* **adapter-pgsql:** One adapter home for the v2 decoder and a table proof refusing contradictions ([#573](https://github.com/oorabona/db-semantic-planner/issues/573)) ([50eece0](https://github.com/oorabona/db-semantic-planner/commit/50eece0a5ac6930730728fb2af0f5b93b329c113))
* **adapter-pgsql:** Postconditions are structural catalogue proofs, not rendered-text comparison ([#565](https://github.com/oorabona/db-semantic-planner/issues/565)) ([b67dbb2](https://github.com/oorabona/db-semantic-planner/commit/b67dbb2ca9b49416676e1882456aa31e66a8ca51))
* **adapter-pgsql:** Reinitialize, index read-back, and key-list verification hardening ([#560](https://github.com/oorabona/db-semantic-planner/issues/560)) ([31e0e55](https://github.com/oorabona/db-semantic-planner/commit/31e0e55bfcd014ccd7837384308678f6590395c2))
* **adapter-pgsql:** Session revocation is one core-owned latch per physical client ([#555](https://github.com/oorabona/db-semantic-planner/issues/555)) ([f115b95](https://github.com/oorabona/db-semantic-planner/commit/f115b953f2cce283d8b316dc25042fd4aa9b66d0))
* **cli:** Every read-back proves the object kind and decodes its projection strictly ([#598](https://github.com/oorabona/db-semantic-planner/issues/598)) ([a7c1164](https://github.com/oorabona/db-semantic-planner/commit/a7c1164de818e8eb11884fc0b2c60df4882c8915))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 4.0.0
    * @dbsp/core bumped to 4.0.0
    * @dbsp/nql bumped to 1.10.4
    * @dbsp/types bumped to 4.0.0

## [2.2.0](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.1.4...cli-v2.2.0) (2026-07-31)


### Features

* **adapter-pgsql:** Let PostgreSQL canonicalise column defaults so they converge ([#427](https://github.com/oorabona/db-semantic-planner/issues/427)) ([e49104e](https://github.com/oorabona/db-semantic-planner/commit/e49104e81a98952f1c87efa4a67e65290b28581f)), closes [#382](https://github.com/oorabona/db-semantic-planner/issues/382)
* **adapter-pgsql:** Make a recorded plan describe a target it can identify ([#435](https://github.com/oorabona/db-semantic-planner/issues/435)) ([5217c4a](https://github.com/oorabona/db-semantic-planner/commit/5217c4ab3491f0a54aa2878adeca50383e47273e)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **cli:** Compute a transition plan and make it durable before anything runs ([#432](https://github.com/oorabona/db-semantic-planner/issues/432)) ([50beccf](https://github.com/oorabona/db-semantic-planner/commit/50beccfca3393c542f259b7b5ff8c4d82364102d)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.4.0
    * @dbsp/core bumped to 3.4.0
    * @dbsp/nql bumped to 1.10.3
    * @dbsp/types bumped to 3.4.0

## [2.1.4](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.1.3...cli-v2.1.4) (2026-07-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.3.0
    * @dbsp/core bumped to 3.3.0
    * @dbsp/nql bumped to 1.10.2
    * @dbsp/types bumped to 3.3.0

## [2.1.3](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.1.2...cli-v2.1.3) (2026-07-26)


### Bug Fixes

* **deps:** One catalog for every dependency range, enforced at source and in the tarball ([#398](https://github.com/oorabona/db-semantic-planner/issues/398)) ([7db9979](https://github.com/oorabona/db-semantic-planner/commit/7db9979b82315f1348024d1a9de71e5022a3c3c7))


### Peer requirements

* **`pg` must now be `>=8.21.0`.** The declared peer range narrows from `^8.16.0`
  to `^8.21.0`. On pg 8.16–8.20 you will see an unmet-peer warning, and an error
  under `strict-peer-dependencies`.
* The floor is not a preference: `@dbsp/adapter-pgsql` reads a field pg only
  started recording in 8.21, and without it `orm.inTransaction` reports `true`
  for an idle borrowed connection. The old range promised support the code could
  not deliver.

### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.2.2

## [2.1.2](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.1.1...cli-v2.1.2) (2026-07-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.2.1

## [2.1.1](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.1.0...cli-v2.1.1) (2026-07-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.2.0
    * @dbsp/core bumped to 3.2.0
    * @dbsp/nql bumped to 1.10.1
    * @dbsp/types bumped to 3.2.0

## [2.1.0](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.0.1...cli-v2.1.0) (2026-07-20)


### Features

* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)


### Bug Fixes

* **cli:** Make the migration-integrity guards real, by making the code reachable ([#339](https://github.com/oorabona/db-semantic-planner/issues/339)) ([df46c05](https://github.com/oorabona/db-semantic-planner/commit/df46c057c96a00762c0df13207f8b14d8d7df823))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.1.0
    * @dbsp/core bumped to 3.1.0
    * @dbsp/nql bumped to 1.10.0
    * @dbsp/types bumped to 3.1.0

## [2.0.1](https://github.com/oorabona/db-semantic-planner/compare/cli-v2.0.0...cli-v2.0.1) (2026-07-14)


### Bug Fixes

* **adapter-pgsql:** Let PostgreSQL canonicalise CHECK expressions so migrations converge ([#335](https://github.com/oorabona/db-semantic-planner/issues/335)) ([5cbed9c](https://github.com/oorabona/db-semantic-planner/commit/5cbed9c663afec724a62f738429f67287ec8e44a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 3.0.0
    * @dbsp/core bumped to 3.0.0
    * @dbsp/nql bumped to 1.9.5
    * @dbsp/types bumped to 3.0.0

## [2.0.0](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.11...cli-v2.0.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** Removed the deprecated exports. From @dbsp/adapter-pgsql: acquireMigrationLock and releaseMigrationLock — use withMigrationLock, which holds and releases the lock on a single connection. From @dbsp/cli: generateSchemaFile and the deprecated warnings option on its codegen interface — use generateSchemaFileWithDiagnostics, which returns the generated code together with every warning, so no diagnostic can be lost silently. From @dbsp/types: the ScalarSubqueryIntent alias — use QueryIntent. The string-based orm.select('table') is NOT deprecated and is not going anywhere.
* **core:** The legacy schema surface is gone. Removed from @dbsp/core: defineSchema, ResolvedSchema and its Schema* definition types, isBelongsTo, isHasMany, isManyToMany, DEFAULT_CONVENTIONS, detectForeignKeys, detectManyToMany, inferRelationsFromSchema, OrmOptionsWithSchema, GeneratedSchema and its Generated* types, ColumnTypeToTS, InferRowType, InferDBFromSchema, buildModelFromSchema, buildModelFromResolvedSchema, isGeneratedSchema, isResolvedSchema, normalizeSchema, ResolvedSchemaValidation, ValidatedResolvedSchema, SchemaConversionResult, resolvedSchemaToGeneratedSchema and assertResolvedSchemaToGeneratedSchema. Removed from @dbsp/cli: generateManifest and its manifest types. The exported name SchemaColumnType now refers to the IR column-type union, which is wider than the legacy DSL union it used to name — it gains number and datetime. Define schemas with schema() and ref() from @dbsp/core.

### Features

* **adapter-pgsql:** Drop the deprecated surface, and prove orm.from() works ([#316](https://github.com/oorabona/db-semantic-planner/issues/316)) ([c3f4871](https://github.com/oorabona/db-semantic-planner/commit/c3f48719bd1ca10877561da6faa2acecbe9ba684))
* **core:** Remove the legacy defineSchema and GeneratedSchema surface ([#312](https://github.com/oorabona/db-semantic-planner/issues/312)) ([f743b28](https://github.com/oorabona/db-semantic-planner/commit/f743b289200444e65e28bb6840df012d59710078))


### Bug Fixes

* **cli:** Keep the database's indexes when regenerating a schema ([#306](https://github.com/oorabona/db-semantic-planner/issues/306)) ([7dcfaad](https://github.com/oorabona/db-semantic-planner/commit/7dcfaadf22b88f2c7f92cd38e973fa489f6ad772))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 2.0.0
    * @dbsp/core bumped to 2.0.0
    * @dbsp/nql bumped to 1.9.4
    * @dbsp/types bumped to 2.0.0

## [1.1.11](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.10...cli-v1.1.11) (2026-07-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.11.2

## [1.1.10](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.9...cli-v1.1.10) (2026-07-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.11.1
    * @dbsp/core bumped to 1.11.1

## [1.1.9](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.8...cli-v1.1.9) (2026-07-09)


### Bug Fixes

* **cli:** Emit cross-schema single-column FKs as loadable table-level constraints ([48d22b3](https://github.com/oorabona/db-semantic-planner/commit/48d22b3336159c76405a658160d583774a79595b)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **cli:** Handle alter_column_unique drift and serialize FK referenced schema ([2914115](https://github.com/oorabona/db-semantic-planner/commit/29141159653d812581ec82ea6b421f68f8dbdbe6)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.11.0
    * @dbsp/core bumped to 1.11.0
    * @dbsp/nql bumped to 1.9.3
    * @dbsp/types bumped to 1.9.0

## [1.1.8](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.7...cli-v1.1.8) (2026-07-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.10.2

## [1.1.7](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.6...cli-v1.1.7) (2026-07-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.10.1
    * @dbsp/core bumped to 1.10.1
    * @dbsp/nql bumped to 1.9.2
    * @dbsp/types bumped to 1.8.1

## [1.1.6](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.5...cli-v1.1.6) (2026-07-06)


### Bug Fixes

* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.10.0
    * @dbsp/core bumped to 1.10.0
    * @dbsp/nql bumped to 1.9.1
    * @dbsp/types bumped to 1.8.0

## [1.1.5](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.4...cli-v1.1.5) (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.9.0
    * @dbsp/core bumped to 1.9.0

## [1.1.4](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.3...cli-v1.1.4) (2026-07-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.8.2
    * @dbsp/core bumped to 1.8.0
    * @dbsp/nql bumped to 1.9.0

## [1.1.3](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.2...cli-v1.1.3) (2026-07-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.8.1
    * @dbsp/core bumped to 1.7.1
    * @dbsp/nql bumped to 1.8.1
    * @dbsp/types bumped to 1.7.1

## [1.1.2](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.1...cli-v1.1.2) (2026-07-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.8.0
    * @dbsp/core bumped to 1.7.0
    * @dbsp/nql bumped to 1.8.0
    * @dbsp/types bumped to 1.7.0

## [1.1.1](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.1.0...cli-v1.1.1) (2026-06-20)


### Bug Fixes

* **cli:** Make destructive-rollback guard fail-safe and metadata-driven ([#210](https://github.com/oorabona/db-semantic-planner/issues/210)) ([0aa6b61](https://github.com/oorabona/db-semantic-planner/commit/0aa6b613422d8a8f302279ca22008a8b8400ac84)), closes [#155](https://github.com/oorabona/db-semantic-planner/issues/155)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.7.0
    * @dbsp/core bumped to 1.6.0
    * @dbsp/nql bumped to 1.7.0
    * @dbsp/types bumped to 1.6.0

## [1.1.0](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.10...cli-v1.1.0) (2026-06-20)


### Features

* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.6.0
    * @dbsp/core bumped to 1.5.0
    * @dbsp/nql bumped to 1.6.0
    * @dbsp/types bumped to 1.5.0

## [1.0.10](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.9...cli-v1.0.10) (2026-06-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.5.0
    * @dbsp/core bumped to 1.4.0
    * @dbsp/nql bumped to 1.5.0
    * @dbsp/types bumped to 1.4.0

## [1.0.9](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.8...cli-v1.0.9) (2026-06-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.4.0
    * @dbsp/core bumped to 1.3.0
    * @dbsp/nql bumped to 1.4.0
    * @dbsp/types bumped to 1.3.0

## [1.0.8](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.7...cli-v1.0.8) (2026-06-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.3.0
    * @dbsp/core bumped to 1.2.0
    * @dbsp/nql bumped to 1.3.0
    * @dbsp/types bumped to 1.2.0

## [1.0.7](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.6...cli-v1.0.7) (2026-06-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.2.1

## [1.0.6](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.5...cli-v1.0.6) (2026-06-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.2.0
    * @dbsp/core bumped to 1.1.0
    * @dbsp/nql bumped to 1.2.0
    * @dbsp/types bumped to 1.1.0

## [1.0.5](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.4...cli-v1.0.5) (2026-06-10)


### Bug Fixes

* **cli:** Correctness sweep — batch exit code, introspect interop, FK escape ([a2ab2fb](https://github.com/oorabona/db-semantic-planner/commit/a2ab2fb6589d385c71c125e5fff9645b0257ac56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.1.1
    * @dbsp/core bumped to 1.0.5
    * @dbsp/nql bumped to 1.1.0

## [1.0.4](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.3...cli-v1.0.4) (2026-06-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.1.0
    * @dbsp/core bumped to 1.0.4
    * @dbsp/nql bumped to 1.0.4
    * @dbsp/types bumped to 1.0.3

## [1.0.3](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.2...cli-v1.0.3) (2026-06-04)


### Bug Fixes

* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.0.3
    * @dbsp/core bumped to 1.0.3
    * @dbsp/nql bumped to 1.0.3
    * @dbsp/types bumped to 1.0.2

## [1.0.2](https://github.com/oorabona/db-semantic-planner/compare/cli-v1.0.1...cli-v1.0.2) (2026-06-04)


### Bug Fixes

* Launch-gating correctness & injection-hardening for 1.0.2 ([#135](https://github.com/oorabona/db-semantic-planner/issues/135)) ([cbcd22e](https://github.com/oorabona/db-semantic-planner/commit/cbcd22e2e105b9bb86a4496733442d70d05a28cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 1.0.2
    * @dbsp/core bumped to 1.0.2
    * @dbsp/nql bumped to 1.0.2
