import { describe, expect, it } from 'vitest';
import { classifyGeneratedMutation } from './destructive-classification.js';

describe('generated mutation destructive classification', () => {
	it('classifies every known ChangeKind and fails closed for a new one', () => {
		expect(classifyGeneratedMutation('drop_table')).toBe('removal');
		expect(classifyGeneratedMutation('alter_column_type')).toBe(
			'data-destructive',
		);
		expect(classifyGeneratedMutation('create_index')).toBe('non-destructive');
		expect(classifyGeneratedMutation('future_unclassified_kind')).toBe(
			'data-destructive',
		);
	});
});
