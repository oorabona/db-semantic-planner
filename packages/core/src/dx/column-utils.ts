import { COLUMN_META, RELATION_PATH, TABLE_META } from './symbols.js';
import type { ColumnRef } from './table-ref.js';

/**
 * Turn a ColumnRef or a field name into the field name a query resolves.
 *
 * A ColumnRef from a TableRef (`orm.tables.files.id`) yields `files.id`; one
 * reached through a relation (`symbols.file.path`) yields its relation path,
 * `file.path`; one from a re-rooted RelationRef (a quantifier callback) has an
 * empty path and yields the bare column, bound to the relation's own range.
 * The query resolves the qualifier as it does for the same string.
 *
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
	const relationPath = (
		field as { readonly [RELATION_PATH]?: readonly string[] }
	)[RELATION_PATH];
	if (relationPath !== undefined) {
		return relationPath.length === 0
			? colName
			: `${relationPath.join('.')}.${colName}`;
	}
	const tableName = field[TABLE_META];
	if (tableName === undefined) {
		throw new Error('Invalid ColumnRef: missing TABLE_META');
	}
	return `${tableName}.${colName}`;
}

/**
 * Whether a field is a typed column ref reached through at least one relation:
 * its `getColumnName` is a relation path that a body would re-read from its own
 * row (see the `pathRef` marker of the where intents).
 *
 * @internal
 */
export function isRelationPathColumn(
	field: ColumnRef<string, string, unknown> | string,
): boolean {
	if (typeof field === 'string') return false;
	const relationPath = (
		field as { readonly [RELATION_PATH]?: readonly string[] }
	)[RELATION_PATH];
	return relationPath !== undefined && relationPath.length > 0;
}

/**
 * The column's own name, without its table or relation path: for positions that
 * name a column of the builder's own table (the typed builder's `pick()` and
 * `orderBy()`).
 *
 * @internal
 */
export function getBareColumnName(
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
