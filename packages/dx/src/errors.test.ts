import { describe, it, expect } from 'vitest';
import { AmbiguousRelationError } from './errors.js';

describe('AmbiguousRelationError', () => {
	it('creates error with correct properties', () => {
		const error = new AmbiguousRelationError('users', 'posts', [
			'authoredPosts',
			'reviewedPosts',
		]);

		expect(error.sourceTable).toBe('users');
		expect(error.targetTable).toBe('posts');
		expect(error.options).toEqual(['authoredPosts', 'reviewedPosts']);
	});

	it('has name set to AmbiguousRelationError', () => {
		const error = new AmbiguousRelationError('users', 'posts', ['rel1']);
		expect(error.name).toBe('AmbiguousRelationError');
	});

	it('generates descriptive message with disambiguation hint', () => {
		const error = new AmbiguousRelationError('users', 'posts', [
			'authoredPosts',
			'reviewedPosts',
		]);

		expect(error.message).toContain("Ambiguous relation to 'posts' from 'users'");
		expect(error.message).toContain('authoredPosts, reviewedPosts');
		expect(error.message).toContain("Use { via: 'relationName' } to disambiguate");
	});

	it('works with instanceof check', () => {
		const error = new AmbiguousRelationError('users', 'posts', ['rel1']);

		expect(error instanceof AmbiguousRelationError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});

	it('options array is readonly', () => {
		const options = ['authoredPosts', 'reviewedPosts'];
		const error = new AmbiguousRelationError('users', 'posts', options);

		// The options should be a readonly array
		expect(error.options).toEqual(options);
		// TypeScript ensures readonly - runtime check that it's the same reference
		expect(error.options).toBe(options);
	});

	it('handles single option gracefully', () => {
		const error = new AmbiguousRelationError('users', 'posts', ['singleRelation']);

		expect(error.message).toContain('Available relations: singleRelation');
	});
});
