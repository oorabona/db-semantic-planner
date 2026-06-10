# Changelog

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
