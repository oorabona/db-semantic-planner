import { randomUUID } from 'node:crypto';
import type pg from 'pg';

const ownedMatrixSchemaBrand: unique symbol = Symbol('ownedMatrixSchemaBrand');

/** A matrix-only capability minted after CREATE SCHEMA is acknowledged. */
export type OwnedMatrixSchema = {
	readonly [ownedMatrixSchemaBrand]: true;
};

type MatrixSchemaExecutor = Pick<pg.Pool, 'query'>;

type MatrixSchemaOwnership = {
	readonly executor: MatrixSchemaExecutor;
	readonly name: string;
};

const ownedMatrixSchemas = new WeakMap<
	OwnedMatrixSchema,
	MatrixSchemaOwnership
>();
const droppingMatrixSchemas = new WeakSet<OwnedMatrixSchema>();
const consumedMatrixSchemas = new WeakSet<OwnedMatrixSchema>();
function assertMatrixSchemaIdentifier(name: string): void {
	if (!/^dbsp_catalogue_matrix_[a-z0-9]{32}$/.test(name))
		throw new Error(`invalid catalogue matrix schema identifier: ${name}`);
}

export function newMatrixSchemaName(): string {
	return `dbsp_catalogue_matrix_${randomUUID().replaceAll('-', '')}`;
}

/**
 * A successful CREATE acknowledgement is the only ownership evidence. Cleanup
 * is best-effort for confirmed ownership: a disconnect can leave this random
 * schema in the disposable database without a token to clean it up. Never turn
 * a collision into ownership by deleting a schema that existed first.
 */
export async function createOwnedMatrixSchema(
	pool: MatrixSchemaExecutor,
	name = newMatrixSchemaName(),
): Promise<OwnedMatrixSchema> {
	assertMatrixSchemaIdentifier(name);
	try {
		await pool.query(`CREATE SCHEMA ${name}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`catalogue matrix schema create failed for ${name}; ownership was not confirmed and cleanup will not run: ${detail}`,
			{ cause: error },
		);
	}
	const ownedSchema = Object.freeze({
		[ownedMatrixSchemaBrand]: true as const,
	});
	ownedMatrixSchemas.set(ownedSchema, { name, executor: pool });
	return ownedSchema;
}

export async function dropOwnedMatrixSchema(
	ownedSchema: OwnedMatrixSchema,
): Promise<void> {
	const ownership = ownedMatrixSchemas.get(ownedSchema);
	if (ownership === undefined) {
		const state = consumedMatrixSchemas.has(ownedSchema)
			? 'consumed'
			: 'unknown';
		throw new Error(
			`cannot drop catalogue matrix schema with a ${state} ownership token`,
		);
	}
	if (droppingMatrixSchemas.has(ownedSchema))
		throw new Error(
			'cannot drop catalogue matrix schema with an ownership token already in flight',
		);
	droppingMatrixSchemas.add(ownedSchema);
	const { executor, name } = ownership;
	assertMatrixSchemaIdentifier(name);
	try {
		await executor.query(`DROP SCHEMA ${name} CASCADE`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`catalogue matrix schema cleanup failed for ${name}: ${detail}`,
			{
				cause: error,
			},
		);
	} finally {
		droppingMatrixSchemas.delete(ownedSchema);
	}
	ownedMatrixSchemas.delete(ownedSchema);
	consumedMatrixSchemas.add(ownedSchema);
}
