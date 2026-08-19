/** Read managed-ledger state without appending an event or repairing storage. */

import { isDeepStrictEqual } from 'node:util';
import {
	createPgTransitionLessor,
	DBSP_LEDGER_EVENT_TABLE,
	escapeDiagnosticText,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerMarker,
} from '@dbsp/adapter-pgsql';
import { acquireTransitionLease, projectLedgerChain } from '@dbsp/core';
import {
	canonicalResourceParent,
	type LedgerAddress,
	type LedgerChainProjection,
	type LedgerHome,
	type LedgerStableState,
	type RefusalCode,
} from '@dbsp/types';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';
import { printCliJson, serializeCliJson } from '../utils/output.js';

export interface InspectOptions {
	readonly db: string;
	readonly schema?: string;
	readonly kind?: string;
	/** Parent selector for column/index/constraint resources, e.g. table:orders. */
	readonly parent?: string;
	/** Select the database ledger (currently for database-scoped extensions). */
	readonly databaseLedger?: boolean;
	readonly format?: 'text' | 'json';
}

export interface InspectResult {
	readonly address?: LedgerAddress;
	readonly ledger: LedgerHome;
	readonly marker:
		| Awaited<ReturnType<typeof readPgLedgerMarker>>
		| { readonly kind: 'unreadable'; readonly reason: string };
	readonly projection?: ReturnType<typeof projectLedgerChain>;
	/**
	 * A terminal ledger refusal remains a diagnostic after its claim is closed.
	 * It is deliberately derived from the immutable chain: inspect must not
	 * append a second event merely to explain an earlier refusal.
	 */
	readonly refusal?: {
		readonly code: RefusalCode;
		readonly cause: string;
		readonly address: LedgerAddress;
		readonly state: LedgerStableState;
		readonly withheldAuthority: string;
		readonly resolvingCommand: string;
	};
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
	/** Comparison is derived from reads only; inspect never repairs drift. */
	readonly liveDrift?:
		| { readonly kind: 'matches-ledger' }
		| { readonly kind: 'catalogue-drift'; readonly detail: string }
		| { readonly kind: 'not-comparable'; readonly detail: string };
	/** Identifies the failed read path without mislabelling it as catalogue drift. */
	readonly failedSubsystem?:
		| { readonly subsystem: 'ledger'; readonly reason: string }
		| { readonly subsystem: 'catalogue'; readonly reason: string };
	/** Present for an unqualified inspect; no read path creates or repairs it. */
	readonly addresses?: readonly LedgerAddress[];
}

/**
 * Make a terminal `refused` event actionable without inventing mutable state.
 * A refused claim closes the chain at its prior stable state, so a fresh
 * generator-path apply is the only command that can seek new authority.
 */
export function inspectRefusal(
	projection: LedgerChainProjection | undefined,
): InspectResult['refusal'] | undefined {
	if (projection?.kind !== 'projected-ledger-chain') return undefined;
	const predecessors = new Set(
		projection.events
			.map((event) => event.predecessor)
			.filter(
				(predecessor): predecessor is string => predecessor !== undefined,
			),
	);
	const terminals = projection.events.filter(
		(event) => !predecessors.has(event.eventId),
	);
	const refused = terminals.length === 1 ? terminals[0] : undefined;
	if (refused?.eventKind !== 'refused' || refused.refusal === undefined)
		return undefined;
	return {
		code: refused.refusal.code,
		cause: refused.refusal.cause,
		address: projection.address,
		state: refused.refusal.state,
		withheldAuthority: refused.refusal.withheldAuthority,
		resolvingCommand: refused.refusal.resolvingCommand,
	};
}

