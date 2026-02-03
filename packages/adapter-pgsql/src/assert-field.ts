/**
 * Default primary key column name used as convention fallback
 * when schema metadata doesn't provide an explicit PK.
 *
 * Consumers (handlers, compiler) must NOT use this directly —
 * they use `requiredColumn()` to throw on missing data.
 * Only convention mappers (extractors, introspection) should reference this.
 */
export const DEFAULT_PK_COLUMN = 'id';

/**
 * Derive a foreign key column name from a table name and the PK column it references.
 *
 * Convention: `${singularTableName}_${pkColumnName}`
 * e.g. (authors, id) → author_id, (categories, id) → category_id
 *
 * Consumers should use `deriveFkColumnName` from CompilerContext or options
 * for configurable behavior.
 */
export type FkColumnDerivation = (
	tableName: string,
	pkColumnName: string,
) => string;

/**
 * Simple English plurals → singular: removes trailing 's', handles 'ies' → 'y'.
 */
function singularize(name: string): string {
	if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
	if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
	return name;
}

export const defaultFkDerivation: FkColumnDerivation = (
	tableName,
	pkColumnName,
) => `${singularize(tableName)}_${pkColumnName}`;

/**
 * Assert that a column field expected from a PlanDecision is defined.
 * Throws instead of silently falling back to 'id' — catches upstream bugs
 * where WhereIntent fields (field/kind) aren't converted to PlanDecision (column/type).
 */
export function requiredColumn(
	value: string | undefined,
	field: string,
	context?: string,
): string {
	if (!value) {
		throw new Error(
			`Missing required column '${field}'${context ? ` in ${context}` : ''}`,
		);
	}
	return value;
}
