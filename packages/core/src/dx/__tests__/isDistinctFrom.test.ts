import { describe, expect, it } from 'vitest';
import { isDistinctFrom } from '../filters.js';

describe('isDistinctFrom', () => {
	it('creates a comparison intent with isDistinctFrom operator', () => {
		const result = isDistinctFrom('status', 'active');
		expect(result).toEqual({
			kind: 'comparison',
			field: 'status',
			operator: 'isDistinctFrom',
			value: 'active',
		});
	});

	it('works with null value', () => {
		const result = isDistinctFrom('deleted_at', null);
		expect(result).toEqual({
			kind: 'comparison',
			field: 'deleted_at',
			operator: 'isDistinctFrom',
			value: null,
		});
	});
});
