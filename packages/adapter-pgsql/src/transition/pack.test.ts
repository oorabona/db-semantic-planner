import { describe, expect, it } from 'vitest';
import { createPgTransitionPack } from './pack.js';

describe('createPgTransitionPack', () => {
	it('keeps distinct physical current identifiers that snake_case previously folded', () => {
		const normalize =
			createPgTransitionPack().comparatorNameNormalizer
				?.normalizeCurrentIdentifier;

		expect(normalize).toBeDefined();
		expect(['a_b', 'a_B'].map((identifier) => normalize?.(identifier))).toEqual(
			['a_b', 'a_B'],
		);
	});
});
