import { validateIdentifier } from './errors.js';

/** The segments of a relation-mode join and the alias of each hop's range. */
export interface RelationJoinHops {
	readonly segments: readonly string[];
	readonly aliases: readonly string[];
}

/**
 * Split a relation-mode join argument into its relation segments and name each hop.
 *
 * Hop k defaults to the prefix joined with `_` (`callee`, `callee_file`); a string alias names the last
 * hop and an alias list names every hop. Every segment and alias is a validated identifier.
 */
export function relationJoinHops(
	relation: string,
	alias: string | readonly string[] | undefined,
): RelationJoinHops {
	const segments = relation.split('.');
	for (const segment of segments) validateIdentifier(segment, 'relation');
	if (alias !== undefined && typeof alias !== 'string') {
		if (alias.length !== segments.length)
			throw new Error(
				`join('${relation}'): 'as' lists ${alias.length} aliases for ${segments.length} hops.`,
			);
	}
	const last = segments.length - 1;
	const aliases = segments.map((_, k) => {
		if (alias !== undefined && typeof alias !== 'string')
			return alias[k] as string;
		if (k === last && typeof alias === 'string') return alias;
		return segments.slice(0, k + 1).join('_');
	});
	for (const hopAlias of aliases) validateIdentifier(hopAlias, 'alias');
	return { segments, aliases };
}
