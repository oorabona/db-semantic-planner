import type { TableIR } from '@dbsp/types';

/** Resolve the physical name PostgreSQL will use for a declared index. */
export function getResolvedIndexName(
	tableName: string,
	columns: readonly string[],
	declaredName: string | undefined,
): string {
	return declaredName ?? `idx_${tableName}_${columns.join('_')}`;
}

/** Base name for an automatically generated single-column FK index. */
export function getAutoFkIndexName(
	tableName: string,
	columnName: string,
): string {
	return `idx_${tableName}_${columnName}`;
}

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
 * The pre-#830 generation rule, retained only to recognize legacy automatic
 * indexes during comparison. Unlike coverage, this intentionally considers
 * every declared single-column index, regardless of its options.
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
 * Whether generation should emit an automatic index for a single-column FK.
 *
 * A declared single-column index suppresses automatic generation even when it
 * is not a covering lookup key. This preserves the pre-#830 emission rule;
 * coverage remains available to callers that need to enforce lookup safety.
 */
export function shouldEmitAutoFkIndex(
	table: TableIR,
	fkColumn: string,
): boolean {
	return (
		!hasDeclaredFkIndexCoverage(table, fkColumn) &&
		!hasDeclaredSingleColumnFkIndex(table, fkColumn)
	);
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
