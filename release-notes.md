:robot: I have created a release *beep* *boop*
---


<details><summary>adapter-pgsql: 5.0.0</summary>

## [5.0.0](https://github.com/oorabona/db-semantic-planner/compare/adapter-pgsql-v4.0.0...adapter-pgsql-v5.0.0) (2026-09-04)


###   BREAKING CHANGES

* **adapter-pgsql:** compileInsert, compileUpdate, compileDelete, compileMutation and compileUpsert return PostgreSQL 18 AST nodes: a RETURNING projection is now `returningClause.exprs` instead of `returningList`, and the published @pgsql/types dependency is the 18 major. Emitted SQL is unchanged; code that reads the returned nodes must read returningClause.exprs.

### Features

* **adapter-pgsql:** PostgreSQL 18 grammar via pgsql-parser 18 ([#700](https://github.com/oorabona/db-semantic-planner/issues/700)) ([6d72dc3](https://github.com/oorabona/db-semantic-planner/commit/6d72dc39a864af4f593fcb2facb16a3c6cf014ff))


### Bug Fixes

* **adapter-pgsql:** One operator resolver decides every comparison, and no handler defaults to equality ([#704](https://github.com/oorabona/db-semantic-planner/issues/704)) ([a9c1ab7](https://github.com/oorabona/db-semantic-planner/commit/a9c1ab77abc9a05873ee1ecefcadbc3923114484))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 5.0.0
    * @dbsp/types bumped to 5.0.0
</details>

<details><summary>cli: 2.2.0</summary>

## [2.2.0](https://github.com/oorabona/db-semantic-planner/compare/cli-v3.0.0...cli-v2.2.0) (2026-09-04)


###   BREAKING CHANGES

* **adapter-pgsql:** SequenceIR and schema DSL sequence fields (startWith, incrementBy, minValue, maxValue) accept number | string; strict decimal strings carry exact int64 values.
* **adapter-pgsql:** dbsp push and dbsp migrate removed. Use apply <run-id> to execute recorded plans or apply for unrecorded intents. CLI version 3.0.0.
* **adapter-pgsql:** Removed the deprecated exports. From @dbsp/adapter-pgsql: acquireMigrationLock and releaseMigrationLock  use withMigrationLock, which holds and releases the lock on a single connection. From @dbsp/cli: generateSchemaFile and the deprecated warnings option on its codegen interface  use generateSchemaFileWithDiagnostics, which returns the generated code together with every warning, so no diagnostic can be lost silently. From @dbsp/types: the ScalarSubqueryIntent alias  use QueryIntent. The string-based orm.select('table') is NOT deprecated and is not going anywhere.
* **core:** The legacy schema surface is gone. Removed from @dbsp/core: defineSchema, ResolvedSchema and its Schema* definition types, isBelongsTo, isHasMany, isManyToMany, DEFAULT_CONVENTIONS, detectForeignKeys, detectManyToMany, inferRelationsFromSchema, OrmOptionsWithSchema, GeneratedSchema and its Generated* types, ColumnTypeToTS, InferRowType, InferDBFromSchema, buildModelFromSchema, buildModelFromResolvedSchema, isGeneratedSchema, isResolvedSchema, normalizeSchema, ResolvedSchemaValidation, ValidatedResolvedSchema, SchemaConversionResult, resolvedSchemaToGeneratedSchema and assertResolvedSchemaToGeneratedSchema. Removed from @dbsp/cli: generateManifest and its manifest types. The exported name SchemaColumnType now refers to the IR column-type union, which is wider than the legacy DSL union it used to name  it gains number and datetime. Define schemas with schema() and ref() from @dbsp/core.

### Features

* **adapter-pgsql:** Address-free v3 postconditions with explicit target binding ([#665](https://github.com/oorabona/db-semantic-planner/issues/665)) ([aa5daa8](https://github.com/oorabona/db-semantic-planner/commit/aa5daa899cc95640d92a90ebb3b4217b1e34a426))
* **adapter-pgsql:** Canonical payload digests and exact int64 sequence contracts ([#672](https://github.com/oorabona/db-semantic-planner/issues/672)) ([afa6d24](https://github.com/oorabona/db-semantic-planner/commit/afa6d24f6902cd68ced15e02aefe737ad4cc362a))
* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)
* **adapter-pgsql:** Drop the deprecated surface, and prove orm.from() works ([#316](https://github.com/oorabona/db-semantic-planner/issues/316)) ([c3f4871](https://github.com/oorabona/db-semantic-planner/commit/c3f48719bd1ca10877561da6faa2acecbe9ba684))
* **adapter-pgsql:** Let PostgreSQL canonicalise column defaults so they converge ([#427](https://github.com/oorabona/db-semantic-planner/issues/427)) ([e49104e](https://github.com/oorabona/db-semantic-planner/commit/e49104e81a98952f1c87efa4a67e65290b28581f)), closes [#382](https://github.com/oorabona/db-semantic-planner/issues/382)
* **adapter-pgsql:** Make a recorded plan describe a target it can identify ([#435](https://github.com/oorabona/db-semantic-planner/issues/435)) ([5217c4a](https://github.com/oorabona/db-semantic-planner/commit/5217c4ab3491f0a54aa2878adeca50383e47273e)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **adapter-pgsql:** Managed-state ledger delivery 2  admission, recovery, destructive authority ([#516](https://github.com/oorabona/db-semantic-planner/issues/516)) ([d5979c0](https://github.com/oorabona/db-semantic-planner/commit/d5979c0d7184ffb8b66ca4f9ddc1b148dd2c22b9))
* **cli:** Compute a transition plan and make it durable before anything runs ([#432](https://github.com/oorabona/db-semantic-planner/issues/432)) ([50beccf](https://github.com/oorabona/db-semantic-planner/commit/50beccfca3393c542f259b7b5ff8c4d82364102d)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **cli:** E16c transactions + E16/E16e CSV load/dump ([6999f49](https://github.com/oorabona/db-semantic-planner/commit/6999f4962f5a34dd7cfa6cc7486a4c65fafa370a))
* **cli:** E16d set operations in REPL + E16f mutation bind ([8a40190](https://github.com/oorabona/db-semantic-planner/commit/8a40190ce7b25454f478c7f78a4ae31372caaa52))
* **cli:** Let dbsp generate ddl target a PostgreSQL version ([#482](https://github.com/oorabona/db-semantic-planner/issues/482)) ([477544b](https://github.com/oorabona/db-semantic-planner/commit/477544bc9d9daf0fa71385a95e4c41ef9fb82833)), closes [#468](https://github.com/oorabona/db-semantic-planner/issues/468)
* **core:** Add isOverallSuccess() predicate for query success validation ([#96](https://github.com/oorabona/db-semantic-planner/issues/96)) ([0715c46](https://github.com/oorabona/db-semantic-planner/commit/0715c46f0c72098e130cabff3ea842e7399e9144))
* **core:** Execute a reviewed plan against a target it can prove is the one ([#479](https://github.com/oorabona/db-semantic-planner/issues/479)) ([e89f2be](https://github.com/oorabona/db-semantic-planner/commit/e89f2bee7206aeb4f21e8b06adde18aa984beb58)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)
* **core:** Remove the legacy defineSchema and GeneratedSchema surface ([#312](https://github.com/oorabona/db-semantic-planner/issues/312)) ([f743b28](https://github.com/oorabona/db-semantic-planner/commit/f743b289200444e65e28bb6840df012d59710078))
* **ddl,gui:** DOWN migrations, schema versioning, and GUI schema diff ([115e2fc](https://github.com/oorabona/db-semantic-planner/commit/115e2fc066fa933156ea5e8ed8dd8b25512016e2))
* **ddl:** DDL provisioning  push, migrate, verify commands ([0208e72](https://github.com/oorabona/db-semantic-planner/commit/0208e721a49ad16e20f1856d40a6343927e3b7c4))
* **gui:** Assertion runner + post-MVP polish ([b9af32c](https://github.com/oorabona/db-semantic-planner/commit/b9af32cbd13cd6eeed215c73cd540f013093a1c3))


### Bug Fixes

* **adapter-pgsql:** Defaults compare in the server representation and serial defaults are expected ([fcb9fb1](https://github.com/oorabona/db-semantic-planner/commit/fcb9fb16d6ee92617e86d480eef59764c823759f)), closes [#566](https://github.com/oorabona/db-semantic-planner/issues/566)
* **adapter-pgsql:** Emit CREATE INDEX without IF NOT EXISTS ([#483](https://github.com/oorabona/db-semantic-planner/issues/483)) ([b1c1863](https://github.com/oorabona/db-semantic-planner/commit/b1c1863a30b8944b687f63b4213700ad1b9702ec)), closes [#419](https://github.com/oorabona/db-semantic-planner/issues/419)
* **adapter-pgsql:** Ledger recovery outcomes are explicit, attempt-bound, and session-safe ([#548](https://github.com/oorabona/db-semantic-planner/issues/548)) ([0bab857](https://github.com/oorabona/db-semantic-planner/commit/0bab857d2434f88234ce07cb105fdcb7852202e1))
* **adapter-pgsql:** Let PostgreSQL canonicalise CHECK expressions so migrations converge ([#335](https://github.com/oorabona/db-semantic-planner/issues/335)) ([5cbed9c](https://github.com/oorabona/db-semantic-planner/commit/5cbed9c663afec724a62f738429f67287ec8e44a))
* **adapter-pgsql:** One adapter home for the v2 decoder and a table proof refusing contradictions ([#573](https://github.com/oorabona/db-semantic-planner/issues/573)) ([50eece0](https://github.com/oorabona/db-semantic-planner/commit/50eece0a5ac6930730728fb2af0f5b93b329c113))
* **adapter-pgsql:** Postconditions are structural catalogue proofs, not rendered-text comparison ([#565](https://github.com/oorabona/db-semantic-planner/issues/565)) ([b67dbb2](https://github.com/oorabona/db-semantic-planner/commit/b67dbb2ca9b49416676e1882456aa31e66a8ca51))
* **adapter-pgsql:** Reinitialize, index read-back, and key-list verification hardening ([#560](https://github.com/oorabona/db-semantic-planner/issues/560)) ([31e0e55](https://github.com/oorabona/db-semantic-planner/commit/31e0e55bfcd014ccd7837384308678f6590395c2))
* **adapter-pgsql:** Session revocation is one core-owned latch per physical client ([#555](https://github.com/oorabona/db-semantic-planner/issues/555)) ([f115b95](https://github.com/oorabona/db-semantic-planner/commit/f115b953f2cce283d8b316dc25042fd4aa9b66d0))
* Cli retro-audit 2026-04-20 (8 thematic commits, 43 S/M findings) ([#50](https://github.com/oorabona/db-semantic-planner/issues/50)) ([1606aef](https://github.com/oorabona/db-semantic-planner/commit/1606aefca03a9fc85261801e92bfcaba3592f679))
* **cli:** Add 14 new ChangeKind handlers to verifier CHANGE_TO_DRIFT ([d254382](https://github.com/oorabona/db-semantic-planner/commit/d2543820beb216e807531efc72e5ab9f6d1ba8f1))
* **cli:** Audit-workflow batch  5 confirmed fixes from 2026-04-19 codex audit ([#82](https://github.com/oorabona/db-semantic-planner/issues/82)) ([807bd61](https://github.com/oorabona/db-semantic-planner/commit/807bd610d6cf7272a586928d2f55697200aec8fc))
* **cli:** Correctness sweep  batch exit code, introspect interop, FK escape ([a2ab2fb](https://github.com/oorabona/db-semantic-planner/commit/a2ab2fb6589d385c71c125e5fff9645b0257ac56))
* **cli:** Emit cross-schema single-column FKs as loadable table-level constraints ([48d22b3](https://github.com/oorabona/db-semantic-planner/commit/48d22b3336159c76405a658160d583774a79595b)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **cli:** Every read-back proves the object kind and decodes its projection strictly ([#598](https://github.com/oorabona/db-semantic-planner/issues/598)) ([a7c1164](https://github.com/oorabona/db-semantic-planner/commit/a7c1164de818e8eb11884fc0b2c60df4882c8915))
* **cli:** Handle alter_column_unique drift and serialize FK referenced schema ([2914115](https://github.com/oorabona/db-semantic-planner/commit/29141159653d812581ec82ea6b421f68f8dbdbe6)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **cli:** Keep the database's indexes when regenerating a schema ([#306](https://github.com/oorabona/db-semantic-planner/issues/306)) ([7dcfaad](https://github.com/oorabona/db-semantic-planner/commit/7dcfaadf22b88f2c7f92cd38e973fa489f6ad772))
* **cli:** Make destructive-rollback guard fail-safe and metadata-driven ([#210](https://github.com/oorabona/db-semantic-planner/issues/210)) ([0aa6b61](https://github.com/oorabona/db-semantic-planner/commit/0aa6b613422d8a8f302279ca22008a8b8400ac84)), closes [#155](https://github.com/oorabona/db-semantic-planner/issues/155)
* **cli:** Make the migration-integrity guards real, by making the code reachable ([#339](https://github.com/oorabona/db-semantic-planner/issues/339)) ([df46c05](https://github.com/oorabona/db-semantic-planner/commit/df46c057c96a00762c0df13207f8b14d8d7df823))
* **cli:** Resolve typecheck errors (SetOperationIntent narrowing, RLS drift types) ([1d5a1ce](https://github.com/oorabona/db-semantic-planner/commit/1d5a1ce6bc7b442102be409f29121b5af8f713cf))
* **cli:** Set operations execute as queries + E16 E2E assertions ([968924c](https://github.com/oorabona/db-semantic-planner/commit/968924c2b09752059c14494131ddf10e4b313f42))
* **cli:** Tighten codegen, history permissions, and loader error handling ([#57](https://github.com/oorabona/db-semantic-planner/issues/57)) ([fcab538](https://github.com/oorabona/db-semantic-planner/commit/fcab538ca26a4329b362f9c8c0bf190c9455e11b))
* **core,cli,docs:** Fk gate followups  bundle A2 ([#87](https://github.com/oorabona/db-semantic-planner/issues/87)) ([dc44d51](https://github.com/oorabona/db-semantic-planner/commit/dc44d5126d9e582879a9e3b48f0651a350ea06f0))
* **core,cli,docs:** Fk gate followups  bundle A2 ([#87](https://github.com/oorabona/db-semantic-planner/issues/87)) ([dc44d51](https://github.com/oorabona/db-semantic-planner/commit/dc44d5126d9e582879a9e3b48f0651a350ea06f0))
* **core,cli:** Fk gate followups  bundle A ([#86](https://github.com/oorabona/db-semantic-planner/issues/86)) ([ca35064](https://github.com/oorabona/db-semantic-planner/commit/ca350641307ea6de4c7acb8c2ae78655f791d1d5))
* **core,cli:** Fk gate followups  bundle A ([#86](https://github.com/oorabona/db-semantic-planner/issues/86)) ([ca35064](https://github.com/oorabona/db-semantic-planner/commit/ca350641307ea6de4c7acb8c2ae78655f791d1d5))
* **core:** Preserve non-PK FK target columns through buildRefColumn ([#83](https://github.com/oorabona/db-semantic-planner/issues/83)) ([2fa5e1e](https://github.com/oorabona/db-semantic-planner/commit/2fa5e1eaf4254f58f947f9fa3c871a64d222fe8b))
* **deps:** One catalog for every dependency range, enforced at source and in the tarball ([#398](https://github.com/oorabona/db-semantic-planner/issues/398)) ([7db9979](https://github.com/oorabona/db-semantic-planner/commit/7db9979b82315f1348024d1a9de71e5022a3c3c7))
* Launch-gating correctness & injection-hardening for 1.0.2 ([#135](https://github.com/oorabona/db-semantic-planner/issues/135)) ([cbcd22e](https://github.com/oorabona/db-semantic-planner/commit/cbcd22e2e105b9bb86a4496733442d70d05a28cc))
* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)
* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/adapter-pgsql bumped to 5.0.0
    * @dbsp/core bumped to 5.0.0
    * @dbsp/nql bumped to 1.10.5
    * @dbsp/types bumped to 5.0.0
</details>

<details><summary>core: 5.0.0</summary>

## [5.0.0](https://github.com/oorabona/db-semantic-planner/compare/core-v4.0.0...core-v5.0.0) (2026-09-04)


###   BREAKING CHANGES

* **adapter-pgsql:** replayInvalidatedPlans is accepted only by pool-owning adapter constructors; borrowed-client and compile-only constructors reject it.
* **adapter-pgsql:** SequenceIR and schema DSL sequence fields (startWith, incrementBy, minValue, maxValue) accept number | string; strict decimal strings carry exact int64 values.
* **adapter-pgsql:** dbsp push and dbsp migrate removed. Use apply <run-id> to execute recorded plans or apply for unrecorded intents. CLI version 3.0.0.
* **adapter-pgsql:** dbsp no longer savepoints each statement inside a transaction it opened. PostgreSQL's own semantics stand  a failed statement poisons the transaction. 2.0.0 rolled back the one statement and committed the rest, turning a fail-closed database error into a durable partial business transaction; catching an error inside `transaction()` and continuing no longer works, and that is the point. A nested `transaction()` that was never awaited is refused rather than guessed about. `inTransaction` and `supportsTransactions` are now required members of the adapter contract: an adapter that cannot state whether a transaction is open is one dbsp will not run concurrent DDL through. A `PoolClient` must be declared with `borrowedClient: true`, and `introspect()` takes a `Pool`.
* **adapter-pgsql:** Removed the deprecated exports. From @dbsp/adapter-pgsql: acquireMigrationLock and releaseMigrationLock  use withMigrationLock, which holds and releases the lock on a single connection. From @dbsp/cli: generateSchemaFile and the deprecated warnings option on its codegen interface  use generateSchemaFileWithDiagnostics, which returns the generated code together with every warning, so no diagnostic can be lost silently. From @dbsp/types: the ScalarSubqueryIntent alias  use QueryIntent. The string-based orm.select('table') is NOT deprecated and is not going anywhere.
* **core:** The legacy schema surface is gone. Removed from @dbsp/core: defineSchema, ResolvedSchema and its Schema* definition types, isBelongsTo, isHasMany, isManyToMany, DEFAULT_CONVENTIONS, detectForeignKeys, detectManyToMany, inferRelationsFromSchema, OrmOptionsWithSchema, GeneratedSchema and its Generated* types, ColumnTypeToTS, InferRowType, InferDBFromSchema, buildModelFromSchema, buildModelFromResolvedSchema, isGeneratedSchema, isResolvedSchema, normalizeSchema, ResolvedSchemaValidation, ValidatedResolvedSchema, SchemaConversionResult, resolvedSchemaToGeneratedSchema and assertResolvedSchemaToGeneratedSchema. Removed from @dbsp/cli: generateManifest and its manifest types. The exported name SchemaColumnType now refers to the IR column-type union, which is wider than the legacy DSL union it used to name  it gains number and datetime. Define schemas with schema() and ref() from @dbsp/core.

### Features

* **adapter-pgsql:** Abort a pool-owned transaction via AbortSignal ([#363](https://github.com/oorabona/db-semantic-planner/issues/363)) ([#369](https://github.com/oorabona/db-semantic-planner/issues/369)) ([e61d4b5](https://github.com/oorabona/db-semantic-planner/commit/e61d4b58ec1790b86497fd8d8fb15e7ca1aabc07))
* **adapter-pgsql:** Add transaction isolation, access mode & timeouts ([#360](https://github.com/oorabona/db-semantic-planner/issues/360), [#361](https://github.com/oorabona/db-semantic-planner/issues/361)) ([#368](https://github.com/oorabona/db-semantic-planner/issues/368)) ([74cc335](https://github.com/oorabona/db-semantic-planner/commit/74cc33511d7e501b7bea8915e68bf8955ec9efc4))
* **adapter-pgsql:** Add withPinnedConnection for a bounded pinned-connection scope ([#341](https://github.com/oorabona/db-semantic-planner/issues/341)) ([#373](https://github.com/oorabona/db-semantic-planner/issues/373)) ([c1bdc7d](https://github.com/oorabona/db-semantic-planner/commit/c1bdc7d9e8a5e3388f86264b292a7849a61f659b))
* **adapter-pgsql:** Apply isolation and timeout options to the streaming BEGIN ([#364](https://github.com/oorabona/db-semantic-planner/issues/364)) ([#372](https://github.com/oorabona/db-semantic-planner/issues/372)) ([6dbf579](https://github.com/oorabona/db-semantic-planner/commit/6dbf57970733848bf5689725040fa6888af940fd))
* **adapter-pgsql:** Canonical payload digests and exact int64 sequence contracts ([#672](https://github.com/oorabona/db-semantic-planner/issues/672)) ([afa6d24](https://github.com/oorabona/db-semantic-planner/commit/afa6d24f6902cd68ced15e02aefe737ad4cc362a))
* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)
* **adapter-pgsql:** Deterministically order include json_agg arrays by primary key ([#203](https://github.com/oorabona/db-semantic-planner/issues/203)) ([8e6da3a](https://github.com/oorabona/db-semantic-planner/commit/8e6da3a035c292a36ac98cf1ef18a76203ecfa51)), closes [#196](https://github.com/oorabona/db-semantic-planner/issues/196)
* **adapter-pgsql:** Drop the deprecated surface, and prove orm.from() works ([#316](https://github.com/oorabona/db-semantic-planner/issues/316)) ([c3f4871](https://github.com/oorabona/db-semantic-planner/commit/c3f48719bd1ca10877561da6faa2acecbe9ba684))
* **adapter-pgsql:** Gate NQL text surface by dialect capabilities ([#187](https://github.com/oorabona/db-semantic-planner/issues/187)) ([f536b9a](https://github.com/oorabona/db-semantic-planner/commit/f536b9a809f627007fc2586d66e87e8aa3060cd5)), closes [#183](https://github.com/oorabona/db-semantic-planner/issues/183)
* **adapter-pgsql:** Make a recorded plan describe a target it can identify ([#435](https://github.com/oorabona/db-semantic-planner/issues/435)) ([5217c4a](https://github.com/oorabona/db-semantic-planner/commit/5217c4ab3491f0a54aa2878adeca50383e47273e)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **adapter-pgsql:** Make schema a required argument on the DDL generator port ([#331](https://github.com/oorabona/db-semantic-planner/issues/331)) ([#375](https://github.com/oorabona/db-semantic-planner/issues/375)) ([d106f9e](https://github.com/oorabona/db-semantic-planner/commit/d106f9e0534cf0a70215f0f6d562f596ba64514b))
* **adapter-pgsql:** Managed-state ledger delivery 2  admission, recovery, destructive authority ([#516](https://github.com/oorabona/db-semantic-planner/issues/516)) ([d5979c0](https://github.com/oorabona/db-semantic-planner/commit/d5979c0d7184ffb8b66ca4f9ddc1b148dd2c22b9))
* **adapter-pgsql:** The caller declares who owns the connection ([#330](https://github.com/oorabona/db-semantic-planner/issues/330)) ([8077cd2](https://github.com/oorabona/db-semantic-planner/commit/8077cd249452ca30ac003dbb4470d1002397e89a)), closes [#325](https://github.com/oorabona/db-semantic-planner/issues/325)
* **adapter-pgsql:** Version-gate index features via ADR-0003 capability model ([#349](https://github.com/oorabona/db-semantic-planner/issues/349)) ([618f07b](https://github.com/oorabona/db-semantic-planner/commit/618f07b69968b988a005627568b8da6f9bc27937)), closes [#245](https://github.com/oorabona/db-semantic-planner/issues/245)
* **adapter,core,nql:** Add ANY() operator and batch INSERT via unnest (blocks 1-2) ([b7bbbad](https://github.com/oorabona/db-semantic-planner/commit/b7bbbadf6a3837bd6c59b5298bff0976f9bfd8b8))
* **adapter,core,types:** Add CTE with unnest builder and WITH ORDINALITY (block 5) ([6ef4bec](https://github.com/oorabona/db-semantic-planner/commit/6ef4bec0696a841c8ab0b1ef28f9e2dfe762ed34))
* **adapter,core,types:** Batch TRIVIAL/SIMPLE tasks  6 features + docs ([#28](https://github.com/oorabona/db-semantic-planner/issues/28)) ([9430203](https://github.com/oorabona/db-semantic-planner/commit/943020324a8727813c6ab1b7774b8f04b3df28b1))
* **adapter,core:** Add batch UPDATE via unnest FROM strategy (block 3) ([feb0514](https://github.com/oorabona/db-semantic-planner/commit/feb0514529adccd039abc8d26c8797689c16e2fa))
* **adapter,core:** Add FILTER clause support in aggregate expressions ([18a3d7a](https://github.com/oorabona/db-semantic-planner/commit/18a3d7a64c73636eb14f3de0dc714f031ec40837))
* **adapter:** Remove WASM + internalize pgsql-deparser ([#21](https://github.com/oorabona/db-semantic-planner/issues/21)) ([447813f](https://github.com/oorabona/db-semantic-planner/commit/447813f3d49359c2ec16acd624752aeb070b5337))
* **cli:** Compute a transition plan and make it durable before anything runs ([#432](https://github.com/oorabona/db-semantic-planner/issues/432)) ([50beccf](https://github.com/oorabona/db-semantic-planner/commit/50beccfca3393c542f259b7b5ff8c4d82364102d)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core,adapter:** Add .join() API  manual joins with explicit ON condition ([0d7cb4c](https://github.com/oorabona/db-semantic-planner/commit/0d7cb4c70807f6ac0656ded357b6a57fd8c07b97))
* **core,adapter:** Add caseWhen() expression builder for CASE WHEN in columns/orderBy ([e1678e8](https://github.com/oorabona/db-semantic-planner/commit/e1678e8835a856fc27cae801cf492f417616f2c8))
* **core,adapter:** Add catalog helpers  indexes.exists(), indexes.list(pattern), storageSize() ([7e05cf0](https://github.com/oorabona/db-semantic-planner/commit/7e05cf0c80c67af8901cc4afc547efd52862f48c))
* **core,adapter:** Add dbType escape hatch for custom DB column types ([0d3d414](https://github.com/oorabona/db-semantic-planner/commit/0d3d4146dc05c1d4c378fe502aa91da343aad1b0))
* **core,adapter:** Add generic expression primitives and pgvector extension ([#23](https://github.com/oorabona/db-semantic-planner/issues/23)) ([e2ae011](https://github.com/oorabona/db-semantic-planner/commit/e2ae0112279bb358c69caa618eb94be2f25f47a6))
* **core,adapter:** Add star() and array() expression primitives ([#38](https://github.com/oorabona/db-semantic-planner/issues/38)) ([28fc520](https://github.com/oorabona/db-semantic-planner/commit/28fc520489f4f724d8c1f25e5719c831c39b1f55))
* **core,adapter:** Add table-scoped DDL helpers  truncate, vacuum, alterColumn, indexes ([d8f9227](https://github.com/oorabona/db-semantic-planner/commit/d8f9227990188c1d14c24e685bbf73d7a3590887))
* **core,adapter:** AggOrderBy in fn() + arrayAgg/stringAgg helpers ([6ef2a08](https://github.com/oorabona/db-semantic-planner/commit/6ef2a0877ee6324105e3d03a278663b55d402dc0))
* **core,adapter:** BatchValues, vector search, fullTextSearch, recursive CTE ([2886676](https://github.com/oorabona/db-semantic-planner/commit/288667687419001d52c32e7c11bc7b015ed4c70f))
* **core:** Add ergonomic control over DX warnings ([#237](https://github.com/oorabona/db-semantic-planner/issues/237)) ([21c3d3b](https://github.com/oorabona/db-semantic-planner/commit/21c3d3b0c05796591a30660c8c5c3fe99391db46)), closes [#159](https://github.com/oorabona/db-semantic-planner/issues/159)
* **core:** Add isOverallSuccess() predicate for query success validation ([#96](https://github.com/oorabona/db-semantic-planner/issues/96)) ([0715c46](https://github.com/oorabona/db-semantic-planner/commit/0715c46f0c72098e130cabff3ea842e7399e9144))
* **core:** Add range operator helpers (rangeOverlaps/rangeContains/rangeContainedBy) ([#74](https://github.com/oorabona/db-semantic-planner/issues/74)) ([2c804da](https://github.com/oorabona/db-semantic-planner/commit/2c804da2e162f35eb4a9a17beefff308fa7d1d78))
* **core:** ADR-0003 rule-based schema-transition planner ([#348](https://github.com/oorabona/db-semantic-planner/issues/348)) ([6d41829](https://github.com/oorabona/db-semantic-planner/commit/6d418299f6a9700298aa67bbde56ac91ea42e268))
* **core:** Declare the transition target instead of guessing it ([#408](https://github.com/oorabona/db-semantic-planner/issues/408)) ([ea11e5b](https://github.com/oorabona/db-semantic-planner/commit/ea11e5b3b845b96512cf721eb6339cb902cd5911))
* **core:** Dump(meta?) API + fix obsolete .column() doc blocks ([#68](https://github.com/oorabona/db-semantic-planner/issues/68)) ([4cd24cd](https://github.com/oorabona/db-semantic-planner/commit/4cd24cd079e6fb6599b4345b6c7e5538ad9d82bf))
* **core:** Execute a reviewed plan against a target it can prove is the one ([#479](https://github.com/oorabona/db-semantic-planner/issues/479)) ([e89f2be](https://github.com/oorabona/db-semantic-planner/commit/e89f2bee7206aeb4f21e8b06adde18aa984beb58)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Expose inTransaction on OrmInstance ([#377](https://github.com/oorabona/db-semantic-planner/issues/377)) ([e843ac6](https://github.com/oorabona/db-semantic-planner/commit/e843ac6c959fda6a8d152f5b9b44ecc04ac6e5bc)), closes [#376](https://github.com/oorabona/db-semantic-planner/issues/376)
* **core:** Expose mutation rowCount via affectedRows() and executeWithMeta ([#362](https://github.com/oorabona/db-semantic-planner/issues/362)) ([#366](https://github.com/oorabona/db-semantic-planner/issues/366)) ([3ee7575](https://github.com/oorabona/db-semantic-planner/commit/3ee75752ef15a8c90e01903c1ad57fa3a2979b54))
* **core:** Extend schema DSL  method, opclass, with, where on indexes + CHECK + sequences + extensions ([488d552](https://github.com/oorabona/db-semantic-planner/commit/488d5523515321ea5326e021a10bc2b85a8b686b))
* **core:** Make a transition run's proven plan durable ([#416](https://github.com/oorabona/db-semantic-planner/issues/416)) ([acaa1b1](https://github.com/oorabona/db-semantic-planner/commit/acaa1b1f6cb4c3bf5cc9f824e69a531e2c62f592)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Mutations are keyed by the schema and their payloads are typed by the table ([#652](https://github.com/oorabona/db-semantic-planner/issues/652)) ([ce7b8f1](https://github.com/oorabona/db-semantic-planner/commit/ce7b8f1939101119e82d4c386ead2a168b0e4091))
* **core:** Observers observe, transformers preserve, and the execution port stops lying ([#645](https://github.com/oorabona/db-semantic-planner/issues/645)) ([0720c01](https://github.com/oorabona/db-semantic-planner/commit/0720c0179a13f09a54829efb672969f3c1ae7b76))
* **core:** Opt-in explicit-provenance bigint coercion for orm.raw() ([#359](https://github.com/oorabona/db-semantic-planner/issues/359)) ([#371](https://github.com/oorabona/db-semantic-planner/issues/371)) ([1c1fc10](https://github.com/oorabona/db-semantic-planner/commit/1c1fc1015513131e33aad77165e83c1962ec908a))
* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)
* **core:** Remove the legacy defineSchema and GeneratedSchema surface ([#312](https://github.com/oorabona/db-semantic-planner/issues/312)) ([f743b28](https://github.com/oorabona/db-semantic-planner/commit/f743b289200444e65e28bb6840df012d59710078))
* **core:** Support nulls-not-distinct indexes and external table refs ([be02788](https://github.com/oorabona/db-semantic-planner/commit/be027887d4e103cf904a755333c8451122c0390c))
* **core:** Thread FK referenced schema through the schema DSL ([887cad0](https://github.com/oorabona/db-semantic-planner/commit/887cad0f3e7d3b1913a07d6789ca7a7a314319b9)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Where() accepts branded predicates and rejects every other expression ([#635](https://github.com/oorabona/db-semantic-planner/issues/635)) ([5f8fceb](https://github.com/oorabona/db-semantic-planner/commit/5f8fceb78e249f1e2b2c3f079f46b595b44858b7))
* **gui:** Assertion runner + post-MVP polish ([b9af32c](https://github.com/oorabona/db-semantic-planner/commit/b9af32cbd13cd6eeed215c73cd540f013093a1c3))
* **lock:** E15 FOR UPDATE SKIP LOCKED  row-level locking for job queue pattern ([#11](https://github.com/oorabona/db-semantic-planner/issues/11)) ([6182459](https://github.com/oorabona/db-semantic-planner/commit/6182459e5b2daeda9fb752945e1f80162d164240))
* **nql:** Accept aliased mutation-RETURNING columns as typed read-bind snapshot sources ([#222](https://github.com/oorabona/db-semantic-planner/issues/222)) ([267936b](https://github.com/oorabona/db-semantic-planner/commit/267936bd04a26a80672ae19ad20a6bfbfffd9188))
* **nql:** General named parameters, tag binding, and nqlRaw() ([#165](https://github.com/oorabona/db-semantic-planner/issues/165)) ([905c323](https://github.com/oorabona/db-semantic-planner/commit/905c323f6a9a907dd39a86950e746d8dd5822a61)), closes [#134](https://github.com/oorabona/db-semantic-planner/issues/134)
* **nql:** Generalize read-bind snapshots to aliased, transitive, and count columns ([#218](https://github.com/oorabona/db-semantic-planner/issues/218)) ([0b4b315](https://github.com/oorabona/db-semantic-planner/commit/0b4b315a17427f358aa0f7dd076d0e1b152fdf07))
* **nql:** Snapshot read-only bindings referenced across an intervening mutation ([#212](https://github.com/oorabona/db-semantic-planner/issues/212)) ([00055eb](https://github.com/oorabona/db-semantic-planner/commit/00055eb6a15de86e1cd21ad01ec09b4eba76d9df)), closes [#186](https://github.com/oorabona/db-semantic-planner/issues/186)
* **nql:** Support binding-final tag queries ([#184](https://github.com/oorabona/db-semantic-planner/issues/184)) ([f4ccf6d](https://github.com/oorabona/db-semantic-planner/commit/f4ccf6d32a7c65afc9a1ada9506877a827f92c2a)), closes [#176](https://github.com/oorabona/db-semantic-planner/issues/176)
* **nql:** Support hasMany relation columns from a binding-final read ([#194](https://github.com/oorabona/db-semantic-planner/issues/194)) ([da0d49b](https://github.com/oorabona/db-semantic-planner/commit/da0d49b12e517e2f15676e17ef8809405cedbde2)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support include() hydration from a binding-final read ([#197](https://github.com/oorabona/db-semantic-planner/issues/197)) ([9e1a07d](https://github.com/oorabona/db-semantic-planner/commit/9e1a07da0f448474966542854cd56a2ec8da9d3a)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support manyToMany relation columns from a binding-final read ([#207](https://github.com/oorabona/db-semantic-planner/issues/207)) ([bf3a830](https://github.com/oorabona/db-semantic-planner/commit/bf3a830e73dcb229f6d13f5c7184d765f30a0044)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support multi-level include() from a binding-final read ([#198](https://github.com/oorabona/db-semantic-planner/issues/198)) ([831ddc7](https://github.com/oorabona/db-semantic-planner/commit/831ddc7360d4af30eab3ea2132b0cfea47ba279d)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support ordered multi-mutation tag programs ([#185](https://github.com/oorabona/db-semantic-planner/issues/185)) ([7ddebfa](https://github.com/oorabona/db-semantic-planner/commit/7ddebfa4b2c6c5f7a234c0f94e9dd98753c8074f)), closes [#173](https://github.com/oorabona/db-semantic-planner/issues/173)
* **nql:** Support relation filters from single-source binding reads ([#189](https://github.com/oorabona/db-semantic-planner/issues/189)) ([fb76c10](https://github.com/oorabona/db-semantic-planner/commit/fb76c10dc6540971524e87cae37d4f6e35df85d2)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support scalar multi-hop relation columns from a binding-final read ([#200](https://github.com/oorabona/db-semantic-planner/issues/200)) ([66062e3](https://github.com/oorabona/db-semantic-planner/commit/66062e3320d59540cbba4e8aeb329c2f0029ee44)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support scalar relation columns from single-source binding reads ([#191](https://github.com/oorabona/db-semantic-planner/issues/191)) ([f6d0ad4](https://github.com/oorabona/db-semantic-planner/commit/f6d0ad4eb50101f8270ad8b78320e63fa69f8c5f)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support tagged template mutations ([#175](https://github.com/oorabona/db-semantic-planner/issues/175)) ([c78e89e](https://github.com/oorabona/db-semantic-planner/commit/c78e89e00479359f67f50a3c00edf7fdc63aec18))
* **types,adapter:** Add partitioning support (block 7/8) ([6a30e71](https://github.com/oorabona/db-semantic-planner/commit/6a30e718f7c9ef251ec38a9b33d04a100ee22a4f))
* **types,adapter:** Add Row-Level Security policy support ([#29](https://github.com/oorabona/db-semantic-planner/issues/29)) ([1818d6f](https://github.com/oorabona/db-semantic-planner/commit/1818d6f77218b271f6d5aa182d942a2820dac742))
* **types,core,adapter:** Add ENUM type support (block 2/8) ([a03bcb6](https://github.com/oorabona/db-semantic-planner/commit/a03bcb67035e9c457c904f98602a737b9296f77d))
* **types,core,adapter:** Add join type to include()  inner/left ([#32](https://github.com/oorabona/db-semantic-planner/issues/32)) ([9a0889f](https://github.com/oorabona/db-semantic-planner/commit/9a0889fde774be9a40d1a3eda60cf6e45dff0eea))
* **types,core,adapter:** Add multi-adapter capability negotiation (CAPS) ([d490c62](https://github.com/oorabona/db-semantic-planner/commit/d490c628e142f2ad4baf85f71ded522f7d826f24))
* **types,core,adapter:** Add NamedArgExpr support for PG named parameters ([#31](https://github.com/oorabona/db-semantic-planner/issues/31)) ([6738367](https://github.com/oorabona/db-semantic-planner/commit/673836754732876e662b8c7d61ed03079926ce91))
* **types,core,adapter:** Add sequences and extensions (block 6/8) ([0cf551c](https://github.com/oorabona/db-semantic-planner/commit/0cf551ca392bd6080042c299a970c94d945f4f72))
* **types,core:** Add version-aware dialect capabilities ([4262be3](https://github.com/oorabona/db-semantic-planner/commit/4262be3a5d58800167acee23d827b77347ad60f2))
* **types:** Make CompiledQuery a constructor-only, runtime-branded capability ([#356](https://github.com/oorabona/db-semantic-planner/issues/356)) ([421ae11](https://github.com/oorabona/db-semantic-planner/commit/421ae113d52a71a96fb0be9efc0819ce75f78c4b)), closes [#353](https://github.com/oorabona/db-semantic-planner/issues/353)


### Bug Fixes

* **adapter-pgsql:** Emit CREATE INDEX without IF NOT EXISTS ([#483](https://github.com/oorabona/db-semantic-planner/issues/483)) ([b1c1863](https://github.com/oorabona/db-semantic-planner/commit/b1c1863a30b8944b687f63b4213700ad1b9702ec)), closes [#419](https://github.com/oorabona/db-semantic-planner/issues/419)
* **adapter-pgsql:** Expose full connectionless adapter ([#436](https://github.com/oorabona/db-semantic-planner/issues/436)) ([#440](https://github.com/oorabona/db-semantic-planner/issues/440)) ([53336bd](https://github.com/oorabona/db-semantic-planner/commit/53336bdb5fb0e877f0551655d69c01bfbeba89d8))
* **adapter-pgsql:** Identity-bound quarantine, faithful replay, exact sequence introspection ([#677](https://github.com/oorabona/db-semantic-planner/issues/677)) ([9c64e05](https://github.com/oorabona/db-semantic-planner/commit/9c64e05b62b72bc752bc72571c97d951f8a9abdb))
* **adapter-pgsql:** Ledger recovery outcomes are explicit, attempt-bound, and session-safe ([#548](https://github.com/oorabona/db-semantic-planner/issues/548)) ([0bab857](https://github.com/oorabona/db-semantic-planner/commit/0bab857d2434f88234ce07cb105fdcb7852202e1))
* **adapter-pgsql:** Multi-path join aliasing and result hydration ([#163](https://github.com/oorabona/db-semantic-planner/issues/163)) ([130f53f](https://github.com/oorabona/db-semantic-planner/commit/130f53f0630c5655ac13f8b755f8730c22c59b41)), closes [#154](https://github.com/oorabona/db-semantic-planner/issues/154)
* **adapter-pgsql:** Propagate DISTINCT flag through aggregate compilation ([f6dc756](https://github.com/oorabona/db-semantic-planner/commit/f6dc756f9d5f1eb63e35ff82fbf06409fa413614))
* **adapter-pgsql:** Session revocation is one core-owned latch per physical client ([#555](https://github.com/oorabona/db-semantic-planner/issues/555)) ([f115b95](https://github.com/oorabona/db-semantic-planner/commit/f115b953f2cce283d8b316dc25042fd4aa9b66d0))
* **adapter-pgsql:** Validate escape-hatch and DDL token surfaces against injection ([7487b7b](https://github.com/oorabona/db-semantic-planner/commit/7487b7b0f681c51984186c91b5aef63737ae15a8))
* **adapter,core:** Validate RLS policy expressions against SQL injection (P1) + export createDialectCapabilities in public API. 5 security regression tests. ([69e8134](https://github.com/oorabona/db-semantic-planner/commit/69e813440ea1931c95a7f1ded3d2fdf1cb04cca8))
* **adapter:** Fix 6 integration bugs blocking astix ORM migration ([#39](https://github.com/oorabona/db-semantic-planner/issues/39)) ([bc2a027](https://github.com/oorabona/db-semantic-planner/commit/bc2a027cefa860a66019c1448e73ad5c29754b4d))
* **adapter:** Resolve merge conflicts + delegate DDL to adapter (fix) ([ea1414b](https://github.com/oorabona/db-semantic-planner/commit/ea1414bcc0bd58207bfcbd112a7296a55820a39e))
* **adapter:** Review findings  JSDoc accuracy, toContain’toEqual in FTS+vector tests ([add0a6c](https://github.com/oorabona/db-semantic-planner/commit/add0a6cbbc8f43544612d62493cda502a95e7ff5))
* **cli:** Keep the database's indexes when regenerating a schema ([#306](https://github.com/oorabona/db-semantic-planner/issues/306)) ([7dcfaad](https://github.com/oorabona/db-semantic-planner/commit/7dcfaadf22b88f2c7f92cd38e973fa489f6ad772))
* **core,adapter:** 6 security/correctness bugs from multi-LLM review ([521471f](https://github.com/oorabona/db-semantic-planner/commit/521471f44cf17a1cb0fd6cf6a9bfe6422a97a78e))
* **core,adapter:** 7 astix gaps  rawExists, JOIN ON aliases/expressions, CTE+JOINs, selectExpression, op(subquery) ([540d283](https://github.com/oorabona/db-semantic-planner/commit/540d2839d85387133fd7e41bf98abca93a424227))
* **core,adapter:** Address 6 retroactive audit findings (security + correctness) ([5289149](https://github.com/oorabona/db-semantic-planner/commit/5289149989c1954965df6ba7d00a6398263183c9))
* **core,adapter:** BatchSet() now propagates .where() guard (Gap 1) + rawExists/rawNotExists types (Gap 2 partial) ([054d506](https://github.com/oorabona/db-semantic-planner/commit/054d506efe604d8c25d5c4147df0341bd7f156bb))
* **core,cli,docs:** Fk gate followups  bundle A2 ([#87](https://github.com/oorabona/db-semantic-planner/issues/87)) ([dc44d51](https://github.com/oorabona/db-semantic-planner/commit/dc44d5126d9e582879a9e3b48f0651a350ea06f0))
* **core,cli,docs:** Fk gate followups  bundle A2 ([#87](https://github.com/oorabona/db-semantic-planner/issues/87)) ([dc44d51](https://github.com/oorabona/db-semantic-planner/commit/dc44d5126d9e582879a9e3b48f0651a350ea06f0))
* **core,cli:** Fk gate followups  bundle A ([#86](https://github.com/oorabona/db-semantic-planner/issues/86)) ([ca35064](https://github.com/oorabona/db-semantic-planner/commit/ca350641307ea6de4c7acb8c2ae78655f791d1d5))
* **core,cli:** Fk gate followups  bundle A ([#86](https://github.com/oorabona/db-semantic-planner/issues/86)) ([ca35064](https://github.com/oorabona/db-semantic-planner/commit/ca350641307ea6de4c7acb8c2ae78655f791d1d5))
* **core:** Allow SET DEFAULT foreign-key actions in generated and manifest schemas ([fcb95c4](https://github.com/oorabona/db-semantic-planner/commit/fcb95c48545f607ba8d8e4b1fb060a93da5bd425)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Cascade LEFT JOIN in multi-hop flat include chains  prevent INNER JOIN on required relations from dropping parent rows when ancestor used LEFT JOIN. 3 regression tests. ([964855b](https://github.com/oorabona/db-semantic-planner/commit/964855b8f5c4bd008a80193528cf1ed7a2a5b686))
* **core:** Clearer error when nql template receives a mutation ([bb90c21](https://github.com/oorabona/db-semantic-planner/commit/bb90c21d489b3e54d2ff4cc53f66b75b142023b6))
* **core:** Close tier 2 semantic hygiene items across dx layer ([#58](https://github.com/oorabona/db-semantic-planner/issues/58)) ([607df08](https://github.com/oorabona/db-semantic-planner/commit/607df081611babc953eab65837985a6455b81fa2))
* **core:** Expose TableDDL helpers on orm.tables[] type ([cfac331](https://github.com/oorabona/db-semantic-planner/commit/cfac33166c0ffb43db88828526749b12837b2737))
* **core:** IN-to-EXISTS done properly + inline-EXISTS refactor ([db38526](https://github.com/oorabona/db-semantic-planner/commit/db3852655e870e328a23dee3c1eb117e252474d7))
* **core:** Keep local FK validation for external targets, reject uninferable external column type ([7775c80](https://github.com/oorabona/db-semantic-planner/commit/7775c80969529932a66e1dd80a7dee98f98ea5f3)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Leave a run pristine when a step is refused before any DDL ([#487](https://github.com/oorabona/db-semantic-planner/issues/487)) ([ca1501e](https://github.com/oorabona/db-semantic-planner/commit/ca1501e3b21117f685f7b97390a5b16ef6bbf6db)), closes [#476](https://github.com/oorabona/db-semantic-planner/issues/476) [#485](https://github.com/oorabona/db-semantic-planner/issues/485)
* **core:** Make wCount() field optional for COUNT(*) OVER() ([#34](https://github.com/oorabona/db-semantic-planner/issues/34)) ([44c1f8e](https://github.com/oorabona/db-semantic-planner/commit/44c1f8e54e9b217eeb90506505b78dad058e3d3e))
* **core:** Normalize object access in schema-bridge tests ([fc45f37](https://github.com/oorabona/db-semantic-planner/commit/fc45f376151c34b382b5801dc7a2deaf08c400a7))
* **core:** Preserve non-PK FK target columns through buildRefColumn ([#83](https://github.com/oorabona/db-semantic-planner/issues/83)) ([2fa5e1e](https://github.com/oorabona/db-semantic-planner/commit/2fa5e1eaf4254f58f947f9fa3c871a64d222fe8b))
* **core:** Preserve referenced columns and FK actions for same-schema FK round-trip ([3e3f814](https://github.com/oorabona/db-semantic-planner/commit/3e3f8141a523263ecb6f40fb9ba0743193edd44f)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Re-expose select() on OrmInstance type  fixes 683 TSC errors across test files. Remove 29 (orm as any) casts. ([9f6bb37](https://github.com/oorabona/db-semantic-planner/commit/9f6bb37b12ae9aa425d0be55e25e7e4f3a68bf48))
* **core:** Reminted lessors carry the source revocation capability across module instances ([#591](https://github.com/oorabona/db-semantic-planner/issues/591)) ([b730e94](https://github.com/oorabona/db-semantic-planner/commit/b730e949de83dfbd140684360f0ec2e14c55820b))
* **core:** Remove | undefined from hook composition return types  fixes TSC build errors ([7b1598d](https://github.com/oorabona/db-semantic-planner/commit/7b1598d3d3fc9018737b74e38f84ad34b3a122c7))
* **core:** Remove PostgreSQL-specific index-list fallback from DB-agnostic core ([e742ae0](https://github.com/oorabona/db-semantic-planner/commit/e742ae05c9bf91a5bf78ec7bfed18ccb02a2dc10))
* **core:** Reset LEFT JOIN cascade after explicit join override (Codex P2)  simplify cascade logic to use actual emitted join type, replace old tests with focused q4Schema regression tests ([b8e1822](https://github.com/oorabona/db-semantic-planner/commit/b8e1822b03355ce64a6306236b028778a9e996b1))
* **core:** Retro-audit 2026-04-21 (7 bundles, 35 S/M findings) ([#52](https://github.com/oorabona/db-semantic-planner/issues/52)) ([12faa40](https://github.com/oorabona/db-semantic-planner/commit/12faa40598a5d78728689e2c373d1537571656bc))
* **core:** Round-trip composite cross-schema foreign keys in getSchemaFromDb ([b99e2c9](https://github.com/oorabona/db-semantic-planner/commit/b99e2c902da49cc917d58871f9ca7fd883606af1)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Support foreign keys to external cross-schema tables ([e5908d5](https://github.com/oorabona/db-semantic-planner/commit/e5908d5fccb0245c084326fc8685099404f821b7)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** The typed path infers the row type and IndexMethod matches the runtime allowlist ([#622](https://github.com/oorabona/db-semantic-planner/issues/622)) ([72b8878](https://github.com/oorabona/db-semantic-planner/commit/72b8878657f9da8e338cd10a79ae5125e7220cd5))
* **core:** Type Schema.constraints and keep full FK metadata in getSchemaFromDb round-trip ([ee0c8f9](https://github.com/oorabona/db-semantic-planner/commit/ee0c8f95073b3dc65b0a9d79bb03f5e1d8c80dbd)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **core:** Validate cross-schema FKs by declaration, exclude them from relation inference ([72bbf5a](https://github.com/oorabona/db-semantic-planner/commit/72bbf5aceea0fe9aabe40774389ae3b75bf892ac)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* Launch-gating correctness & injection-hardening for 1.0.2 ([#135](https://github.com/oorabona/db-semantic-planner/issues/135)) ([cbcd22e](https://github.com/oorabona/db-semantic-planner/commit/cbcd22e2e105b9bb86a4496733442d70d05a28cc))
* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)
* Resolve post-force-push CI failures ([8720fd7](https://github.com/oorabona/db-semantic-planner/commit/8720fd767dae51cdfa01a1d17d0e52612dcb4e0d))
* Retro-audit 2026-04-19 realign across nql, types, adapter-pgsql ([#49](https://github.com/oorabona/db-semantic-planner/issues/49)) ([61bc1fa](https://github.com/oorabona/db-semantic-planner/commit/61bc1fa05a9daeec5fed64103e534ed9351ff66c))
* **tests:** Review fixes  6 E2E assertions, 43 TSC errors, Gap 1 test, like() overload ([f68d75a](https://github.com/oorabona/db-semantic-planner/commit/f68d75aac273fb9a42ba9fa99d9da097614fee35))
* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/nql bumped to 1.10.5
    * @dbsp/types bumped to 5.0.0
</details>

<details><summary>mcp-server: 2.0.8</summary>

## [2.0.8](https://github.com/oorabona/db-semantic-planner/compare/mcp-server-v2.0.7...mcp-server-v2.0.8) (2026-09-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/core bumped to 5.0.0
    * @dbsp/types bumped to 5.0.0
</details>

<details><summary>nql: 1.10.5</summary>

## [1.10.5](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.10.4...nql-v1.10.5) (2026-09-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 5.0.0
</details>

<details><summary>types: 5.0.0</summary>

## [5.0.0](https://github.com/oorabona/db-semantic-planner/compare/types-v4.0.0...types-v5.0.0) (2026-09-04)


###   BREAKING CHANGES

* **adapter-pgsql:** replayInvalidatedPlans is accepted only by pool-owning adapter constructors; borrowed-client and compile-only constructors reject it.
* **adapter-pgsql:** SequenceIR and schema DSL sequence fields (startWith, incrementBy, minValue, maxValue) accept number | string; strict decimal strings carry exact int64 values.
* **adapter-pgsql:** dbsp push and dbsp migrate removed. Use apply <run-id> to execute recorded plans or apply for unrecorded intents. CLI version 3.0.0.
* **adapter-pgsql:** dbsp no longer savepoints each statement inside a transaction it opened. PostgreSQL's own semantics stand  a failed statement poisons the transaction. 2.0.0 rolled back the one statement and committed the rest, turning a fail-closed database error into a durable partial business transaction; catching an error inside `transaction()` and continuing no longer works, and that is the point. A nested `transaction()` that was never awaited is refused rather than guessed about. `inTransaction` and `supportsTransactions` are now required members of the adapter contract: an adapter that cannot state whether a transaction is open is one dbsp will not run concurrent DDL through. A `PoolClient` must be declared with `borrowedClient: true`, and `introspect()` takes a `Pool`.
* **adapter-pgsql:** Removed the deprecated exports. From @dbsp/adapter-pgsql: acquireMigrationLock and releaseMigrationLock  use withMigrationLock, which holds and releases the lock on a single connection. From @dbsp/cli: generateSchemaFile and the deprecated warnings option on its codegen interface  use generateSchemaFileWithDiagnostics, which returns the generated code together with every warning, so no diagnostic can be lost silently. From @dbsp/types: the ScalarSubqueryIntent alias  use QueryIntent. The string-based orm.select('table') is NOT deprecated and is not going anywhere.
* **core:** The legacy schema surface is gone. Removed from @dbsp/core: defineSchema, ResolvedSchema and its Schema* definition types, isBelongsTo, isHasMany, isManyToMany, DEFAULT_CONVENTIONS, detectForeignKeys, detectManyToMany, inferRelationsFromSchema, OrmOptionsWithSchema, GeneratedSchema and its Generated* types, ColumnTypeToTS, InferRowType, InferDBFromSchema, buildModelFromSchema, buildModelFromResolvedSchema, isGeneratedSchema, isResolvedSchema, normalizeSchema, ResolvedSchemaValidation, ValidatedResolvedSchema, SchemaConversionResult, resolvedSchemaToGeneratedSchema and assertResolvedSchemaToGeneratedSchema. Removed from @dbsp/cli: generateManifest and its manifest types. The exported name SchemaColumnType now refers to the IR column-type union, which is wider than the legacy DSL union it used to name  it gains number and datetime. Define schemas with schema() and ref() from @dbsp/core.

### Features

* **adapter-pgsql:** Abort a pool-owned transaction via AbortSignal ([#363](https://github.com/oorabona/db-semantic-planner/issues/363)) ([#369](https://github.com/oorabona/db-semantic-planner/issues/369)) ([e61d4b5](https://github.com/oorabona/db-semantic-planner/commit/e61d4b58ec1790b86497fd8d8fb15e7ca1aabc07))
* **adapter-pgsql:** Add transaction isolation, access mode & timeouts ([#360](https://github.com/oorabona/db-semantic-planner/issues/360), [#361](https://github.com/oorabona/db-semantic-planner/issues/361)) ([#368](https://github.com/oorabona/db-semantic-planner/issues/368)) ([74cc335](https://github.com/oorabona/db-semantic-planner/commit/74cc33511d7e501b7bea8915e68bf8955ec9efc4))
* **adapter-pgsql:** Add withPinnedConnection for a bounded pinned-connection scope ([#341](https://github.com/oorabona/db-semantic-planner/issues/341)) ([#373](https://github.com/oorabona/db-semantic-planner/issues/373)) ([c1bdc7d](https://github.com/oorabona/db-semantic-planner/commit/c1bdc7d9e8a5e3388f86264b292a7849a61f659b))
* **adapter-pgsql:** Apply isolation and timeout options to the streaming BEGIN ([#364](https://github.com/oorabona/db-semantic-planner/issues/364)) ([#372](https://github.com/oorabona/db-semantic-planner/issues/372)) ([6dbf579](https://github.com/oorabona/db-semantic-planner/commit/6dbf57970733848bf5689725040fa6888af940fd))
* **adapter-pgsql:** Canonical payload digests and exact int64 sequence contracts ([#672](https://github.com/oorabona/db-semantic-planner/issues/672)) ([afa6d24](https://github.com/oorabona/db-semantic-planner/commit/afa6d24f6902cd68ced15e02aefe737ad4cc362a))
* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)
* **adapter-pgsql:** Deterministically order include json_agg arrays by primary key ([#203](https://github.com/oorabona/db-semantic-planner/issues/203)) ([8e6da3a](https://github.com/oorabona/db-semantic-planner/commit/8e6da3a035c292a36ac98cf1ef18a76203ecfa51)), closes [#196](https://github.com/oorabona/db-semantic-planner/issues/196)
* **adapter-pgsql:** Drop the deprecated surface, and prove orm.from() works ([#316](https://github.com/oorabona/db-semantic-planner/issues/316)) ([c3f4871](https://github.com/oorabona/db-semantic-planner/commit/c3f48719bd1ca10877561da6faa2acecbe9ba684))
* **adapter-pgsql:** Gate NQL text surface by dialect capabilities ([#187](https://github.com/oorabona/db-semantic-planner/issues/187)) ([f536b9a](https://github.com/oorabona/db-semantic-planner/commit/f536b9a809f627007fc2586d66e87e8aa3060cd5)), closes [#183](https://github.com/oorabona/db-semantic-planner/issues/183)
* **adapter-pgsql:** Make a recorded plan describe a target it can identify ([#435](https://github.com/oorabona/db-semantic-planner/issues/435)) ([5217c4a](https://github.com/oorabona/db-semantic-planner/commit/5217c4ab3491f0a54aa2878adeca50383e47273e)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **adapter-pgsql:** Make schema a required argument on the DDL generator port ([#331](https://github.com/oorabona/db-semantic-planner/issues/331)) ([#375](https://github.com/oorabona/db-semantic-planner/issues/375)) ([d106f9e](https://github.com/oorabona/db-semantic-planner/commit/d106f9e0534cf0a70215f0f6d562f596ba64514b))
* **adapter-pgsql:** Managed-state ledger delivery 2  admission, recovery, destructive authority ([#516](https://github.com/oorabona/db-semantic-planner/issues/516)) ([d5979c0](https://github.com/oorabona/db-semantic-planner/commit/d5979c0d7184ffb8b66ca4f9ddc1b148dd2c22b9))
* **adapter-pgsql:** The caller declares who owns the connection ([#330](https://github.com/oorabona/db-semantic-planner/issues/330)) ([8077cd2](https://github.com/oorabona/db-semantic-planner/commit/8077cd249452ca30ac003dbb4470d1002397e89a)), closes [#325](https://github.com/oorabona/db-semantic-planner/issues/325)
* **adapter-pgsql:** Version-gate index features via ADR-0003 capability model ([#349](https://github.com/oorabona/db-semantic-planner/issues/349)) ([618f07b](https://github.com/oorabona/db-semantic-planner/commit/618f07b69968b988a005627568b8da6f9bc27937)), closes [#245](https://github.com/oorabona/db-semantic-planner/issues/245)
* **adapter,core,nql:** Add ANY() operator and batch INSERT via unnest (blocks 1-2) ([b7bbbad](https://github.com/oorabona/db-semantic-planner/commit/b7bbbadf6a3837bd6c59b5298bff0976f9bfd8b8))
* **adapter,core,types:** Add CTE with unnest builder and WITH ORDINALITY (block 5) ([6ef4bec](https://github.com/oorabona/db-semantic-planner/commit/6ef4bec0696a841c8ab0b1ef28f9e2dfe762ed34))
* **adapter,core,types:** Batch TRIVIAL/SIMPLE tasks  6 features + docs ([#28](https://github.com/oorabona/db-semantic-planner/issues/28)) ([9430203](https://github.com/oorabona/db-semantic-planner/commit/943020324a8727813c6ab1b7774b8f04b3df28b1))
* **adapter,core:** Add batch UPDATE via unnest FROM strategy (block 3) ([feb0514](https://github.com/oorabona/db-semantic-planner/commit/feb0514529adccd039abc8d26c8797689c16e2fa))
* **adapter,core:** Add FILTER clause support in aggregate expressions ([18a3d7a](https://github.com/oorabona/db-semantic-planner/commit/18a3d7a64c73636eb14f3de0dc714f031ec40837))
* **core,adapter:** Add .join() API  manual joins with explicit ON condition ([0d7cb4c](https://github.com/oorabona/db-semantic-planner/commit/0d7cb4c70807f6ac0656ded357b6a57fd8c07b97))
* **core,adapter:** Add catalog helpers  indexes.exists(), indexes.list(pattern), storageSize() ([7e05cf0](https://github.com/oorabona/db-semantic-planner/commit/7e05cf0c80c67af8901cc4afc547efd52862f48c))
* **core,adapter:** Add generic expression primitives and pgvector extension ([#23](https://github.com/oorabona/db-semantic-planner/issues/23)) ([e2ae011](https://github.com/oorabona/db-semantic-planner/commit/e2ae0112279bb358c69caa618eb94be2f25f47a6))
* **core,adapter:** Add star() and array() expression primitives ([#38](https://github.com/oorabona/db-semantic-planner/issues/38)) ([28fc520](https://github.com/oorabona/db-semantic-planner/commit/28fc520489f4f724d8c1f25e5719c831c39b1f55))
* **core,adapter:** Add table-scoped DDL helpers  truncate, vacuum, alterColumn, indexes ([d8f9227](https://github.com/oorabona/db-semantic-planner/commit/d8f9227990188c1d14c24e685bbf73d7a3590887))
* **core,adapter:** AggOrderBy in fn() + arrayAgg/stringAgg helpers ([6ef2a08](https://github.com/oorabona/db-semantic-planner/commit/6ef2a0877ee6324105e3d03a278663b55d402dc0))
* **core,adapter:** BatchValues, vector search, fullTextSearch, recursive CTE ([2886676](https://github.com/oorabona/db-semantic-planner/commit/288667687419001d52c32e7c11bc7b015ed4c70f))
* **core:** ADR-0003 rule-based schema-transition planner ([#348](https://github.com/oorabona/db-semantic-planner/issues/348)) ([6d41829](https://github.com/oorabona/db-semantic-planner/commit/6d418299f6a9700298aa67bbde56ac91ea42e268))
* **core:** Declare the transition target instead of guessing it ([#408](https://github.com/oorabona/db-semantic-planner/issues/408)) ([ea11e5b](https://github.com/oorabona/db-semantic-planner/commit/ea11e5b3b845b96512cf721eb6339cb902cd5911))
* **core:** Execute a reviewed plan against a target it can prove is the one ([#479](https://github.com/oorabona/db-semantic-planner/issues/479)) ([e89f2be](https://github.com/oorabona/db-semantic-planner/commit/e89f2bee7206aeb4f21e8b06adde18aa984beb58)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Expose mutation rowCount via affectedRows() and executeWithMeta ([#362](https://github.com/oorabona/db-semantic-planner/issues/362)) ([#366](https://github.com/oorabona/db-semantic-planner/issues/366)) ([3ee7575](https://github.com/oorabona/db-semantic-planner/commit/3ee75752ef15a8c90e01903c1ad57fa3a2979b54))
* **core:** Make a transition run's proven plan durable ([#416](https://github.com/oorabona/db-semantic-planner/issues/416)) ([acaa1b1](https://github.com/oorabona/db-semantic-planner/commit/acaa1b1f6cb4c3bf5cc9f824e69a531e2c62f592)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Observers observe, transformers preserve, and the execution port stops lying ([#645](https://github.com/oorabona/db-semantic-planner/issues/645)) ([0720c01](https://github.com/oorabona/db-semantic-planner/commit/0720c0179a13f09a54829efb672969f3c1ae7b76))
* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)
* **core:** Remove the legacy defineSchema and GeneratedSchema surface ([#312](https://github.com/oorabona/db-semantic-planner/issues/312)) ([f743b28](https://github.com/oorabona/db-semantic-planner/commit/f743b289200444e65e28bb6840df012d59710078))
* **core:** Support nulls-not-distinct indexes and external table refs ([be02788](https://github.com/oorabona/db-semantic-planner/commit/be027887d4e103cf904a755333c8451122c0390c))
* **core:** Where() accepts branded predicates and rejects every other expression ([#635](https://github.com/oorabona/db-semantic-planner/issues/635)) ([5f8fceb](https://github.com/oorabona/db-semantic-planner/commit/5f8fceb78e249f1e2b2c3f079f46b595b44858b7))
* **lock:** E15 FOR UPDATE SKIP LOCKED  row-level locking for job queue pattern ([#11](https://github.com/oorabona/db-semantic-planner/issues/11)) ([6182459](https://github.com/oorabona/db-semantic-planner/commit/6182459e5b2daeda9fb752945e1f80162d164240))
* **nql:** CTE syntax (WITH name AS (query) mainQuery). SimpleCteIntent type, lexer With token, parser grammar, visitor, compiler with ColumnValidator CTE bypass, adapter simpleCte handler. 10 tests. ([ead6a1f](https://github.com/oorabona/db-semantic-planner/commit/ead6a1fceafbf247d09814fc29e8167dea60d404))
* **nql:** General named parameters, tag binding, and nqlRaw() ([#165](https://github.com/oorabona/db-semantic-planner/issues/165)) ([905c323](https://github.com/oorabona/db-semantic-planner/commit/905c323f6a9a907dd39a86950e746d8dd5822a61)), closes [#134](https://github.com/oorabona/db-semantic-planner/issues/134)
* **nql:** Generalize read-bind snapshots to aliased, transitive, and count columns ([#218](https://github.com/oorabona/db-semantic-planner/issues/218)) ([0b4b315](https://github.com/oorabona/db-semantic-planner/commit/0b4b315a17427f358aa0f7dd076d0e1b152fdf07))
* **nql:** Recursive self-referential relation columns from a binding-final read ([#209](https://github.com/oorabona/db-semantic-planner/issues/209)) ([047ff3c](https://github.com/oorabona/db-semantic-planner/commit/047ff3c29dd786864061d884ef2054db25e90053)), closes [#193](https://github.com/oorabona/db-semantic-planner/issues/193)
* **nql:** Snapshot read-only bindings referenced across an intervening mutation ([#212](https://github.com/oorabona/db-semantic-planner/issues/212)) ([00055eb](https://github.com/oorabona/db-semantic-planner/commit/00055eb6a15de86e1cd21ad01ec09b4eba76d9df)), closes [#186](https://github.com/oorabona/db-semantic-planner/issues/186)
* **nql:** Support binding-final tag queries ([#184](https://github.com/oorabona/db-semantic-planner/issues/184)) ([f4ccf6d](https://github.com/oorabona/db-semantic-planner/commit/f4ccf6d32a7c65afc9a1ada9506877a827f92c2a)), closes [#176](https://github.com/oorabona/db-semantic-planner/issues/176)
* **nql:** Support hasMany relation columns from a binding-final read ([#194](https://github.com/oorabona/db-semantic-planner/issues/194)) ([da0d49b](https://github.com/oorabona/db-semantic-planner/commit/da0d49b12e517e2f15676e17ef8809405cedbde2)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support include() hydration from a binding-final read ([#197](https://github.com/oorabona/db-semantic-planner/issues/197)) ([9e1a07d](https://github.com/oorabona/db-semantic-planner/commit/9e1a07da0f448474966542854cd56a2ec8da9d3a)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support manyToMany relation columns from a binding-final read ([#207](https://github.com/oorabona/db-semantic-planner/issues/207)) ([bf3a830](https://github.com/oorabona/db-semantic-planner/commit/bf3a830e73dcb229f6d13f5c7184d765f30a0044)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support multi-level include() from a binding-final read ([#198](https://github.com/oorabona/db-semantic-planner/issues/198)) ([831ddc7](https://github.com/oorabona/db-semantic-planner/commit/831ddc7360d4af30eab3ea2132b0cfea47ba279d)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support ordered multi-mutation tag programs ([#185](https://github.com/oorabona/db-semantic-planner/issues/185)) ([7ddebfa](https://github.com/oorabona/db-semantic-planner/commit/7ddebfa4b2c6c5f7a234c0f94e9dd98753c8074f)), closes [#173](https://github.com/oorabona/db-semantic-planner/issues/173)
* **nql:** Support relation filters from single-source binding reads ([#189](https://github.com/oorabona/db-semantic-planner/issues/189)) ([fb76c10](https://github.com/oorabona/db-semantic-planner/commit/fb76c10dc6540971524e87cae37d4f6e35df85d2)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support scalar multi-hop relation columns from a binding-final read ([#200](https://github.com/oorabona/db-semantic-planner/issues/200)) ([66062e3](https://github.com/oorabona/db-semantic-planner/commit/66062e3320d59540cbba4e8aeb329c2f0029ee44)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support scalar relation columns from single-source binding reads ([#191](https://github.com/oorabona/db-semantic-planner/issues/191)) ([f6d0ad4](https://github.com/oorabona/db-semantic-planner/commit/f6d0ad4eb50101f8270ad8b78320e63fa69f8c5f)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support tagged template mutations ([#175](https://github.com/oorabona/db-semantic-planner/issues/175)) ([c78e89e](https://github.com/oorabona/db-semantic-planner/commit/c78e89e00479359f67f50a3c00edf7fdc63aec18))
* **types,adapter:** Add advanced index support (block 3/8) ([9dc03cb](https://github.com/oorabona/db-semantic-planner/commit/9dc03cbc2f1c81440b12a5b8653e976b6dd1b394))
* **types,adapter:** Add CHECK constraint support (block 1/8) ([6beb061](https://github.com/oorabona/db-semantic-planner/commit/6beb06165985ec67401997ef5d4b72edd34df1ea))
* **types,adapter:** Add collation, identity, comments (block 5/8) ([c73c159](https://github.com/oorabona/db-semantic-planner/commit/c73c159ed32d62074f324f5ea42326502a08640e))
* **types,adapter:** Add FK onUpdate, deferred, auto-index (block 4/8) ([edad413](https://github.com/oorabona/db-semantic-planner/commit/edad413262a6bba64733855fdb636f8e79481f78))
* **types,adapter:** Add partitioning support (block 7/8) ([6a30e71](https://github.com/oorabona/db-semantic-planner/commit/6a30e718f7c9ef251ec38a9b33d04a100ee22a4f))
* **types,adapter:** Add Row-Level Security policy support ([#29](https://github.com/oorabona/db-semantic-planner/issues/29)) ([1818d6f](https://github.com/oorabona/db-semantic-planner/commit/1818d6f77218b271f6d5aa182d942a2820dac742))
* **types,core,adapter:** Add ENUM type support (block 2/8) ([a03bcb6](https://github.com/oorabona/db-semantic-planner/commit/a03bcb67035e9c457c904f98602a737b9296f77d))
* **types,core,adapter:** Add join type to include()  inner/left ([#32](https://github.com/oorabona/db-semantic-planner/issues/32)) ([9a0889f](https://github.com/oorabona/db-semantic-planner/commit/9a0889fde774be9a40d1a3eda60cf6e45dff0eea))
* **types,core,adapter:** Add multi-adapter capability negotiation (CAPS) ([d490c62](https://github.com/oorabona/db-semantic-planner/commit/d490c628e142f2ad4baf85f71ded522f7d826f24))
* **types,core,adapter:** Add NamedArgExpr support for PG named parameters ([#31](https://github.com/oorabona/db-semantic-planner/issues/31)) ([6738367](https://github.com/oorabona/db-semantic-planner/commit/673836754732876e662b8c7d61ed03079926ce91))
* **types,core,adapter:** Add sequences and extensions (block 6/8) ([0cf551c](https://github.com/oorabona/db-semantic-planner/commit/0cf551ca392bd6080042c299a970c94d945f4f72))
* **types,core:** Add version-aware dialect capabilities ([4262be3](https://github.com/oorabona/db-semantic-planner/commit/4262be3a5d58800167acee23d827b77347ad60f2))
* **types:** Add optional referenced schema to ForeignKeyIR ([51684b0](https://github.com/oorabona/db-semantic-planner/commit/51684b0ebde28c5de941fc747a9fb3ecb7bb5cd5)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **types:** Carry introspected unique-constraint name on ColumnIR ([f79f126](https://github.com/oorabona/db-semantic-planner/commit/f79f126d8cb8d13bc0509b7a5de4097fba36a439)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **types:** Make CompiledQuery a constructor-only, runtime-branded capability ([#356](https://github.com/oorabona/db-semantic-planner/issues/356)) ([421ae11](https://github.com/oorabona/db-semantic-planner/commit/421ae113d52a71a96fb0be9efc0819ce75f78c4b)), closes [#353](https://github.com/oorabona/db-semantic-planner/issues/353)


### Bug Fixes

* **adapter-pgsql:** Expose full connectionless adapter ([#436](https://github.com/oorabona/db-semantic-planner/issues/436)) ([#440](https://github.com/oorabona/db-semantic-planner/issues/440)) ([53336bd](https://github.com/oorabona/db-semantic-planner/commit/53336bdb5fb0e877f0551655d69c01bfbeba89d8))
* **adapter-pgsql:** Identity-bound quarantine, faithful replay, exact sequence introspection ([#677](https://github.com/oorabona/db-semantic-planner/issues/677)) ([9c64e05](https://github.com/oorabona/db-semantic-planner/commit/9c64e05b62b72bc752bc72571c97d951f8a9abdb))
* **adapter-pgsql:** Ledger recovery outcomes are explicit, attempt-bound, and session-safe ([#548](https://github.com/oorabona/db-semantic-planner/issues/548)) ([0bab857](https://github.com/oorabona/db-semantic-planner/commit/0bab857d2434f88234ce07cb105fdcb7852202e1))
* **adapter-pgsql:** Let PostgreSQL canonicalise CHECK expressions so migrations converge ([#335](https://github.com/oorabona/db-semantic-planner/issues/335)) ([5cbed9c](https://github.com/oorabona/db-semantic-planner/commit/5cbed9c663afec724a62f738429f67287ec8e44a))
* **adapter-pgsql:** Propagate DISTINCT flag through aggregate compilation ([f6dc756](https://github.com/oorabona/db-semantic-planner/commit/f6dc756f9d5f1eb63e35ff82fbf06409fa413614))
* **adapter-pgsql:** Schema-aware custom type identity for multi-tenant DDL ([#304](https://github.com/oorabona/db-semantic-planner/issues/304)) ([5e16d79](https://github.com/oorabona/db-semantic-planner/commit/5e16d7948d47ff4f2311043f56bf46f3a1e4c6df)), closes [#285](https://github.com/oorabona/db-semantic-planner/issues/285)
* **adapter:** Resolve merge conflicts + delegate DDL to adapter (fix) ([ea1414b](https://github.com/oorabona/db-semantic-planner/commit/ea1414bcc0bd58207bfcbd112a7296a55820a39e))
* **cli:** Keep the database's indexes when regenerating a schema ([#306](https://github.com/oorabona/db-semantic-planner/issues/306)) ([7dcfaad](https://github.com/oorabona/db-semantic-planner/commit/7dcfaadf22b88f2c7f92cd38e973fa489f6ad772))
* **core,adapter:** 7 astix gaps  rawExists, JOIN ON aliases/expressions, CTE+JOINs, selectExpression, op(subquery) ([540d283](https://github.com/oorabona/db-semantic-planner/commit/540d2839d85387133fd7e41bf98abca93a424227))
* **core,adapter:** BatchSet() now propagates .where() guard (Gap 1) + rawExists/rawNotExists types (Gap 2 partial) ([054d506](https://github.com/oorabona/db-semantic-planner/commit/054d506efe604d8c25d5c4147df0341bd7f156bb))
* **core:** Close tier 2 semantic hygiene items across dx layer ([#58](https://github.com/oorabona/db-semantic-planner/issues/58)) ([607df08](https://github.com/oorabona/db-semantic-planner/commit/607df081611babc953eab65837985a6455b81fa2))
* **core:** IN-to-EXISTS done properly + inline-EXISTS refactor ([db38526](https://github.com/oorabona/db-semantic-planner/commit/db3852655e870e328a23dee3c1eb117e252474d7))
* **core:** Retro-audit 2026-04-21 (7 bundles, 35 S/M findings) ([#52](https://github.com/oorabona/db-semantic-planner/issues/52)) ([12faa40](https://github.com/oorabona/db-semantic-planner/commit/12faa40598a5d78728689e2c373d1537571656bc))
* **core:** The typed path infers the row type and IndexMethod matches the runtime allowlist ([#622](https://github.com/oorabona/db-semantic-planner/issues/622)) ([72b8878](https://github.com/oorabona/db-semantic-planner/commit/72b8878657f9da8e338cd10a79ae5125e7220cd5))
* **docs:** Drive doctest failures from 173 to 0 across all doc buckets ([df34789](https://github.com/oorabona/db-semantic-planner/commit/df34789692dc101ef3a021cf20c6a1c957a9e3ac))
* **mcp-server:** Accept the same schema format as the CLI ([#311](https://github.com/oorabona/db-semantic-planner/issues/311)) ([b25fed4](https://github.com/oorabona/db-semantic-planner/commit/b25fed40fbda2e19e114b6981bc133c070322ae0))
* **nql:** Emit aliased mutation RETURNING through the source column ([#220](https://github.com/oorabona/db-semantic-planner/issues/220)) ([f4213a0](https://github.com/oorabona/db-semantic-planner/commit/f4213a0f3e23463b5a8f48e379d4ade9ce516232))
* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)
* Retro-audit 2026-04-19 realign across nql, types, adapter-pgsql ([#49](https://github.com/oorabona/db-semantic-planner/issues/49)) ([61bc1fa](https://github.com/oorabona/db-semantic-planner/commit/61bc1fa05a9daeec5fed64103e534ed9351ff66c))
* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))
* **types:** Unify dbType metadata, tighten CompileOnlyAdapter, preserve adapter config ([#46](https://github.com/oorabona/db-semantic-planner/issues/46)) ([d9f82a5](https://github.com/oorabona/db-semantic-planner/commit/d9f82a55a5c91cff375b96aca41b20c6c1d203e2))
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).