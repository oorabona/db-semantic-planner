import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface OwnedMatrixSchema {
	readonly name: string;
}

function assertMatrixSchemaIdentifier(name: string): void {
	if (!/^dbsp_catalogue_matrix_[a-z0-9]{32}$/.test(name))
		throw new Error(`invalid catalogue matrix schema identifier: ${name}`);
}

export function newMatrixSchemaName(): string {
	return `dbsp_catalogue_matrix_${randomUUID().replaceAll('-', '')}`;
}

/**
 * A successful CREATE is the only ownership evidence. In particular, never
 * turn a collision into ownership by deleting a schema that existed first.
 */
export async function createOwnedMatrixSchema(
	pool: pg.Pool,
	name = newMatrixSchemaName(),
): Promise<OwnedMatrixSchema> {
	assertMatrixSchemaIdentifier(name);
	await pool.query(`CREATE SCHEMA ${name}`);
	return { name };
}

export async function dropOwnedMatrixSchema(
	pool: pg.Pool,
	ownedSchema: OwnedMatrixSchema,
): Promise<void> {
	assertMatrixSchemaIdentifier(ownedSchema.name);
	await pool.query(`DROP SCHEMA ${ownedSchema.name} CASCADE`);
}
