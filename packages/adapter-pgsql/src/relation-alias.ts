/**
 * Resolve a relation path to the SQL alias emitted for it in this query.
 *
 * Nested paths intentionally require an exact match: their leaf name can be
 * shared by another joined relation.
 */
export function resolveVisibleRelationAlias(
	relation: string,
	column: string,
	aliases: ReadonlyMap<string, string>,
): string {
	const alias = aliases.get(relation);
	if (alias) return alias;
	throw new Error(
		`relation column ${JSON.stringify(relation)}.${JSON.stringify(column)} has no emitted alias in this query`,
	);
}
