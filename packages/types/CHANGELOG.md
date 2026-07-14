# Changelog

## [2.0.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.9.0...types-v2.0.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* **types:** `BaseAdapter` now requires `inTransaction: boolean`, and transaction-capable adapters must declare `capabilities.supportsTransactions: true`; dbsp treats these as explicit adapter facts rather than inferring them from optional methods.
* **adapter-pgsql:** Removed the deprecated exports. From @dbsp/adapter-pgsql: acquireMigrationLock and releaseMigrationLock — use withMigrationLock, which holds and releases the lock on a single connection. From @dbsp/cli: generateSchemaFile and the deprecated warnings option on its codegen interface — use generateSchemaFileWithDiagnostics, which returns the generated code together with every warning, so no diagnostic can be lost silently. From @dbsp/types: the ScalarSubqueryIntent alias — use QueryIntent. The string-based orm.select('table') is NOT deprecated and is not going anywhere.
* **core:** The legacy schema surface is gone. Removed from @dbsp/core: defineSchema, ResolvedSchema and its Schema* definition types, isBelongsTo, isHasMany, isManyToMany, DEFAULT_CONVENTIONS, detectForeignKeys, detectManyToMany, inferRelationsFromSchema, OrmOptionsWithSchema, GeneratedSchema and its Generated* types, ColumnTypeToTS, InferRowType, InferDBFromSchema, buildModelFromSchema, buildModelFromResolvedSchema, isGeneratedSchema, isResolvedSchema, normalizeSchema, ResolvedSchemaValidation, ValidatedResolvedSchema, SchemaConversionResult, resolvedSchemaToGeneratedSchema and assertResolvedSchemaToGeneratedSchema. Removed from @dbsp/cli: generateManifest and its manifest types. The exported name SchemaColumnType now refers to the IR column-type union, which is wider than the legacy DSL union it used to name — it gains number and datetime. Define schemas with schema() and ref() from @dbsp/core.

### Features

