/** Render CREATE POLICY clauses in PostgreSQL grammar order. */
export function renderPolicyClauses(
	asClause: string,
	forClause: string,
	toClause: string,
	usingClause: string,
	withCheckClause: string,
): string {
	return `${asClause}${forClause}${toClause}${usingClause}${withCheckClause}`;
}
