import type { ColumnIR } from '@dbsp/types';
import { pgBuiltInTypeFamily, renderColumnDbType } from '../db-type.js';

export type ColumnEmissionDecision =
	| {
			readonly type: 'plain';
			readonly defaultKind?: 'authored';
	  }
	| {
			readonly type: 'serial' | 'bigserial';
			readonly defaultKind: 'generated-sequence';
	  };

/** An auto-increment marker cannot create a sequence for this physical type. */
export class AutoIncrementColumnTypeError extends Error {
	constructor(type: string) {
		super(
			`generator planning refuses autoIncrement: ${type} is not an integer or bigint column type`,
		);
		this.name = 'AutoIncrementColumnTypeError';
	}
}

/** SERIAL/BIGSERIAL would silently strengthen an explicitly nullable column. */
export class AutoIncrementNullableColumnError extends Error {
	constructor(type: string) {
		super(
			`generator planning refuses autoIncrement: ${type} emits SERIAL/BIGSERIAL, which PostgreSQL makes NOT NULL while the column is nullable`,
		);
		this.name = 'AutoIncrementNullableColumnError';
	}
}

/**
 * The single source of truth for a column's emitted type/default relationship.
 * An authored default deliberately wins over autoIncrement: SERIAL/BIGSERIAL
 * creates its own default and cannot also preserve an authored one.
 */
export function decideColumnEmission(
	column: ColumnIR,
	targetSchema?: string,
): ColumnEmissionDecision {
	if (column.default !== undefined)
		return { type: 'plain', defaultKind: 'authored' };
	if (!column.autoIncrement) return { type: 'plain' };

	const databaseType = renderColumnDbType(column, targetSchema);
	const family = pgBuiltInTypeFamily(databaseType);
	if (family !== undefined && column.nullable)
		throw new AutoIncrementNullableColumnError(databaseType);
	if (family === 'integer')
		return { type: 'serial', defaultKind: 'generated-sequence' };
	if (family === 'bigint')
		return { type: 'bigserial', defaultKind: 'generated-sequence' };
	throw new AutoIncrementColumnTypeError(databaseType);
}
