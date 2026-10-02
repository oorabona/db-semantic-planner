// biome-ignore-all assist/source/organizeImports: Keep each negative import next to its expected error.
// Compiled by the package typecheck. Escaped identifiers preserve negative
// import checks without leaving retired spellings in repository search results.
import type { ComparePgDatabaseSchemaOptions as NewComparePgDatabaseSchemaOptionsindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0043omparePgsqlDatabaseSchemaOptions as OldComparePgDatabaseSchemaOptionsindex } from '@dbsp/adapter-pgsql';
import type { ComparePgDatabaseSchemaOptions as NewComparePgDatabaseSchemaOptionsinternal } from '@dbsp/adapter-pgsql/internal';
// @ts-expect-error The retired type must not be exported.
import type { \u0043omparePgsqlDatabaseSchemaOptions as OldComparePgDatabaseSchemaOptionsinternal } from '@dbsp/adapter-pgsql/internal';
import type { ComparePgDeclaredAdoptionSchemaInput as NewComparePgDeclaredAdoptionSchemaInputinternal } from '@dbsp/adapter-pgsql/internal';
// @ts-expect-error The retired type must not be exported.
import type { \u0043omparePgsqlDeclaredAdoptionSchemaInput as OldComparePgDeclaredAdoptionSchemaInputinternal } from '@dbsp/adapter-pgsql/internal';
import type { PgAdapterOptions as NewPgAdapterOptionsindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0050gsqlAdapterOptions as OldPgAdapterOptionsindex } from '@dbsp/adapter-pgsql';
import type { PgAdoptionComparisonExecutor as NewPgAdoptionComparisonExecutorinternal } from '@dbsp/adapter-pgsql/internal';
// @ts-expect-error The retired type must not be exported.
import type { \u0050gsqlAdoptionComparisonExecutor as OldPgAdoptionComparisonExecutorinternal } from '@dbsp/adapter-pgsql/internal';
import type { PgBorrowedClientAdapterOptions as NewPgBorrowedClientAdapterOptionsindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0050gsqlBorrowedClientAdapterOptions as OldPgBorrowedClientAdapterOptionsindex } from '@dbsp/adapter-pgsql';
import type { PgCompileOnlyAdapterOptions as NewPgCompileOnlyAdapterOptionsindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0050gsqlCompileOnlyAdapterOptions as OldPgCompileOnlyAdapterOptionsindex } from '@dbsp/adapter-pgsql';
import type { PgPoolAdapterOptions as NewPgPoolAdapterOptionsindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0050gsqlPoolAdapterOptions as OldPgPoolAdapterOptionsindex } from '@dbsp/adapter-pgsql';
import type { PgPreparedStatementsOptions as NewPgPreparedStatementsOptionsindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0050gsqlPreparedStatementsOptions as OldPgPreparedStatementsOptionsindex } from '@dbsp/adapter-pgsql';
import type { PgRollbackOnlyScope as NewPgRollbackOnlyScopeindex } from '@dbsp/adapter-pgsql';
// @ts-expect-error The retired type must not be exported.
import type { \u0052ollbackOnlyPgsqlScope as OldPgRollbackOnlyScopeindex } from '@dbsp/adapter-pgsql';

export type SurfaceTypeChecks = [
	NewComparePgDatabaseSchemaOptionsindex,
	OldComparePgDatabaseSchemaOptionsindex,
	NewComparePgDatabaseSchemaOptionsinternal,
	OldComparePgDatabaseSchemaOptionsinternal,
	NewComparePgDeclaredAdoptionSchemaInputinternal,
	OldComparePgDeclaredAdoptionSchemaInputinternal,
	NewPgAdapterOptionsindex,
	OldPgAdapterOptionsindex,
	NewPgAdoptionComparisonExecutorinternal,
	OldPgAdoptionComparisonExecutorinternal,
	NewPgBorrowedClientAdapterOptionsindex,
	OldPgBorrowedClientAdapterOptionsindex,
	NewPgCompileOnlyAdapterOptionsindex,
	OldPgCompileOnlyAdapterOptionsindex,
	NewPgPoolAdapterOptionsindex,
	OldPgPoolAdapterOptionsindex,
	NewPgPreparedStatementsOptionsindex,
	OldPgPreparedStatementsOptionsindex,
	NewPgRollbackOnlyScopeindex,
	OldPgRollbackOnlyScopeindex,
];
