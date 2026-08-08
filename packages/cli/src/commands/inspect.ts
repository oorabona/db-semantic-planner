/** Read managed-ledger state without appending an event or repairing storage. */
import {
	createPgTransitionLessor,
	DBSP_LEDGER_EVENT_TABLE,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerMarker,
} from '@dbsp/adapter-pgsql';
import { acquireTransitionLease, projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress, LedgerHome } from '@dbsp/types';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';

export interface InspectOptions {
	readonly db: string;
	readonly schema?: string;
	readonly kind?: string;
	readonly format?: 'text' | 'json';
}

export interface InspectResult {
	readonly address?: LedgerAddress;
	readonly ledger: LedgerHome;
	readonly marker:
		| Awaited<ReturnType<typeof readPgLedgerMarker>>
		| { readonly kind: 'unreadable'; readonly reason: string };
	readonly projection?: ReturnType<typeof projectLedgerChain>;
	/** A selected address exposes an interrupted re-address pair without repair. */
	readonly readdressPair?: {
		readonly pairId: string;
		readonly state: 'open';
	};
	readonly live:
		| { readonly kind: 'not-requested' }
		| { readonly kind: 'present'; readonly catalogueIdentity: unknown }
		| { readonly kind: 'absent' }
		| { readonly kind: 'catalogue-unavailable'; readonly reason: string };
	/** Present for an unqualified inspect; no read path creates or repairs it. */
	readonly addresses?: readonly LedgerAddress[];
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

async function readLedgerAddresses(
	lease: {
		query(
			sql: string,
			params?: unknown,
		): Promise<{ rows: readonly Record<string, unknown>[] }>;
	},
	ledger: LedgerHome,
): Promise<readonly LedgerAddress[]> {
	const schema = ledger.scope === 'database' ? 'dbsp_meta' : ledger.schema;
	if (!schema) throw new Error('schema ledger target is missing its schema');
	const rows = await lease.query(
		`SELECT DISTINCT address_engine, address_database, address_schema, address_parent, address_kind, address_name FROM ${quoteIdentifier(schema)}.${quoteIdentifier(DBSP_LEDGER_EVENT_TABLE)} ORDER BY address_engine, address_database, address_schema, address_kind, address_name`,
	);
	return rows.rows.map((row) => {
		if (
			typeof row.address_engine !== 'string' ||
			typeof row.address_database !== 'string' ||
			typeof row.address_schema !== 'string' ||
			typeof row.address_kind !== 'string' ||
			typeof row.address_name !== 'string'
		)
			throw new Error('ledger address is unreadable');
		return {
			scope: ledger.scope,
			engine: row.address_engine,
			database: row.address_database,
			...(row.address_schema === '' ? {} : { schema: row.address_schema }),
			...(row.address_parent == null
				? {}
				: {
						parent:
							typeof row.address_parent === 'string'
								? JSON.parse(row.address_parent)
								: (row.address_parent as LedgerAddress),
					}),
			kind: row.address_kind as LedgerAddress['kind'],
			name: row.address_name,
		};
	});
}

function addressParts(
	value: string,
	defaultKind: string,
): {
	kind: string;
	name: string;
} {
	const separator = value.indexOf(':');
	if (separator < 1) return { kind: defaultKind, name: value };
	return { kind: value.slice(0, separator), name: value.slice(separator + 1) };
}

/** Parse the compact inspect selector; parents remain intentionally explicit later. */
export function inspectAddress(
	database: string,
	schema: string,
	selector: string,
	kind = 'table',
): LedgerAddress {
	const parsed = addressParts(selector, kind);
	if (!parsed.name) throw new Error('inspect address name must not be empty');
	if (!parsed.kind) throw new Error('inspect address kind must not be empty');
	return {
		scope: 'schema',
		engine: 'postgresql',
		database,
		schema,
		kind: parsed.kind as LedgerAddress['kind'],
		name: parsed.name,
	};
}

export async function runInspect(
	selector: string | undefined,
	options: InspectOptions,
): Promise<InspectResult> {
	const { pool } = await createDbConnection(options.db);
	const schema = options.schema ?? 'public';
	const ledger: LedgerHome = { scope: 'schema', schema };
	try {
		const lease = await acquireTransitionLease(createPgTransitionLessor(pool));
		try {
			let marker: InspectResult['marker'];
			try {
				marker = await readPgLedgerMarker(lease.session, ledger);
			} catch (error) {
				marker = {
					kind: 'unreadable',
					reason: error instanceof Error ? error.message : String(error),
				};
			}
			if (!selector) {
				try {
					return {
						ledger,
						marker,
						addresses: await readLedgerAddresses(lease.session, ledger),
						live: { kind: 'not-requested' },
					};
				} catch (error) {
					return {
						ledger,
						marker,
						addresses: [],
						live: {
							kind: 'catalogue-unavailable',
							reason: error instanceof Error ? error.message : String(error),
						},
					};
				}
			}
			const databaseRow = await lease.session.query(
				'SELECT pg_catalog.current_database() AS database',
			);
			const database = databaseRow.rows[0]?.database;
			if (typeof database !== 'string')
				throw new Error('PostgreSQL current_database() is unreadable');
			const address = inspectAddress(database, schema, selector, options.kind);
			let projection: InspectResult['projection'];
			try {
				projection = projectLedgerChain(
					await readPgLedgerAddressChain(lease.session, ledger, address),
				);
			} catch (error) {
				// A missing/malformed ledger is a readable diagnostic, never a reason
				// for inspect to create its structures.
				return {
					address,
					ledger,
					marker,
					live: {
						kind: 'catalogue-unavailable',
						reason: error instanceof Error ? error.message : String(error),
					},
				};
			}
			try {
				const live = await readPgCatalogueIdentity(lease.session, address);
				const openReaddress =
					projection?.kind === 'projected-ledger-chain' &&
					projection.openClaim?.kind === 'readdress-intent' &&
					projection.openClaim.event.pairId
						? {
								pairId: projection.openClaim.event.pairId,
								state: 'open' as const,
							}
						: undefined;
				return {
					address,
					ledger,
					marker,
					projection,
					...(openReaddress === undefined
						? {}
						: { readdressPair: openReaddress }),
					live: live?.catalogueIdentity
						? { kind: 'present', catalogueIdentity: live.catalogueIdentity }
						: { kind: 'absent' },
				};
			} catch (error) {
				return {
					address,
					ledger,
					marker,
					projection,
					live: {
						kind: 'catalogue-unavailable',
						reason: error instanceof Error ? error.message : String(error),
					},
				};
			}
		} finally {
			await lease.release();
		}
	} finally {
		await pool.end();
	}
}

export const inspectCommand = new Command('inspect')
	.description(
		'Read managed ledger state and live drift; never appends ledger events',
	)
	.argument('[address]', 'Address as name or kind:name')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema <name>', 'Schema ledger to read', 'public')
	.option('--kind <kind>', 'Kind for an unqualified address', 'table')
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (address: string | undefined, options: InspectOptions) => {
		try {
			const result = await runInspect(address, options);
			if (options.format === 'json')
				console.log(JSON.stringify(result, null, 2));
			else console.log(JSON.stringify(result, null, 2));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (options.format === 'json')
				console.log(
					JSON.stringify(
						{ outcome: 'inspect-failed', error: message },
						null,
						2,
					),
				);
			else console.error(`inspect-failed: ${message}`);
			process.exitCode = 1;
		}
	});
