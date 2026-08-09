import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

describe('managed-state table declarations', () => {
	it('refuses contradictory adoption and replacement declarations', () => {
		expect(() =>
			schema(
				{ accounts: { id: 'integer' as const } },
				{ accounts: { adopt: true, replace: true } },
			),
		).toThrow('schema table accounts cannot set adopt and replace together');
	});
});
