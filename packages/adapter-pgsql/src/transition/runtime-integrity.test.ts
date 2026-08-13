import { describe, expect, it, vi } from 'vitest';
import { validatePgLedgerRuntimeIntegrity } from './outcome-protocol.js';

describe('validatePgLedgerRuntimeIntegrity', () => {
	it('revalidates each admission without retaining a client/run cache', async () => {
		const executor = { query: vi.fn() };
		const validateShape = vi.fn(async () => undefined);
		const readCurrency = vi.fn(async () => ({ kind: 'current' as const }));
		const homes = [{ scope: 'schema' as const, schema: 'tenant' }];
		const seams = { validateShape, readCurrency: readCurrency as never };
		const run = { runId: 'run-1', planDigest: 'digest-1' } as never;

		await expect(
			validatePgLedgerRuntimeIntegrity(executor, homes, run, seams),
		).resolves.toBeUndefined();
		await expect(
			validatePgLedgerRuntimeIntegrity(executor, homes, run, seams),
		).resolves.toBeUndefined();

		expect(validateShape).toHaveBeenCalledTimes(2);
		expect(readCurrency).toHaveBeenCalledTimes(2);
	});
});
