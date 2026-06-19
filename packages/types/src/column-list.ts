/**
 * Shared relation-key normalizer.
 *
 * Relation metadata accepts either a single column or a composite column list.
 * Readers should normalize once and keep the full list instead of degrading to
 * the first column.
 */
export type ColumnListInput = string | readonly string[] | undefined;

export function toColumnList(key: ColumnListInput): readonly string[] {
	if (key === undefined) return [];
	return typeof key === 'string' ? [key] : key;
}
