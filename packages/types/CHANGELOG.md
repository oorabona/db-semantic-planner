# Changelog

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
