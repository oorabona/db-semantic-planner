/** Public physical-model DDL facade.  The rendering engines remain ModelIR-only. */

import type { PgsqlAdapter } from '../pgsql-adapter.js';
import type { PgPhysicalModel } from '../physical-model/index.js';
import { declaredSequenceNamesFromInventory } from '../sequence-name.js';
import {
	generateDDL as generateDDLForPhysicalModel,
	type GenerateDDLOptions as InternalGenerateDDLOptions,
} from './ddl-generator.js';
import {
	comparePgsqlDatabaseSchema as comparePgsqlDatabaseSchemaForModel,
	type ComparePgsqlDatabaseSchemaOptions as InternalComparePgsqlDatabaseSchemaOptions,
} from './live-diff.js';
import {
	generateDownSQL as generateDownSQLForDiff,
	generateMigrationSQL as generateMigrationSQLForDiff,
	type MigrationSQLOptions as InternalMigrationSQLOptions,
} from './migration-sql.js';
import {
	compareSchemata as compareSchemataForModel,
	type CompareSchemataOptions as InternalCompareSchemataOptions,
	type SchemaDiff,
} from './schema-diff.js';

export interface GenerateDDLOptions
	extends Omit<
		InternalGenerateDDLOptions,
		'schemaName' | 'naming' | 'fkAutoIndex'
	> {}
export interface CompareSchemataOptions
	extends Omit<
		InternalCompareSchemataOptions,
		'schema' | 'dbCasing' | 'declaredSequenceNames'
	> {}
export interface ComparePgsqlDatabaseSchemaOptions
	extends Omit<
		InternalComparePgsqlDatabaseSchemaOptions,
		'schema' | 'dbCasing' | 'declaredSequenceNames'
	> {}
export interface MigrationSQLOptions
	extends Omit<InternalMigrationSQLOptions, 'schemaName' | 'fkAutoIndex'> {}

export interface PgSchemaDiff extends SchemaDiff {
	readonly physical: Pick<PgPhysicalModel, 'schema' | 'fkAutoIndex'>;
}

/** Raised before comparison when two otherwise-valid physical models target different schemas. */
export class PgPhysicalModelSchemaMismatchError extends Error {
	constructor(
		readonly desiredSchema: string,
		readonly databaseSchema: string,
	) {
		super(
			`Cannot compare PostgreSQL physical models for different schemas: "${desiredSchema}" and "${databaseSchema}".`,
		);
		this.name = 'PgPhysicalModelSchemaMismatchError';
	}
}

function stamp(diff: SchemaDiff, physical: PgPhysicalModel): PgSchemaDiff {
	return Object.freeze({
		...diff,
		physical: { schema: physical.schema, fkAutoIndex: physical.fkAutoIndex },
	});
}

export function generateDDL(
	physical: PgPhysicalModel,
	options: GenerateDDLOptions = {},
): string[] {
	return generateDDLForPhysicalModel(physical.model, {
		...options,
		schemaName: physical.schema,
		fkAutoIndex: physical.fkAutoIndex,
	});
}

export function compareSchemata(
	desired: PgPhysicalModel,
	database: PgPhysicalModel,
	options?: CompareSchemataOptions,
): PgSchemaDiff {
	if (desired.schema !== database.schema)
		throw new PgPhysicalModelSchemaMismatchError(
			desired.schema,
			database.schema,
		);
	return stamp(
		compareSchemataForModel(desired.model, database.model, {
			...options,
			schema: desired.schema,
			declaredSequenceNames: declaredSequenceNamesFromInventory(
				desired.inventory,
			),
		}),
		desired,
	);
}

export async function comparePgsqlDatabaseSchema(
	adapter: PgsqlAdapter,
	desired: PgPhysicalModel,
	options?: ComparePgsqlDatabaseSchemaOptions,
): Promise<PgSchemaDiff> {
	return stamp(
		await comparePgsqlDatabaseSchemaForModel(adapter, desired.model, {
			...options,
			schema: desired.schema,
			declaredSequenceNames: declaredSequenceNamesFromInventory(
				desired.inventory,
			),
		}),
		desired,
	);
}

export function generateMigrationSQL(
	diff: PgSchemaDiff,
	options?: MigrationSQLOptions,
): readonly string[] {
	return generateMigrationSQLForDiff(diff, {
		...options,
		schemaName: diff.physical.schema,
		fkAutoIndex: diff.physical.fkAutoIndex,
	});
}

export function generateDownSQL(
	diff: PgSchemaDiff,
	options?: MigrationSQLOptions,
): readonly string[] {
	return generateDownSQLForDiff(diff, {
		...options,
		schemaName: diff.physical.schema,
		fkAutoIndex: diff.physical.fkAutoIndex,
	});
}
