# Changelog

## [1.9.4](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.9.3...nql-v1.9.4) (2026-07-12)


### Bug Fixes

* **adapter-pgsql:** Schema-aware custom type identity for multi-tenant DDL ([#304](https://github.com/oorabona/db-semantic-planner/issues/304)) ([5e16d79](https://github.com/oorabona/db-semantic-planner/commit/5e16d7948d47ff4f2311043f56bf46f3a1e4c6df)), closes [#285](https://github.com/oorabona/db-semantic-planner/issues/285)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 2.0.0

## [1.9.3](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.9.2...nql-v1.9.3) (2026-07-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.9.0

## [1.9.2](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.9.1...nql-v1.9.2) (2026-07-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.8.1

## [1.9.1](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.9.0...nql-v1.9.1) (2026-07-06)


### Bug Fixes

* **repo:** Scope release-please commits for commitlint, require node &gt;=22 ([#243](https://github.com/oorabona/db-semantic-planner/issues/243)) ([0fe03f7](https://github.com/oorabona/db-semantic-planner/commit/0fe03f7a80c650e2066641d39707a829cb6aa15e)), closes [#242](https://github.com/oorabona/db-semantic-planner/issues/242)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.8.0

## [1.9.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.8.1...nql-v1.9.0) (2026-07-03)


### Features

* **nql:** Accept aliased mutation-RETURNING columns as typed read-bind snapshot sources ([#222](https://github.com/oorabona/db-semantic-planner/issues/222)) ([267936b](https://github.com/oorabona/db-semantic-planner/commit/267936bd04a26a80672ae19ad20a6bfbfffd9188))

## [1.8.1](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.8.0...nql-v1.8.1) (2026-07-03)


### Bug Fixes

* **nql:** Emit aliased mutation RETURNING through the source column ([#220](https://github.com/oorabona/db-semantic-planner/issues/220)) ([f4213a0](https://github.com/oorabona/db-semantic-planner/commit/f4213a0f3e23463b5a8f48e379d4ade9ce516232))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.7.1

## [1.8.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.7.0...nql-v1.8.0) (2026-07-02)


### Features

* **nql:** Generalize read-bind snapshots to aliased, transitive, and count columns ([#218](https://github.com/oorabona/db-semantic-planner/issues/218)) ([0b4b315](https://github.com/oorabona/db-semantic-planner/commit/0b4b315a17427f358aa0f7dd076d0e1b152fdf07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.7.0

## [1.7.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.6.0...nql-v1.7.0) (2026-06-20)


### Features

* **nql:** Recursive self-referential relation columns from a binding-final read ([#209](https://github.com/oorabona/db-semantic-planner/issues/209)) ([047ff3c](https://github.com/oorabona/db-semantic-planner/commit/047ff3c29dd786864061d884ef2054db25e90053)), closes [#193](https://github.com/oorabona/db-semantic-planner/issues/193)
* **nql:** Snapshot read-only bindings referenced across an intervening mutation ([#212](https://github.com/oorabona/db-semantic-planner/issues/212)) ([00055eb](https://github.com/oorabona/db-semantic-planner/commit/00055eb6a15de86e1cd21ad01ec09b4eba76d9df)), closes [#186](https://github.com/oorabona/db-semantic-planner/issues/186)
* **nql:** Support manyToMany relation columns from a binding-final read ([#207](https://github.com/oorabona/db-semantic-planner/issues/207)) ([bf3a830](https://github.com/oorabona/db-semantic-planner/commit/bf3a830e73dcb229f6d13f5c7184d765f30a0044)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.6.0

## [1.6.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.5.0...nql-v1.6.0) (2026-06-20)


### Features

* **adapter-pgsql:** Correlate composite (multi-column) foreign keys end-to-end ([#202](https://github.com/oorabona/db-semantic-planner/issues/202)) ([6b4422d](https://github.com/oorabona/db-semantic-planner/commit/6b4422d79768f8bd4cf70d95eecc484ebb034e92)), closes [#179](https://github.com/oorabona/db-semantic-planner/issues/179)
* **nql:** Support hasMany relation columns from a binding-final read ([#194](https://github.com/oorabona/db-semantic-planner/issues/194)) ([da0d49b](https://github.com/oorabona/db-semantic-planner/commit/da0d49b12e517e2f15676e17ef8809405cedbde2)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support include() hydration from a binding-final read ([#197](https://github.com/oorabona/db-semantic-planner/issues/197)) ([9e1a07d](https://github.com/oorabona/db-semantic-planner/commit/9e1a07da0f448474966542854cd56a2ec8da9d3a)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support multi-level include() from a binding-final read ([#198](https://github.com/oorabona/db-semantic-planner/issues/198)) ([831ddc7](https://github.com/oorabona/db-semantic-planner/commit/831ddc7360d4af30eab3ea2132b0cfea47ba279d)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)
* **nql:** Support scalar multi-hop relation columns from a binding-final read ([#200](https://github.com/oorabona/db-semantic-planner/issues/200)) ([66062e3](https://github.com/oorabona/db-semantic-planner/commit/66062e3320d59540cbba4e8aeb329c2f0029ee44)), closes [#192](https://github.com/oorabona/db-semantic-planner/issues/192)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.5.0

## [1.5.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.4.0...nql-v1.5.0) (2026-06-19)


### Features

* **nql:** Support relation filters from single-source binding reads ([#189](https://github.com/oorabona/db-semantic-planner/issues/189)) ([fb76c10](https://github.com/oorabona/db-semantic-planner/commit/fb76c10dc6540971524e87cae37d4f6e35df85d2)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)
* **nql:** Support scalar relation columns from single-source binding reads ([#191](https://github.com/oorabona/db-semantic-planner/issues/191)) ([f6d0ad4](https://github.com/oorabona/db-semantic-planner/commit/f6d0ad4eb50101f8270ad8b78320e63fa69f8c5f)), closes [#182](https://github.com/oorabona/db-semantic-planner/issues/182)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.4.0

## [1.4.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.3.0...nql-v1.4.0) (2026-06-18)


### Features

* **nql:** Support binding-final tag queries ([#184](https://github.com/oorabona/db-semantic-planner/issues/184)) ([f4ccf6d](https://github.com/oorabona/db-semantic-planner/commit/f4ccf6d32a7c65afc9a1ada9506877a827f92c2a)), closes [#176](https://github.com/oorabona/db-semantic-planner/issues/176)
* **nql:** Support ordered multi-mutation tag programs ([#185](https://github.com/oorabona/db-semantic-planner/issues/185)) ([7ddebfa](https://github.com/oorabona/db-semantic-planner/commit/7ddebfa4b2c6c5f7a234c0f94e9dd98753c8074f)), closes [#173](https://github.com/oorabona/db-semantic-planner/issues/173)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.3.0

## [1.3.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.2.0...nql-v1.3.0) (2026-06-16)


### Features

* **adapter-pgsql:** Support conditional upsert ON CONFLICT DO UPDATE SET ... WHERE ([#172](https://github.com/oorabona/db-semantic-planner/issues/172)) ([ddf5d2c](https://github.com/oorabona/db-semantic-planner/commit/ddf5d2c69178dbd6e231955a922bf99853763b3a)), closes [#160](https://github.com/oorabona/db-semantic-planner/issues/160)
* **nql:** Support tagged template mutations ([#175](https://github.com/oorabona/db-semantic-planner/issues/175)) ([c78e89e](https://github.com/oorabona/db-semantic-planner/commit/c78e89e00479359f67f50a3c00edf7fdc63aec18))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.2.0

## [1.2.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.1.0...nql-v1.2.0) (2026-06-12)


### Features

* **nql:** General named parameters, tag binding, and nqlRaw() ([#165](https://github.com/oorabona/db-semantic-planner/issues/165)) ([905c323](https://github.com/oorabona/db-semantic-planner/commit/905c323f6a9a907dd39a86950e746d8dd5822a61)), closes [#134](https://github.com/oorabona/db-semantic-planner/issues/134)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.1.0

## [1.1.0](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.0.4...nql-v1.1.0) (2026-06-10)


### ⚠ Behavior Changes

* **A where-less `update`/`delete` now throws by default.** It previously compiled silently to an unfiltered, all-rows mutation. Pass `{ allowUnfilteredMutations: true }` to the compiler to emit an unfiltered mutation deliberately.
* **Multiple top-level statements now require an explicit `| bind <name>` that materializes a result.** Previously, extra statements were silently dropped and only the last one's result was returned. A non-last mutation used as a binding must include a `returning` clause.
* **Clauses after a set operation (`union`/`intersect`/`except`) now throw** instead of being silently discarded — including a trailing `| bind` directly on a set-operation result (previously an inert no-op).
* **`upsert ... where` now throws a clear "not yet supported" error** instead of silently ignoring the predicate (the SQL generator has no `ON CONFLICT DO UPDATE ... WHERE` yet — tracked in [#160](https://github.com/oorabona/db-semantic-planner/issues/160)).


### Bug Fixes

* **nql:** Correctness sweep — bounded ANY, context isolation, mutation safety guards ([e9d4325](https://github.com/oorabona/db-semantic-planner/commit/e9d4325bc768a3b1e1c7c20271b01a221f340b04))

## [1.0.4](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.0.3...nql-v1.0.4) (2026-06-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.0.3

## [1.0.3](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.0.2...nql-v1.0.3) (2026-06-04)


### Bug Fixes

* **types:** Tighten public contract so impossible states are unrepresentable ([#131](https://github.com/oorabona/db-semantic-planner/issues/131)) ([5055c1d](https://github.com/oorabona/db-semantic-planner/commit/5055c1dd6e51c190b9600b6bd9adb72f1b2e6975))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @dbsp/types bumped to 1.0.2

## [1.0.2](https://github.com/oorabona/db-semantic-planner/compare/nql-v1.0.1...nql-v1.0.2) (2026-06-04)


### Bug Fixes

* Launch-gating correctness & injection-hardening for 1.0.2 ([#135](https://github.com/oorabona/db-semantic-planner/issues/135)) ([cbcd22e](https://github.com/oorabona/db-semantic-planner/commit/cbcd22e2e105b9bb86a4496733442d70d05a28cc))
