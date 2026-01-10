import { describe, expect, it } from 'vitest';
import {
	AmbiguousRelationError,
	ColumnNotFoundError,
	ExecutionError,
	findClosestMatch,
	NotFoundError,
	RelationNotFoundError,
	TableNotFoundError,
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

	it('generates actionable message with code examples', () => {
		const error = new AmbiguousRelationError('users', 'posts', [
			'authoredPosts',
			'reviewedPosts',
		]);

		expect(error.message).toContain(
			"Ambiguous relation from 'users' to 'posts'",
		);
		expect(error.message).toContain('authoredPosts, reviewedPosts');
		expect(error.message).toContain(
			".include('posts', { via: 'authoredPosts' })",
		);
		expect(error.message).toContain('createOrm({ db, relationHints:');
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

		expect(error.message).toContain('Multiple relations found: singleRelation');
		expect(error.message).toContain("{ via: 'singleRelation' }");
	});
});

describe('ExecutionError', () => {
	it('creates error with operation, reason, and fix', () => {
		const error = new ExecutionError({
			operation: 'findMany',
			reason: 'Database not configured',
			fix: 'Pass db option to createOrm()',
		});

		expect(error.operation).toBe('findMany');
		expect(error.reason).toBe('Database not configured');
		expect(error.fix).toBe('Pass db option to createOrm()');
	});

	it('generates actionable message', () => {
		const error = new ExecutionError({
			operation: 'findMany',
			reason: 'Database not configured',
			fix: 'Pass db option to createOrm()',
		});

		expect(error.message).toContain('Cannot execute findMany');
		expect(error.message).toContain('Database not configured');
		expect(error.message).toContain('To fix:');
		expect(error.message).toContain('Pass db option to createOrm()');
	});

	it('has name set to ExecutionError', () => {
		const error = new ExecutionError({
			operation: 'test',
			reason: 'reason',
			fix: 'fix',
		});

		expect(error.name).toBe('ExecutionError');
	});

	it('works with instanceof check', () => {
		const error = new ExecutionError({
			operation: 'test',
			reason: 'reason',
			fix: 'fix',
		});

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

	it('includes optional hint in message', () => {
		const error = new NotFoundError('users', 'Check if the ID exists.');

		expect(error.table).toBe('users');
		expect(error.hint).toBe('Check if the ID exists.');
		expect(error.message).toBe(
			"No record found for 'users'. Check if the ID exists.",
		);
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

describe('RelationNotFoundError', () => {
	it('creates error with table, requested, and available relations', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'comment',
			available: ['posts', 'profile', 'comments'],
		});

		expect(error.table).toBe('users');
		expect(error.requested).toBe('comment');
		expect(error.available).toEqual(['posts', 'profile', 'comments']);
	});

	it('generates message with available relations', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: ['posts', 'profile'],
		});

		expect(error.message).toContain(
			"Relation 'unknown' not found on table 'users'",
		);
		expect(error.message).toContain('Available relations: posts, profile');
	});

	it('provides fuzzy match suggestion for typos', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'coments',
			available: ['posts', 'profile', 'comments'],
		});

		expect(error.suggestion).toBe('comments');
		expect(error.message).toContain("Did you mean 'comments'?");
	});

	it('provides suggestion for prefix match', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'post',
			available: ['posts', 'profile', 'comments'],
		});

		expect(error.suggestion).toBe('posts');
		expect(error.message).toContain("Did you mean 'posts'?");
	});

	it('handles no available relations gracefully', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'anything',
			available: [],
		});

		expect(error.suggestion).toBeUndefined();
		expect(error.message).toContain('Available relations: (none defined)');
		expect(error.message).not.toContain('Did you mean');
	});

	it('has name set to RelationNotFoundError', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'x',
			available: [],
		});

		expect(error.name).toBe('RelationNotFoundError');
	});

	it('works with instanceof check', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'x',
			available: [],
		});

		expect(error instanceof RelationNotFoundError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});