* **adapter-pgsql:** Drop the deprecated surface, and prove orm.from() works ([#316](https://github.com/oorabona/db-semantic-planner/issues/316)) ([c3f4871](https://github.com/oorabona/db-semantic-planner/commit/c3f48719bd1ca10877561da6faa2acecbe9ba684))
* **core:** Remove the legacy defineSchema and GeneratedSchema surface ([#312](https://github.com/oorabona/db-semantic-planner/issues/312)) ([f743b28](https://github.com/oorabona/db-semantic-planner/commit/f743b289200444e65e28bb6840df012d59710078))


### Bug Fixes

* **adapter-pgsql:** Schema-aware custom type identity for multi-tenant DDL ([#304](https://github.com/oorabona/db-semantic-planner/issues/304)) ([5e16d79](https://github.com/oorabona/db-semantic-planner/commit/5e16d7948d47ff4f2311043f56bf46f3a1e4c6df)), closes [#285](https://github.com/oorabona/db-semantic-planner/issues/285)
* **cli:** Keep the database's indexes when regenerating a schema ([#306](https://github.com/oorabona/db-semantic-planner/issues/306)) ([7dcfaad](https://github.com/oorabona/db-semantic-planner/commit/7dcfaadf22b88f2c7f92cd38e973fa489f6ad772))
* **mcp-server:** Accept the same schema format as the CLI ([#311](https://github.com/oorabona/db-semantic-planner/issues/311)) ([b25fed4](https://github.com/oorabona/db-semantic-planner/commit/b25fed40fbda2e19e114b6981bc133c070322ae0))

## [1.9.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.8.1...types-v1.9.0) (2026-07-09)


### Features

* **types:** Add optional referenced schema to ForeignKeyIR ([51684b0](https://github.com/oorabona/db-semantic-planner/commit/51684b0ebde28c5de941fc747a9fb3ecb7bb5cd5)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)
* **types:** Carry introspected unique-constraint name on ColumnIR ([f79f126](https://github.com/oorabona/db-semantic-planner/commit/f79f126d8cb8d13bc0509b7a5de4097fba36a439)), closes [#265](https://github.com/oorabona/db-semantic-planner/issues/265)

## [1.8.1](https://github.com/oorabona/db-semantic-planner/compare/types-v1.8.0...types-v1.8.1) (2026-07-07)


### Bug Fixes

* **adapter-pgsql:** Propagate DISTINCT flag through aggregate compilation ([f6dc756](https://github.com/oorabona/db-semantic-planner/commit/f6dc756f9d5f1eb63e35ff82fbf06409fa413614))

## [1.8.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.7.1...types-v1.8.0) (2026-07-06)


### Features

* **core:** Support nulls-not-distinct indexes and external table refs ([be02788](https://github.com/oorabona/db-semantic-planner/commit/be027887d4e103cf904a755333c8451122c0390c))


### Bug Fixes

* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)

## [1.7.1](https://github.com/oorabona/db-semantic-planner/compare/types-v1.7.0...types-v1.7.1) (2026-07-03)


### Bug Fixes

* **nql:** Emit aliased mutation RETURNING through the source column ([#220](https://github.com/oorabona/db-semantic-planner/issues/220)) ([f4213a0](https://github.com/oorabona/db-semantic-planner/commit/f4213a0f3e23463b5a8f48e379d4ade9ce516232))

## [1.7.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.6.0...types-v1.7.0) (2026-07-02)


### Features

* **nql:** Generalize read-bind snapshots to aliased, transitive, and count columns ([#218](https://github.com/oorabona/db-semantic-planner/issues/218)) ([0b4b315](https://github.com/oorabona/db-semantic-planner/commit/0b4b315a17427f358aa0f7dd076d0e1b152fdf07))

## [1.6.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.5.0...types-v1.6.0) (2026-06-20)


### Features

* **nql:** Recursive self-referential relation columns from a binding-final read ([#209](https://github.com/oorabona/db-semantic-planner/issues/209)) ([047ff3c](https://github.com/oorabona/db-semantic-planner/commit/047ff3c29dd786864061d884ef2054db25e90053)), closes [#193](https://github.com/oorabona/db-semantic-planner/issues/193)
* **nql:** Snapshot read-only bindings referenced across an intervening mutation ([#212](https://github.com/oorabona/db-semantic-planner/issues/212)) ([00055eb](https://github.com/oorabona/db-semantic-planner/commit/00055eb6a15de86e1cd21ad01ec09b4eba76d9df)), closes [#186](https://github.com/oorabona/db-semantic-planner/issues/186)
* **nql:** Support manyToMany relation columns from a binding-final read ([#207](https://github.com/oorabona/db-semantic-planner/issues/207)) ([bf3a830](https://github.com/oorabona/db-semantic-planner/commit/bf3a830e73dcb229f6d13f5c7184d765f30a0044)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)

## [1.5.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.4.0...types-v1.5.0) (2026-06-20)


### Features

* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)
* **adapter-pgsql:** Deterministically order include json_agg arrays by primary key ([#203](https://github.com/oorabona/db-semantic-planner/issues/203)) ([8e6da3a](https://github.com/oorabona/db-semantic-planner/commit/8e6da3a035c292a36ac98cf1ef18a76203ecfa51)), closes [#196](https://github.com/oorabona/db-semantic-planner/issues/196)
* **nql:** Support hasMany relation columns from a binding-final read ([#194](https://github.com/oorabona/db-semantic-planner/issues/194)) ([da0d49b](https://github.com/oorabona/db-semantic-planner/commit/da0d49b12e517e2f15676e17ef8809405cedbde2)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support include() hydration from a binding-final read ([#197](https://github.com/oorabona/db-semantic-planner/issues/197)) ([9e1a07d](https://github.com/oorabona/db-semantic-planner/commit/9e1a07da0f448474966542854cd56a2ec8da9d3a)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support multi-level include() from a binding-final read ([#198](https://github.com/oorabona/db-semantic-planner/issues/198)) ([831ddc7](https://github.com/oorabona/db-semantic-planner/commit/831ddc7360d4af30eab3ea2132b0cfea47ba279d)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support scalar multi-hop relation columns from a binding-final read ([#200](https://github.com/oorabona/db-semantic-planner/issues/200)) ([66062e3](https://github.com/oorabona/db-semantic-planner/commit/66062e3320d59540cbba4e8aeb329c2f0029ee44)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)

## [1.4.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.3.0...types-v1.4.0) (2026-06-19)


### Features

* **nql:** Support relation filters from single-source binding reads ([#189](https://github.com/oorabona/db-semantic-planner/issues/189)) ([fb76c10](https://github.com/oorabona/db-semantic-planner/commit/fb76c10dc6540971524e87cae37d4f6e35df85d2)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support scalar relation columns from single-source binding reads ([#191](https://github.com/oorabona/db-semantic-planner/issues/191)) ([f6d0ad4](https://github.com/oorabona/db-semantic-planner/commit/f6d0ad4eb50101f8270ad8b78320e63fa69f8c5f)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)

## [1.3.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.2.0...types-v1.3.0) (2026-06-18)


### Features

* **adapter-pgsql:** Gate NQL text surface by dialect capabilities ([#187](https://github.com/oorabona/db-semantic-planner/issues/187)) ([f536b9a](https://github.com/oorabona/db-semantic-planner/commit/f536b9a809f627007fc2586d66e87e8aa3060cd5)), closes [#183](https://github.com/oorabona/db-semantic-planner/issues/183)
* **nql:** Support binding-final tag queries ([#184](https://github.com/oorabona/db-semantic-planner/issues/184)) ([f4ccf6d](https://github.com/oorabona/db-semantic-planner/commit/f4ccf6d32a7c65afc9a1ada9506877a827f92c2a)), closes [#176](https://github.com/oorabona/db-semantic-planner/issues/176)
* **nql:** Support ordered multi-mutation tag programs ([#185](https://github.com/oorabona/db-semantic-planner/issues/185)) ([7ddebfa](https://github.com/oorabona/db-semantic-planner/commit/7ddebfa4b2c6c5f7a234c0f94e9dd98753c8074f)), closes [#173](https://github.com/oorabona/db-semantic-planner/issues/173)

## [1.2.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.1.0...types-v1.2.0) (2026-06-16)


### Features

* **nql:** Support tagged template mutations ([#175](https://github.com/oorabona/db-semantic-planner/issues/175)) ([c78e89e](https://github.com/oorabona/db-semantic-planner/commit/c78e89e00479359f67f50a3c00edf7fdc63aec18))

## [1.1.0](https://github.com/oorabona/db-semantic-planner/compare/types-v1.0.3...types-v1.1.0) (2026-06-12)


### Features

* **nql:** General named parameters, tag binding, and nqlRaw() ([#165](https://github.com/oorabona/db-semantic-planner/issues/165)) ([905c323](https://github.com/oorabona/db-semantic-planner/commit/905c323f6a9a907dd39a86950e746d8dd5822a61)), closes [#134](https://github.com/oorabona/db-semantic-planner/issues/134)

## [1.0.3](https://github.com/oorabona/db-semantic-planner/compare/types-v1.0.2...types-v1.0.3) (2026-06-05)


### Bug Fixes

* **core:** IN-to-EXISTS done properly + inline-EXISTS refactor ([db38526](https://github.com/oorabona/db-semantic-planner/commit/db3852655e870e328a23dee3c1eb117e252474d7))

## [1.0.2](https://github.com/oorabona/db-semantic-planner/compare/types-v1.0.1...types-v1.0.2) (2026-06-04)


### Bug Fixes

* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))
