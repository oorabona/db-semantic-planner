/**
 * DX-030 Block 6: Autocompletion Tests
 */

import type { ResolvedSchema } from '@dbsp/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { CompletionProvider, formatCompletions } from './completion.js';

// Test schema
const testSchema: ResolvedSchema = {
	tables: {
		users: {
			id: { type: 'string', nullable: false },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false },
			active: { type: 'boolean', nullable: false },
		},
		posts: {
			id: { type: 'string', nullable: false },
			title: { type: 'string', nullable: false },
			content: { type: 'string', nullable: true },
			authorId: { type: 'string', nullable: false },
		},
		comments: {
			id: { type: 'string', nullable: false },
			postId: { type: 'string', nullable: false },
			body: { type: 'string', nullable: false },
		},
	},
	relations: {
		userPosts: {
			kind: 'hasMany',
			target: 'posts',
			foreignKey: 'authorId',
			sourceKey: 'id',
		},
		postComments: {
			kind: 'hasMany',
			target: 'comments',
			foreignKey: 'postId',
			sourceKey: 'id',
		},
		postAuthor: { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
	},
	hints: {},
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: [],
		fkAutoIndex: true,
	},
	indexes: {},
};

describe('CompletionProvider', () => {
	let provider: CompletionProvider;

	beforeEach(() => {
		provider = new CompletionProvider(testSchema);
	});

	describe('table completions', () => {
		it('should suggest tables for empty input', () => {
			const suggestions = provider.complete('');
			const tableNames = suggestions
				.filter((s) => s.type === 'table')
				.map((s) => s.text);
			expect(tableNames).toContain('users');
			expect(tableNames).toContain('posts');
			expect(tableNames).toContain('comments');
		});

		it('should filter tables by prefix', () => {
			const suggestions = provider.complete('us');
			const tableNames = suggestions
				.filter((s) => s.type === 'table')
				.map((s) => s.text);
			expect(tableNames).toContain('users');
			expect(tableNames).not.toContain('posts');
		});

		it('should suggest tables at start of query', () => {
			const suggestions = provider.complete('po');
			const tableNames = suggestions
				.filter((s) => s.type === 'table')
				.map((s) => s.text);
			expect(tableNames).toContain('posts');
		});
	});

	describe('dot command completions', () => {
		it('should suggest dot commands for "." prefix', () => {
			const suggestions = provider.complete('.');
			const commands = suggestions
				.filter((s) => s.type === 'command')
				.map((s) => s.text);
			expect(commands).toContain('.help');
			expect(commands).toContain('.tables');
			expect(commands).toContain('.schema');
		});

		it('should filter dot commands by prefix', () => {
			const suggestions = provider.complete('.ta');
			const commands = suggestions
				.filter((s) => s.type === 'command')
				.map((s) => s.text);
			expect(commands).toContain('.tables');
			expect(commands).not.toContain('.help');
		});

		it('should include .history command', () => {
			const suggestions = provider.complete('.hi');
			const commands = suggestions.map((s) => s.text);
			expect(commands).toContain('.history');
		});
	});

	describe('keyword completions', () => {
		it('should suggest keywords after table name', () => {
			const suggestions = provider.complete('users ');
			const keywords = suggestions
				.filter((s) => s.type === 'keyword')
				.map((s) => s.text);
			expect(keywords).toContain('where');
			expect(keywords).toContain('with');
			expect(keywords).toContain('limit');
		});

		it('should filter keywords by prefix', () => {
			const suggestions = provider.complete('users wh');
			const keywords = suggestions
				.filter((s) => s.type === 'keyword')
				.map((s) => s.text);
			expect(keywords).toContain('where');
			expect(keywords).not.toContain('include');
		});
	});

	describe('column completions', () => {
		it('should suggest columns after where', () => {
			const suggestions = provider.complete('users where ');
			const columns = suggestions
				.filter((s) => s.type === 'column')
				.map((s) => s.text);
			expect(columns).toContain('id');
			expect(columns).toContain('name');
			expect(columns).toContain('email');
			expect(columns).toContain('active');
		});

		it('should filter columns by prefix', () => {
			const suggestions = provider.complete('users where na');
			const columns = suggestions
				.filter((s) => s.type === 'column')
				.map((s) => s.text);
			expect(columns).toContain('name');
			expect(columns).not.toContain('email');
		});

		it('should suggest columns for correct table', () => {
			const suggestions = provider.complete('posts where ');
			const columns = suggestions
				.filter((s) => s.type === 'column')
				.map((s) => s.text);
			expect(columns).toContain('title');
			expect(columns).toContain('content');
			expect(columns).not.toContain('email'); // email is in users, not posts
		});

		it('should suggest columns after and/or', () => {
			const suggestions = provider.complete('users where active = true and ');
			const columns = suggestions
				.filter((s) => s.type === 'column')
				.map((s) => s.text);
			expect(columns).toContain('name');
			expect(columns).toContain('email');
		});
	});

	describe('relation completions', () => {
		it('should suggest relations after with', () => {
			const suggestions = provider.complete('users with ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			expect(relations).toContain('userPosts');
			expect(relations).toContain('postComments');
		});

		it('should filter relations by prefix', () => {
			const suggestions = provider.complete('users with user');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			expect(relations).toContain('userPosts');
			expect(relations).not.toContain('postComments');
		});
	});

	describe('context-aware relation completions (qualified)', () => {
		// Schema with qualified relation names (as produced by defineSchema)
		const qualifiedSchema: ResolvedSchema = {
			tables: {
				posts: {
					id: { type: 'string', nullable: false },
					authorId: { type: 'string', nullable: false },
					title: { type: 'string', nullable: false },
				},
				authors: {
					id: { type: 'string', nullable: false },
					name: { type: 'string', nullable: false },
				},
			},
			relations: {
				'posts.author': {
					kind: 'belongsTo',
					target: 'authors',
					foreignKey: 'authorId',
				},
				'authors.posts': {
					kind: 'hasMany',
					target: 'posts',
					foreignKey: 'authorId',
					sourceKey: 'id',
				},
			},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: true,
			},
			indexes: {},
		};

		let qualifiedProvider: CompletionProvider;

		beforeEach(() => {
			qualifiedProvider = new CompletionProvider(qualifiedSchema);
		});

		it('should suggest simple relation names for current table', () => {
			const suggestions = qualifiedProvider.complete('posts with ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			// Should show "author" not "posts.author"
			expect(relations).toContain('author');
			expect(relations).not.toContain('posts.author');
		});

		it('should not suggest relations from other tables', () => {
			const suggestions = qualifiedProvider.complete('posts with ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			// Should NOT show "posts" (which belongs to authors table)
			expect(relations).not.toContain('posts');
		});

		it('should suggest correct relations for different table', () => {
			const suggestions = qualifiedProvider.complete('authors with ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			// Should show "posts" (from authors.posts)
			expect(relations).toContain('posts');
			// Should NOT show "author" (which belongs to posts table)
			expect(relations).not.toContain('author');
		});
	});

	describe('value completions', () => {
		it('should suggest boolean values after =', () => {
			const suggestions = provider.complete('users where active = ');
			const values = suggestions.map((s) => s.text);
			expect(values).toContain('true');
			expect(values).toContain('false');
			expect(values).toContain('null');
		});
	});

	describe('helper methods', () => {
		it('getTableNames should return all table names', () => {
			const tables = provider.getTableNames();
			expect(tables).toEqual(['users', 'posts', 'comments']);
		});

		it('getColumnNames should return columns for a table', () => {
			const columns = provider.getColumnNames('users');
			expect(columns).toContain('id');
			expect(columns).toContain('name');
			expect(columns).toContain('email');
			expect(columns).toContain('active');
		});

		it('getColumnNames should return empty for unknown table', () => {
			const columns = provider.getColumnNames('unknown');
			expect(columns).toEqual([]);
		});

		it('getRelationNames should return all relation names', () => {
			const relations = provider.getRelationNames();
			expect(relations).toContain('userPosts');
			expect(relations).toContain('postComments');
			expect(relations).toContain('postAuthor');
		});
	});

	describe('applyCompletion', () => {
		it('should append completion when input ends with space', () => {
			const result = provider.applyCompletion('users where ', 'active');
			expect(result).toBe('users where active');
		});

		it('should replace partial word when not ending with space', () => {
			const result = provider.applyCompletion('users where act', 'active');
			expect(result).toBe('users where active');
		});

		it('should replace single partial word', () => {
			const result = provider.applyCompletion('us', 'users');
			expect(result).toBe('users');
		});

		it('should handle empty input', () => {
			const result = provider.applyCompletion('', 'users');
			expect(result).toBe('users');
		});

		it('should preserve previous words when replacing partial', () => {
			const result = provider.applyCompletion(
				'users where active = tr',
				'true',
			);
			expect(result).toBe('users where active = true');
		});

		it('should handle dot commands', () => {
			const result = provider.applyCompletion('.tab', '.tables');
			expect(result).toBe('.tables');
		});
	});
});

describe('formatCompletions', () => {
	it('should format completions with type icons', () => {
		const suggestions = [
			{ text: 'users', label: 'users', type: 'table' as const },
			{ text: '.help', label: '.help', type: 'command' as const },
		];
		const formatted = formatCompletions(suggestions);
		expect(formatted).toContain('users');
		expect(formatted).toContain('.help');
	});

	it('should return empty string for no suggestions', () => {
		const formatted = formatCompletions([]);
		expect(formatted).toBe('');
	});

	it('should limit to maxItems', () => {
		const suggestions = Array.from({ length: 20 }, (_, i) => ({
			text: `item${i}`,
			label: `item${i}`,
			type: 'table' as const,
		}));
		const formatted = formatCompletions(suggestions, 5);
		// Should only contain first 5 items
		expect(formatted).toContain('item0');
		expect(formatted).toContain('item4');
		expect(formatted).not.toContain('item5');
	});
});

// Tests for Levenshtein fuzzy matching (ARCH-003)
import {
	enhanceErrorWithSuggestion,
	levenshtein,
	suggestClosestMatch,
} from './completion.js';

describe('levenshtein', () => {
	it('should return 0 for identical strings', () => {
		expect(levenshtein('hello', 'hello')).toBe(0);
	});

	it('should be case-insensitive', () => {
		expect(levenshtein('Hello', 'hello')).toBe(0);
		expect(levenshtein('ROOMBOOKS', 'roombooks')).toBe(0);
	});

	it('should calculate distance for single character difference', () => {
		expect(levenshtein('cat', 'bat')).toBe(1); // substitution
		expect(levenshtein('cat', 'cats')).toBe(1); // insertion
		expect(levenshtein('cats', 'cat')).toBe(1); // deletion
	});

	it('should calculate distance for multiple differences', () => {
		expect(levenshtein('kitten', 'sitting')).toBe(3);
		expect(levenshtein('saturday', 'sunday')).toBe(3);
	});

	it('should handle empty strings', () => {
		expect(levenshtein('', '')).toBe(0);
		expect(levenshtein('hello', '')).toBe(5);
		expect(levenshtein('', 'world')).toBe(5);
	});
});

describe('suggestClosestMatch', () => {
	const tables = ['users', 'orders', 'products', 'categories', 'roomBookings'];

	it('should suggest closest table name (case mismatch)', () => {
		expect(suggestClosestMatch('roombooking', tables)).toBe('roomBookings');
	});

	it('should suggest closest table name (typo)', () => {
		expect(suggestClosestMatch('prodcts', tables)).toBe('products');
		expect(suggestClosestMatch('usrs', tables)).toBe('users');
	});

	it('should return null for completely different input', () => {
		expect(suggestClosestMatch('xyzabc', tables)).toBe(null);
	});

	it('should return null for empty input', () => {
		expect(suggestClosestMatch('', tables)).toBe(null);
	});

	it('should return null for empty candidates', () => {
		expect(suggestClosestMatch('users', [])).toBe(null);
	});

	it('should suggest for near matches even when exact exists (distance > 0)', () => {
		// 'users' to 'orders' has Levenshtein distance of 3, so a match is found
		// In practice, this function is only called for unknown tables (errors)
		const result = suggestClosestMatch('usrs', tables); // typo: missing 'e'
		expect(result).toBe('users');
	});

	it('should respect maxDistance parameter', () => {
		// 'abcdef' has distance > 3 from all tables, so it should be null at default
		expect(suggestClosestMatch('abcdef', tables)).toBe(null);
		// With higher threshold, closest match is found
		expect(suggestClosestMatch('abcdef', tables, 6)).not.toBe(null);
	});
});

describe('enhanceErrorWithSuggestion', () => {
	const tables = ['users', 'orders', 'products', 'roomBookings'];

	it('should enhance unknown table error with suggestion', () => {
		const error = 'Unknown table: roombooking';
		const enhanced = enhanceErrorWithSuggestion(error, tables);
		expect(enhanced).toContain("Did you mean 'roomBookings'?");
	});

	it('should enhance unknown table error (typo)', () => {
		const error = 'Unknown table: prodcts';
		const enhanced = enhanceErrorWithSuggestion(error, tables);
		expect(enhanced).toContain("Did you mean 'products'?");
	});

	it('should return original error if no close match', () => {
		const error = 'Unknown table: xyzabc';
		const enhanced = enhanceErrorWithSuggestion(error, tables);
		expect(enhanced).toBe(error);
	});

	it('should return original error if not an unknown table error', () => {
		const error = 'Some other error';
		const enhanced = enhanceErrorWithSuggestion(error, tables);
		expect(enhanced).toBe(error);
	});

	it('should enhance unknown column error if columns provided', () => {
		const columns = ['firstName', 'lastName', 'email'];
		const error = 'Unknown column: fristName';
		const enhanced = enhanceErrorWithSuggestion(error, tables, columns);
		expect(enhanced).toContain("Did you mean 'firstName'?");
	});
});
