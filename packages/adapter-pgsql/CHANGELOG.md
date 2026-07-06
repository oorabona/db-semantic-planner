# Changelog

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
