import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

describe('managed-state table declarations', () => {
	it.each([
		{ adopt: true, replace: true } as const,
		{
			adopt: true,
			readdress: { from: { name: 'legacyAccounts' }, to: { name: 'accounts' } },
		} as const,
		{
			replace: true,
			readdress: { from: { name: 'legacyAccounts' }, to: { name: 'accounts' } },
		} as const,
	])('refuses every pair of lifecycle directives', (constraints) => {
		expect(() =>
			schema(
				{ accounts: { id: 'integer' as const } },
				{ accounts: constraints },
			),
		).toThrow(
			'schema table accounts cannot set more than one lifecycle directive',
		);
	});
});
