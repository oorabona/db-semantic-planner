import { describe, expect, it, vi } from 'vitest';
import { pgLockRelationForAddress } from './lock-relation.js';

describe('pgLockRelationForAddress', () => {
	it('emits one escaped line for a mismatched parent schema and object name', () => {
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const address = {
			scope: 'schema' as const,
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'column' as const,
			name: 'status\nFAKE',
			parent: {
				engine: 'postgresql',
				database: 'app',
				kind: 'table' as const,
				name: 'accounts',
				schema: 'stale\nFAKE',
			},
		};

		expect(pgLockRelationForAddress(address)).toEqual({
			schema: 'tenant',
			table: 'accounts',
		});
		expect(warning).toHaveBeenCalledWith(
			'relation lock ignores mismatched parent schema stale\\nFAKE for column status\\nFAKE; catalogue identity resolves tenant',
		);
		expect(warning.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
		warning.mockRestore();
	});
});
