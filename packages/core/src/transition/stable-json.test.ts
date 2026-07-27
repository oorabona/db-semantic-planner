import { describe, expect, it } from 'vitest';
import { stableJson } from './stable-json.js';

describe('stableJson', () => {
	// This ordering is the durable transition digest. `localeCompare` reads the
	// host's default locale — `sv-SE` sorts `ä` after `z`, `en-US` between `a` and
	// `z` — so using it would make a plan persisted on one host produce a
	// different digest on another, and recovery would refuse a perfectly good
	// plan. Asserting the code-unit order pins the property without needing to
	// change the process locale: under any locale collation, `ä` sorts near `a`,
	// and only code-unit order puts every ASCII key ahead of it.
	it('orders object keys by code unit, not by locale collation', () => {
		const serialized = stableJson({ z: 1, ä: 2, a: 3, Z: 4 });
		const order = [...serialized.matchAll(/"([^"]+)":/g)].map(
			(match) => match[1],
		);
		expect(order).toEqual(['Z', 'a', 'z', 'ä']);
	});

	it('is insensitive to the order the keys were inserted in', () => {
		expect(stableJson({ ä: 2, a: 3, Z: 4, z: 1 })).toBe(
			stableJson({ z: 1, ä: 2, a: 3, Z: 4 }),
		);
	});

	it('orders nested object keys the same way', () => {
		const serialized = stableJson({ outer: { z: 1, ä: 2, a: 3 } });
		const order = [...serialized.matchAll(/"([^"]+)":/g)].map(
			(match) => match[1],
		);
		expect(order).toEqual(['outer', 'a', 'z', 'ä']);
	});
});
