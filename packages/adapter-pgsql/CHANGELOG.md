# Changelog

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
