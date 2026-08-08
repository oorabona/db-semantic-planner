import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

describe('managed-state table declarations', () => {
	it('carries explicit adoption and replacement declarations into TableIR', () => {
		const result = schema(
			{ accounts: { id: 'integer' as const } },
			{ accounts: { adopt: true, replace: true } },
		);
		expect(result.model.tables.get('accounts')).toMatchObject({
			name: 'accounts',
			adopt: true,
			replace: true,
		});
	});
});
