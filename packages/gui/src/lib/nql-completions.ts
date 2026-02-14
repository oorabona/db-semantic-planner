/**
 * Monaco completion provider for NQL using schema store data.
 * Provides keyword, table, column, and pipe-stage completions.
 */
import type { editor, IRange, languages, Position } from 'monaco-editor';
import { useSchemaStore } from '@/stores/schema-store';

// NQL pipe stages (after |)
const PIPE_STAGES = [
	{ label: 'where', detail: 'Filter rows' },
	{ label: 'select', detail: 'Choose columns' },
	{ label: 'limit', detail: 'Limit result count' },
	{ label: 'offset', detail: 'Skip rows' },
	{ label: 'order by', detail: 'Sort results' },
	{ label: 'group by', detail: 'Group rows' },
	{ label: 'having', detail: 'Filter groups' },
	{ label: 'include', detail: 'Include related data' },
	{ label: 'distinct', detail: 'Remove duplicates' },
	{ label: 'join', detail: 'Join related table' },
];

const NQL_KEYWORDS = [
	'where',
	'select',
	'limit',
	'offset',
	'order',
	'by',
	'group',
	'having',
	'include',
	'distinct',
	'join',
	'and',
	'or',
	'not',
	'in',
	'between',
	'like',
	'ilike',
	'is',
	'null',
	'true',
	'false',
	'asc',
	'desc',
	'as',
	'case',
	'when',
	'then',
	'else',
	'end',
	'insert',
	'into',
	'values',
	'set',
	'update',
	'delete',
	'upsert',
	'bind',
	'returning',
	'with',
	'strategy',
	'flat',
	'exists',
	'count',
	'sum',
	'avg',
	'min',
	'max',
];

function getWordRange(model: editor.ITextModel, position: Position): IRange {
	const word = model.getWordUntilPosition(position);
	return {
		startLineNumber: position.lineNumber,
		endLineNumber: position.lineNumber,
		startColumn: word.startColumn,
		endColumn: word.endColumn,
	};
}

export function createNqlCompletionProvider(): languages.CompletionItemProvider {
	return {
		triggerCharacters: ['|', '.', ' '],

		provideCompletionItems(model, position) {
			const range = getWordRange(model, position);
			const suggestions: languages.CompletionItem[] = [];
			const lineContent = model.getLineContent(position.lineNumber);
			const textBefore = lineContent.substring(0, position.column - 1);

			const { schema } = useSchemaStore.getState();

			// After pipe: suggest stages
			if (/\|\s*$/.test(textBefore)) {
				for (const stage of PIPE_STAGES) {
					suggestions.push({
						label: stage.label,
						kind: 14, // Keyword
						detail: stage.detail,
						insertText: stage.label,
						range,
					});
				}
				return { suggestions };
			}

			// After dot: column completion
			const dotMatch = textBefore.match(/(\w+)\.\s*$/);
			if (dotMatch && schema) {
				const tableName = dotMatch[1] ?? '';
				const table = schema.tables.find(
					(t) => t.name.toLowerCase() === tableName.toLowerCase(),
				);
				if (table) {
					for (const col of table.columns) {
						suggestions.push({
							label: col.name,
							kind: 5, // Field
							detail: col.originalDbType ?? col.type,
							insertText: col.name,
							range,
						});
					}
					return { suggestions };
				}
			}

			// Default: keywords + tables
			for (const kw of NQL_KEYWORDS) {
				suggestions.push({
					label: kw,
					kind: 14, // Keyword
					insertText: kw,
					range,
				});
			}

			if (schema) {
				for (const table of schema.tables) {
					suggestions.push({
						label: table.name,
						kind: 7, // Class
						detail: `${table.columns.length} columns`,
						insertText: table.name,
						range,
					});
				}
			}

			return { suggestions };
		},
	};
}
