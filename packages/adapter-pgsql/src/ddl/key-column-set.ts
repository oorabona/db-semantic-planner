import type { IndexIR } from '@dbsp/types';

/** A key column set, with duplicates rejected and names encoded unambiguously. */
export function canonicalColumnSet(
	columns: readonly string[],
): string | undefined {
	if (new Set(columns).size !== columns.length) return undefined;
	return JSON.stringify([...columns].sort());
}

export function sameColumnSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const leftKey = canonicalColumnSet(left);
	const rightKey = canonicalColumnSet(right);
	return leftKey !== undefined && leftKey === rightKey;
}

/** PostgreSQL-valid unique-index backing key for a foreign key. */
export function isQualifyingUniqueIndex(
	index: IndexIR | undefined,
	columns: readonly string[],
): boolean {
	return (
		index?.unique === true &&
		index.where === undefined &&
		(index.expressions === undefined || index.expressions.length === 0) &&
		sameColumnSet(index.columns, columns)
	);
}
