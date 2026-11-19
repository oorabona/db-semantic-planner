/**
 * Unit tests for applyHintToIncludeRecursive: relation hints resolve a target
 * table to a relation name, never override an explicit `via`, and reach
 * nested includes.
 */

import { describe, expect, it } from 'vitest';
import { applyHintToIncludeRecursive } from './include-hints.js';

describe('applyHintToIncludeRecursive()', () => {
	it('should apply hint to matching include', () => {
		const result = applyHintToIncludeRecursive(
			{ relation: 'users' },
			{ users: 'author' },
		);
		expect(result.via).toBe('author');
	});

	it('should not override explicit via', () => {
		const result = applyHintToIncludeRecursive(
			{ relation: 'users', via: 'editor' },
			{ users: 'author' },
		);
		expect(result.via).toBe('editor');
	});

	it('should process nested includes when parent has explicit via', () => {
		const result = applyHintToIncludeRecursive(
			{
				relation: 'comments',
				via: 'postComments',
				include: [{ relation: 'users' }],
			},
			{ users: 'author' },
		);
		expect(result.via).toBe('postComments');
		expect(result.include?.[0]?.via).toBe('author');
	});

	it('should process nested includes when parent has no explicit via', () => {
		const result = applyHintToIncludeRecursive(
			{ relation: 'comments', include: [{ relation: 'users' }] },
			{ users: 'author' },
		);
		expect(result.via).toBeUndefined();
		expect(result.include?.[0]?.via).toBe('author');
	});

	it('should leave includes without matching hint unchanged', () => {
		const inc = { relation: 'posts' };
		const result = applyHintToIncludeRecursive(inc, { categories: 'parent' });
		expect(result).toBe(inc);
		expect(result.via).toBeUndefined();
	});
});
