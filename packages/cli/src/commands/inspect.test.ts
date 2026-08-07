import { describe, expect, it } from 'vitest';
import { inspectAddress } from './inspect.js';

describe('inspect address selection', () => {
	it('uses the supplied kind prefix without appending a ledger event', () => {
		expect(inspectAddress('app', 'tenant', 'enum:status')).toEqual({
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'enum',
			name: 'status',
		});
	});

	it('keeps an unqualified selector at the caller supplied kind', () => {
		expect(inspectAddress('app', 'tenant', 'orders', 'table')).toMatchObject({
			kind: 'table',
			name: 'orders',
		});
	});
});
