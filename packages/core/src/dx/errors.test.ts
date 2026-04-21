import { describe, expect, it } from 'vitest';
import {
	AmbiguousRelationError,
	ColumnNotFoundError,
	ErrorCode,
	Errors,
	ExecutionError,
	findClosestMatch,
	InvalidOperationError,
	NotFoundError,
	RelationNotFoundError,
	TableNotFoundError,
	UnsafeOperationError,
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

		// FIND-006: .message is generic (no info leakage); diagnostic detail in .available
		expect(error.message).toBe('Relation not found');
		expect(error.publicMessage).toBe('Relation not found');
		expect(error.available).toContain('posts');
		expect(error.available).toContain('profile');
	});

	it('provides fuzzy match suggestion for typos', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'coments',
			available: ['posts', 'profile', 'comments'],
		});

		// FIND-006: suggestion in .suggestion field, not in .message
		expect(error.suggestion).toBe('comments');
		expect(error.message).toBe('Relation not found');
	});

	it('provides suggestion for prefix match', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'post',
			available: ['posts', 'profile', 'comments'],
		});

		// FIND-006: suggestion in .suggestion field, not in .message
		expect(error.suggestion).toBe('posts');
		expect(error.message).toBe('Relation not found');
	});

	it('handles no available relations gracefully', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'anything',
			available: [],
		});

		// FIND-006: .message is generic; no suggestion when none match
		expect(error.suggestion).toBeUndefined();
		expect(error.message).toBe('Relation not found');
		expect(error.available).toHaveLength(0);
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

		// FIND-006: .message is generic; diagnostic detail in .available
		expect(error.message).toBe('Table not found');
		expect(error.publicMessage).toBe('Table not found');
		expect(error.available).toContain('users');
		expect(error.available).toContain('posts');
	});

	it('provides fuzzy match suggestion for typos', () => {
		const error = new TableNotFoundError({
			requested: 'usrs',
			available: ['users', 'posts', 'comments'],
		});

		// FIND-006: suggestion in .suggestion field, not in .message
		expect(error.suggestion).toBe('users');
		expect(error.message).toBe('Table not found');
	});

	it('provides suggestion for prefix match', () => {
		const error = new TableNotFoundError({
			requested: 'user',
			available: ['users', 'posts'],
		});

		// FIND-006: suggestion in .suggestion field, not in .message
		expect(error.suggestion).toBe('users');
		expect(error.message).toBe('Table not found');
	});

	it('handles no available tables gracefully', () => {
		const error = new TableNotFoundError({
			requested: 'anything',
			available: [],
		});

		// FIND-006: .message is generic; no suggestion when none match
		expect(error.suggestion).toBeUndefined();
		expect(error.message).toBe('Table not found');
		expect(error.available).toHaveLength(0);
	});

	it('truncates long table lists', () => {
		const tables = Array.from({ length: 15 }, (_, i) => `table${i}`);
		const error = new TableNotFoundError({
			requested: 'unknown',
			available: tables,
		});

		// FIND-006: truncation detail in .available length, not in .message
		expect(error.available).toHaveLength(15);
		// All tables accessible via .available; no truncation in .message
		expect(tables.every((t) => error.available.includes(t))).toBe(true);
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

		// FIND-006: .message is generic; diagnostic detail in .available
		expect(error.message).toBe('Column not found');
		expect(error.publicMessage).toBe('Column not found');
		expect(error.available).toContain('id');
		expect(error.available).toContain('email');
	});

	it('provides fuzzy match suggestion for typos', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'emial',
			available: ['id', 'email', 'name'],
		});

		// FIND-006: suggestion in .suggestion field, not in .message
		expect(error.suggestion).toBe('email');
		expect(error.message).toBe('Column not found');
	});

	it('provides suggestion for prefix match', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'create',
			available: ['id', 'createdAt', 'updatedAt'],
		});

		// FIND-006: suggestion in .suggestion field, not in .message
		expect(error.suggestion).toBe('createdAt');
		expect(error.message).toBe('Column not found');
	});

	it('handles no available columns gracefully', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'anything',
			available: [],
		});

		// FIND-006: .message is generic; no suggestion when none match
		expect(error.suggestion).toBeUndefined();
		expect(error.message).toBe('Column not found');
		expect(error.available).toHaveLength(0);
	});

	it('truncates long column lists', () => {
		const columns = Array.from({ length: 20 }, (_, i) => `column${i}`);
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: columns,
		});

		// FIND-006: all columns accessible via .available; no truncation in .message
		expect(error.available).toHaveLength(20);
		expect(columns.every((c) => error.available.includes(c))).toBe(true);
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

// ============================================================================
// Error Factory & ErrorCode (AUD-011)
// ============================================================================

