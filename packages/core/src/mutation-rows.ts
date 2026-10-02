import { InvalidOperationError } from './dx/errors.js';

/** Inspect own enumerable mutation keys without consulting model metadata. */
export function inspectMutationRows(
	rows: readonly Record<string, unknown>[],
	options: {
		operation: 'insert' | 'upsert' | 'update';
		homogeneous?: boolean;
		requiredKeys?: readonly string[];
	},
): { columns: string[]; heterogeneous: boolean } {
	const columns = Object.keys(rows[0] ?? {});
	const firstKeys = [...columns];
	const seen = new Set(columns);
	let heterogeneous = false;
	for (const [index, row] of rows.entries()) {
		for (const key of firstKeys) {
			if (!Object.hasOwn(row, key)) {
				heterogeneous = true;
				if (options.homogeneous)
					throw new InvalidOperationError(
						options.operation,
						`${options.operation}: row ${index} lacks key '${key}' present in row 0`,
					);
			}
		}
		for (const key of Object.keys(row)) {
			if (!Object.hasOwn(rows[0] ?? {}, key)) {
				heterogeneous = true;
				if (options.homogeneous)
					throw new InvalidOperationError(
						options.operation,
						`${options.operation}: row ${index} has key '${key}' that row 0 does not`,
					);
			}
			if (!seen.has(key)) {
				seen.add(key);
				columns.push(key);
			}
		}
		for (const key of options.requiredKeys ?? []) {
			if (!Object.hasOwn(row, key))
				throw new InvalidOperationError(
					options.operation,
					`${options.operation}: row ${index} lacks required match key '${key}'`,
				);
		}
	}
	return { columns, heterogeneous };
}
