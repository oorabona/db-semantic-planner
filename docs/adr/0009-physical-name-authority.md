# ADR 0009: The PostgreSQL Physical Name Authority

## Status

Accepted (2026-09-30). It records the decision on #784, which also settles #762 and #318. "Deliveries" gives
the state of each part.

## Context

A logical model reaches PostgreSQL through many independent identifier transformations: DDL generation,
schema comparison, migration SQL, converge, declaration binding and query compilation each apply the naming
plugin, derive some names themselves, or receive names that are already physical. One declared object can
therefore get more than one physical name. Measured on one `dbCasing: 'snake_case'` model before this
decision:

- `generateDDL` names a primary key `pk_userProfile` and a foreign key `fk_userProfile_ownerId`, and leaves an
  explicit index name unmapped, while `compareSchemata` and `generateMigrationSQL` produce `pk_user_profile`,
  `fk_user_profile_owner_id` and the mapped index name.
- Two tables `userProfile` and `user_profile` give two `CREATE TABLE "user_profile"` in `generateDDL` and one
  `create_table` in the comparison, which folds them (#784).
- The comparison's table normalisation drops `policies`, `rlsEnabled` and the table comment whenever `dbCasing`
  is passed, `'preserve'` included.

The naming plugin is idempotent but not injective (`userProfile`, `user_profile` and `UserProfile` all map to
`user_profile`) and not reversible. PostgreSQL places tables, indexes and sequences in one per-schema namespace
(`pg_class`), table row types and enums in another (`pg_type`, each with an implicit `_name` array type), and
columns, constraints and policies in per-table namespaces; it truncates identifiers to 63 bytes. An introspected
model is already physical, and mapping it again is wrong.

## Decision

The PostgreSQL adapter owns one immutable physical model, `PgPhysicalModel`, built once by
`createPgPhysicalModel` from either a logical model (with the target schema and one naming choice) or an
introspected physical model (with the target schema and no naming). Logical names are mapped exactly once;
physical input is never mapped. Every PostgreSQL schema consumer of a declared object — DDL generation, schema
comparison and migration SQL, live comparison and converge, and declaration binding — takes this value. Model-backed
query compilation still maps names with the adapter's naming plugin; it moves onto this value in the second delivery
(#762).

The model records the physical name of every table, column, index (explicit, default and automatic
foreign-key), primary-key, foreign-key, CHECK and column-unique constraint, standalone sequence, enum and policy.
Derived names are composed from already-physical parts with one template each (`pk_<table>`,
`fk_<table>_<columns>`, `idx_<table>_<columns>`), and the 63-byte rule is applied to every mapped and derived
name. Names PostgreSQL chooses itself — the sequence behind a serial column (`<table>_<column>_seq`) and the
index behind an unnamed column `UNIQUE` (`<table>_<column>_key`) — are predicted with PostgreSQL's rule and
claimed, not rewritten; dbsp finds those sequences through `pg_depend`, never by name.

Before any SQL is produced, the model admits every claim into its PostgreSQL namespace: `pg_class` and
`pg_type` (row types and implicit array types included) per effective schema, and columns, constraints and
policies per table. A collision refuses the model with `PgPhysicalNameCollisionError`, naming the namespace,
the physical name and both logical origins. dbsp never relies on PostgreSQL adding a numeric suffix.

`@dbsp/types` owns the dialect-neutral part: an immutable logical-address-to-physical-name inventory and the
generic duplicate rule (tables per schema, columns per table). Core's declaration binding consumes that
inventory instead of a naming strategy. Everything PostgreSQL-specific stays in the adapter.

Expression text — CHECK expressions, index predicates and expressions, policy `USING`/`WITH CHECK`, SQL column
defaults — is physical SQL and is never rewritten (#318, option a). Enum names keep their existing physical
meaning. Query-local aliases (CTE columns, relation aliases, `RETURNING` labels) are compiler-local, not model
names, and are handled with the query compiler (#762).

Public exports with PostgreSQL-specific semantics carry the `Pg` prefix; the neutral contract in `@dbsp/types`
and internal symbols do not (#860 tracks the convention for the existing exports).

## Consequences

- This is a breaking release with no compatibility layer: the model-taking APIs take a `PgPhysicalModel`, the
  per-call naming options move to its construction, and persisted plans and manifests built before it must be
  regenerated. The changed signatures are listed once in the release notes.
- A live object whose desired physical name changes is drift; dbsp never renames it automatically.
- A colliding model is refused before any SQL is rendered, any connection is made, or any ledger row is written.
- The table physicalisation is exhaustive: adding a field to `TableIR` without classifying it fails the type
  check, so a field cannot be silently dropped again.

## Deliveries

1. Physical model, namespace verdict, neutral inventory, and the closed DDL, comparison, migration, live
   comparison, converge, declaration and CLI entry points (#784): not shipped.
2. Model-backed query compilation on the physical model, query-local aliases and the `orm.tables` runtime
   helpers (#762): not shipped.
3. Expression text documented as physical SQL (#318): not shipped.