describe('ErrorCode', () => {
	it('has unique codes for each error type', () => {
		const codes = Object.values(ErrorCode);
		const uniqueCodes = new Set(codes);
		expect(codes.length).toBe(uniqueCodes.size);
	});

	it('follows DBSP_EXXX format', () => {
		for (const code of Object.values(ErrorCode)) {
			expect(code).toMatch(/^DBSP_E\d{3}$/);
		}
	});
});

describe('Errors factory', () => {
	describe('factory functions', () => {
		it('creates ExecutionError with code', () => {
			const error = Errors.execution({
				operation: 'findMany',
				reason: 'no adapter',
				fix: 'provide adapter',
			});
			expect(error).toBeInstanceOf(ExecutionError);
			expect(error.code).toBe(ErrorCode.EXECUTION_ERROR);
			expect(error.operation).toBe('findMany');
		});

		it('creates NotFoundError with code', () => {
			const error = Errors.notFound('users', 'Check your filters');
			expect(error).toBeInstanceOf(NotFoundError);
			expect(error.code).toBe(ErrorCode.NOT_FOUND);
			expect(error.table).toBe('users');
		});

		it('creates AmbiguousRelationError with code', () => {
			const error = Errors.ambiguousRelation('users', 'posts', [
				'authoredPosts',
				'reviewedPosts',
			]);
			expect(error).toBeInstanceOf(AmbiguousRelationError);
			expect(error.code).toBe(ErrorCode.AMBIGUOUS_RELATION);
			expect(error.options).toEqual(['authoredPosts', 'reviewedPosts']);
		});

		it('creates RelationNotFoundError with code', () => {
			const error = Errors.relationNotFound({
				table: 'users',
				requested: 'postss',
				available: ['posts', 'comments'],
			});
			expect(error).toBeInstanceOf(RelationNotFoundError);
			expect(error.code).toBe(ErrorCode.RELATION_NOT_FOUND);
			expect(error.suggestion).toBe('posts');
		});

		it('creates InvalidOperationError with code', () => {
			const error = Errors.invalidOperation('insert', 'no values provided');
			expect(error).toBeInstanceOf(InvalidOperationError);
			expect(error.code).toBe(ErrorCode.INVALID_OPERATION);
		});

		it('creates UnsafeOperationError with code', () => {
			const error = Errors.unsafeOperation(
				'update',
				'Add a WHERE clause or use .all()',
			);
			expect(error).toBeInstanceOf(UnsafeOperationError);
			expect(error.code).toBe(ErrorCode.UNSAFE_OPERATION);
		});

		it('creates TableNotFoundError with code', () => {
			const error = Errors.tableNotFound({
				requested: 'userz',
				available: ['users', 'posts'],
			});
			expect(error).toBeInstanceOf(TableNotFoundError);
			expect(error.code).toBe(ErrorCode.TABLE_NOT_FOUND);
			expect(error.suggestion).toBe('users');
		});

		it('creates ColumnNotFoundError with code', () => {
			const error = Errors.columnNotFound({
				table: 'users',
				requested: 'emial',
				available: ['email', 'name'],
			});
			expect(error).toBeInstanceOf(ColumnNotFoundError);
			expect(error.code).toBe(ErrorCode.COLUMN_NOT_FOUND);
			expect(error.suggestion).toBe('email');
		});
	});

	describe('type guards', () => {
		it('isExecution identifies ExecutionError', () => {
			const error = new ExecutionError({
				operation: 'x',
				reason: 'y',
				fix: 'z',
			});
			expect(Errors.isExecution(error)).toBe(true);
			expect(Errors.isExecution(new Error('test'))).toBe(false);
		});

		it('isNotFound identifies NotFoundError', () => {
			expect(Errors.isNotFound(new NotFoundError('users'))).toBe(true);
			expect(Errors.isNotFound(new Error('test'))).toBe(false);
		});

		it('isDbspError identifies any DBSP error', () => {
			expect(
				Errors.isDbspError(
					new ExecutionError({ operation: 'x', reason: 'y', fix: 'z' }),
				),
			).toBe(true);
			expect(Errors.isDbspError(new NotFoundError('t'))).toBe(true);
			expect(
				Errors.isDbspError(
					new TableNotFoundError({ requested: 'x', available: [] }),
				),
			).toBe(true);
			expect(Errors.isDbspError(new Error('generic'))).toBe(false);
			expect(Errors.isDbspError('string')).toBe(false);
		});

		it('hasCode identifies errors with DBSP codes', () => {
			const withCode = Errors.execution({
				operation: 'x',
				reason: 'y',
				fix: 'z',
			});
			const withoutCode = new ExecutionError({
				operation: 'x',
				reason: 'y',
				fix: 'z',
			});

			expect(Errors.hasCode(withCode)).toBe(true);
			expect(Errors.hasCode(withoutCode)).toBe(false);
		});
	});
});
