/**
 * SC-01 — privileged #481 e2e requirements fail at the harness boundary.
 *
 * This is intentionally not run in the constrained authoring sandbox. The
 * synthetic external environment makes the fail-not-skip contract deterministic
 * without changing the real global setup environment for neighbouring suites.
 */

import { describe, expect, it } from 'vitest';
import { requireE2eCapabilities } from './harness/index.js';
import { getTestPool } from './testkit/index.js';

const EXTERNAL_ENVIRONMENT: NodeJS.ProcessEnv = {
	...process.env,
	DBSP_E2E_LOCAL_CONTAINER: '0',
};
delete EXTERNAL_ENVIRONMENT.DBSP_E2E_LOCAL_CONTAINER_ID;

describe('SC-01 #481 e2e capability gates', () => {
	it('runs against the e2e PostgreSQL fixture', async () => {
		const pool = await getTestPool();
		const result = await pool.query<{ ready: number }>('SELECT 1 AS ready');
		expect(result.rows[0]?.ready).toBe(1);
	});

	it.each([
		'container-exec',
		'standby-topology',
	] as const)('fails rather than skips when %s is requested from an external DATABASE_URL', async (capability) => {
		await expect(
			requireE2eCapabilities([capability], {
				environment: EXTERNAL_ENVIRONMENT,
			}),
		).rejects.toMatchObject({
			name: 'E2eCapabilityError',
			capability,
		});
	});

	it('fails rather than skips when role administration is unavailable', async () => {
		await expect(
			requireE2eCapabilities(['role-administration'], {
				probeRoleAdministration: async () => false,
			}),
		).rejects.toMatchObject({
			name: 'E2eCapabilityError',
			capability: 'role-administration',
		});
	});
});
