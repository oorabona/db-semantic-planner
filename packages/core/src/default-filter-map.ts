import type { WhereIntent } from '@dbsp/types';

type FilterMap = Readonly<Record<string, WhereIntent>>;

/** Copy only own entries, retaining a null prototype after range exclusions. */
export function copyDefaultFilters(
	filters: FilterMap,
	keep: (table: string) => boolean = () => true,
): Record<string, WhereIntent> {
	const result = Object.create(null) as Record<string, WhereIntent>;
	for (const [table, filter] of Object.entries(filters)) {
		if (keep(table)) result[table] = filter;
	}
	return result;
}

/** Prototype properties never designate a physical scan policy. */
export function getDefaultFilter(
	filters: FilterMap | undefined,
	table: string,
): WhereIntent | undefined {
	return filters && Object.hasOwn(filters, table) ? filters[table] : undefined;
}
