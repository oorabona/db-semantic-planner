# Changelog

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
