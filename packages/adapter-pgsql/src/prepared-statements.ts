export const DEFAULT_MAX_PREPARED_STATEMENTS = 500;
/** Namespace reserved for names created by dbsp on an executor. */
export const PREPARED_STATEMENT_NAMESPACE = 'dbsp_ps_';

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
	private readonly tombstones = new Set<string>();
	private nextName = 1;

	constructor(private readonly maxStatements: number) {}

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

		const name = `${PREPARED_STATEMENT_NAMESPACE}${this.nextName++}`;
		this.namesByText.set(textKey, name);
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
