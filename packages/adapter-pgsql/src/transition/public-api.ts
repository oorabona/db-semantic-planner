import type { Pool } from 'pg';
import type { PgPhysicalModel } from '../physical-model/index.js';
import { declaredSequenceNamesFromInventory } from '../sequence-name.js';
import {
	convergePg as convergePgForModel,
	type ConvergePgCheckOptions as InternalConvergePgCheckOptions,
	type ConvergePgOptions as InternalConvergePgOptions,
	type PgConvergeCheckResult,
	PgConvergeRefusalError,
	type PgConvergeResult,
} from './converge.js';

export interface ConvergePgBaseOptions
	extends Omit<
		InternalConvergePgOptions,
		'schema' | 'dbCasing' | 'mode' | 'declaredSequenceNames'
	> {}
export interface ConvergePgOptions extends ConvergePgBaseOptions {
	readonly mode?: 'apply';
}
export interface ConvergePgCheckOptions extends ConvergePgBaseOptions {
	readonly mode: 'check';
}

function physicalTable(physical: PgPhysicalModel, table: string): string {
	return physical.inventory.get({
		kind: 'table',
		schema: physical.schema,
		name: table,
	});
}

/**
 * `externalIndexes` names tables in the caller's logical vocabulary. Validate
 * that vocabulary before resolving it through the physical inventory, so an
 * undeclared table remains the documented invalid-options refusal.
 */
function validateExternalIndexes(
	physical: PgPhysicalModel,
	externalIndexes: ConvergePgBaseOptions['externalIndexes'],
): void {
	if (externalIndexes === undefined) return;
	if (!Array.isArray(externalIndexes))
		throw new PgConvergeRefusalError(
			'invalid-options',
			[],
			'converge externalIndexes must be an array',
		);
	const declaredTables = new Set(
		physical.inventory.entries.flatMap((entry) =>
			entry.logical.kind === 'table' && entry.logical.schema === physical.schema
				? [entry.logical.name]
				: [],
		),
	);
	for (const [position, entry] of externalIndexes.entries()) {
		const label = `externalIndexes[${position}]`;
		if (
			entry === null ||
			typeof entry !== 'object' ||
			Array.isArray(entry) ||
			typeof entry.table !== 'string' ||
			entry.table.length === 0 ||
			typeof entry.name !== 'string' ||
			entry.name.length === 0
		)
			throw new PgConvergeRefusalError(
				'invalid-options',
				[],
				`converge ${label} must be an object with non-empty string table and name fields`,
			);
		if (!declaredTables.has(entry.table))
			throw new PgConvergeRefusalError(
				'invalid-options',
				[],
				`converge ${label} names undeclared table ${entry.table}`,
			);
	}
}

/** Converts ownership declarations at the public boundary; index names are physical by contract. */
function physicalOptions(
	physical: PgPhysicalModel,
	options: ConvergePgOptions | ConvergePgCheckOptions,
): InternalConvergePgOptions | InternalConvergePgCheckOptions {
	validateExternalIndexes(physical, options.externalIndexes);
	const externalIndexes = options.externalIndexes?.map((entry) => ({
		...entry,
		table: physicalTable(physical, entry.table),
	}));
	const steps = options.steps?.map((step) => {
		if (step.kind !== 'assert' || step.owns === undefined) return step;
		const owns = step.owns;
		return {
			...step,
			owns: {
				...owns,
				...(owns.columnTypes === undefined
					? {}
					: {
							columnTypes: owns.columnTypes.map((entry) => ({
								table: physicalTable(physical, entry.table),
								column: physical.inventory.get({
									kind: 'column',
									schema: physical.schema,
									table: entry.table,
									name: entry.column,
								}),
							})),
						}),
				...(owns.checks === undefined
					? {}
					: {
							checks: owns.checks.map((entry) => ({
								table: physicalTable(physical, entry.table),
								name: physical.inventory.get({
									kind: 'constraint',
									schema: physical.schema,
									table: entry.table,
									name: entry.name,
								}),
							})),
						}),
				...(owns.indexes === undefined
					? {}
					: {
							indexes: owns.indexes.map((entry) => ({
								...entry,
								table: physicalTable(physical, entry.table),
							})),
						}),
			},
		};
	});
	return {
		...options,
		...(externalIndexes === undefined ? {} : { externalIndexes }),
		...(steps === undefined ? {} : { steps }),
		schema: physical.schema,
		dbCasing: 'preserve',
		declaredSequenceNames: declaredSequenceNamesFromInventory(
			physical.inventory,
		),
	};
}

export function convergePg(
	pool: Pool,
	physical: PgPhysicalModel,
	options?: ConvergePgOptions,
): Promise<PgConvergeResult>;
export function convergePg(
	pool: Pool,
	physical: PgPhysicalModel,
	options: ConvergePgCheckOptions,
): Promise<PgConvergeCheckResult>;
export function convergePg(
	pool: Pool,
	physical: PgPhysicalModel,
	options: ConvergePgOptions | ConvergePgCheckOptions = {},
): Promise<PgConvergeResult | PgConvergeCheckResult> {
	return convergePgForModel(
		pool,
		physical.model,
		physicalOptions(physical, options) as never,
	);
}
