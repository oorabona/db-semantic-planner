import { serverVersionNum } from '@dbsp/core';
import type { CapabilityDescriptor } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY_DESCRIPTOR,
	INDEX_INCLUDE_CAPABILITY,
	INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
} from './index-feature-capabilities.js';
import { createPgTransitionPack } from './pack.js';

function descriptorAvailable(
	descriptor: CapabilityDescriptor,
	version: string,
): boolean {
	const actual = serverVersionNum(version);
	return (
		actual !== undefined &&
		actual >= descriptor.predicate.minServerVersionNum
	);
}

describe('PostgreSQL index feature capability descriptors', () => {
	it('registers index feature descriptors in the transition pack', () => {
		const pack = createPgTransitionPack();
		expect(pack.capabilityDescriptors).toEqual(
			expect.arrayContaining([
				CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY_DESCRIPTOR,
				INDEX_INCLUDE_CAPABILITY,
				INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
			]),
		);
	});

	it('derives INCLUDE availability from the descriptor min server version', () => {
		expect(descriptorAvailable(INDEX_INCLUDE_CAPABILITY, '10')).toBe(false);
		expect(descriptorAvailable(INDEX_INCLUDE_CAPABILITY, '11')).toBe(true);
		expect(descriptorAvailable(INDEX_INCLUDE_CAPABILITY, '14')).toBe(true);
		expect(descriptorAvailable(INDEX_INCLUDE_CAPABILITY, '15')).toBe(true);
	});

	it('derives NULLS NOT DISTINCT availability from the descriptor min server version', () => {
		const min = INDEX_NULLS_NOT_DISTINCT_CAPABILITY.predicate.minServerVersionNum;

		expect(min).toBe(serverVersionNum('15'));
		expect(serverVersionNum('14')).toBeLessThan(min);
		expect(serverVersionNum('15')).toBe(min);
		expect(descriptorAvailable(INDEX_NULLS_NOT_DISTINCT_CAPABILITY, '10')).toBe(
			false,
		);
		expect(descriptorAvailable(INDEX_NULLS_NOT_DISTINCT_CAPABILITY, '11')).toBe(
			false,
		);
		expect(descriptorAvailable(INDEX_NULLS_NOT_DISTINCT_CAPABILITY, '14')).toBe(
			false,
		);
		expect(descriptorAvailable(INDEX_NULLS_NOT_DISTINCT_CAPABILITY, '15')).toBe(
			true,
		);
	});
});