function inspectLiveDrift(
	projection: InspectResult['projection'],
	live: Awaited<ReturnType<typeof readPgCatalogueIdentity>>,
): NonNullable<InspectResult['liveDrift']> {
	if (projection?.kind !== 'projected-ledger-chain')
		return { kind: 'not-comparable', detail: 'ledger chain is unavailable' };
	const terminalIds = new Set(
		projection.events
			.map((event) => event.predecessor)
			.filter((value): value is string => value !== undefined),
	);
	const terminal = projection.events.find(
		(event) => !terminalIds.has(event.eventId),
	);
	if (!terminal?.catalogueIdentity)
		return {
			kind: 'not-comparable',
			detail: 'ledger terminal has no catalogue identity',
		};
	if (!live?.catalogueIdentity)
		return {
			kind: 'catalogue-drift',
			detail:
				'ledger records a present catalogue identity but the object is absent',
		};
	return isDeepStrictEqual(terminal.catalogueIdentity, live.catalogueIdentity)
		? { kind: 'matches-ledger' }
		: {
				kind: 'catalogue-drift',
				detail: 'live catalogue identity differs from the ledger terminal',
			};
}

/** Human inspect output is intentionally the same escaped document as JSON. */
export function renderInspectHuman(result: InspectResult): string {
	return serializeCliJson(result);
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
	parentSelector?: string,
	scope: LedgerAddress['scope'] = 'schema',
): LedgerAddress {
	const parsed = addressParts(selector, kind);
	if (!parsed.name) throw new Error('inspect address name must not be empty');
	if (!parsed.kind) throw new Error('inspect address kind must not be empty');
	const parent = parentSelector
		? addressParts(parentSelector, 'table')
		: undefined;
	if (parent && (!parent.kind || !parent.name))
		throw new Error('inspect parent address must be kind:name');
	if (
		!parent &&
		['column', 'index', 'constraint', 'policy'].includes(parsed.kind)
	)
		throw new Error(
			`inspect address ${parsed.kind}:${parsed.name} requires --parent <kind:name>`,
		);
	return {
		scope,
		engine: 'postgresql',
		database,
		...(scope === 'schema' ? { schema } : {}),
		...(parent
			? {
					parent: canonicalResourceParent({
						engine: 'postgresql',
						database,
						...(scope === 'schema' ? { schema } : {}),
						kind: parent.kind as LedgerAddress['kind'],
						name: parent.name,
					}),
				}
			: {}),
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
	const ledger: LedgerHome = options.databaseLedger
		? { scope: 'database' }
		: { scope: 'schema', schema };
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
						failedSubsystem: {
							subsystem: 'ledger',
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
			const address = inspectAddress(
				database,
				schema,
				selector,
				options.kind,
				options.parent,
				ledger.scope,
			);
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
					live: { kind: 'not-requested' },
					liveDrift: {
						kind: 'not-comparable',
						detail: 'ledger chain is unavailable',
					},
					failedSubsystem: {
						subsystem: 'ledger',
						reason: error instanceof Error ? error.message : String(error),
					},
				};
			}
			try {
				const live = await readPgCatalogueIdentity(lease.session, address);
				const refusal = inspectRefusal(projection);
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
					...(refusal === undefined ? {} : { refusal }),
					...(openReaddress === undefined
						? {}
						: { readdressPair: openReaddress }),
					liveDrift: inspectLiveDrift(projection, live),
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
					liveDrift: {
						kind: 'not-comparable',
						detail: 'live catalogue read is unavailable',
					},
					failedSubsystem: {
						subsystem: 'catalogue',
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
	.option(
		'--parent <kind:name>',
		'Required parent for column, index, constraint, or policy',
	)
	.option('--database-ledger', 'Read the database ledger (for extensions)')
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (address: string | undefined, options: InspectOptions) => {
		try {
			const result = await runInspect(address, options);
			if (options.format === 'json') printCliJson(result);
			else console.log(renderInspectHuman(result));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (options.format === 'json')
				printCliJson({ outcome: 'inspect-failed', error: message });
			else console.error(`inspect-failed: ${escapeDiagnosticText(message)}`);
			process.exitCode = 1;
		}
	});
