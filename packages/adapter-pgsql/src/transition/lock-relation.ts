import type { LedgerAddress } from '@dbsp/types';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import type { TransitionJournalQueryable } from './journal.js';
import { renderPgLockIdentifier } from './lock-identifier.js';

export interface PgLockRelation {
	readonly schema: string;
	readonly table: string;
}

/** A catalogue read failed while establishing or proving a relation lock. */
export class PgResolvableRelationIdentityReadError extends Error {
	constructor(cause: unknown) {
		super('catalogue identity read failed while establishing a relation lock', {
			cause,
		});
		this.name = 'PgResolvableRelationIdentityReadError';
	}
}

/** A relation lock failed while establishing the catalogue identity boundary. */
export class PgResolvableRelationLockError extends Error {
	constructor(cause: unknown) {
		super('relation lock failed while establishing a relation lock', { cause });
		this.name = 'PgResolvableRelationLockError';
	}
}

/** Formats arbitrary thrown values without letting hostile objects throw again. */
export function formatPgTransitionUnknownError(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return 'unprintable thrown value';
	}
}

async function readCatalogueIdentity(
	executor: TransitionJournalQueryable,
	address: LedgerAddress,
): Promise<Awaited<ReturnType<typeof readPgCatalogueIdentity>>> {
	try {
		return await readPgCatalogueIdentity(executor, address);
	} catch (error) {
		throw new PgResolvableRelationIdentityReadError(error);
	}
}

/**
 * Returns the relation whose lock protects a mapped address through its
 * terminal append. Columns, constraints, and policies share their containing
 * table's DDL lock. Indexes are deliberately excluded: ALTER INDEX RENAME
 * locks the index relation itself, and SQL LOCK TABLE cannot lock an index.
 */
export function pgLockRelationForAddress(
	address: LedgerAddress,
	label = 'relation',
): PgLockRelation | undefined {
	if (address.kind === 'table' && address.schema)
		return { schema: address.schema, table: address.name };
	if (
		(address.kind === 'constraint' ||
			address.kind === 'column' ||
			address.kind === 'policy') &&
		address.parent?.kind === 'table' &&
		address.schema
	) {
		if (
			address.parent.schema !== undefined &&
			address.parent.schema !== address.schema
		)
			console.warn(
				`${label} lock ignores mismatched parent schema ${address.parent.schema} for ${address.kind} ${address.name}; catalogue identity resolves ${address.schema}`,
			);
		return { schema: address.schema, table: address.parent.name };
	}
	return undefined;
}

/** Acquires the relation lock that blocks concurrent DROP and ALTER, but not DML. */
export async function lockPgRelation(
	executor: TransitionJournalQueryable,
	relation: PgLockRelation,
): Promise<void> {
	const statement = `LOCK TABLE ONLY ${renderPgLockIdentifier(relation.schema)}.${renderPgLockIdentifier(relation.table)} IN SHARE UPDATE EXCLUSIVE MODE`;
	try {
		await executor.query(statement);
	} catch (error) {
		throw new PgResolvableRelationLockError(error);
	}
}

/**
 * Read catalogue identity while holding the mapped relation lock whenever the
 * addressed object exists. A present pre-read only establishes that locking is
 * possible; callers use the post-lock re-read as their proof and retain the
 * lock through their terminal append. Absence and unmapped kinds have only a
 * final-read window; recovery terminal callers re-read immediately before
 * appending. Two-session adversaries are tracked in #595.
 */
export async function readPgCatalogueIdentityWithResolvableRelationLock(
	executor: TransitionJournalQueryable,
	address: LedgerAddress,
	label = 'relation',
): Promise<Awaited<ReturnType<typeof readPgCatalogueIdentity>>> {
	const relation = pgLockRelationForAddress(address, label);
	if (!relation) return readCatalogueIdentity(executor, address);
	const preLock = await readCatalogueIdentity(executor, address);
	if (!preLock?.catalogueIdentity) return preLock;
	await lockPgRelation(executor, relation);
	return readCatalogueIdentity(executor, address);
}
