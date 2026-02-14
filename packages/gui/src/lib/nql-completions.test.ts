import { beforeEach, describe, expect, it } from 'vitest';
import { useSchemaStore } from '@/stores/schema-store';
import { createNqlCompletionProvider } from './nql-completions.js';

// Minimal mock for Monaco editor model and position
function createMockModel(lineContent: string) {
	return {
		getLineContent: () => lineContent,
		getWordUntilPosition: () => ({
			word: '',
			startColumn: lineContent.length + 1,
			endColumn: lineContent.length + 1,
		}),
	} as unknown as Parameters<
		ReturnType<typeof createNqlCompletionProvider>['provideCompletionItems']
	>[0];
}

function createMockPosition(lineNumber: number, column: number) {
	return { lineNumber, column } as Parameters<
		ReturnType<typeof createNqlCompletionProvider>['provideCompletionItems']
	>[1];
}

describe('createNqlCompletionProvider', () => {
	beforeEach(() => {
		useSchemaStore.setState({ schema: null });
	});

	it('returns a completion provider with trigger characters', () => {
		const provider = createNqlCompletionProvider();
		expect(provider.triggerCharacters).toContain('|');
		expect(provider.triggerCharacters).toContain('.');
		expect(provider.triggerCharacters).toContain(' ');
	});

	describe('pipe stage completions', () => {
		it('suggests pipe stages after |', () => {
			const provider = createNqlCompletionProvider();
			const model = createMockModel('users | ');
			const position = createMockPosition(1, 9);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);

			const suggestions = (result as { suggestions: Array<{ label: string }> })
				.suggestions;
			const labels = suggestions.map((s) => s.label);
			expect(labels).toContain('where');
			expect(labels).toContain('select');
			expect(labels).toContain('limit');
			expect(labels).toContain('offset');
			expect(labels).toContain('order by');
			expect(labels).toContain('group by');
			expect(labels).toContain('having');
			expect(labels).toContain('include');
			expect(labels).toContain('distinct');
			expect(labels).toContain('join');
		});

		it('returns only pipe stages (no keywords) after pipe', () => {
			const provider = createNqlCompletionProvider();
			const model = createMockModel('users | ');
			const position = createMockPosition(1, 9);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);
			const suggestions = (result as { suggestions: Array<{ kind: number }> })
				.suggestions;
			// All should be keyword kind (14)
			for (const s of suggestions) {
				expect(s.kind).toBe(14);
			}
		});
	});

	describe('dot column completions', () => {
		it('suggests columns after table dot', () => {
			useSchemaStore.setState({
				schema: {
					tables: [
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									originalDbType: 'int4',
								},
								{
									name: 'email',
									type: 'string',
									nullable: false,
									originalDbType: 'varchar',
								},
							],
							primaryKey: ['id'],
							foreignKeys: [],
							indexes: [],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: new Date().toISOString(),
				},
			});

			const provider = createNqlCompletionProvider();
			const model = createMockModel('users.');
			const position = createMockPosition(1, 7);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);
			const suggestions = (result as { suggestions: Array<{ label: string }> })
				.suggestions;
			const labels = suggestions.map((s) => s.label);
			expect(labels).toContain('id');
			expect(labels).toContain('email');
		});

		it('returns empty for unknown table after dot', () => {
			useSchemaStore.setState({
				schema: {
					tables: [
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									originalDbType: 'int4',
								},
							],
							primaryKey: ['id'],
							foreignKeys: [],
							indexes: [],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: new Date().toISOString(),
				},
			});

			const provider = createNqlCompletionProvider();
			const model = createMockModel('unknown.');
			const position = createMockPosition(1, 9);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);
			const suggestions = (result as { suggestions: Array<{ label: string }> })
				.suggestions;
			// Should fall through to default keywords + tables
			expect(suggestions.length).toBeGreaterThan(0);
			expect(suggestions.some((s) => s.label === 'users')).toBe(true);
		});
	});

	describe('default completions (keywords + tables)', () => {
		it('suggests NQL keywords when no context', () => {
			const provider = createNqlCompletionProvider();
			const model = createMockModel('');
			const position = createMockPosition(1, 1);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);
			const suggestions = (result as { suggestions: Array<{ label: string }> })
				.suggestions;
			const labels = suggestions.map((s) => s.label);
			expect(labels).toContain('select');
			expect(labels).toContain('where');
			expect(labels).toContain('insert');
			expect(labels).toContain('update');
			expect(labels).toContain('delete');
			expect(labels).toContain('upsert');
			expect(labels).toContain('bind');
		});

		it('includes table names when schema loaded', () => {
			useSchemaStore.setState({
				schema: {
					tables: [
						{
							name: 'orders',
							columns: [],
							primaryKey: [],
							foreignKeys: [],
							indexes: [],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: new Date().toISOString(),
				},
			});

			const provider = createNqlCompletionProvider();
			const model = createMockModel('');
			const position = createMockPosition(1, 1);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);
			const suggestions = (
				result as { suggestions: Array<{ label: string; kind: number }> }
			).suggestions;
			const tableSuggestion = suggestions.find((s) => s.label === 'orders');
			expect(tableSuggestion).toBeDefined();
			expect(tableSuggestion!.kind).toBe(7); // Class kind for tables
		});

		it('shows column count in table detail', () => {
			useSchemaStore.setState({
				schema: {
					tables: [
						{
							name: 'products',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									originalDbType: 'int4',
								},
								{
									name: 'name',
									type: 'string',
									nullable: false,
									originalDbType: 'text',
								},
								{
									name: 'price',
									type: 'number',
									nullable: false,
									originalDbType: 'numeric',
								},
							],
							primaryKey: ['id'],
							foreignKeys: [],
							indexes: [],
						},
					],
					relations: [],
					hierarchies: [],
					warnings: [],
					introspectedAt: new Date().toISOString(),
				},
			});

			const provider = createNqlCompletionProvider();
			const model = createMockModel('');
			const position = createMockPosition(1, 1);

			const result = provider.provideCompletionItems(
				model,
				position,
				{} as never,
				{} as never,
			);
			const suggestions = (
				result as { suggestions: Array<{ label: string; detail?: string }> }
			).suggestions;
			const tableSuggestion = suggestions.find((s) => s.label === 'products');
			expect(tableSuggestion!.detail).toBe('3 columns');
		});
	});
});
