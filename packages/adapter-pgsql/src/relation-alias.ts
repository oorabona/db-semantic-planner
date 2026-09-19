/**
 * Resolve a relation path to the SQL alias emitted for it in this query.
 *
 * Nested paths intentionally require an exact match: their leaf name can be
 * shared by another joined relation.
 */
const AMBIGUOUS_RELATION_ALIAS_PREFIX = '\0dbsp:ambiguous-relation-alias:';

/**
 * Record two emitted aliases that serve the same public relation path.
 *
 * The NUL-prefixed value cannot be an emitted SQL alias: aliases are validated
 * identifiers before they enter the registry. Keeping this sentinel as a
 * string lets the existing handler context retain its Map<string, string>
 * contract while the resolver remains its only interpreter.
 */
export function ambiguousRelationAlias(
	firstAlias: string,
	secondAlias: string,
): string {
	return `${AMBIGUOUS_RELATION_ALIAS_PREFIX}${JSON.stringify([firstAlias, secondAlias])}`;
}

export function isAmbiguousRelationAlias(alias: string): boolean {
	return alias.startsWith(AMBIGUOUS_RELATION_ALIAS_PREFIX);
}

function ambiguousAliases(alias: string): readonly [string, string] {
	const aliases = JSON.parse(
		alias.slice(AMBIGUOUS_RELATION_ALIAS_PREFIX.length),
	) as unknown;
	if (
		!Array.isArray(aliases) ||
		aliases.length !== 2 ||
		typeof aliases[0] !== 'string' ||
		typeof aliases[1] !== 'string'
	) {
		throw new Error('Invalid ambiguous relation alias registry entry');
	}
	return [aliases[0], aliases[1]];
}

export function resolveVisibleRelationAlias(
	relation: string,
	column: string,
	aliases: ReadonlyMap<string, string>,
): string {
	const alias = aliases.get(relation);
	if (alias) {
		if (isAmbiguousRelationAlias(alias)) {
			const [firstAlias, secondAlias] = ambiguousAliases(alias);
			throw new Error(
				`relation column ${JSON.stringify(relation)}.${JSON.stringify(column)} is ambiguous between emitted aliases ${JSON.stringify(firstAlias)} and ${JSON.stringify(secondAlias)}`,
			);
		}
		return alias;
	}
	throw new Error(
		`relation column ${JSON.stringify(relation)}.${JSON.stringify(column)} has no emitted alias in this query`,
	);
}
