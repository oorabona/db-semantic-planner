import { COLUMN_META } from './symbols.js';
import type { ColumnRef } from './table-ref.js';

/**
 * Extract the column name from a ColumnRef or string.
 * @internal Shared helper — used by filters, functions, window-functions, typed-query-builder.
 */
export function getColumnName(
	field: ColumnRef<string, string, unknown> | string,
): string {
	if (typeof field === 'string') {
		return field;
	}
	const colName = field[COLUMN_META];
	if (colName === undefined) {
		throw new Error('Invalid ColumnRef: missing COLUMN_META');
	}
	return colName;
}
