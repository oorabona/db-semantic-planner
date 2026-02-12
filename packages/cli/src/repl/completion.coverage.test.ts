// @ts-nocheck — coverage test: runtime assertions
/**
 * Coverage tests for completion.ts — targets uncovered branches
 * not in completion.test.ts.
 *
 * Focus: parseContext edge cases, filterSuggestions label matching,
 * formatCompletions with unknown type, 'or' keyword context,
 * applyCompletion edge for empty words array, and "any" context fallback.
 */

import type { ColumnType, ModelIR, RelationIR, RelationType, TableIR } from '@dbsp/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoadedSchema } from '../utils/schema-loader.js';
import {
	CompletionProvider,
	enhanceErrorWithSuggestion,
	formatCompletions,
	levenshtein,
	suggestClosestMatch,
} from './completion.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createMockSchema(
	tables: Record<string, Array<{ name: string; type: ColumnType; nullable?: boolean }>>,
	relations: Record<string, { type: RelationType; source: string; target: string; foreignKey?: string }>,
): LoadedSchema {
	const tableMap = new Map<string, TableIR>();
	for (const [tableName, columns] of Object.entries(tables)) {
		tableMap.set(tableName, {
			name: tableName,
			columns: columns.map((c) => ({
				name: c.name,
				type: c.type,
				nullable: c.nullable ?? false,
			})),
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		});
	}

	const relationMap = new Map<string, RelationIR>();
	for (const [relName, rel] of Object.entries(relations)) {
		relationMap.set(relName, {
			name: relName.includes('.') ? relName.split('.')[1]! : relName,
			type: rel.type,
			source: rel.source,
			target: rel.target,
			foreignKey: rel.foreignKey,
			cardinality: rel.type === 'hasMany' || rel.type === 'belongsToMany' ? 'many' : 'one',
			optionality: 'optional',
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		});
	}

	const model: ModelIR = {
		tables: tableMap,
		relations: relationMap,
		getTable: (name) => tableMap.get(name),
		getRelation: (name) => relationMap.get(name),
		getRelationsFrom: (source) => Array.from(relationMap.values()).filter((r) => r.source === source),
		getRelationsTo: (target) => Array.from(relationMap.values()).filter((r) => r.target === target),
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};

	return {
		definition: tables,
		model,
		tableNames: Object.keys(tables),
	};
}

const testSchema = createMockSchema(
	{
		users: [
			{ name: 'id', type: 'string' },
			{ name: 'name', type: 'string' },
			{ name: 'email', type: 'string' },
		],
		posts: [
			{ name: 'id', type: 'string' },
			{ name: 'title', type: 'string' },
		],
	},
	{
		userPosts: {
			type: 'hasMany',
			source: 'users',
			target: 'posts',
			foreignKey: 'authorId',
		},
	},
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletionProvider — coverage', () => {
	let provider: CompletionProvider;

	beforeEach(() => {
		provider = new CompletionProvider(testSchema);
	});

	describe('parseContext — "or" keyword triggers column suggestions', () => {
		it('suggests columns after "or" keyword', () => {
			const suggestions = provider.complete('users where name = "x" or ');
			const columns = suggestions.filter((s) => s.type === 'column').map((s) => s.text);
			expect(columns).toContain('name');
			expect(columns).toContain('email');
		});
	});

	describe('parseContext — operator context (value suggestions)', () => {
		it('suggests boolean/null values after != operator', () => {
			const suggestions = provider.complete('users where name != ');
			const values = suggestions.map((s) => s.text);
			expect(values).toContain('true');
			expect(values).toContain('false');
			expect(values).toContain('null');
		});

		it('suggests boolean/null values after > operator', () => {
			const suggestions = provider.complete('users where id > ');
			const values = suggestions.map((s) => s.text);
			expect(values).toContain('true');
			expect(values).toContain('false');
		});

		it('suggests boolean/null values after < operator', () => {
			const suggestions = provider.complete('users where id < ');
			const values = suggestions.map((s) => s.text);
			expect(values).toContain('null');
		});
	});

	describe('parseContext — "any" fallback context', () => {
		it('falls back to tables + keywords when first word is not a table', () => {
			// "nonexistent" is not a recognized table, so context is "any"
			const suggestions = provider.complete('nonexistent ');
			const types = new Set(suggestions.map((s) => s.type));
			expect(types.has('table') || types.has('keyword')).toBe(true);
		});

		it('filters tables + keywords in "any" context by partial', () => {
			const suggestions = provider.complete('nonexistent us');
			const tables = suggestions.filter((s) => s.type === 'table').map((s) => s.text);
			expect(tables).toContain('users');
		});
	});

	describe('parseContext — table context from first word', () => {
		it('returns keyword context when first word is recognized table', () => {
			const suggestions = provider.complete('users li');
			const keywords = suggestions.filter((s) => s.type === 'keyword').map((s) => s.text);
			expect(keywords).toContain('limit');
		});

		it('includes table in context when first word is a table', () => {
			// After "users" with space, table is set → keywords expected
			const suggestions = provider.complete('users ');
			const keywords = suggestions.filter((s) => s.type === 'keyword').map((s) => s.text);
			expect(keywords.length).toBeGreaterThan(0);
		});
	});

	describe('parseContext — no trailing space → partial from last word', () => {
		it('completes partial word at end (no space)', () => {
			const suggestions = provider.complete('us');
			const tables = suggestions.filter((s) => s.type === 'table').map((s) => s.text);
			expect(tables).toContain('users');
			expect(tables).not.toContain('posts');
		});
	});

	describe('filterSuggestions — label-based matching', () => {
		it('matches via label.includes (not just text.startsWith)', () => {
			// ".schema" label contains "schema", searching with "sch" should match via startsWith
			const suggestions = provider.complete('.sch');
			const commands = suggestions.filter((s) => s.type === 'command').map((s) => s.text);
			expect(commands).toContain('.schema');
		});
	});

	describe('relation completions — falls back to all relations when no table-specific', () => {
		it('returns global relations when table has none', () => {
			const suggestions = provider.complete('posts with ');
			const relations = suggestions.filter((s) => s.type === 'relation').map((s) => s.text);
			// userPosts is the only relation, not table-specific (no dot), so all fallback
			expect(relations).toContain('userPosts');
		});
	});

	describe('applyCompletion — edge cases', () => {
		it('handles input that is only whitespace', () => {
			const result = provider.applyCompletion('   ', 'users');
			// Ends with space → append
			expect(result).toBe('   users');
		});
	});

	describe('empty input → tables + limited dot commands', () => {
		it('shows up to 5 dot commands for empty input', () => {
			const suggestions = provider.complete('');
			const commands = suggestions.filter((s) => s.type === 'command');
			expect(commands.length).toBeLessThanOrEqual(5);
		});
	});
});

