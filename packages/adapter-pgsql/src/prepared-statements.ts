import { createHash } from 'node:crypto';

export const DEFAULT_MAX_PREPARED_STATEMENTS = 500;
/** Namespace reserved for names created by dbsp on an executor. */
export const PREPARED_STATEMENT_NAMESPACE = 'dbsp_ps_';

export type PreparedStatementNameHasher = (sql: string) => string;

/**
 * Produces a PostgreSQL-safe node-postgres statement name from 128 bits of
 * SHA-256 of the complete SQL text.
 *
 * Node-postgres reuses its statement mapping by name, so distinct text must
 * never deliberately share a name.
 */
export function derivePreparedStatementName(sql: string): string {
	return `${PREPARED_STATEMENT_NAMESPACE}${createHash('sha256')
		.update(sql)
		.digest('hex')
		.slice(0, 32)}`;
}

/**
 * Executor-scoped admission, naming, and tombstone registry for named statements.
 *
 * Candidates are retained only until their second sighting. They form a
 * bounded recency window: when it is full, the oldest candidate is evicted.
 * A candidate evicted between sightings must be seen again before it can be
 * admitted. Once named admission is full, no new candidate text is retained.
 */
export class PreparedStatementRegistry {
	private readonly candidates = new Set<string>();
	private readonly namesByText = new Map<string, string>();
	private readonly textsByName = new Map<string, string>();
	private readonly tombstones = new Set<string>();

	constructor(
		private readonly maxStatements: number,
		private readonly hashName: PreparedStatementNameHasher = derivePreparedStatementName,
	) {}

	/** Returns a name only from the second sighting onward. */
	admit(sql: string): string | undefined {
		const textKey = sql;
		if (this.tombstones.has(sql)) return undefined;

		const knownName = this.namesByText.get(textKey);
		if (knownName !== undefined) return knownName;

		if (!this.candidates.delete(sql)) {
			if (this.namesByText.size >= this.maxStatements) return undefined;
			if (this.candidates.size >= this.maxStatements) {
				const oldest = this.candidates.values().next().value;
				if (oldest !== undefined) this.candidates.delete(oldest);
			}
			this.candidates.add(sql);
			return undefined;
		}

		if (this.namesByText.size >= this.maxStatements) return undefined;

		const name = this.hashName(sql);
		const existingText = this.textsByName.get(name);
		if (existingText !== undefined && existingText !== sql) {
			this.tombstone(sql);
			return undefined;
		}
		this.namesByText.set(textKey, name);
		this.textsByName.set(name, sql);
		if (this.namesByText.size >= this.maxStatements) this.candidates.clear();
		return name;
	}

	/** Permanently disables named execution for this text on this executor. */
	tombstone(sql: string): void {
		this.tombstones.add(sql);
		this.candidates.delete(sql);
	}
}

export function normalizeMaxPreparedStatements(
	maxStatements: number | null | undefined,
): number {
	const resolved =
		maxStatements === undefined
			? DEFAULT_MAX_PREPARED_STATEMENTS
			: maxStatements;
	if (!Number.isSafeInteger(resolved))
		throw new Error('preparedStatements.maxStatements must be a safe integer.');
	const normalized = resolved as number;
	if (normalized < 1)
		throw new Error(
			'preparedStatements.maxStatements must be greater than zero.',
		);
	return normalized;
}
