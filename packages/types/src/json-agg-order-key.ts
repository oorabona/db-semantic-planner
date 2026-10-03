import { toColumnList } from './column-list.js';
import type { TableIR } from './model-ir.js';

/**
 * Dialect-neutral json_agg order intent.
 *
 * `fallback` means the table has no declared primary key, so adapters should
 * realize the all-column deterministic fallback in their own dialect.
 */
export interface JsonAggOrderKey {
	readonly columns: readonly string[];
	readonly fallback: boolean;
}

/**
 * Use the declared primary-key columns when present (fallback: false).
 * Otherwise use every declared column in table order (fallback: true), which
 * adapters realize as their dialect's deterministic all-column ordering.
 */
export function resolveJsonAggOrderKey(table: TableIR): JsonAggOrderKey {
	const pkColumns = toColumnList(table.primaryKey);
	return pkColumns.length > 0
		? { columns: pkColumns, fallback: false }
		: { columns: table.columns.map((col) => col.name), fallback: true };
}
