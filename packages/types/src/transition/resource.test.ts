import { describe, expect, it } from 'vitest';
import { sameControllerIdentity } from './resource.js';

describe('controller identity', () => {
	it('OBL-PRED1 mutation: changing either name or OID rejects a value-equal controller identity', () => {
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
		expect(
			sameControllerIdentity(
				{ name: 'deployment', oid: '42' },
				{ name: 'deployment_readonly', oid: '42' },
			),
		).toBe(false);
	});
});
