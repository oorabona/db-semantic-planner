import type { TableIR } from '@dbsp/types';

/**
 * Whether a declared key can serve lookups through a single-column foreign key.
 *
 * This deliberately preserves key order. It is not a uniqueness check and must
 * not use canonicalColumnSet(), which sorts columns for a different purpose.
 */
export function hasDeclaredFkIndexCoverage(
	table: TableIR,
	fkColumn: string,
): boolean {
	if (primaryKeyColumns(table.primaryKey)[0] === fkColumn) return true;

	if (
		table.columns.some(
			(column) => column.name === fkColumn && column.unique === true,
		)
	) {
		return true;
	}

	return table.indexes.some(
		(index) =>
			index.columns[0] === fkColumn &&
			index.where === undefined &&
			(index.expressions === undefined || index.expressions.length === 0) &&
			(index.method === undefined || index.method === 'btree'),
	);
}

/**
 * Whether a declared index is the single-column key recognized by the current
 * generation and fresh-FK admission rules. Unlike coverage, this intentionally
 * considers every declared single-column index, regardless of its options.
 */
export function hasDeclaredSingleColumnFkIndex(
	table: TableIR,
	fkColumn: string,
): boolean {
	return table.indexes.some(
		(index) => index.columns.length === 1 && index.columns[0] === fkColumn,
	);
}

/**
 * Whether a declared key admits a fresh single-column foreign key.
 *
 * Admission matches automatic FK-index emission: a covering key or any
 * declared single-column index means generation needs no automatic index.
 */
export function hasDeclaredFkIndexAdmission(
	table: TableIR,
	fkColumn: string,
): boolean {
	return (
		hasDeclaredFkIndexCoverage(table, fkColumn) ||
		hasDeclaredSingleColumnFkIndex(table, fkColumn)
	);
}

/**
 * Whether generation should emit an automatic index for a single-column FK.
 *
 * A declared single-column index suppresses automatic generation even when it
 * is not a covering lookup key.
 */
export function shouldEmitAutoFkIndex(
	table: TableIR,
	fkColumn: string,
): boolean {
	return !hasDeclaredFkIndexAdmission(table, fkColumn);
}

function primaryKeyColumns(
	primaryKey: TableIR['primaryKey'],
): readonly string[] {
	if (primaryKey === undefined) return [];

	// Match generateCreateTable's defensive normalisation for introspected IR.
	const rawPrimaryKey = primaryKey as unknown;
	if (
		rawPrimaryKey !== null &&
		typeof rawPrimaryKey === 'object' &&
		'columns' in rawPrimaryKey &&
		Array.isArray((rawPrimaryKey as { columns: unknown }).columns)
	) {
		return (rawPrimaryKey as { columns: readonly string[] }).columns;
	}
	return Array.isArray(rawPrimaryKey)
		? rawPrimaryKey
		: [rawPrimaryKey as string];
}
