/** SC-66: claims take their controller from the PostgreSQL transaction role. */

import { randomUUID } from 'node:crypto';
import {
	DBSP_META_SCHEMA,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { appendPgLedgerResolution } from '@dbsp/adapter-pgsql/internal';
import type { LedgerAddress } from '@dbsp/types';
import { afterEach, expect, it } from 'vitest';
import { applyCommand } from '../../packages/cli/src/commands/apply.js';
import { planCommand } from '../../packages/cli/src/commands/plan.js';
import { preflightCommand } from '../../packages/cli/src/commands/preflight.js';
import {
	releaseCommand,
	runRelease,
} from '../../packages/cli/src/commands/release.js';
import { describeWithE2eCapabilities } from './harness/index.js';
import { openFixtureOutcomeClaim } from './outcome-claim-fixture.js';
import { getTestPool } from './testkit/index.js';
import {
	emptyDeclarations,
	quoteIdent,
	resetDbspMeta,
	rolePool,
	uniqueName,
} from './transition-reinitialize-preflight-testkit.js';

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

interface ParsedCliCommand {
	readonly options: readonly {
		attributeName(): string;
		readonly flags: string;
	}[];
	parseOptions(argv: string[]): { readonly unknown: readonly string[] };
}

function optionAttributes(command: ParsedCliCommand): readonly string[] {
	return command.options.map((option) => option.attributeName());
}

describeWithE2eCapabilities(
	['role-administration'],
	'SC-66 claim controller identity',
	() => {
		const roles: string[] = [];
		const schemas: string[] = [];

		afterEach(async () => {
			const pool = await getTestPool();
			await pool.query(
				`DROP SCHEMA IF EXISTS ${quoteIdent(DBSP_META_SCHEMA)} CASCADE`,
			);
			for (const schema of schemas.splice(0))
				await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
			for (const role of roles.splice(0)) {
				await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
				await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
			}
			await resetDbspMeta();
		});

		it('records the second login role as controller when that role opens the claim', async () => {
			const setup = await getTestPool();
			const role = uniqueName('claim_controller');
			const password = uniqueName('claim_controller_password');
			const schema = uniqueName('claim_controller_schema');
			let claimId: string | undefined;
			roles.push(role);
			schemas.push(schema);

			await setup.query(
				`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
			);
			const deployment = await setup.query<{
				database: string;
				role: string;
			}>('SELECT current_database() AS database, current_user AS role');
			await setup.query(
				`GRANT CREATE ON DATABASE ${quoteIdent(deployment.rows[0]!.database)} TO ${quoteIdent(role)}`,
			);
			await setup.query(
				`CREATE SCHEMA ${quoteIdent(schema)} AUTHORIZATION ${quoteIdent(role)}`,
			);

			const secondRole = await rolePool(role, password);
			try {
				const preflight = await runPgReinitializePreflight({
					// The cutover validates ledger ownership and grants. It is a
					// separately privileged operation; the second role is evidence
					// only for the claim-opening transaction below.
					pool: setup,
					schemas: [schema],
					declarations: emptyDeclarations(),
					writeAdoptionFile: async () => {},
				});
				expect(
					preflight.scopes.every((scope) => scope.outcome !== 'failed'),
					JSON.stringify(preflight.scopes),
				).toBe(true);
				// Preflight validates the ledger owner has no widened table grants.
				// An operator therefore inherits the deployment role rather than
				// receiving a tenant-style ACL on the ledger tables themselves.
				await setup.query(
					`GRANT ${quoteIdent(deployment.rows[0]!.role)} TO ${quoteIdent(role)}`,
				);
				const address: LedgerAddress = {
					scope: 'schema',
					engine: 'postgresql',
					database: deployment.rows[0]!.database,
					schema,
					kind: 'table',
					name: 'second_role_claim',
				};
				claimId = `dbsp.sc66.${randomUUID()}`;
				const reservation = {
					address,
					claimKind: 'intent' as const,
					executionId: claimId,
					rootClaimId: claimId,
					homeLedger: { scope: 'schema' as const, schema },
				};
				const admission = await openFixtureOutcomeClaim(secondRole, {
					claimId,
					address,
					claimKind: 'intent',
					statements: ['SELECT 1'],
					reservations: [reservation],
				});
				if (admission.kind !== 'admitted-outcome-claim')
					expect.fail(
						`SC-66 claim admission received ${JSON.stringify(admission)}`,
					);
			} finally {
				await secondRole.end();
			}

			const result = await setup.query(
				`SELECT controller::text AS controller FROM ${quoteIdent(schema)}.dbsp_ledger_event WHERE event_id = $1`,
				[claimId],
			);
			expect(result.rows).toEqual([{ controller: role }]);
		});

		it('accepts no controller input on the parsed claiming-command option surfaces', () => {
			const commands = [
				applyCommand,
				planCommand,
				preflightCommand,
				releaseCommand,
			];
			for (const command of commands) {
				const attributes = optionAttributes(command);
				const parsed = command.parseOptions(['--controller', 'spoofed-role']);
				expect(attributes).not.toContain('controller');
				expect(attributes).not.toContain('role');
				expect(attributes).not.toContain('user');
				expect(parsed.unknown).toEqual(['--controller', 'spoofed-role']);
				expect(command.options.map((option) => option.flags)).not.toContain(
					'--controller <controller>',
				);
			}
		});

		it('OBL-CTRL2: CLI release refuses a managed address claimed by a second role, including after that role is dropped', async () => {
			const setup = await getTestPool();
			const role = uniqueName('obl_ctrl2_controller');
			const password = uniqueName('obl_ctrl2_password');
			const schema = uniqueName('obl_ctrl2_schema');
			roles.push(role);
			schemas.push(schema);
			await setup.query(
				`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
			);
			const deployment = await setup.query<{
				database: string;
				role: string;
			}>('SELECT current_database() AS database, current_user AS role');
			await setup.query(
				`GRANT CREATE ON DATABASE ${quoteIdent(deployment.rows[0]!.database)} TO ${quoteIdent(role)}`,
			);
			await setup.query(
				`CREATE SCHEMA ${quoteIdent(schema)} AUTHORIZATION ${quoteIdent(role)}`,
			);
			const controller = await rolePool(role, password);
			const address: LedgerAddress = {
				scope: 'schema',
				engine: 'postgresql',
				database: deployment.rows[0]!.database,
				schema,
				kind: 'table',
				name: 'foreign_controller',
			};
			const claimId = `dbsp.obl-ctrl2.${randomUUID()}`;
			try {
				const preflight = await runPgReinitializePreflight({
					pool: setup,
					schemas: [schema],
					declarations: emptyDeclarations(),
					writeAdoptionFile: async () => {},
				});
				expect(preflight.scopes.map((scope) => scope.outcome)).not.toContain(
					'failed',
				);
				await setup.query(
					`GRANT ${quoteIdent(deployment.rows[0]!.role)} TO ${quoteIdent(role)}`,
				);
				const opened = await openFixtureOutcomeClaim(controller, {
					claimId,
					address,
					claimKind: 'adopt-intent',
					statements: ['SELECT 1'],
					reservations: [
						{
							address,
							claimKind: 'adopt-intent',
							executionId: claimId,
							rootClaimId: claimId,
							homeLedger: { scope: 'schema', schema },
						},
					],
				});
				expect(opened.kind).toBe('admitted-outcome-claim');
				await appendPgLedgerResolution(
					controller,
					{ scope: 'schema', schema },
					{
						eventId: `${claimId}:adopted`,
						address,
						eventKind: 'adopt',
						predecessor: claimId,
						observed: { value: { table: address.name }, digest: 'obl-ctrl2' },
					},
					claimId,
					[
						{
							address,
						},
					],
				);
				const first = await runRelease(`table:${address.name}`, {
					db: process.env.DATABASE_URL!,
					schema,
					kind: 'table',
				});
				expect(first).toMatchObject({
					outcome: 'release-refused',
					refusal: { withheldAuthority: 'managed mutation authority' },
				});

				// The durable controller identity is an oid/name pair, not a grant
				// lookup.  Dropping the original login cannot become an authority
				// fallback: the public CLI still refuses its now-stale controller.
				await controller.end();
				await setup.query(
					`ALTER SCHEMA ${quoteIdent(schema)} OWNER TO ${quoteIdent(deployment.rows[0]!.role)}`,
				);
				await setup.query(
					`REVOKE ${quoteIdent(deployment.rows[0]!.role)} FROM ${quoteIdent(role)}`,
				);
				await setup.query(
					`REVOKE CREATE ON DATABASE ${quoteIdent(deployment.rows[0]!.database)} FROM ${quoteIdent(role)}`,
				);
				await setup.query(`DROP ROLE ${quoteIdent(role)}`);
				roles.splice(roles.indexOf(role), 1);
				const dropped = await runRelease(`table:${address.name}`, {
					db: process.env.DATABASE_URL!,
					schema,
					kind: 'table',
				});
				expect(dropped).toMatchObject({
					outcome: 'release-refused',
					refusal: { withheldAuthority: 'managed mutation authority' },
				});
			} finally {
				await controller.end().catch(() => undefined);
			}
		}, 30_000);
	},
);
