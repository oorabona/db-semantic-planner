import type { Pool } from 'pg';
import type { PgPhysicalModel } from '../physical-model/index.js';
import { escapeDiagnosticText, validateIdentifier } from '../validate.js';
import {
	convergePgPhysical,
	type ConvergePgOptions as InternalConvergePgOptions,
	type PgConvergeCheckResult,
	PgConvergeRefusalError,
	type PgConvergeResult,
	physicalConvergeOptions,
} from './converge.js';

export interface ConvergePgBaseOptions
	extends Omit<
		InternalConvergePgOptions,
		'schema' | 'dbCasing' | 'mode' | 'declaredSequenceNames' | 'fkAutoIndex'
	> {}
export interface ConvergePgOptions extends ConvergePgBaseOptions {
	readonly mode?: 'apply';
}

export interface ConvergePgCheckOptions extends ConvergePgBaseOptions {
	readonly mode: 'check';
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
	try {
		validateIdentifier(physical.schema, 'schema');
	} catch (error) {
		throw new PgConvergeRefusalError(
			'invalid-options',
			[],
			`converge refuses physical schema ${escapeDiagnosticText(physical.schema)}: ${escapeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
		);
	}
	return convergePgPhysical(
		pool,
		physical,
		physicalConvergeOptions(physical, options),
	);
}
