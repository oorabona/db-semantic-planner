/**
 * Tests for SQL completion provider
 */

import type {
	CancellationToken,
	editor,
	IRange,
	languages,
	Position,
} from 'monaco-editor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSchemaStore } from '@/stores/schema-store';
import { createSqlCompletionProvider } from './sql-completions';

// Mock the schema store
vi.mock('@/stores/schema-store', () => ({
	useSchemaStore: {
		getState: vi.fn(),
	},
}));

describe('createSqlCompletionProvider', () => {
	let provider: languages.CompletionItemProvider;
	let mockModel: editor.ITextModel;
	let mockPosition: Position;

	beforeEach(() => {
		provider = createSqlCompletionProvider();

		// Reset mocks
		vi.clearAllMocks();

		// Default mock model
		mockModel = {
			getWordUntilPosition: vi.fn().mockReturnValue({
				word: '',
				startColumn: 1,
				endColumn: 1,
			}),
			getLineContent: vi.fn().mockReturnValue(''),
			getValueInRange: vi.fn().mockReturnValue(''),
		} as unknown as editor.ITextModel;

		mockPosition = {
			lineNumber: 1,
			column: 1,
		} as Position;

		// Default empty schema
		vi.mocked(useSchemaStore.getState).mockReturnValue({
			schema: null,
		} as any);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('provider structure', () => {
		it('should return a completion provider with required methods', () => {
			expect(provider).toBeDefined();
			expect(provider.provideCompletionItems).toBeDefined();
			expect(typeof provider.provideCompletionItems).toBe('function');
		});

		it('should define trigger characters', () => {
			expect(provider.triggerCharacters).toBeDefined();
			expect(provider.triggerCharacters).toEqual(['.', ' ']);
		});
	});

	describe('SQL keyword completions', () => {
		it('should suggest SQL keywords when no schema context', () => {
			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			expect(result).toBeDefined();
			const suggestions = (result as languages.CompletionList).suggestions;
			expect(suggestions).toBeDefined();
			expect(suggestions.length).toBeGreaterThan(0);

			// Check for essential keywords
			const keywords = suggestions.filter((s) => s.kind === 14); // Keyword kind
			const labels = keywords.map((k) => k.label);

			expect(labels).toContain('SELECT');
			expect(labels).toContain('FROM');
			expect(labels).toContain('WHERE');
			expect(labels).toContain('JOIN');
			expect(labels).toContain('INSERT');
			expect(labels).toContain('UPDATE');
			expect(labels).toContain('DELETE');
		});

		it('should provide keywords with correct structure', () => {
			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const selectKeyword = suggestions.find((s) => s.label === 'SELECT');

			expect(selectKeyword).toBeDefined();
			expect(selectKeyword!.kind).toBe(14); // Keyword
			expect(selectKeyword!.insertText).toBe('SELECT');
			expect(selectKeyword!.range).toBeDefined();
		});

		it('should include DDL keywords', () => {
			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const keywords = suggestions.filter((s) => s.kind === 14);
			const labels = keywords.map((k) => k.label);

			expect(labels).toContain('CREATE');
			expect(labels).toContain('ALTER');
			expect(labels).toContain('DROP');
			expect(labels).toContain('TABLE');
			expect(labels).toContain('INDEX');
		});

		it('should include aggregate functions', () => {
			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const keywords = suggestions.filter((s) => s.kind === 14);
			const labels = keywords.map((k) => k.label);

			expect(labels).toContain('COUNT');
			expect(labels).toContain('SUM');
			expect(labels).toContain('AVG');
			expect(labels).toContain('MIN');
			expect(labels).toContain('MAX');
		});

		it('should include window function keywords', () => {
			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const keywords = suggestions.filter((s) => s.kind === 14);
			const labels = keywords.map((k) => k.label);

			expect(labels).toContain('ROW_NUMBER');
			expect(labels).toContain('RANK');
			expect(labels).toContain('OVER');
			expect(labels).toContain('PARTITION');
		});
	});

	describe('table name completions', () => {
		it('should suggest table names from schema', () => {
			vi.mocked(useSchemaStore.getState).mockReturnValue({
				schema: {
					tables: [
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'uuid',
									nullable: false,
									originalDbType: 'uuid',
								},
								{
									name: 'name',
									type: 'string',
									nullable: false,
									originalDbType: 'text',
								},
							],
						},
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'uuid',
									nullable: false,
									originalDbType: 'uuid',
								},
								{
									name: 'title',
									type: 'string',
									nullable: false,
									originalDbType: 'text',
								},
							],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: '2026-01-01T00:00:00Z',
				},
			} as any);

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const tables = suggestions.filter((s) => s.kind === 1); // Text/Class kind

			expect(tables.length).toBe(2);
			expect(tables.map((t) => t.label)).toContain('users');
			expect(tables.map((t) => t.label)).toContain('posts');
		});

		it('should provide table suggestions with column count detail', () => {
			vi.mocked(useSchemaStore.getState).mockReturnValue({
				schema: {
					tables: [
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'uuid',
									nullable: false,
									originalDbType: 'uuid',
								},
								{
									name: 'name',
									type: 'string',
									nullable: false,
									originalDbType: 'text',
								},
								{
									name: 'email',
									type: 'string',
									nullable: false,
									originalDbType: 'text',
								},
							],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: '2026-01-01T00:00:00Z',
				},
			} as any);

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const usersTable = suggestions.find((s) => s.label === 'users');

			expect(usersTable).toBeDefined();
			expect(usersTable!.detail).toBe('3 columns');
			expect(usersTable!.insertText).toBe('users');
		});

		it('should handle empty schema gracefully', () => {
			vi.mocked(useSchemaStore.getState).mockReturnValue({
				schema: {
					tables: [],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: '2026-01-01T00:00:00Z',
				},
			} as any);

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			// Should still have keywords
			expect(suggestions.length).toBeGreaterThan(0);
			// But no table suggestions
			const tables = suggestions.filter((s) => s.kind === 1);
			expect(tables.length).toBe(0);
		});
	});

	describe('column completions (after dot)', () => {
		beforeEach(() => {
			vi.mocked(useSchemaStore.getState).mockReturnValue({
				schema: {
					tables: [
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'uuid',
									nullable: false,
									originalDbType: 'uuid',
								},
								{
									name: 'name',
									type: 'string',
									nullable: false,
									originalDbType: 'text',
								},
								{
									name: 'email',
									type: 'string',
									nullable: true,
									originalDbType: 'varchar',
								},
							],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: '2026-01-01T00:00:00Z',
				},
			} as any);
		});

		it('should suggest columns when typing after table name and dot', () => {
			mockModel.getLineContent = vi.fn().mockReturnValue('SELECT users.');
			mockPosition = { lineNumber: 1, column: 14 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const columns = suggestions.filter((s) => s.kind === 5); // Field kind

			expect(columns.length).toBe(3);
			expect(columns.map((c) => c.label)).toContain('id');
			expect(columns.map((c) => c.label)).toContain('name');
			expect(columns.map((c) => c.label)).toContain('email');
		});

		it('should provide column detail with original DB type', () => {
			mockModel.getLineContent = vi.fn().mockReturnValue('SELECT users.');
			mockPosition = { lineNumber: 1, column: 14 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const idColumn = suggestions.find((s) => s.label === 'id');

			expect(idColumn).toBeDefined();
			expect(idColumn!.kind).toBe(5); // Field
			expect(idColumn!.detail).toBe('uuid');
			expect(idColumn!.insertText).toBe('id');
		});

		it('should fallback to type if originalDbType is missing', () => {
			vi.mocked(useSchemaStore.getState).mockReturnValue({
				schema: {
					tables: [
						{
							name: 'products',
							columns: [
								{
									name: 'price',
									type: 'number',
									nullable: false,
									originalDbType: undefined,
								},
							],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: '2026-01-01T00:00:00Z',
				},
			} as any);

			mockModel.getLineContent = vi.fn().mockReturnValue('SELECT products.');
			mockPosition = { lineNumber: 1, column: 17 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const priceColumn = suggestions.find((s) => s.label === 'price');

			expect(priceColumn).toBeDefined();
			expect(priceColumn!.detail).toBe('number');
		});

		it('should handle case-insensitive table name matching', () => {
			mockModel.getLineContent = vi.fn().mockReturnValue('SELECT USERS.');
			mockPosition = { lineNumber: 1, column: 14 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const columns = suggestions.filter((s) => s.kind === 5);

			expect(columns.length).toBe(3);
		});

		it('should return empty suggestions for unknown table', () => {
			mockModel.getLineContent = vi.fn().mockReturnValue('SELECT nonexistent.');
			mockPosition = { lineNumber: 1, column: 20 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			expect(suggestions.length).toBe(0);
		});

		it('should handle whitespace after dot', () => {
			mockModel.getLineContent = vi.fn().mockReturnValue('SELECT users. ');
			mockPosition = { lineNumber: 1, column: 15 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			const columns = suggestions.filter((s) => s.kind === 5);

			expect(columns.length).toBe(3);
		});
	});

	describe('range calculation', () => {
		it('should compute correct range from word boundaries', () => {
			mockModel.getWordUntilPosition = vi.fn().mockReturnValue({
				word: 'SEL',
				startColumn: 1,
				endColumn: 4,
			});
			mockPosition = { lineNumber: 2, column: 4 } as Position;

			const result = provider.provideCompletionItems!(
				mockModel,
				mockPosition,
				{} as languages.CompletionContext,
				{} as CancellationToken,
			);

			const suggestions = (result as languages.CompletionList).suggestions;
			expect(suggestions.length).toBeGreaterThan(0);

			const firstSuggestion = suggestions[0];
			expect(firstSuggestion!.range).toBeDefined();
			const range = firstSuggestion!.range as IRange;

			expect(range.startLineNumber).toBe(2);
			expect(range.endLineNumber).toBe(2);
			expect(range.startColumn).toBe(1);
			expect(range.endColumn).toBe(4);
		});
	});
});
