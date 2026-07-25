/**
 * DDL Generation Module - Main exports
 *
 * @module ddl
 */

export {
	DdlExecutionError,
	type DdlExecutionOutcome,
	type DdlExecutionPhase,
	type DdlExecutionPlan,
	type DdlExecutionResult,
	describeCompletedAutocommitOperations,
	type ExecuteDdlPlanOptions,
	executeDdlPlan,
	executeDdlPlanWithClient,
} from './ddl-executor.js';
export {
	canGenerateCreateIndex,
	type GenerateDDLOptions,
	generateCreateIndex,
	generateDDL,
} from './ddl-generator.js';
export {
	assertCreateIndexesSupported,
	assertCreateIndexSupported,
	type IndexCapabilityContext,
	IndexFeatureUnsupportedError,
	type IndexRenderSpec,
	renderCreateIndex,
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
	generatePhasedMigrationFiles,
	hasExecutableSqlStatements,
	isDestructiveDown,
	type ParsedMigrationFile,
	type PhasedMigrationFiles,
	parseEnumAdditionSidecar,
	parseMigrationFile,
	renderPhasedMigrationFiles,
} from './migration-file.js';
export {
	type CompiledMigration,
	compileMigration,
	EnumAddAndDropConflictError,
	generateDownMigrationSQL,
	generateDownSQL,
	generateMigrationPlan,
	generateMigrationSQL,
	InconsistentEnumChangeSetError,
	InvalidEnumMigrationMetadataError,
	MigrationPhaseBoundaryError,
	type MigrationSQLOptions,
	type MigrationSQLPlan,
} from './migration-sql.js';
export {
	ensureMigrationsTable,
	getAppliedMigrations,
	getNextSchemaVersion,
	isMigrationApplied,
	type MigrationRecord,
	type MigrationTrackerQueryable,
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
