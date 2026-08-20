import { createHash } from 'node:crypto';

export const DEFAULT_MAX_PREPARED_STATEMENTS = 500;
/** Namespace reserved for names created by dbsp on an executor. */
export const PREPARED_STATEMENT_NAMESPACE = 'dbsp_ps_';

export type PreparedStatementNameHasher = (sql: string) => string;

/** Full SHA-256 identity used for bounded registry bookkeeping. */
export function derivePreparedStatementFingerprint(sql: string): string {
	return createHash('sha256').update(sql).digest('hex');
}

/**
 * Produces a PostgreSQL-safe node-postgres statement name from 128 bits of
 * SHA-256 of the complete SQL text.
 *
 * Node-postgres reuses its statement mapping by name, so distinct text must
 * never deliberately share a name.
 */
export function derivePreparedStatementName(sql: string): string {
	return `${PREPARED_STATEMENT_NAMESPACE}${derivePreparedStatementFingerprint(sql).slice(0, 32)}`;
}

/**
 * Executor-scoped admission, naming, and collision-protection registry for named
 * statements.
 *
 * Candidates are retained only until their second sighting. They form a
 * bounded recency window: when it is full, the oldest candidate is evicted.
 * A candidate evicted between sightings must be seen again before it can be
 * admitted. Once named admission is full, no new candidate text is retained.
 */
export class PreparedStatementRegistry {
	private readonly candidates = new Set<string>();
	private readonly namesByFingerprint = new Map<string, string>();
	private readonly fingerprintsByName = new Map<string, string>();
	private readonly collisionRejectedFingerprints = new Set<string>();

	constructor(
		private readonly maxStatements: number,
		private readonly hashName: PreparedStatementNameHasher = derivePreparedStatementName,
	) {}

	/** Returns a name only from the second sighting onward. */
	admit(sql: string): string | undefined {
		const fingerprint = derivePreparedStatementFingerprint(sql);
		if (this.collisionRejectedFingerprints.has(fingerprint)) return undefined;

		const knownName = this.namesByFingerprint.get(fingerprint);
		if (knownName !== undefined) return knownName;

		if (!this.candidates.delete(fingerprint)) {
			if (this.namesByFingerprint.size >= this.maxStatements) return undefined;
			if (this.candidates.size >= this.maxStatements) {
				const oldest = this.candidates.values().next().value;
				if (oldest !== undefined) this.candidates.delete(oldest);
			}
			this.candidates.add(fingerprint);
			return undefined;
		}

		if (this.namesByFingerprint.size >= this.maxStatements) return undefined;

		const name = this.hashName(sql);
		const existingFingerprint = this.fingerprintsByName.get(name);
		if (
			existingFingerprint !== undefined &&
			existingFingerprint !== fingerprint
		) {
			this.rejectHashCollision(fingerprint);
			return undefined;
		}
		this.namesByFingerprint.set(fingerprint, name);
		this.fingerprintsByName.set(name, fingerprint);
		if (this.namesByFingerprint.size >= this.maxStatements)
			this.candidates.clear();
		return name;
	}

	/** Keeps a colliding full fingerprint unnamed within a bounded registry. */
	private rejectHashCollision(fingerprint: string): void {
		if (this.collisionRejectedFingerprints.size >= this.maxStatements) {
			const oldest = this.collisionRejectedFingerprints.values().next().value;
			if (oldest !== undefined)
				this.collisionRejectedFingerprints.delete(oldest);
		}
		this.collisionRejectedFingerprints.add(fingerprint);
		this.candidates.delete(fingerprint);
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
