/**
 * DDL Generation Module - Main exports
 *
 * @module ddl
 */

export { type GenerateDDLOptions, generateDDL } from './ddl-generator.js';
export {
	generateMigrationSQL,
	type MigrationSQLOptions,
} from './migration-sql.js';
export {
	acquireMigrationLock,
	ensureMigrationsTable,
	getAppliedMigrations,
	isMigrationApplied,
	type MigrationRecord,
	recordMigration,
	releaseMigrationLock,
} from './migration-tracker.js';
export {
	type ChangeKind,
	compareSchemata,
	type DiffSummary,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';
export { mapColumnType, mapOnDeleteAction } from './type-mapping.js';
