# Changelog

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
