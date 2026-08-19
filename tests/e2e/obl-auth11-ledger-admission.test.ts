import { randomUUID } from 'node:crypto';
import {
	acquirePgLedgerLocks,
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
	DBSP_META_SCHEMA,
	ensureDbspMetaLedger,
	ensurePgLedger,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import {
	classifyPgLedgerPhysicalShape,
	createPostLockAdmissionEvidence,
	readPgLedgerReservationsForPair,
} from '@dbsp/adapter-pgsql/internal';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { describeWithE2eCapabilities } from './harness/index.js';
import { dropSchema, getTestPool } from './testkit/index.js';
import {
	quoteIdent,
	resetDbspMeta,
	rolePool,
	uniqueName,
} from './transition-reinitialize-preflight-testkit.js';

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

describeWithE2eCapabilities(
	['role-administration'],
	'OBL-AUTH11 #481 read-only ledger admission',
	() => {
		const roles: string[] = [];
		const schemas: string[] = [];

		beforeEach(resetDbspMeta);

		afterEach(async () => {
			const pool = await getTestPool();
			for (const schema of schemas.splice(0)) await dropSchema(schema);
			await resetDbspMeta();
			for (const role of roles.splice(0)) {
				await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
				await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
			}
		});

		it('OBL-AUTH11: pair discovery captures every same-shaped home through a login role without CREATE', async () => {
			const pool = await getTestPool();
			const schema = uniqueName('obl_auth11');
			const peerSchema = uniqueName('obl_auth11_peer');
			const role = uniqueName('obl_auth11_reader');
			const password = randomUUID();
			schemas.push(schema, peerSchema);
			await pool.query(
				`CREATE SCHEMA ${quoteIdent(schema)}; CREATE SCHEMA ${quoteIdent(peerSchema)}`,
			);
			await runPgReinitializePreflight({
				pool,
				schemas: [schema, peerSchema],
				declarations: {
					version: 1,
					digest: `obl-auth11-${schema}`,
					declarations: [],
				},
				writeAdoptionFile: async () => {},
			});
			await ensureDbspMetaLedger(pool);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			await pool.query(
				`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
			);
			roles.push(role);
			for (const ledgerSchema of [schema, peerSchema, DBSP_META_SCHEMA]) {
				await pool.query(
					`GRANT USAGE ON SCHEMA ${quoteIdent(ledgerSchema)} TO ${quoteIdent(role)}`,
				);
				await pool.query(
					`GRANT SELECT ON TABLE ${[
						DBSP_LEDGER_EVENT_TABLE,
						DBSP_LEDGER_RESERVATION_TABLE,
						DBSP_LEDGER_IDENTITY_TABLE,
						DBSP_LEDGER_MARKER_TABLE,
					]
						.map((table) => `${quoteIdent(ledgerSchema)}.${quoteIdent(table)}`)
						.join(', ')} TO ${quoteIdent(role)}`,
				);
			}

			const createPrivilege = await pool.query<{ allowed: boolean }>(
				"SELECT has_database_privilege($1, current_database(), 'CREATE') AS allowed",
				[role],
			);
			expect(createPrivilege.rows[0]?.allowed).toBe(false);

			const reader = await rolePool(role, password);
			try {
				const statements: string[] = [];
				const readOnlyExecutor = {
					query: async (text: string, values?: readonly unknown[]) => {
						statements.push(text);
						return reader.query(text, values as never[]);
					},
					connect: async () => {
						const client = await reader.connect();
						return {
							query: async (text: string, values?: readonly unknown[]) => {
								statements.push(text);
								return client.query(text, values as never[]);
							},
							release: () => client.release(),
						};
					},
				};
				await expect(
					classifyPgLedgerPhysicalShape(readOnlyExecutor, {
						scope: 'schema',
						schema,
					}),
				).resolves.toEqual({ kind: 'verified' });
				await expect(
					classifyPgLedgerPhysicalShape(readOnlyExecutor, {
						scope: 'database',
					}),
				).resolves.toEqual({ kind: 'verified' });
				// Pair discovery must make the same no-CREATE promise as ordinary
				// admission.  There is intentionally no pair in this fixture.  The two
				// same-shaped schema homes plus the database home prove it did not stop
				// at the first catalogue candidate.
				const pair = await readPgLedgerReservationsForPair(
					readOnlyExecutor,
					`obl-auth11-empty-pair-${schema}`,
				);
				expect(pair).toEqual([]);
				expect(pair.candidates).toEqual(
					expect.arrayContaining([
						{ target: { scope: 'schema', schema }, kind: 'verified' },
						{
							target: { scope: 'schema', schema: peerSchema },
							kind: 'verified',
						},
						{ target: { scope: 'database' }, kind: 'verified' },
					]),
				);
				const client = await reader.connect();
				try {
					await client.query('BEGIN');
					const postLockExecutor = {
						query: async (text: string, values?: readonly unknown[]) => {
							statements.push(text);
							return client.query(text, values as never[]);
						},
					};
					const locks = await acquirePgLedgerLocks(postLockExecutor, [
						{ scope: 'schema', schema },
						{ scope: 'database' },
					]);
					if (locks.kind !== 'acquired')
						throw new Error(`expected ledger locks, got ${locks.kind}`);
					const evidence = await createPostLockAdmissionEvidence(
						postLockExecutor,
						locks.proof,
					);
					expect(evidence.homes).toEqual([
						{ scope: 'database' },
						{ scope: 'schema', schema },
					]);
				} finally {
					await client.query('ROLLBACK');
					client.release();
				}

				const statementClasses = new Set(
					statements.map((text) => text.trim().split(/\s+/u)[0]?.toUpperCase()),
				);
				// Every allowed verb is either SELECT or read-only transaction control.
				expect(statementClasses).toEqual(
					new Set([
						'BEGIN',
						'COMMIT',
						'RELEASE',
						'ROLLBACK',
						'SAVEPOINT',
						'SELECT',
						'SET',
					]),
				);
				expect(
					statements.some((text) =>
						/\b(?:ALTER|CREATE|DELETE|DROP|INSERT|UPDATE)\b/iu.test(text),
					),
				).toBe(false);

				const unsupportedMajorExecutor = {
					query: async (text: string, values?: readonly unknown[]) => {
						if (text.includes("current_setting('server_version_num')"))
							return { rows: [{ server_version_num: '999999' }] };
						return reader.query(text, values as never[]);
					},
				};
				await expect(
					classifyPgLedgerPhysicalShape(unsupportedMajorExecutor, {
						scope: 'schema',
						schema,
					}),
				).resolves.toEqual({ kind: 'unsupported-major', major: 99 });
			} finally {
				await reader.end();
			}
		}, 30_000);
	},
);
