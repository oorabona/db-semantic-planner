import type { Pool } from 'pg';
import type { PgPhysicalModel } from '../physical-model/index.js';
import {
	convergePgPhysical,
	type ConvergePgOptions as InternalConvergePgOptions,
	type PgConvergeCheckResult,
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
	return convergePgPhysical(
		pool,
		physical,
		physicalConvergeOptions(physical, options),
	);
}
