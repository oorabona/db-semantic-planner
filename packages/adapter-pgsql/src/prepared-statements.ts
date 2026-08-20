import { createHash } from 'node:crypto';

export const DEFAULT_MAX_PREPARED_STATEMENTS = 500;
/** Namespace reserved for names created by dbsp on an executor. */
export const PREPARED_STATEMENT_NAMESPACE = 'dbsp_ps_';

export type PreparedStatementNameHasher = (sql: string) => string;

export interface PreparedStatementReservation {
	readonly fingerprint: string;
	readonly name: string;
	readonly generation: number;
}

export interface PreparedStatementAdmission {
	readonly name: string;
	/** Present only until a named execution has demonstrated the name is usable. */
	readonly reservation?: PreparedStatementReservation;
}

interface PendingPreparedStatement {
	readonly name: string;
	readonly generations: Set<number>;
}

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
	private readonly pendingByFingerprint = new Map<
		string,
		PendingPreparedStatement
	>();
	private readonly collisionRejectedFingerprints = new Set<string>();
	private nextGeneration = 0;

	constructor(
		private readonly maxStatements: number,
		private readonly hashName: PreparedStatementNameHasher = derivePreparedStatementName,
	) {}

	/**
	 * Reserves a name only from the second sighting onward. Call confirm to commit
	 * executor-scoped admission after a successful named execution or a failure the
	 * caller classified as server-reported. Call abort for a failure the caller
	 * classified as never having reached server acceptance.
	 */
	admit(sql: string): PreparedStatementAdmission | undefined {
		const fingerprint = derivePreparedStatementFingerprint(sql);
		if (this.collisionRejectedFingerprints.has(fingerprint)) return undefined;

		const knownName = this.namesByFingerprint.get(fingerprint);
		if (knownName !== undefined) return { name: knownName };

		const pending = this.pendingByFingerprint.get(fingerprint);
		if (pending !== undefined) {
			return this.reserveAttempt(fingerprint, pending);
		}

		if (!this.candidates.delete(fingerprint)) {
			if (this.atCapacity()) return undefined;
			if (this.candidates.size >= this.maxStatements) {
				const oldest = this.candidates.values().next().value;
				if (oldest !== undefined) this.candidates.delete(oldest);
			}
			this.candidates.add(fingerprint);
			return undefined;
		}

		if (this.atCapacity()) return undefined;

		const name = this.hashName(sql);
		const existingFingerprint = this.fingerprintsByName.get(name);
		if (
			existingFingerprint !== undefined &&
			existingFingerprint !== fingerprint
		) {
			this.rejectHashCollision(fingerprint);
			return undefined;
		}
		this.fingerprintsByName.set(name, fingerprint);
		const reservation = this.reserveAttempt(fingerprint, {
			name,
			generations: new Set(),
		});
		if (this.atCapacity()) this.candidates.clear();
		return reservation;
	}

	/** Commits executor-scoped admission after a successful named execution or a caller-classified server-reported failure. */
	confirm(reservation: PreparedStatementReservation): void {
		const pending = this.pendingByFingerprint.get(reservation.fingerprint);
		if (
			pending === undefined ||
			pending.name !== reservation.name ||
			!pending.generations.has(reservation.generation)
		)
			return;
		this.pendingByFingerprint.delete(reservation.fingerprint);
		this.namesByFingerprint.set(reservation.fingerprint, reservation.name);
	}

	/** Aborts only this still-pending attempt after a caller-classified failure that never reached server acceptance, never a later confirmation. */
	abort(reservation: PreparedStatementReservation): void {
		const pending = this.pendingByFingerprint.get(reservation.fingerprint);
		if (
			pending === undefined ||
			pending.name !== reservation.name ||
			!pending.generations.delete(reservation.generation)
		)
			return;
		if (pending.generations.size !== 0) return;
		this.pendingByFingerprint.delete(reservation.fingerprint);
		if (
			this.fingerprintsByName.get(reservation.name) === reservation.fingerprint
		) {
			this.fingerprintsByName.delete(reservation.name);
		}
	}

	private atCapacity(): boolean {
		return (
			this.namesByFingerprint.size + this.pendingByFingerprint.size >=
			this.maxStatements
		);
	}

	private reserveAttempt(
		fingerprint: string,
		pending: PendingPreparedStatement,
	): PreparedStatementAdmission {
		this.pendingByFingerprint.set(fingerprint, pending);
		const reservation = {
			fingerprint,
			name: pending.name,
			generation: this.nextGeneration++,
		};
		pending.generations.add(reservation.generation);
		return { name: pending.name, reservation };
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
