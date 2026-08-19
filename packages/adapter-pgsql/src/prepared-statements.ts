import { createHash } from 'node:crypto';

export const DEFAULT_MAX_PREPARED_STATEMENTS = 500;

export type PreparedStatementNameHasher = (sql: string) => string;

/**
 * Produces a node-postgres statement name from 128 bits of SHA-256.
 *
 * The SQL text is deliberately the complete hash input: node-postgres reuses
 * a statement by name even if a later call supplies different text.
 */
export function derivePreparedStatementName(sql: string): string {
	return `dbsp_ps_${createHash('sha256').update(sql).digest('hex').slice(0, 32)}`;
}

/**
 * Pool-scoped admission and collision registry for named statements.
 *
 * Candidates are retained only until their second sighting.  There is no
 * eviction: once the statement cap is reached, new texts stay unnamed.
 */
export class PreparedStatementRegistry {
	private readonly candidates = new Set<string>();
	private readonly namesByText = new Map<string, string>();
	private readonly textsByName = new Map<string, string>();
	private readonly collisionTexts = new Set<string>();

	constructor(
		private readonly maxStatements: number,
		private readonly hashName: PreparedStatementNameHasher = derivePreparedStatementName,
	) {}

	/** Returns a name only from the second sighting onward. */
	admit(sql: string): string | undefined {
		const textKey = sql;
		if (this.collisionTexts.has(sql)) return undefined;

		const knownName = this.namesByText.get(textKey);
		if (knownName !== undefined) return knownName;

		if (!this.candidates.delete(sql)) {
			if (this.candidates.size < this.maxStatements) {
				this.candidates.add(sql);
			}
			return undefined;
		}

		if (this.namesByText.size >= this.maxStatements) return undefined;

		const name = this.hashName(sql);
		const existingText = this.textsByName.get(name);
		if (existingText !== undefined && existingText !== sql) {
			this.collisionTexts.add(sql);
			return undefined;
		}

		this.namesByText.set(textKey, name);
		this.textsByName.set(name, sql);
		return name;
	}
}

export function normalizeMaxPreparedStatements(
	maxStatements: number | undefined,
): number {
	const resolved = maxStatements ?? DEFAULT_MAX_PREPARED_STATEMENTS;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error(
			'preparedStatements.maxStatements must be a positive integer.',
		);
	}
	return resolved;
}
