
/**
 * PostgreSQL built-in function helpers.
 *
 * Thin wrappers around core expression primitives for common PostgreSQL functions.
 * Same pattern as pgvector.ts and paradedb.ts.
 */
import { fn, literal, type ExpressionRef } from '@dbsp/core';

/**
 * Generate a series of values: generate_series(start, stop[, step])
 *
 * Returns a set of values from start to stop (inclusive), with an optional step.
 * Commonly used with CTE for batch operations.
 *
 * @example generateSeries(1, 100) → generate_series(1, 100)
 * @example generateSeries(0, 50, 5) → generate_series(0, 50, 5)
 */
export function generateSeries(
	start: number,
	stop: number,
	step?: number,
): ExpressionRef {
	const args: ExpressionRef[] = [literal(start), literal(stop)];
	if (step !== undefined) {
		args.push(literal(step));
	}
	return fn('generate_series', ...args);
}

/**
 * Get next value from a sequence: nextval('sequence_name')
 *
 * @example nextval('order_id_seq') → nextval('order_id_seq')
 */
export function nextval(sequenceName: string): ExpressionRef {
	return fn('nextval', literal(sequenceName));
}