describe('TableNotFoundError', () => {
	it('creates error with requested and available tables', () => {
		const error = new TableNotFoundError({
			requested: 'usrs',
			available: ['users', 'posts', 'comments'],
		});

		expect(error.requested).toBe('usrs');
		expect(error.available).toEqual(['users', 'posts', 'comments']);
	});

	it('generates message with available tables', () => {
		const error = new TableNotFoundError({
			requested: 'unknown',
			available: ['users', 'posts'],
		});

		expect(error.message).toContain("Table 'unknown' not found in schema");
		expect(error.message).toContain('Available tables: users, posts');
	});

	it('provides fuzzy match suggestion for typos', () => {
		const error = new TableNotFoundError({
			requested: 'usrs',
			available: ['users', 'posts', 'comments'],
		});

		expect(error.suggestion).toBe('users');
		expect(error.message).toContain("Did you mean 'users'?");
	});

	it('provides suggestion for prefix match', () => {
		const error = new TableNotFoundError({
			requested: 'user',
			available: ['users', 'posts'],
		});

		expect(error.suggestion).toBe('users');
		expect(error.message).toContain("Did you mean 'users'?");
	});

	it('handles no available tables gracefully', () => {
		const error = new TableNotFoundError({
			requested: 'anything',
			available: [],
		});

		expect(error.suggestion).toBeUndefined();
		expect(error.message).toContain('Available tables: (none defined)');
		expect(error.message).not.toContain('Did you mean');
	});

	it('truncates long table lists', () => {
		const tables = Array.from({ length: 15 }, (_, i) => `table${i}`);
		const error = new TableNotFoundError({
			requested: 'unknown',
			available: tables,
		});

		expect(error.message).toContain('(and 5 more)');
	});

	it('has name set to TableNotFoundError', () => {
		const error = new TableNotFoundError({
			requested: 'x',
			available: [],
		});

		expect(error.name).toBe('TableNotFoundError');
	});

	it('works with instanceof check', () => {
		const error = new TableNotFoundError({
			requested: 'x',
			available: [],
		});

		expect(error instanceof TableNotFoundError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});

describe('ColumnNotFoundError', () => {
	it('creates error with table, requested, and available columns', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'emial',
			available: ['id', 'email', 'name'],
		});

		expect(error.table).toBe('users');
		expect(error.requested).toBe('emial');
		expect(error.available).toEqual(['id', 'email', 'name']);
	});

	it('generates message with available columns', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: ['id', 'email'],
		});

		expect(error.message).toContain(
			"Column 'unknown' not found on table 'users'",
		);
		expect(error.message).toContain('Available columns: id, email');
	});

	it('provides fuzzy match suggestion for typos', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'emial',
			available: ['id', 'email', 'name'],
		});

		expect(error.suggestion).toBe('email');
		expect(error.message).toContain("Did you mean 'email'?");
	});

	it('provides suggestion for prefix match', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'create',
			available: ['id', 'createdAt', 'updatedAt'],
		});

		expect(error.suggestion).toBe('createdAt');
		expect(error.message).toContain("Did you mean 'createdAt'?");
	});

	it('handles no available columns gracefully', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'anything',
			available: [],
		});

		expect(error.suggestion).toBeUndefined();
		expect(error.message).toContain('Available columns: (none defined)');
		expect(error.message).not.toContain('Did you mean');
	});

	it('truncates long column lists', () => {
		const columns = Array.from({ length: 20 }, (_, i) => `column${i}`);
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: columns,
		});

		expect(error.message).toContain('(and 5 more)');
	});

	it('has name set to ColumnNotFoundError', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'x',
			available: [],
		});

		expect(error.name).toBe('ColumnNotFoundError');
	});

	it('works with instanceof check', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'x',
			available: [],
		});

		expect(error instanceof ColumnNotFoundError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});

describe('findClosestMatch', () => {
	it('returns exact prefix match', () => {
		const result = findClosestMatch('user', ['users', 'posts', 'comments']);
		expect(result).toBe('users');
	});

	it('returns case-insensitive prefix match', () => {
		const result = findClosestMatch('User', ['users', 'posts']);
		expect(result).toBe('users');
	});

	it('returns fuzzy match for typos', () => {
		const result = findClosestMatch('commnets', ['users', 'posts', 'comments']);
		expect(result).toBe('comments');
	});

	it('prefers prefix match over levenshtein', () => {
		// Prefix match takes priority
		const result = findClosestMatch('post', ['posts', 'pots', 'posit']);
		expect(result).toBe('posts'); // prefix match wins
	});

	it('returns undefined for empty candidates', () => {
		const result = findClosestMatch('users', []);
		expect(result).toBeUndefined();
	});

	it('handles single character typos', () => {
		const result = findClosestMatch('usres', ['users', 'posts']);
		expect(result).toBe('users');
	});

	it('handles missing character', () => {
		const result = findClosestMatch('sers', ['users', 'posts']);
		expect(result).toBe('users');
	});

	it('handles extra character', () => {
		const result = findClosestMatch('userss', ['users', 'posts']);
		expect(result).toBe('users');
	});
});
