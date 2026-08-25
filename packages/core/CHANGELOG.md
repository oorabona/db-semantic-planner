# Changelog

## [4.0.0](https://github.com/oorabona/db-semantic-planner/compare/core-v3.4.0...core-v4.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** replayInvalidatedPlans is accepted only by pool-owning adapter constructors; borrowed-client and compile-only constructors reject it.
* **adapter-pgsql:** SequenceIR and schema DSL sequence fields (startWith, incrementBy, minValue, maxValue) accept number | string; strict decimal strings carry exact int64 values.
* **adapter-pgsql:** dbsp push and dbsp migrate removed. Use apply <run-id> to execute recorded plans or apply for unrecorded intents. CLI version 3.0.0.

### Features

* **adapter-pgsql:** Canonical payload digests and exact int64 sequence contracts ([#672](https://github.com/oorabona/db-semantic-planner/issues/672)) ([afa6d24](https://github.com/oorabona/db-semantic-planner/commit/afa6d24f6902cd68ced15e02aefe737ad4cc362a))
* **adapter-pgsql:** Managed-state ledger delivery 2 — admission, recovery, destructive authority ([#516](https://github.com/oorabona/db-semantic-planner/issues/516)) ([d5979c0](https://github.com/oorabona/db-semantic-planner/commit/d5979c0d7184ffb8b66ca4f9ddc1b148dd2c22b9))
* **core:** Execute a reviewed plan against a target it can prove is the one ([#479](https://github.com/oorabona/db-semantic-planner/issues/479)) ([e89f2be](https://github.com/oorabona/db-semantic-planner/commit/e89f2bee7206aeb4f21e8b06adde18aa984beb58)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Mutations are keyed by the schema and their payloads are typed by the table ([#652](https://github.com/oorabona/db-semantic-planner/issues/652)) ([ce7b8f1](https://github.com/oorabona/db-semantic-planner/commit/ce7b8f1939101119e82d4c386ead2a168b0e4091))
* **core:** Observers observe, transformers preserve, and the execution port stops lying ([#645](https://github.com/oorabona/db-semantic-planner/issues/645)) ([0720c01](https://github.com/oorabona/db-semantic-planner/commit/0720c0179a13f09a54829efb672969f3c1ae7b76))
* **core:** Where() accepts branded predicates and rejects every other expression ([#635](https://github.com/oorabona/db-semantic-planner/issues/635)) ([5f8fceb](https://github.com/oorabona/db-semantic-planner/commit/5f8fceb78e249f1e2b2c3f079f46b595b44858b7))


### Bug Fixes

* **adapter-pgsql:** Emit CREATE INDEX without IF NOT EXISTS ([#483](https://github.com/oorabona/db-semantic-planner/issues/483)) ([b1c1863](https://github.com/oorabona/db-semantic-planner/commit/b1c1863a30b8944b687f63b4213700ad1b9702ec)), closes [#419](https://github.com/oorabona/db-semantic-planner/issues/419)
* **adapter-pgsql:** Identity-bound quarantine, faithful replay, exact sequence introspection ([#677](https://github.com/oorabona/db-semantic-planner/issues/677)) ([9c64e05](https://github.com/oorabona/db-semantic-planner/commit/9c64e05b62b72bc752bc72571c97d951f8a9abdb))
* **adapter-pgsql:** Ledger recovery outcomes are explicit, attempt-bound, and session-safe ([#548](https://github.com/oorabona/db-semantic-planner/issues/548)) ([0bab857](https://github.com/oorabona/db-semantic-planner/commit/0bab857d2434f88234ce07cb105fdcb7852202e1))
* **adapter-pgsql:** Session revocation is one core-owned latch per physical client ([#555](https://github.com/oorabona/db-semantic-planner/issues/555)) ([f115b95](https://github.com/oorabona/db-semantic-planner/commit/f115b953f2cce283d8b316dc25042fd4aa9b66d0))
* **core:** Leave a run pristine when a step is refused before any DDL ([#487](https://github.com/oorabona/db-semantic-planner/issues/487)) ([ca1501e](https://github.com/oorabona/db-semantic-planner/commit/ca1501e3b21117f685f7b97390a5b16ef6bbf6db)), closes [#476](https://github.com/oorabona/db-semantic-planner/issues/476) [#485](https://github.com/oorabona/db-semantic-planner/issues/485)
* **core:** Reminted lessors carry the source revocation capability across module instances ([#591](https://github.com/oorabona/db-semantic-planner/issues/591)) ([b730e94](https://github.com/oorabona/db-semantic-planner/commit/b730e949de83dfbd140684360f0ec2e14c55820b))
* **core:** The typed path infers the row type and IndexMethod matches the runtime allowlist ([#622](https://github.com/oorabona/db-semantic-planner/issues/622)) ([72b8878](https://github.com/oorabona/db-semantic-planner/commit/72b8878657f9da8e338cd10a79ae5125e7220cd5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.10.4
    * @dbsp/types bumped to 4.0.0

## [3.4.0](https://github.com/oorabona/db-semantic-planner/compare/core-v3.3.0...core-v3.4.0) (2026-07-31)


### Features

* **adapter-pgsql:** Make a recorded plan describe a target it can identify ([#435](https://github.com/oorabona/db-semantic-planner/issues/435)) ([5217c4a](https://github.com/oorabona/db-semantic-planner/commit/5217c4ab3491f0a54aa2878adeca50383e47273e)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **cli:** Compute a transition plan and make it durable before anything runs ([#432](https://github.com/oorabona/db-semantic-planner/issues/432)) ([50beccf](https://github.com/oorabona/db-semantic-planner/commit/50beccfca3393c542f259b7b5ff8c4d82364102d)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Make a transition run's proven plan durable ([#416](https://github.com/oorabona/db-semantic-planner/issues/416)) ([acaa1b1](https://github.com/oorabona/db-semantic-planner/commit/acaa1b1f6cb4c3bf5cc9f824e69a531e2c62f592)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)


### Bug Fixes

* **adapter-pgsql:** Expose full connectionless adapter ([#436](https://github.com/oorabona/db-semantic-planner/issues/436)) ([#440](https://github.com/oorabona/db-semantic-planner/issues/440)) ([53336bd](https://github.com/oorabona/db-semantic-planner/commit/53336bdb5fb0e877f0551655d69c01bfbeba89d8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.10.3
    * @dbsp/types bumped to 3.4.0

## [3.3.0](https://github.com/oorabona/db-semantic-planner/compare/core-v3.2.0...core-v3.3.0) (2026-07-27)


### Features

* **core:** Declare the transition target instead of guessing it ([#408](https://github.com/oorabona/db-semantic-planner/issues/408)) ([ea11e5b](https://github.com/oorabona/db-semantic-planner/commit/ea11e5b3b845b96512cf721eb6339cb902cd5911))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.10.2
    * @dbsp/types bumped to 3.3.0

## [3.2.0](https://github.com/oorabona/db-semantic-planner/compare/core-v3.1.0...core-v3.2.0) (2026-07-22)


### Features

* **adapter-pgsql:** Abort a pool-owned transaction via AbortSignal ([#363](https://github.com/oorabona/db-semantic-planner/issues/363)) ([#369](https://github.com/oorabona/db-semantic-planner/issues/369)) ([e61d4b5](https://github.com/oorabona/db-semantic-planner/commit/e61d4b58ec1790b86497fd8d8fb15e7ca1aabc07))
* **adapter-pgsql:** Add transaction isolation, access mode & timeouts ([#360](https://github.com/oorabona/db-semantic-planner/issues/360), [#361](https://github.com/oorabona/db-semantic-planner/issues/361)) ([#368](https://github.com/oorabona/db-semantic-planner/issues/368)) ([74cc335](https://github.com/oorabona/db-semantic-planner/commit/74cc33511d7e501b7bea8915e68bf8955ec9efc4))
* **adapter-pgsql:** Add withPinnedConnection for a bounded pinned-connection scope ([#341](https://github.com/oorabona/db-semantic-planner/issues/341)) ([#373](https://github.com/oorabona/db-semantic-planner/issues/373)) ([c1bdc7d](https://github.com/oorabona/db-semantic-planner/commit/c1bdc7d9e8a5e3388f86264b292a7849a61f659b))
* **adapter-pgsql:** Apply isolation and timeout options to the streaming BEGIN ([#364](https://github.com/oorabona/db-semantic-planner/issues/364)) ([#372](https://github.com/oorabona/db-semantic-planner/issues/372)) ([6dbf579](https://github.com/oorabona/db-semantic-planner/commit/6dbf57970733848bf5689725040fa6888af940fd))
* **adapter-pgsql:** Make schema a required argument on the DDL generator port ([#331](https://github.com/oorabona/db-semantic-planner/issues/331)) ([#375](https://github.com/oorabona/db-semantic-planner/issues/375)) ([d106f9e](https://github.com/oorabona/db-semantic-planner/commit/d106f9e0534cf0a70215f0f6d562f596ba64514b))
* **core:** Expose inTransaction on OrmInstance ([#377](https://github.com/oorabona/db-semantic-planner/issues/377)) ([e843ac6](https://github.com/oorabona/db-semantic-planner/commit/e843ac6c959fda6a8d152f5b9b44ecc04ac6e5bc)), closes [#376](https://github.com/oorabona/db-semantic-planner/issues/376)
* **core:** Expose mutation rowCount via affectedRows() and executeWithMeta ([#362](https://github.com/oorabona/db-semantic-planner/issues/362)) ([#366](https://github.com/oorabona/db-semantic-planner/issues/366)) ([3ee7575](https://github.com/oorabona/db-semantic-planner/commit/3ee75752ef15a8c90e01903c1ad57fa3a2979b54))
* **core:** Opt-in explicit-provenance bigint coercion for orm.raw() ([#359](https://github.com/oorabona/db-semantic-planner/issues/359)) ([#371](https://github.com/oorabona/db-semantic-planner/issues/371)) ([1c1fc10](https://github.com/oorabona/db-semantic-planner/commit/1c1fc1015513131e33aad77165e83c1962ec908a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.10.1
    * @dbsp/types bumped to 3.2.0

## [3.1.0](https://github.com/oorabona/db-semantic-planner/compare/core-v3.0.0...core-v3.1.0) (2026-07-20)


### Features

* **adapter-pgsql:** Version-gate index features via ADR-0003 capability model ([#349](https://github.com/oorabona/db-semantic-planner/issues/349)) ([618f07b](https://github.com/oorabona/db-semantic-planner/commit/618f07b69968b988a005627568b8da6f9bc27937)), closes [#245](https://github.com/oorabona/db-semantic-planner/issues/245)
* **core:** ADR-0003 rule-based schema-transition planner ([#348](https://github.com/oorabona/db-semantic-planner/issues/348)) ([6d41829](https://github.com/oorabona/db-semantic-planner/commit/6d418299f6a9700298aa67bbde56ac91ea42e268))
* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)
* **types:** Make CompiledQuery a constructor-only, runtime-branded capability ([#356](https://github.com/oorabona/db-semantic-planner/issues/356)) ([421ae11](https://github.com/oorabona/db-semantic-planner/commit/421ae113d52a71a96fb0be9efc0819ce75f78c4b)), closes [#353](https://github.com/oorabona/db-semantic-planner/issues/353)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.10.0
    * @dbsp/types bumped to 3.1.0

## [3.0.0](https://github.com/oorabona/db-semantic-planner/compare/core-v2.0.0...core-v3.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** dbsp no longer savepoints each statement inside a transaction it opened. PostgreSQL's own semantics stand — a failed statement poisons the transaction. 2.0.0 rolled back the one statement and committed the rest, turning a fail-closed database error into a durable partial business transaction; catching an error inside `transaction()` and continuing no longer works, and that is the point. A nested `transaction()` that was never awaited is refused rather than guessed about. `inTransaction` and `supportsTransactions` are now required members of the adapter contract: an adapter that cannot state whether a transaction is open is one dbsp will not run concurrent DDL through. A `PoolClient` must be declared with `borrowedClient: true`, and `introspect()` takes a `Pool`.

### Features

* **adapter-pgsql:** The caller declares who owns the connection ([#330](https://github.com/oorabona/db-semantic-planner/issues/330)) ([8077cd2](https://github.com/oorabona/db-semantic-planner/commit/8077cd249452ca30ac003dbb4470d1002397e89a)), closes [#325](https://github.com/oorabona/db-semantic-planner/issues/325)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.9.5
    * @dbsp/types bumped to 3.0.0

## [2.0.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.11.1...core-v2.0.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* **core:** Adapters must declare `capabilities.supportsTransactions: true` for `orm.transaction()` to delegate to `transaction()`. Core no longer infers transaction support from method presence. Adapters that execute DDL must also expose `inTransaction: boolean`; transaction-sensitive DDL such as `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` is refused when that state is missing.
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
    * @dbsp/nql bumped to 1.9.4
    * @dbsp/types bumped to 2.0.0

## [1.11.1](https://github.com/oorabona/db-semantic-planner/compare/core-v1.11.0...core-v1.11.1) (2026-07-09)


### Bug Fixes

* **core:** Expose TableDDL helpers on orm.tables[] type ([cfac331](https://github.com/oorabona/db-semantic-planner/commit/cfac33166c0ffb43db88828526749b12837b2737))
* **core:** Remove PostgreSQL-specific index-list fallback from DB-agnostic core ([e742ae0](https://github.com/oorabona/db-semantic-planner/commit/e742ae05c9bf91a5bf78ec7bfed18ccb02a2dc10))

## [1.11.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.10.1...core-v1.11.0) (2026-07-09)


### Features

* **core:** Thread FK referenced schema through the schema DSL ([887cad0](https://github.com/oorabona/db-semantic-planner/commit/887cad0f3e7d3b1913a07d6789ca7a7a314319b9)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)


### Bug Fixes

* **core:** Allow SET DEFAULT foreign-key actions in generated and manifest schemas ([fcb95c4](https://github.com/oorabona/db-semantic-planner/commit/fcb95c48545f607ba8d8e4b1fb060a93da5bd425)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Keep local FK validation for external targets, reject uninferable external column type ([7775c80](https://github.com/oorabona/db-semantic-planner/commit/7775c80969529932a66e1dd80a7dee98f98ea5f3)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Preserve referenced columns and FK actions for same-schema FK round-trip ([3e3f814](https://github.com/oorabona/db-semantic-planner/commit/3e3f8141a523263ecb6f40fb9ba0743193edd44f)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Round-trip composite cross-schema foreign keys in getSchemaFromDb ([b99e2c9](https://github.com/oorabona/db-semantic-planner/commit/b99e2c902da49cc917d58871f9ca7fd883606af1)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Support foreign keys to external cross-schema tables ([e5908d5](https://github.com/oorabona/db-semantic-planner/commit/e5908d5fccb0245c084326fc8685099404f821b7)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Type Schema.constraints and keep full FK metadata in getSchemaFromDb round-trip ([ee0c8f9](https://github.com/oorabona/db-semantic-planner/commit/ee0c8f95073b3dc65b0a9d79bb03f5e1d8c80dbd)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Validate cross-schema FKs by declaration, exclude them from relation inference ([72bbf5a](https://github.com/oorabona/db-semantic-planner/commit/72bbf5aceea0fe9aabe40774389ae3b75bf892ac)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.9.3
    * @dbsp/types bumped to 1.9.0

## [1.10.1](https://github.com/oorabona/db-semantic-planner/compare/core-v1.10.0...core-v1.10.1) (2026-07-07)


### Bug Fixes

* **adapter-pgsql:** Propagate DISTINCT flag through aggregate compilation ([f6dc756](https://github.com/oorabona/db-semantic-planner/commit/f6dc756f9d5f1eb63e35ff82fbf06409fa413614))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.9.2
    * @dbsp/types bumped to 1.8.1

## [1.10.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.9.0...core-v1.10.0) (2026-07-06)


### Features

* **core:** Support nulls-not-distinct indexes and external table refs ([be02788](https://github.com/oorabona/db-semantic-planner/commit/be027887d4e103cf904a755333c8451122c0390c))


### Bug Fixes

* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.9.1
    * @dbsp/types bumped to 1.8.0

## [1.9.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.8.0...core-v1.9.0) (2026-07-06)


### Features

* **core:** Add ergonomic control over DX warnings ([#237](https://github.com/oorabona/db-semantic-planner/issues/237)) ([21c3d3b](https://github.com/oorabona/db-semantic-planner/commit/21c3d3b0c05796591a30660c8c5c3fe99391db46)), closes [#159](https://github.com/oorabona/db-semantic-planner/issues/159)


### Bug Fixes

* **core:** Keep every include in .exists() so filters and multiplicity survive ([#241](https://github.com/oorabona/db-semantic-planner/issues/241)) ([d9812950c0bc798e0856f6a33ee44fbdc393c60c](https://github.com/oorabona/db-semantic-planner/commit/d9812950c0bc798e0856f6a33ee44fbdc393c60c)), closes [#230](https://github.com/oorabona/db-semantic-planner/issues/230)

## [1.8.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.7.1...core-v1.8.0) (2026-07-03)


### Features

* **nql:** Accept aliased mutation-RETURNING columns as typed read-bind snapshot sources ([#222](https://github.com/oorabona/db-semantic-planner/issues/222)) ([267936b](https://github.com/oorabona/db-semantic-planner/commit/267936bd04a26a80672ae19ad20a6bfbfffd9188))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.9.0

## [1.7.1](https://github.com/oorabona/db-semantic-planner/compare/core-v1.7.0...core-v1.7.1) (2026-07-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.8.1
    * @dbsp/types bumped to 1.7.1

## [1.7.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.6.0...core-v1.7.0) (2026-07-02)


### Features

* **nql:** Generalize read-bind snapshots to aliased, transitive, and count columns ([#218](https://github.com/oorabona/db-semantic-planner/issues/218)) ([0b4b315](https://github.com/oorabona/db-semantic-planner/commit/0b4b315a17427f358aa0f7dd076d0e1b152fdf07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.8.0
    * @dbsp/types bumped to 1.7.0

## [1.6.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.5.0...core-v1.6.0) (2026-06-20)


### Features

* **nql:** Snapshot read-only bindings referenced across an intervening mutation ([#212](https://github.com/oorabona/db-semantic-planner/issues/212)) ([00055eb](https://github.com/oorabona/db-semantic-planner/commit/00055eb6a15de86e1cd21ad01ec09b4eba76d9df)), closes [#186](https://github.com/oorabona/db-semantic-planner/issues/186)
* **nql:** Support manyToMany relation columns from a binding-final read ([#207](https://github.com/oorabona/db-semantic-planner/issues/207)) ([bf3a830](https://github.com/oorabona/db-semantic-planner/commit/bf3a830e73dcb229f6d13f5c7184d765f30a0044)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.7.0
    * @dbsp/types bumped to 1.6.0

## [1.5.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.4.0...core-v1.5.0) (2026-06-20)


### Features

* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)
* **adapter-pgsql:** Deterministically order include json_agg arrays by primary key ([#203](https://github.com/oorabona/db-semantic-planner/issues/203)) ([8e6da3a](https://github.com/oorabona/db-semantic-planner/commit/8e6da3a035c292a36ac98cf1ef18a76203ecfa51)), closes [#196](https://github.com/oorabona/db-semantic-planner/issues/196)
* **nql:** Support hasMany relation columns from a binding-final read ([#194](https://github.com/oorabona/db-semantic-planner/issues/194)) ([da0d49b](https://github.com/oorabona/db-semantic-planner/commit/da0d49b12e517e2f15676e17ef8809405cedbde2)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support include() hydration from a binding-final read ([#197](https://github.com/oorabona/db-semantic-planner/issues/197)) ([9e1a07d](https://github.com/oorabona/db-semantic-planner/commit/9e1a07da0f448474966542854cd56a2ec8da9d3a)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support multi-level include() from a binding-final read ([#198](https://github.com/oorabona/db-semantic-planner/issues/198)) ([831ddc7](https://github.com/oorabona/db-semantic-planner/commit/831ddc7360d4af30eab3ea2132b0cfea47ba279d)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support scalar multi-hop relation columns from a binding-final read ([#200](https://github.com/oorabona/db-semantic-planner/issues/200)) ([66062e3](https://github.com/oorabona/db-semantic-planner/commit/66062e3320d59540cbba4e8aeb329c2f0029ee44)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.6.0
    * @dbsp/types bumped to 1.5.0

## [1.4.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.3.0...core-v1.4.0) (2026-06-19)


### Features

* **nql:** Support relation filters from single-source binding reads ([#189](https://github.com/oorabona/db-semantic-planner/issues/189)) ([fb76c10](https://github.com/oorabona/db-semantic-planner/commit/fb76c10dc6540971524e87cae37d4f6e35df85d2)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support scalar relation columns from single-source binding reads ([#191](https://github.com/oorabona/db-semantic-planner/issues/191)) ([f6d0ad4](https://github.com/oorabona/db-semantic-planner/commit/f6d0ad4eb50101f8270ad8b78320e63fa69f8c5f)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.5.0
    * @dbsp/types bumped to 1.4.0

## [1.3.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.2.0...core-v1.3.0) (2026-06-18)


### Features

* **adapter-pgsql:** Gate NQL text surface by dialect capabilities ([#187](https://github.com/oorabona/db-semantic-planner/issues/187)) ([f536b9a](https://github.com/oorabona/db-semantic-planner/commit/f536b9a809f627007fc2586d66e87e8aa3060cd5)), closes [#183](https://github.com/oorabona/db-semantic-planner/issues/183)
* **nql:** Support binding-final tag queries ([#184](https://github.com/oorabona/db-semantic-planner/issues/184)) ([f4ccf6d](https://github.com/oorabona/db-semantic-planner/commit/f4ccf6d32a7c65afc9a1ada9506877a827f92c2a)), closes [#176](https://github.com/oorabona/db-semantic-planner/issues/176)
* **nql:** Support ordered multi-mutation tag programs ([#185](https://github.com/oorabona/db-semantic-planner/issues/185)) ([7ddebfa](https://github.com/oorabona/db-semantic-planner/commit/7ddebfa4b2c6c5f7a234c0f94e9dd98753c8074f)), closes [#173](https://github.com/oorabona/db-semantic-planner/issues/173)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.4.0
    * @dbsp/types bumped to 1.3.0

## [1.2.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.1.0...core-v1.2.0) (2026-06-16)


### Features

* **nql:** Support tagged template mutations ([#175](https://github.com/oorabona/db-semantic-planner/issues/175)) ([c78e89e](https://github.com/oorabona/db-semantic-planner/commit/c78e89e00479359f67f50a3c00edf7fdc63aec18))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.3.0
    * @dbsp/types bumped to 1.2.0

## [1.1.0](https://github.com/oorabona/db-semantic-planner/compare/core-v1.0.5...core-v1.1.0) (2026-06-12)


### Features

* **nql:** General named parameters, tag binding, and nqlRaw() ([#165](https://github.com/oorabona/db-semantic-planner/issues/165)) ([905c323](https://github.com/oorabona/db-semantic-planner/commit/905c323f6a9a907dd39a86950e746d8dd5822a61)), closes [#134](https://github.com/oorabona/db-semantic-planner/issues/134)


### Bug Fixes

* **adapter-pgsql:** Multi-path join aliasing and result hydration ([#163](https://github.com/oorabona/db-semantic-planner/issues/163)) ([130f53f](https://github.com/oorabona/db-semantic-planner/commit/130f53f0630c5655ac13f8b755f8730c22c59b41)), closes [#154](https://github.com/oorabona/db-semantic-planner/issues/154)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.2.0
    * @dbsp/types bumped to 1.1.0

## [1.0.5](https://github.com/oorabona/db-semantic-planner/compare/core-v1.0.4...core-v1.0.5) (2026-06-10)


### Bug Fixes

* **adapter-pgsql:** Validate escape-hatch and DDL token surfaces against injection ([7487b7b](https://github.com/oorabona/db-semantic-planner/commit/7487b7b0f681c51984186c91b5aef63737ae15a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.1.0

## [1.0.4](https://github.com/oorabona/db-semantic-planner/compare/core-v1.0.3...core-v1.0.4) (2026-06-05)


### ⚠ Behavior Changes

* **`exists('rel', { where })` no longer filters a sibling `.include('rel')`.** `exists('rel', { where: X }).include('rel')` now returns *all* related rows for the include (correlated on the FK only), matching standard ORM semantics — the `exists` filter applies only to the parent-row predicate. To filter the included rows, use the explicit `.include('rel', { where })` option.


### Bug Fixes

* **core:** IN-to-EXISTS done properly + inline-EXISTS refactor ([db38526](https://github.com/oorabona/db-semantic-planner/commit/db3852655e870e328a23dee3c1eb117e252474d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.0.4
    * @dbsp/types bumped to 1.0.3

## [1.0.3](https://github.com/oorabona/db-semantic-planner/compare/core-v1.0.2...core-v1.0.3) (2026-06-04)


### Bug Fixes

* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.0.3
    * @dbsp/types bumped to 1.0.2

## [1.0.2](https://github.com/oorabona/db-semantic-planner/compare/core-v1.0.1...core-v1.0.2) (2026-06-04)


### Bug Fixes

* Launch-gating correctness & injection-hardening for 1.0.2 ([#135](https://github.com/oorabona/db-semantic-planner/issues/135)) ([cbcd22e](https://github.com/oorabona/db-semantic-planner/commit/cbcd22e2e105b9bb86a4496733442d70d05a28cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.0.2
