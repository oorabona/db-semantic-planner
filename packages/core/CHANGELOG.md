# Changelog

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
