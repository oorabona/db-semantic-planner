# Changelog

## [6.0.0](https://github.com/oorabona/db-semantic-planner/compare/types-v5.0.0...types-v6.0.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* **core:** included rows, joined tables, relation predicates, subqueries, recursive walks and NQL reads now honour schema default filters.
* **core:** include-where and mixed-strategy refusals surface at plan(), and a nested include's unqualified outerRef() binds its parent, not the root.
* **core:** a recursive relation predicate in a join ON condition now refuses instead of compiling a plain EXISTS, a qualifier naming a later join refuses, and ON refusals surface at plan().
* **adapter-pgsql:** internal decision compiler and in-process rule for every select condition ([#952](https://github.com/oorabona/db-semantic-planner/issues/952))
* **core:** the root where compiles from a typed resolved condition tree planned once ([#949](https://github.com/oorabona/db-semantic-planner/issues/949))
* **core:** explicit joins resolve at plan() and compile from their resolved ranges ([#947](https://github.com/oorabona/db-semantic-planner/issues/947))
* **core:** relation predicates always compile as exists; the filter join is removed ([#946](https://github.com/oorabona/db-semantic-planner/issues/946))
* **core:** relations in a model resolve keys from their declaration or the referenced primary key ([#945](https://github.com/oorabona/db-semantic-planner/issues/945))
* **adapter-pgsql:** includes compile from resolved include nodes planned once ([#944](https://github.com/oorabona/db-semantic-planner/issues/944))
* **core:** schema() declares many-to-many relations; relation paths resolve from declared keys ([#940](https://github.com/oorabona/db-semantic-planner/issues/940))
* **adapter-pgsql:** recursive includes walk the tree per root row ([#937](https://github.com/oorabona/db-semantic-planner/issues/937))
* **core:** plan() and adapter.compile() apply one set of include rules ([#934](https://github.com/oorabona/db-semantic-planner/issues/934))
* **core:** orm.nql plans with dialect capabilities and returns the requested nested or flat output ([#930](https://github.com/oorabona/db-semantic-planner/issues/930))
* **adapter-pgsql:** join includes return data instead of the primary key only, and to-many join includes are refused; use exists() to filter roots and .join() for a flat relational join.
* **core:** expression, predicate and ref brands are non-enumerable Symbol.for properties ([#924](https://github.com/oorabona/db-semantic-planner/issues/924))
* **adapter-pgsql:** requested relation names at every depth, enumerated jsonb_build_object payloads, relation.column flat labels, and model-free compilation refused when the report cannot establish keys or read types.
* **core:** include ordering accepts field orderings only (IncludeOrderByIntent); strategy conflicts and unsupported include options are refused instead of ignored.
* **core:** the subquery include strategy is removed. IncludeStrategy no longer has 'subquery'; SubqueryIncludeInfo, CompileResultWithIncludes, PgAdapter.compileSubqueryInclude and ResultHydrator.hydrateIncludes are removed. 'subquery' as a default, per-include strategy or plan decision is refused, and a recursive include on a dialect without recursive CTEs is refused. SQL subqueries are unchanged.
* **core:** names used only by adapters and the CLI are importable from @dbsp/core/internal and @dbsp/types/internal, no longer from the roots, and root exports no consumer referenced are removed.
* **adapter-pgsql:** result keys follow the declared logical name, with no camel/snake inference; an undeclared table, column or ON CONFLICT ON CONSTRAINT name refuses compilation; compiling without a model works only under dbCasing 'preserve'; recursive edgeTable takes the logical table name; alias and CTE SQL text changes under non-preserve casing; NamingPlugin no longer serves query compilation.

### Features

* **adapter-pgsql:** A join include carries the related row with a private presence marker ([#928](https://github.com/oorabona/db-semantic-planner/issues/928)) ([88a9e69](https://github.com/oorabona/db-semantic-planner/commit/88a9e692cac376374eb54b6f957a3d113f574828))
* **adapter-pgsql:** Include payload keys resolve once, before SQL and hydration ([#922](https://github.com/oorabona/db-semantic-planner/issues/922)) ([59a85e9](https://github.com/oorabona/db-semantic-planner/commit/59a85e9265737ead76b4dd45973bc3c0616a7d87)), closes [#907](https://github.com/oorabona/db-semantic-planner/issues/907)
* **adapter-pgsql:** Internal decision compiler and in-process rule for every select condition ([#952](https://github.com/oorabona/db-semantic-planner/issues/952)) ([c050a01](https://github.com/oorabona/db-semantic-planner/commit/c050a015eb75f203fe66a17b3a9022092da267c4)), closes [#891](https://github.com/oorabona/db-semantic-planner/issues/891)
* **adapter-pgsql:** Query compilation resolves names through the physical model ([#875](https://github.com/oorabona/db-semantic-planner/issues/875)) ([1b3c383](https://github.com/oorabona/db-semantic-planner/commit/1b3c3838d1d88698ca2759b5c5995e3cddacc86f))
* **core:** Default filters apply to every table scan of a read ([#964](https://github.com/oorabona/db-semantic-planner/issues/964)) ([c4de280](https://github.com/oorabona/db-semantic-planner/commit/c4de280cedd088be22574823f7f892bf1afaf120))
* **core:** Explicit joins resolve at plan() and compile from their resolved ranges ([#947](https://github.com/oorabona/db-semantic-planner/issues/947)) ([7dd3a6b](https://github.com/oorabona/db-semantic-planner/commit/7dd3a6bae996842027881d736fd50abe67bbb9ab)), closes [#891](https://github.com/oorabona/db-semantic-planner/issues/891)
* **core:** Include limit, orderBy and select are honoured or refused per strategy, with one strategy precedence ([#912](https://github.com/oorabona/db-semantic-planner/issues/912)) ([e30dd38](https://github.com/oorabona/db-semantic-planner/commit/e30dd38249248a78211aad11327db2d9496d12bd))
* **core:** Include where resolves at plan() and compiles from the typed condition union ([#960](https://github.com/oorabona/db-semantic-planner/issues/960)) ([64d30f2](https://github.com/oorabona/db-semantic-planner/commit/64d30f21381f03a6afd0613b9e32fe8a3835941f))
* **core:** Join on conditions resolve at plan() and compile from the typed condition union ([#955](https://github.com/oorabona/db-semantic-planner/issues/955)) ([ac6f64b](https://github.com/oorabona/db-semantic-planner/commit/ac6f64bbf94c43dc9faffa263282e02c1cfe1287))
* **core:** Relation predicates always compile as exists; the filter join is removed ([#946](https://github.com/oorabona/db-semantic-planner/issues/946)) ([2a10ef0](https://github.com/oorabona/db-semantic-planner/commit/2a10ef0a535e17eb834556708effc3e37bb65939)), closes [#891](https://github.com/oorabona/db-semantic-planner/issues/891)
* **core:** Schema() declares many-to-many relations; relation paths resolve from declared keys ([#940](https://github.com/oorabona/db-semantic-planner/issues/940)) ([55f76aa](https://github.com/oorabona/db-semantic-planner/commit/55f76aa4fbad117ba63a1140f9eec1c0830b15fa)), closes [#936](https://github.com/oorabona/db-semantic-planner/issues/936) [#787](https://github.com/oorabona/db-semantic-planner/issues/787)
* **core:** The root where compiles from a typed resolved condition tree planned once ([#949](https://github.com/oorabona/db-semantic-planner/issues/949)) ([af3dc90](https://github.com/oorabona/db-semantic-planner/commit/af3dc907cb4847c3be0248a32f3ba779c93ad38f)), closes [#891](https://github.com/oorabona/db-semantic-planner/issues/891)


### Bug Fixes

* **adapter-pgsql:** Empty condition groups are constants on every path ([#896](https://github.com/oorabona/db-semantic-planner/issues/896)) ([9b0e401](https://github.com/oorabona/db-semantic-planner/commit/9b0e401e75d52449dfc06543308090728582ac81)), closes [#888](https://github.com/oorabona/db-semantic-planner/issues/888)
* **adapter-pgsql:** Expression text is physical SQL; generated policies put AS before FOR ([#882](https://github.com/oorabona/db-semantic-planner/issues/882)) ([c2f6aa6](https://github.com/oorabona/db-semantic-planner/commit/c2f6aa6cbb06ef669887815ac9f50ef3f6119126)), closes [#318](https://github.com/oorabona/db-semantic-planner/issues/318)
* **adapter-pgsql:** Recursive includes walk the tree per root row ([#937](https://github.com/oorabona/db-semantic-planner/issues/937)) ([ec596b0](https://github.com/oorabona/db-semantic-planner/commit/ec596b033459b931d3426e8c1f16c3cb65417dc0)), closes [#877](https://github.com/oorabona/db-semantic-planner/issues/877) [#933](https://github.com/oorabona/db-semantic-planner/issues/933)
* **core:** Expression, predicate and ref brands are non-enumerable Symbol.for properties ([#924](https://github.com/oorabona/db-semantic-planner/issues/924)) ([2e8f121](https://github.com/oorabona/db-semantic-planner/commit/2e8f121ebd91e2e955452eb00d7bf443a892b88a))
* **core:** Orm.nql plans with dialect capabilities and returns the requested nested or flat output ([#930](https://github.com/oorabona/db-semantic-planner/issues/930)) ([6c64d7b](https://github.com/oorabona/db-semantic-planner/commit/6c64d7bbe602dc510582dcee6168fc8ebe9635a8))
* **core:** Plan() and adapter.compile() apply one set of include rules ([#934](https://github.com/oorabona/db-semantic-planner/issues/934)) ([8753a14](https://github.com/oorabona/db-semantic-planner/commit/8753a1408a884548925853c5373fefff8e7569a7)), closes [#915](https://github.com/oorabona/db-semantic-planner/issues/915) [#917](https://github.com/oorabona/db-semantic-planner/issues/917) [#927](https://github.com/oorabona/db-semantic-planner/issues/927)
* **core:** Plan(), public types and the adapter agree on every include option ([#918](https://github.com/oorabona/db-semantic-planner/issues/918)) ([a0a1492](https://github.com/oorabona/db-semantic-planner/commit/a0a1492fab6c85ad2285b3688a1b7ab11f47e203)), closes [#911](https://github.com/oorabona/db-semantic-planner/issues/911)
* **core:** Relations in a model resolve keys from their declaration or the referenced primary key ([#945](https://github.com/oorabona/db-semantic-planner/issues/945)) ([9bf24a9](https://github.com/oorabona/db-semantic-planner/commit/9bf24a9085e93ad705dc0f4837b8d61d5570d4dc)), closes [#943](https://github.com/oorabona/db-semantic-planner/issues/943)
* **core:** Renamed include keys keep their qualifier and generated aliases fit in 63 bytes ([#950](https://github.com/oorabona/db-semantic-planner/issues/950)) ([0c556e4](https://github.com/oorabona/db-semantic-planner/commit/0c556e4010d9395fd710554fb46c7b938a50debc)), closes [#948](https://github.com/oorabona/db-semantic-planner/issues/948)
* **nql:** Relation columns are validated against the final target of their path ([#913](https://github.com/oorabona/db-semantic-planner/issues/913)) ([8b8e84f](https://github.com/oorabona/db-semantic-planner/commit/8b8e84ff1f64563117fb01cfe8e39a7f167a8e17))


### Code Refactoring

* **adapter-pgsql:** Includes compile from resolved include nodes planned once ([#944](https://github.com/oorabona/db-semantic-planner/issues/944)) ([5af444e](https://github.com/oorabona/db-semantic-planner/commit/5af444e8802aea122fea1b32ae4813f58b88adfc)), closes [#891](https://github.com/oorabona/db-semantic-planner/issues/891)
* **core:** Keep adapter-only exports behind /internal and drop unused ones ([#898](https://github.com/oorabona/db-semantic-planner/issues/898)) ([94a17bd](https://github.com/oorabona/db-semantic-planner/commit/94a17bda7ecef508cbcd4653d15940c9fd67544f)), closes [#860](https://github.com/oorabona/db-semantic-planner/issues/860)
* **core:** Remove the subquery include strategy; nested includes keep one strategy per branch ([#901](https://github.com/oorabona/db-semantic-planner/issues/901)) ([3e423ff](https://github.com/oorabona/db-semantic-planner/commit/3e423ff155f9f9d03fe199bec893b5d8979f46e2))

## [5.0.0](https://github.com/oorabona/db-semantic-planner/compare/types-v4.0.0...types-v5.0.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** generateDDL, compareSchemata, generateMigrationSQL, generateDownSQL, comparePgsqlDatabaseSchema, convergePg and planPgTransitionRun take a PgPhysicalModel built with createPgPhysicalModel; the per-call schema, dbCasing, naming and fkAutoIndex options move to it. declarationSetFromModel takes no naming. DeclarationNamingStrategy, DDLGeneratingAdapter, supportsDDLGeneration and SetNotNullRuleOptions are removed. convergePg honours fkAutoIndex, default true.

### Features

* **adapter-pgsql:** ConvergePg adopts existing standalone sequences ([#834](https://github.com/oorabona/db-semantic-planner/issues/834)) ([72da9f0](https://github.com/oorabona/db-semantic-planner/commit/72da9f099226a62c480c622fd530863c4684e2ca))
* **adapter-pgsql:** ConvergePg runs once and assert application steps ([#844](https://github.com/oorabona/db-semantic-planner/issues/844)) ([491698e](https://github.com/oorabona/db-semantic-planner/commit/491698e2879d81815280a9b9567c8eed4006be8a))
* **adapter-pgsql:** One PostgreSQL physical name authority for schema generation, comparison and converge ([#865](https://github.com/oorabona/db-semantic-planner/issues/865)) ([662d66f](https://github.com/oorabona/db-semantic-planner/commit/662d66f6242ec9092acfd00345fcc7a2185e551d)), closes [#784](https://github.com/oorabona/db-semantic-planner/issues/784)


### Bug Fixes

* **adapter-pgsql:** A relation column needs an alias a join emitted ([#794](https://github.com/oorabona/db-semantic-planner/issues/794)) ([19a3ea4](https://github.com/oorabona/db-semantic-planner/commit/19a3ea43e1ff4cdb7c4b9cef22e459734674df6f))
* **adapter-pgsql:** A relation target resolved to a CTE uses that CTE's projection ([#772](https://github.com/oorabona/db-semantic-planner/issues/772)) ([b93f976](https://github.com/oorabona/db-semantic-planner/commit/b93f9769676cbdd7404d31469db509781379b811))
* **core:** Declared enum names stay physical under every dbCasing ([#827](https://github.com/oorabona/db-semantic-planner/issues/827)) ([b4d5d04](https://github.com/oorabona/db-semantic-planner/commit/b4d5d0416390719e912ceddb0595ce85706aed1b))

## [4.0.0](https://github.com/oorabona/db-semantic-planner/compare/types-v3.4.0...types-v4.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** replayInvalidatedPlans is accepted only by pool-owning adapter constructors; borrowed-client and compile-only constructors reject it.
* **adapter-pgsql:** SequenceIR and schema DSL sequence fields (startWith, incrementBy, minValue, maxValue) accept number | string; strict decimal strings carry exact int64 values.
* **adapter-pgsql:** dbsp push and dbsp migrate removed. Use apply <run-id> to execute recorded plans or apply for unrecorded intents. CLI version 3.0.0.

### Features

* **adapter-pgsql:** Canonical payload digests and exact int64 sequence contracts ([#672](https://github.com/oorabona/db-semantic-planner/issues/672)) ([afa6d24](https://github.com/oorabona/db-semantic-planner/commit/afa6d24f6902cd68ced15e02aefe737ad4cc362a))
* **adapter-pgsql:** Managed-state ledger delivery 2 — admission, recovery, destructive authority ([#516](https://github.com/oorabona/db-semantic-planner/issues/516)) ([d5979c0](https://github.com/oorabona/db-semantic-planner/commit/d5979c0d7184ffb8b66ca4f9ddc1b148dd2c22b9))
* **core:** Execute a reviewed plan against a target it can prove is the one ([#479](https://github.com/oorabona/db-semantic-planner/issues/479)) ([e89f2be](https://github.com/oorabona/db-semantic-planner/commit/e89f2bee7206aeb4f21e8b06adde18aa984beb58)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Observers observe, transformers preserve, and the execution port stops lying ([#645](https://github.com/oorabona/db-semantic-planner/issues/645)) ([0720c01](https://github.com/oorabona/db-semantic-planner/commit/0720c0179a13f09a54829efb672969f3c1ae7b76))
* **core:** Where() accepts branded predicates and rejects every other expression ([#635](https://github.com/oorabona/db-semantic-planner/issues/635)) ([5f8fceb](https://github.com/oorabona/db-semantic-planner/commit/5f8fceb78e249f1e2b2c3f079f46b595b44858b7))


### Bug Fixes

* **adapter-pgsql:** Identity-bound quarantine, faithful replay, exact sequence introspection ([#677](https://github.com/oorabona/db-semantic-planner/issues/677)) ([9c64e05](https://github.com/oorabona/db-semantic-planner/commit/9c64e05b62b72bc752bc72571c97d951f8a9abdb))
* **adapter-pgsql:** Ledger recovery outcomes are explicit, attempt-bound, and session-safe ([#548](https://github.com/oorabona/db-semantic-planner/issues/548)) ([0bab857](https://github.com/oorabona/db-semantic-planner/commit/0bab857d2434f88234ce07cb105fdcb7852202e1))
* **core:** The typed path infers the row type and IndexMethod matches the runtime allowlist ([#622](https://github.com/oorabona/db-semantic-planner/issues/622)) ([72b8878](https://github.com/oorabona/db-semantic-planner/commit/72b8878657f9da8e338cd10a79ae5125e7220cd5))

## [3.4.0](https://github.com/oorabona/db-semantic-planner/compare/types-v3.3.0...types-v3.4.0) (2026-07-31)


### Features

* **adapter-pgsql:** Make a recorded plan describe a target it can identify ([#435](https://github.com/oorabona/db-semantic-planner/issues/435)) ([5217c4a](https://github.com/oorabona/db-semantic-planner/commit/5217c4ab3491f0a54aa2878adeca50383e47273e)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)
* **core:** Make a transition run's proven plan durable ([#416](https://github.com/oorabona/db-semantic-planner/issues/416)) ([acaa1b1](https://github.com/oorabona/db-semantic-planner/commit/acaa1b1f6cb4c3bf5cc9f824e69a531e2c62f592)), closes [#394](https://github.com/oorabona/db-semantic-planner/issues/394)


### Bug Fixes

* **adapter-pgsql:** Expose full connectionless adapter ([#436](https://github.com/oorabona/db-semantic-planner/issues/436)) ([#440](https://github.com/oorabona/db-semantic-planner/issues/440)) ([53336bd](https://github.com/oorabona/db-semantic-planner/commit/53336bdb5fb0e877f0551655d69c01bfbeba89d8))

## [3.3.0](https://github.com/oorabona/db-semantic-planner/compare/types-v3.2.0...types-v3.3.0) (2026-07-27)


### Features

* **core:** Declare the transition target instead of guessing it ([#408](https://github.com/oorabona/db-semantic-planner/issues/408)) ([ea11e5b](https://github.com/oorabona/db-semantic-planner/commit/ea11e5b3b845b96512cf721eb6339cb902cd5911))

## [3.2.0](https://github.com/oorabona/db-semantic-planner/compare/types-v3.1.0...types-v3.2.0) (2026-07-22)


### Features

* **adapter-pgsql:** Abort a pool-owned transaction via AbortSignal ([#363](https://github.com/oorabona/db-semantic-planner/issues/363)) ([#369](https://github.com/oorabona/db-semantic-planner/issues/369)) ([e61d4b5](https://github.com/oorabona/db-semantic-planner/commit/e61d4b58ec1790b86497fd8d8fb15e7ca1aabc07))
* **adapter-pgsql:** Add transaction isolation, access mode & timeouts ([#360](https://github.com/oorabona/db-semantic-planner/issues/360), [#361](https://github.com/oorabona/db-semantic-planner/issues/361)) ([#368](https://github.com/oorabona/db-semantic-planner/issues/368)) ([74cc335](https://github.com/oorabona/db-semantic-planner/commit/74cc33511d7e501b7bea8915e68bf8955ec9efc4))
* **adapter-pgsql:** Add withPinnedConnection for a bounded pinned-connection scope ([#341](https://github.com/oorabona/db-semantic-planner/issues/341)) ([#373](https://github.com/oorabona/db-semantic-planner/issues/373)) ([c1bdc7d](https://github.com/oorabona/db-semantic-planner/commit/c1bdc7d9e8a5e3388f86264b292a7849a61f659b))
* **adapter-pgsql:** Apply isolation and timeout options to the streaming BEGIN ([#364](https://github.com/oorabona/db-semantic-planner/issues/364)) ([#372](https://github.com/oorabona/db-semantic-planner/issues/372)) ([6dbf579](https://github.com/oorabona/db-semantic-planner/commit/6dbf57970733848bf5689725040fa6888af940fd))
* **adapter-pgsql:** Make schema a required argument on the DDL generator port ([#331](https://github.com/oorabona/db-semantic-planner/issues/331)) ([#375](https://github.com/oorabona/db-semantic-planner/issues/375)) ([d106f9e](https://github.com/oorabona/db-semantic-planner/commit/d106f9e0534cf0a70215f0f6d562f596ba64514b))
* **core:** Expose mutation rowCount via affectedRows() and executeWithMeta ([#362](https://github.com/oorabona/db-semantic-planner/issues/362)) ([#366](https://github.com/oorabona/db-semantic-planner/issues/366)) ([3ee7575](https://github.com/oorabona/db-semantic-planner/commit/3ee75752ef15a8c90e01903c1ad57fa3a2979b54))

## [3.1.0](https://github.com/oorabona/db-semantic-planner/compare/types-v3.0.0...types-v3.1.0) (2026-07-20)


### Features

* **adapter-pgsql:** Version-gate index features via ADR-0003 capability model ([#349](https://github.com/oorabona/db-semantic-planner/issues/349)) ([618f07b](https://github.com/oorabona/db-semantic-planner/commit/618f07b69968b988a005627568b8da6f9bc27937)), closes [#245](https://github.com/oorabona/db-semantic-planner/issues/245)
* **core:** ADR-0003 rule-based schema-transition planner ([#348](https://github.com/oorabona/db-semantic-planner/issues/348)) ([6d41829](https://github.com/oorabona/db-semantic-planner/commit/6d418299f6a9700298aa67bbde56ac91ea42e268))
* **core:** Opt-in js: read-side JS type for bigint columns ([#354](https://github.com/oorabona/db-semantic-planner/issues/354)) ([70b9405](https://github.com/oorabona/db-semantic-planner/commit/70b9405e0c745788b6001f05c59fcd5af6e3abb1)), closes [#310](https://github.com/oorabona/db-semantic-planner/issues/310)
* **types:** Make CompiledQuery a constructor-only, runtime-branded capability ([#356](https://github.com/oorabona/db-semantic-planner/issues/356)) ([421ae11](https://github.com/oorabona/db-semantic-planner/commit/421ae113d52a71a96fb0be9efc0819ce75f78c4b)), closes [#353](https://github.com/oorabona/db-semantic-planner/issues/353)

## [3.0.0](https://github.com/oorabona/db-semantic-planner/compare/types-v2.0.0...types-v3.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **adapter-pgsql:** dbsp no longer savepoints each statement inside a transaction it opened. PostgreSQL's own semantics stand — a failed statement poisons the transaction. 2.0.0 rolled back the one statement and committed the rest, turning a fail-closed database error into a durable partial business transaction; catching an error inside `transaction()` and continuing no longer works, and that is the point. A nested `transaction()` that was never awaited is refused rather than guessed about. `inTransaction` and `supportsTransactions` are now required members of the adapter contract: an adapter that cannot state whether a transaction is open is one dbsp will not run concurrent DDL through. A `PoolClient` must be declared with `borrowedClient: true`, and `introspect()` takes a `Pool`.

### Features

* **adapter-pgsql:** The caller declares who owns the connection ([#330](https://github.com/oorabona/db-semantic-planner/issues/330)) ([8077cd2](https://github.com/oorabona/db-semantic-planner/commit/8077cd249452ca30ac003dbb4470d1002397e89a)), closes [#325](https://github.com/oorabona/db-semantic-planner/issues/325)


### Bug Fixes

* **adapter-pgsql:** Let PostgreSQL canonicalise CHECK expressions so migrations converge ([#335](https://github.com/oorabona/db-semantic-planner/issues/335)) ([5cbed9c](https://github.com/oorabona/db-semantic-planner/commit/5cbed9c663afec724a62f738429f67287ec8e44a))

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
