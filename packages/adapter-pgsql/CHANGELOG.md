# Changelog

## [3.2.1](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v3.2.0...adapter-pgsql-v3.2.1) (2026-07-22)


### Bug Fixes

* **adapter-pgsql:** Any() casts by declared column type without originalDbType ([#379](https://github.com/oorabona/db-semantic-planner/issues/379)) ([66547f5](https://github.com/oorabona/db-semantic-planner/commit/66547f55bd6685f7265305e992cd412e42af01cf))

## [3.2.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v3.1.0...adapter-pgsql-v3.2.0) (2026-07-22)


### Features

* **adapter-pgsql:** Abort a pool-owned transaction via AbortSignal ([#363](https://github.com/oorabona/db-semantic-planner/issues/363)) ([#369](https://github.com/oorabona/db-semantic-planner/issues/369)) ([e61d4b5](https://github.com/oorabona/db-semantic-planner/commit/e61d4b58ec1790b86497fd8d8fb15e7ca1aabc07))
* **adapter-pgsql:** Add transaction isolation, access mode & timeouts ([#360](https://github.com/oorabona/db-semantic-planner/issues/360), [#361](https://github.com/oorabona/db-semantic-planner/issues/361)) ([#368](https://github.com/oorabona/db-semantic-planner/issues/368)) ([74cc335](https://github.com/oorabona/db-semantic-planner/commit/74cc33511d7e501b7bea8915e68bf8955ec9efc4))
* **adapter-pgsql:** Add withAdvisoryLock and route withMigrationLock through it ([#341](https://github.com/oorabona/db-semantic-planner/issues/341)) ([#378](https://github.com/oorabona/db-semantic-planner/issues/378)) ([89b2cde](https://github.com/oorabona/db-semantic-planner/commit/89b2cdef13f97f400487bb303b8a3c1d7ccf5fb3))
* **adapter-pgsql:** Add withPinnedConnection for a bounded pinned-connection scope ([#341](https://github.com/oorabona/db-semantic-planner/issues/341)) ([#373](https://github.com/oorabona/db-semantic-planner/issues/373)) ([c1bdc7d](https://github.com/oorabona/db-semantic-planner/commit/c1bdc7d9e8a5e3388f86264b292a7849a61f659b))
* **adapter-pgsql:** Apply isolation and timeout options to the streaming BEGIN ([#364](https://github.com/oorabona/db-semantic-planner/issues/364)) ([#372](https://github.com/oorabona/db-semantic-planner/issues/372)) ([6dbf579](https://github.com/oorabona/db-semantic-planner/commit/6dbf57970733848bf5689725040fa6888af940fd))
* **adapter-pgsql:** Make schema a required argument on the DDL generator port ([#331](https://github.com/oorabona/db-semantic-planner/issues/331)) ([#375](https://github.com/oorabona/db-semantic-planner/issues/375)) ([d106f9e](https://github.com/oorabona/db-semantic-planner/commit/d106f9e0534cf0a70215f0f6d562f596ba64514b))
* **core:** Expose mutation rowCount via affectedRows() and executeWithMeta ([#362](https://github.com/oorabona/db-semantic-planner/issues/362)) ([#366](https://github.com/oorabona/db-semantic-planner/issues/366)) ([3ee7575](https://github.com/oorabona/db-semantic-planner/commit/3ee75752ef15a8c90e01903c1ad57fa3a2979b54))


### Bug Fixes

* **adapter-pgsql:** Cast any(col, array) by the column's DB type, not JS values ([#347](https://github.com/oorabona/db-semantic-planner/issues/347)) ([#374](https://github.com/oorabona/db-semantic-planner/issues/374)) ([3fe7c0e](https://github.com/oorabona/db-semantic-planner/commit/3fe7c0e4748f3de130e8c65861cf183fd46a6786))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 3.2.0
    * @dbsp/types bumped to 3.2.0

## [3.1.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v3.0.0...adapter-pgsql-v3.1.0) (2026-07-20)


### Features

* **adapter-pgsql:** Version-gate index features via ADR-0003 capability model ([#349](https://github.com/oorabona/db-semantic-planner/issues/349)) ([618f07b](https://github.com/oorabona/db-semantic-planner/commit/618f07b69968b988a005627568b8da6f9bc27937)), closes [#245](https://github.com/oorabona/db-semantic-planner/issues/245)
* **core:** ADR-0003 rule-based schema-transition planner ([#348](https://github.com/oorabona/db-semantic-planner/issues/348)) ([6d41829](https://github.com/oorabona/db-semantic-planner/commit/6d418299f6a9700298aa67bbde56ac91ea42e268))
* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)
* **types:** Make CompiledQuery a constructor-only, runtime-branded capability ([#356](https://github.com/oorabona/db-semantic-planner/issues/356)) ([421ae11](https://github.com/oorabona/db-semantic-planner/commit/421ae113d52a71a96fb0be9efc0819ce75f78c4b)), closes [#353](https://github.com/oorabona/db-semantic-planner/issues/353)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 3.1.0
    * @dbsp/types bumped to 3.1.0

## [3.0.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v2.0.0...adapter-pgsql-v3.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** dbsp no longer savepoints each statement inside a transaction it opened. PostgreSQL's own semantics stand — a failed statement poisons the transaction. 2.0.0 rolled back the one statement and committed the rest, turning a fail-closed database error into a durable partial business transaction; catching an error inside `transaction()` and continuing no longer works, and that is the point. A nested `transaction()` that was never awaited is refused rather than guessed about. `inTransaction` and `supportsTransactions` are now required members of the adapter contract: an adapter that cannot state whether a transaction is open is one dbsp will not run concurrent DDL through. A `PoolClient` must be declared with `borrowedClient: true`, and `introspect()` takes a `Pool`.

### Features

* **adapter-pgsql:** The caller declares who owns the connection ([#330](https://github.com/oorabona/db-semantic-planner/issues/330)) ([8077cd2](https://github.com/oorabona/db-semantic-planner/commit/8077cd249452ca30ac003dbb4470d1002397e89a)), closes [#325](https://github.com/oorabona/db-semantic-planner/issues/325)


### Bug Fixes

* **adapter-pgsql:** Let PostgreSQL canonicalise CHECK expressions so migrations converge ([#335](https://github.com/oorabona/db-semantic-planner/issues/335)) ([5cbed9c](https://github.com/oorabona/db-semantic-planner/commit/5cbed9c663afec724a62f738429f67287ec8e44a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 3.0.0
    * @dbsp/types bumped to 3.0.0

## [2.0.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.11.2...adapter-pgsql-v2.0.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** Removed the deprecated exports. From @dbsp/adapter-pgsql: acquireMigrationLock and releaseMigrationLock — use withMigrationLock, which holds and releases the lock on a single connection. From @dbsp/cli: generateSchemaFile and the deprecated warnings option on its codegen interface — use generateSchemaFileWithDiagnostics, which returns the generated code together with every warning, so no diagnostic can be lost silently. From @dbsp/types: the ScalarSubqueryIntent alias — use QueryIntent. The string-based orm.select('table') is NOT deprecated and is not going anywhere.

### Features

* **adapter-pgsql:** Drop the deprecated surface, and prove orm.from() works ([#316](https://github.com/oorabona/db-semantic-planner/issues/316)) ([c3f4871](https://github.com/oorabona/db-semantic-planner/commit/c3f48719bd1ca10877561da6faa2acecbe9ba684))


### Bug Fixes

* **adapter-pgsql:** Correct DOWN rollback for RLS policy replacement and comment changes ([#300](https://github.com/oorabona/db-semantic-planner/issues/300)) ([9c72d13](https://github.com/oorabona/db-semantic-planner/commit/9c72d13b0050ddf255a8390ac809b0b531a4c948)), closes [#264](https://github.com/oorabona/db-semantic-planner/issues/264)
* **adapter-pgsql:** Honor fn().filter() FILTER in every expression position ([#297](https://github.com/oorabona/db-semantic-planner/issues/297)) ([d0fc7bc](https://github.com/oorabona/db-semantic-planner/commit/d0fc7bc9b516169bdabaa280259a9da1d03deb1d)), closes [#251](https://github.com/oorabona/db-semantic-planner/issues/251) [#296](https://github.com/oorabona/db-semantic-planner/issues/296)
* **adapter-pgsql:** Lower multi-hop dotted WHERE via nested EXISTS with per-hop aliases ([#295](https://github.com/oorabona/db-semantic-planner/issues/295)) ([399ab8e](https://github.com/oorabona/db-semantic-planner/commit/399ab8e37107dbd79af9a42eb89ff61f6b84cb97)), closes [#256](https://github.com/oorabona/db-semantic-planner/issues/256)
* **adapter-pgsql:** Require an explicit schemaName for schema-scoped DDL ([#305](https://github.com/oorabona/db-semantic-planner/issues/305)) ([280bb0c](https://github.com/oorabona/db-semantic-planner/commit/280bb0c7e56a15cdc23940df768b435308402072))
* **adapter-pgsql:** Resolve catalog-read schema search_path-aware, not literal 'public' ([5927878](https://github.com/oorabona/db-semantic-planner/commit/5927878517c98b2ea47932b46a79ebc6f8326435)), closes [#283](https://github.com/oorabona/db-semantic-planner/issues/283)
* **adapter-pgsql:** Schema-aware custom type identity for multi-tenant DDL ([#304](https://github.com/oorabona/db-semantic-planner/issues/304)) ([5e16d79](https://github.com/oorabona/db-semantic-planner/commit/5e16d7948d47ff4f2311043f56bf46f3a1e4c6df)), closes [#285](https://github.com/oorabona/db-semantic-planner/issues/285)
* **cli:** Keep the database's indexes when regenerating a schema ([#306](https://github.com/oorabona/db-semantic-planner/issues/306)) ([7dcfaad](https://github.com/oorabona/db-semantic-planner/commit/7dcfaadf22b88f2c7f92cd38e973fa489f6ad772))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 2.0.0
    * @dbsp/types bumped to 2.0.0

## [1.11.2](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.11.1...adapter-pgsql-v1.11.2) (2026-07-10)


### Bug Fixes

* **adapter-pgsql:** Faithful array/modifier introspection + SQL-safe catalog type rendering ([15b998b](https://github.com/oorabona/db-semantic-planner/commit/15b998b3cda5d10e692bd3fa14a076cfeb56b77d)), closes [#261](https://github.com/oorabona/db-semantic-planner/issues/261) [#262](https://github.com/oorabona/db-semantic-planner/issues/262) [#284](https://github.com/oorabona/db-semantic-planner/issues/284) [#285](https://github.com/oorabona/db-semantic-planner/issues/285) [#286](https://github.com/oorabona/db-semantic-planner/issues/286)

## [1.11.1](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.11.0...adapter-pgsql-v1.11.1) (2026-07-09)


### Bug Fixes

* **adapter-pgsql:** Thread bound params in JOIN ON and CASE THEN/ELSE expressions ([38d0461](https://github.com/oorabona/db-semantic-planner/commit/38d0461749f3cb165f08c1ed105570d0c3e92034)), closes [#267](https://github.com/oorabona/db-semantic-planner/issues/267) [#268](https://github.com/oorabona/db-semantic-planner/issues/268) [#279](https://github.com/oorabona/db-semantic-planner/issues/279)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.11.1

## [1.11.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.10.2...adapter-pgsql-v1.11.0) (2026-07-09)


### Features

* **adapter-pgsql:** Cross-schema FK references and column-unique introspection ([e65854c](https://github.com/oorabona/db-semantic-planner/commit/e65854c62b6bdd8639ccfffacc68187edcc521e9)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)


### Bug Fixes

* **adapter-pgsql:** Accept safe escaped literals in CHECK constraint validation ([a024fdf](https://github.com/oorabona/db-semantic-planner/commit/a024fdf54d9d7b0a45fd2d5c3056d2e17465c278)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Detect column-level UNIQUE changes in schema diff ([d934e57](https://github.com/oorabona/db-semantic-planner/commit/d934e57c5462f2d206908d96a57871260e97716b)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Emit FK schema verbatim and gate destructive unique down-migrations ([1cc4937](https://github.com/oorabona/db-semantic-planner/commit/1cc493761e7e8a56a2be38d0520330b4e6f246c0)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Mark unique-constraint drops destructive; key FKs by table+name ([dcca2d7](https://github.com/oorabona/db-semantic-planner/commit/dcca2d717de42b9e04c06c9b9a64efa5ef0490ae)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Reject non-string CHECK constraint expressions ([0aba1bd](https://github.com/oorabona/db-semantic-planner/commit/0aba1bd35063121b07b62657f2c15abae0c86e3c)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Reject non-string identifiers before quoting ([dbc2324](https://github.com/oorabona/db-semantic-planner/commit/dbc2324b3f702c3e49d7e2f454e03363dccc599f)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Reject non-string values across SQL expression, name and literal helpers ([39420d4](https://github.com/oorabona/db-semantic-planner/commit/39420d49f44c875c1ca352d424dec6eaf9e0941d)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Reliable cross-schema FK casing, unique drop, CHECK lexer ([aafd0ec](https://github.com/oorabona/db-semantic-planner/commit/aafd0ecfbe89635d24fe72e12b949eddf3c68ba9)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Restore previous primary key on PK-change rollback ([09f18f0](https://github.com/oorabona/db-semantic-planner/commit/09f18f06ebe18a6c533a629afacdf6cbf36150a9)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Sanitize IR values interpolated into migration warning comments ([7221c93](https://github.com/oorabona/db-semantic-planner/commit/7221c937bc74df924f108190f4dc0c01a04d5edf)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Schema-aware relation inference and faithful unique-constraint rollback ([a3702ba](https://github.com/oorabona/db-semantic-planner/commit/a3702ba915fc07cb30289bc85620d94350121552)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Snapshot CHECK expression before validate and render ([06eb3dc](https://github.com/oorabona/db-semantic-planner/commit/06eb3dc181a87c8489c0f8fbdff9223b08ae6310)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **adapter-pgsql:** Validate storage-parameter, sequence, and type-name values before SQL ([fd7ffa9](https://github.com/oorabona/db-semantic-planner/commit/fd7ffa9547ae07df0aa7ce6c28807c943d99a63d)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.11.0
    * @dbsp/types bumped to 1.9.0

## [1.10.2](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.10.1...adapter-pgsql-v1.10.2) (2026-07-07)


### Bug Fixes

* **adapter-pgsql:** Preserve any values and resolve dotted orderBy on joined columns ([236de07](https://github.com/oorabona/db-semantic-planner/commit/236de07e6a62ef4f356a90b89177f7ba61d18710))

## [1.10.1](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.10.0...adapter-pgsql-v1.10.1) (2026-07-07)


### Bug Fixes

* **adapter-pgsql:** Propagate DISTINCT flag through aggregate compilation ([f6dc756](https://github.com/oorabona/db-semantic-planner/commit/f6dc756f9d5f1eb63e35ff82fbf06409fa413614))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.10.1
    * @dbsp/types bumped to 1.8.1

## [1.10.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.9.0...adapter-pgsql-v1.10.0) (2026-07-06)


### Features

* **core:** Support nulls-not-distinct indexes and external table refs ([be02788](https://github.com/oorabona/db-semantic-planner/commit/be027887d4e103cf904a755333c8451122c0390c))


### Bug Fixes

* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.10.0
    * @dbsp/types bumped to 1.8.0

## [1.9.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.8.2...adapter-pgsql-v1.9.0) (2026-07-06)


### Features

* **core:** Add ergonomic control over DX warnings ([#237](https://github.com/oorabona/db-semantic-planner/issues/237)) ([21c3d3b](https://github.com/oorabona/db-semantic-planner/commit/21c3d3b0c05796591a30660c8c5c3fe99391db46)), closes [#159](https://github.com/oorabona/db-semantic-planner/issues/159)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.9.0

## [1.8.2](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.8.1...adapter-pgsql-v1.8.2) (2026-07-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.8.0

## [1.8.1](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.8.0...adapter-pgsql-v1.8.1) (2026-07-03)


### Bug Fixes

* **nql:** Emit aliased mutation RETURNING through the source column ([#220](https://github.com/oorabona/db-semantic-planner/issues/220)) ([f4213a0](https://github.com/oorabona/db-semantic-planner/commit/f4213a0f3e23463b5a8f48e379d4ade9ce516232))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.7.1
    * @dbsp/types bumped to 1.7.1

## [1.8.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.7.0...adapter-pgsql-v1.8.0) (2026-07-02)


### Features

* **nql:** Generalize read-bind snapshots to aliased, transitive, and count columns ([#218](https://github.com/oorabona/db-semantic-planner/issues/218)) ([0b4b315](https://github.com/oorabona/db-semantic-planner/commit/0b4b315a17427f358aa0f7dd076d0e1b152fdf07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.7.0
    * @dbsp/types bumped to 1.7.0

## [1.7.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.6.0...adapter-pgsql-v1.7.0) (2026-06-20)


### Features

* **nql:** Recursive self-referential relation columns from a binding-final read ([#209](https://github.com/oorabona/db-semantic-planner/issues/209)) ([047ff3c](https://github.com/oorabona/db-semantic-planner/commit/047ff3c29dd786864061d884ef2054db25e90053)), closes [#193](https://github.com/oorabona/db-semantic-planner/issues/193)
* **nql:** Snapshot read-only bindings referenced across an intervening mutation ([#212](https://github.com/oorabona/db-semantic-planner/issues/212)) ([00055eb](https://github.com/oorabona/db-semantic-planner/commit/00055eb6a15de86e1cd21ad01ec09b4eba76d9df)), closes [#186](https://github.com/oorabona/db-semantic-planner/issues/186)
* **nql:** Support manyToMany relation columns from a binding-final read ([#207](https://github.com/oorabona/db-semantic-planner/issues/207)) ([bf3a830](https://github.com/oorabona/db-semantic-planner/commit/bf3a830e73dcb229f6d13f5c7184d765f30a0044)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)


### Bug Fixes

* **cli:** Make destructive-rollback guard fail-safe and metadata-driven ([#210](https://github.com/oorabona/db-semantic-planner/issues/210)) ([0aa6b61](https://github.com/oorabona/db-semantic-planner/commit/0aa6b613422d8a8f302279ca22008a8b8400ac84)), closes [#155](https://github.com/oorabona/db-semantic-planner/issues/155)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.6.0
    * @dbsp/types bumped to 1.6.0

## [1.6.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.5.0...adapter-pgsql-v1.6.0) (2026-06-20)


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
    * @dbsp/core bumped to 1.5.0
    * @dbsp/types bumped to 1.5.0

## [1.5.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.4.0...adapter-pgsql-v1.5.0) (2026-06-19)


### Features

* **nql:** Support relation filters from single-source binding reads ([#189](https://github.com/oorabona/db-semantic-planner/issues/189)) ([fb76c10](https://github.com/oorabona/db-semantic-planner/commit/fb76c10dc6540971524e87cae37d4f6e35df85d2)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support scalar relation columns from single-source binding reads ([#191](https://github.com/oorabona/db-semantic-planner/issues/191)) ([f6d0ad4](https://github.com/oorabona/db-semantic-planner/commit/f6d0ad4eb50101f8270ad8b78320e63fa69f8c5f)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.4.0
    * @dbsp/types bumped to 1.4.0

## [1.4.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.3.0...adapter-pgsql-v1.4.0) (2026-06-18)


### Features

* **adapter-pgsql:** Gate NQL text surface by dialect capabilities ([#187](https://github.com/oorabona/db-semantic-planner/issues/187)) ([f536b9a](https://github.com/oorabona/db-semantic-planner/commit/f536b9a809f627007fc2586d66e87e8aa3060cd5)), closes [#183](https://github.com/oorabona/db-semantic-planner/issues/183)
* **nql:** Support binding-final tag queries ([#184](https://github.com/oorabona/db-semantic-planner/issues/184)) ([f4ccf6d](https://github.com/oorabona/db-semantic-planner/commit/f4ccf6d32a7c65afc9a1ada9506877a827f92c2a)), closes [#176](https://github.com/oorabona/db-semantic-planner/issues/176)
* **nql:** Support ordered multi-mutation tag programs ([#185](https://github.com/oorabona/db-semantic-planner/issues/185)) ([7ddebfa](https://github.com/oorabona/db-semantic-planner/commit/7ddebfa4b2c6c5f7a234c0f94e9dd98753c8074f)), closes [#173](https://github.com/oorabona/db-semantic-planner/issues/173)


### Bug Fixes

* **adapter-pgsql:** Fail loud on composite FK mutation exists guards ([#180](https://github.com/oorabona/db-semantic-planner/issues/180)) ([f5898b0](https://github.com/oorabona/db-semantic-planner/commit/f5898b0ce42d75d2c44c15650484ffe9ec3a806e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.3.0
    * @dbsp/types bumped to 1.3.0

## [1.3.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.2.1...adapter-pgsql-v1.3.0) (2026-06-16)


### Features

* **adapter-pgsql:** Support conditional upsert ON CONFLICT DO UPDATE SET ... WHERE ([#172](https://github.com/oorabona/db-semantic-planner/issues/172)) ([ddf5d2c](https://github.com/oorabona/db-semantic-planner/commit/ddf5d2c69178dbd6e231955a922bf99853763b3a)), closes [#160](https://github.com/oorabona/db-semantic-planner/issues/160)
* **nql:** Support tagged template mutations ([#175](https://github.com/oorabona/db-semantic-planner/issues/175)) ([c78e89e](https://github.com/oorabona/db-semantic-planner/commit/c78e89e00479359f67f50a3c00edf7fdc63aec18))


### Bug Fixes

* **adapter-pgsql:** Resolve relation aliases in distinctOn() columns ([#169](https://github.com/oorabona/db-semantic-planner/issues/169)) ([bc5ea35](https://github.com/oorabona/db-semantic-planner/commit/bc5ea351f85af0b57b3b0777eb18cbea91e37e9f)), closes [#168](https://github.com/oorabona/db-semantic-planner/issues/168)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.2.0
    * @dbsp/types bumped to 1.2.0

## [1.2.1](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.2.0...adapter-pgsql-v1.2.1) (2026-06-12)


### Bug Fixes

* **adapter-pgsql:** Reserve manual join aliases to prevent include collision ([#166](https://github.com/oorabona/db-semantic-planner/issues/166)) ([1f53f86](https://github.com/oorabona/db-semantic-planner/commit/1f53f86381214ddfb6f6f5ecf450cceec126ecf4)), closes [#162](https://github.com/oorabona/db-semantic-planner/issues/162)

## [1.2.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.1.1...adapter-pgsql-v1.2.0) (2026-06-12)


### Features

* **nql:** General named parameters, tag binding, and nqlRaw() ([#165](https://github.com/oorabona/db-semantic-planner/issues/165)) ([905c323](https://github.com/oorabona/db-semantic-planner/commit/905c323f6a9a907dd39a86950e746d8dd5822a61)), closes [#134](https://github.com/oorabona/db-semantic-planner/issues/134)


### Bug Fixes

* **adapter-pgsql:** Multi-path join aliasing and result hydration ([#163](https://github.com/oorabona/db-semantic-planner/issues/163)) ([130f53f](https://github.com/oorabona/db-semantic-planner/commit/130f53f0630c5655ac13f8b755f8730c22c59b41)), closes [#154](https://github.com/oorabona/db-semantic-planner/issues/154)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.1.0
    * @dbsp/types bumped to 1.1.0

## [1.1.1](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.1.0...adapter-pgsql-v1.1.1) (2026-06-10)


### Bug Fixes

* **adapter-pgsql:** Validate escape-hatch and DDL token surfaces against injection ([7487b7b](https://github.com/oorabona/db-semantic-planner/commit/7487b7b0f681c51984186c91b5aef63737ae15a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.5

## [1.1.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.0.3...adapter-pgsql-v1.1.0) (2026-06-05)


### Features

* **adapter-pgsql:** Support cast() expressions in SELECT column lists ([c88742a](https://github.com/oorabona/db-semantic-planner/commit/c88742a428f9cf6ca73fb29656ee6c3218bb0e27))


### Bug Fixes

* **adapter-pgsql:** CompareSchemata ignoreUnmanagedExtensions option (+ e2e image bump) ([4028937](https://github.com/oorabona/db-semantic-planner/commit/402893747061157f6794e445e3155bdbb63e289c))
* **adapter-pgsql:** Guard subquery modifiers on every path via an emission chokepoint ([fc85e55](https://github.com/oorabona/db-semantic-planner/commit/fc85e550ea407121bb90c71c3bbc97eeffcab22e))
* **core:** IN-to-EXISTS done properly + inline-EXISTS refactor ([db38526](https://github.com/oorabona/db-semantic-planner/commit/db3852655e870e328a23dee3c1eb117e252474d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.4
    * @dbsp/types bumped to 1.0.3

## [1.0.3](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.0.2...adapter-pgsql-v1.0.3) (2026-06-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.3
    * @dbsp/types bumped to 1.0.2

## [1.0.2](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v1.0.1...adapter-pgsql-v1.0.2) (2026-06-04)


### Bug Fixes

* Launch-gating correctness & injection-hardening for 1.0.2 ([#135](https://github.com/oorabona/db-semantic-planner/issues/135)) ([cbcd22e](https://github.com/oorabona/db-semantic-planner/commit/cbcd22e2e105b9bb86a4496733442d70d05a28cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 1.0.2
