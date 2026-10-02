import { InvalidOperationError } from './dx/errors.js';

/** Inspect enumerable own keys without consulting model metadata. */
export function inspectMutationRows(
	rows: readonly Record<string, unknown>[],
	options: {
		operation: 'insert' | 'upsert' | 'update';
		homogeneous?: boolean;
		requiredKeys?: readonly string[];
	},
): {
	columns: string[];
	heterogeneous: boolean;
	rowKeys: ReadonlySet<string>[];
} {
	const rowKeys = rows.map((row) => new Set(Object.keys(row)));
	const columns = [...(rowKeys[0] ?? [])];
	const firstKeys = [...columns];
	const seen = new Set(columns);
	let heterogeneous = false;
	for (const [index, keys] of rowKeys.entries()) {
		for (const key of firstKeys) {
			if (!keys.has(key)) {
				heterogeneous = true;
				if (options.homogeneous)
					throw new InvalidOperationError(
						options.operation,
						`${options.operation}: row ${index} lacks key '${key}' present in row 0`,
					);
			}
		}
		for (const key of keys) {
			if (!rowKeys[0]?.has(key)) {
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
			if (!keys.has(key))
				throw new InvalidOperationError(
					options.operation,
					`${options.operation}: row ${index} lacks required match key '${key}'`,
				);
		}
	}
	return { columns, heterogeneous, rowKeys };
}
