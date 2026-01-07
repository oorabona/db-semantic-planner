import { describe, expect, it } from 'vitest';
import {
	AmbiguousRelationError,
	ExecutionError,
	NotFoundError,
} from './errors.js';

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

		expect(error.message).toContain(
			"Ambiguous relation to 'posts' from 'users'",
		);
		expect(error.message).toContain('authoredPosts, reviewedPosts');
		expect(error.message).toContain(
			"Use { via: 'relationName' } to disambiguate",
		);
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
		const error = new AmbiguousRelationError('users', 'posts', [
			'singleRelation',
		]);

		expect(error.message).toContain('Available relations: singleRelation');
	});
});

describe('ExecutionError', () => {
	it('creates error with message', () => {
		const error = new ExecutionError('No database configured');

		expect(error.message).toBe('No database configured');
	});

	it('has name set to ExecutionError', () => {
		const error = new ExecutionError('test');

		expect(error.name).toBe('ExecutionError');
	});

	it('works with instanceof check', () => {
		const error = new ExecutionError('test');

		expect(error instanceof ExecutionError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});

describe('NotFoundError', () => {
	it('creates error with table name', () => {
		const error = new NotFoundError('users');

		expect(error.table).toBe('users');
		expect(error.message).toBe("No record found for 'users'");
	});

	it('has name set to NotFoundError', () => {
		const error = new NotFoundError('posts');

		expect(error.name).toBe('NotFoundError');
	});

	it('works with instanceof check', () => {
		const error = new NotFoundError('users');

		expect(error instanceof NotFoundError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});
