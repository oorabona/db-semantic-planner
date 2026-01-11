/**
 * DX-030 Block 6: Autocompletion Tests
 */

import type { ResolvedSchema } from '@db-semantic-planner/schema';
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
		userPosts: { kind: 'one-to-many', target: 'posts' },
		postComments: { kind: 'one-to-many', target: 'comments' },
		postAuthor: { kind: 'many-to-one', target: 'users' },
	},
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
			expect(keywords).toContain('include');
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
		it('should suggest relations after include', () => {
			const suggestions = provider.complete('users include ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			expect(relations).toContain('userPosts');
			expect(relations).toContain('postComments');
		});

		it('should filter relations by prefix', () => {
			const suggestions = provider.complete('users include user');
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
				},
			},
		};

		let qualifiedProvider: CompletionProvider;

		beforeEach(() => {
			qualifiedProvider = new CompletionProvider(qualifiedSchema);
		});

		it('should suggest simple relation names for current table', () => {
			const suggestions = qualifiedProvider.complete('posts include ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			// Should show "author" not "posts.author"
			expect(relations).toContain('author');
			expect(relations).not.toContain('posts.author');
		});

		it('should not suggest relations from other tables', () => {
			const suggestions = qualifiedProvider.complete('posts include ');
			const relations = suggestions
				.filter((s) => s.type === 'relation')
				.map((s) => s.text);
			// Should NOT show "posts" (which belongs to authors table)
			expect(relations).not.toContain('posts');
		});

		it('should suggest correct relations for different table', () => {
			const suggestions = qualifiedProvider.complete('authors include ');
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
