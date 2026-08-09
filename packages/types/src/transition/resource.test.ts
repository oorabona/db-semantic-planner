import { describe, expect, it } from 'vitest';
import { sameControllerIdentity } from './resource.js';

describe('controller identity', () => {
	it('requires both the role name and OID to match', () => {
		expect(
			sameControllerIdentity(
				{ name: 'deployment', oid: '42' },
				{ name: 'deployment', oid: '42' },
			),
		).toBe(true);
		expect(
			sameControllerIdentity(
				{ name: 'deployment', oid: '42' },
				{ name: 'deployment', oid: '43' },
			),
		).toBe(false);
	});
});