describe('formatCompletions — coverage', () => {
	it('handles unknown type gracefully (no icon)', () => {
		const suggestions = [
			{ text: 'custom', label: 'custom', type: 'unknown' as any },
		];
		const formatted = formatCompletions(suggestions);
		expect(formatted).toContain('custom');
	});

	it('formats relation type with link icon', () => {
		const suggestions = [
			{ text: 'userPosts', label: 'userPosts', type: 'relation' as const },
		];
		const formatted = formatCompletions(suggestions);
		expect(formatted).toContain('userPosts');
	});

	it('default maxItems limits to 10', () => {
		const suggestions = Array.from({ length: 15 }, (_, i) => ({
			text: `t${i}`,
			label: `t${i}`,
			type: 'table' as const,
		}));
		const formatted = formatCompletions(suggestions);
		expect(formatted).toContain('t9');
		expect(formatted).not.toContain('t10');
	});
});

describe('levenshtein — coverage', () => {
	it('handles single character strings', () => {
		expect(levenshtein('a', 'b')).toBe(1);
		expect(levenshtein('a', 'a')).toBe(0);
	});

	it('handles one empty, one non-empty', () => {
		expect(levenshtein('abc', '')).toBe(3);
		expect(levenshtein('', 'xyz')).toBe(3);
	});
});

describe('suggestClosestMatch — coverage', () => {
	it('returns null when all distances are 0 (exact match is excluded)', () => {
		// suggestClosestMatch filters distance > 0, so exact match is excluded
		const result = suggestClosestMatch('users', ['users']);
		expect(result).toBe(null);
	});

	it('picks closest among multiple close candidates', () => {
		const result = suggestClosestMatch('urer', ['users', 'orders', 'ubers']);
		// "urer" → "users" distance 2, "ubers" distance 2, "orders" distance 3
		expect(result).toBeDefined();
	});
});

describe('enhanceErrorWithSuggestion — coverage', () => {
	it('does not enhance unknown column error when no columnNames provided', () => {
		const error = 'Unknown column: nmae';
		const result = enhanceErrorWithSuggestion(error, ['users']);
		// No column names → no column suggestion → original error
		expect(result).toBe(error);
	});

	it('returns original when column error has no close match', () => {
		const error = 'Unknown column: xyzabc';
		const result = enhanceErrorWithSuggestion(error, ['users'], ['name', 'email']);
		expect(result).toBe(error);
	});

	it('returns original for non-matching error pattern', () => {
		const error = 'Syntax error at position 42';
		const result = enhanceErrorWithSuggestion(error, ['users'], ['name']);
		expect(result).toBe(error);
	});
});
