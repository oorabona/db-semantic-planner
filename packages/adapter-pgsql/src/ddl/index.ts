/**
 * DDL Generation Module - Main exports
 *
 * @module ddl
 */

export {
	canGenerateCreateIndex,
	type GenerateDDLOptions,
	generateCreateIndex,
	generateDDL,
} from './ddl-generator.js';
export {
	assertCreateIndexesSupported,
	assertCreateIndexSupported,
	IndexFeatureUnsupportedError,
	renderCreateIndex,
	type IndexCapabilityContext,
	type IndexRenderSpec,
} from './index-render.js';
export {
	type AddedEnumValue,
	assertNoRepeatedExpressionSurfaceDrift,
	CheckConstraintNewEnumValueError,
	type ComparePgsqlDatabaseSchemaOptions,
	comparePgsqlDatabaseSchema,
	NonConvergentSchemaDiffError,
} from './live-diff.js';
export {
	generateMigrationFile,
	isDestructiveDown,
	type ParsedMigrationFile,
	parseMigrationFile,
} from './migration-file.js';
export {
	generateDownSQL,
	generateMigrationSQL,
	type MigrationSQLOptions,
} from './migration-sql.js';
export {
	ensureMigrationsTable,
	getAppliedMigrations,
	getNextSchemaVersion,
	isMigrationApplied,
	type MigrationRecord,
	recordMigration,
	removeMigrationRecord,
	withMigrationLock,
} from './migration-tracker.js';
export {
	type ChangeKind,
	type CompareSchemataOptions,
	compareSchemata,
	type DiffSummary,
	ExpressionCanonicalizationUnavailableError,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';
export { mapColumnType, mapOnDeleteAction } from './type-mapping.js';
