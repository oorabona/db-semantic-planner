/**
 * DDL Generation Module - Main exports
 *
 * @module ddl
 */

export { type GenerateDDLOptions, generateDDL } from './ddl-generator.js';
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
	acquireMigrationLock,
	ensureMigrationsTable,
	getAppliedMigrations,
	getNextSchemaVersion,
	isMigrationApplied,
	type MigrationRecord,
	recordMigration,
	releaseMigrationLock,
	removeMigrationRecord,
	withMigrationLock,
} from './migration-tracker.js';
export {
	type ChangeKind,
	type CompareSchemataOptions,
	compareSchemata,
	type DiffSummary,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';
export { mapColumnType, mapOnDeleteAction } from './type-mapping.js';
