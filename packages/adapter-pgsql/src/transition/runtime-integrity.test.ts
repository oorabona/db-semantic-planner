import { describe, expect, it, vi } from 'vitest';
import { validatePgLedgerRuntimeIntegrity } from './outcome-protocol.js';

describe('validatePgLedgerRuntimeIntegrity', () => {
	it('OBL-LOCK6 keeps no per-run integrity cache on one long-lived client', async () => {
		const executor = { query: vi.fn() };
		const validateShape = vi.fn(async () => undefined);
		const readCurrency = vi.fn(async () => ({ kind: 'current' as const }));
		const homes = [{ scope: 'schema' as const, schema: 'tenant' }];
		const seams = { validateShape, readCurrency: readCurrency as never };
		const run = { runId: 'run-1', planDigest: 'digest-1' };

		for (let index = 0; index < 64; index += 1)
			await expect(
				validatePgLedgerRuntimeIntegrity(
					executor,
					homes,
					{ ...run, runId: `run-${index}` } as never,
					seams,
				),
			).resolves.toBeUndefined();

		expect(validateShape).toHaveBeenCalledTimes(64);
		expect(readCurrency).toHaveBeenCalledTimes(64);
	});
});
