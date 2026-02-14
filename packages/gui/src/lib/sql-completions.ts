/**
 * Monaco completion provider for SQL using schema store data.
 */
import type { editor, IRange, languages, Position } from 'monaco-editor';
import { useSchemaStore } from '@/stores/schema-store';

// PostgreSQL keywords for basic completions
const SQL_KEYWORDS = [
	'SELECT',
	'FROM',
	'WHERE',
	'INSERT',
	'INTO',
	'VALUES',
	'UPDATE',
	'SET',
	'DELETE',
	'JOIN',
	'LEFT',
	'RIGHT',
	'INNER',
	'OUTER',
	'CROSS',
	'ON',
	'AND',
	'OR',
	'NOT',
	'IN',
	'EXISTS',
	'BETWEEN',
	'LIKE',
	'ILIKE',
	'IS',
	'NULL',
	'AS',
	'ORDER',
	'BY',
	'GROUP',
	'HAVING',
	'LIMIT',
	'OFFSET',
	'DISTINCT',
	'UNION',
	'ALL',
	'INTERSECT',
	'EXCEPT',
	'CREATE',
	'ALTER',
	'DROP',
	'TABLE',
	'INDEX',
	'VIEW',
	'SCHEMA',
	'PRIMARY',
	'KEY',
	'FOREIGN',
	'REFERENCES',
	'UNIQUE',
	'CHECK',
	'DEFAULT',
	'CASCADE',
	'RESTRICT',
	'RETURNING',
	'WITH',
	'RECURSIVE',
	'CASE',
	'WHEN',
	'THEN',
	'ELSE',
	'END',
	'COALESCE',
	'NULLIF',
	'CAST',
	'TRUE',
	'FALSE',
	'ASC',
	'DESC',
	'FETCH',
	'FIRST',
	'LAST',
	'COUNT',
	'SUM',
	'AVG',
	'MIN',
	'MAX',
	'ARRAY_AGG',
	'STRING_AGG',
	'ROW_NUMBER',
	'RANK',
	'DENSE_RANK',
	'OVER',
	'PARTITION',
	'WINDOW',
	'LATERAL',
	'UNNEST',
	'GENERATE_SERIES',
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

export function createSqlCompletionProvider(): languages.CompletionItemProvider {
	return {
		triggerCharacters: ['.', ' '],

		provideCompletionItems(model, position) {
			const range = getWordRange(model, position);
			const suggestions: languages.CompletionItem[] = [];

			// Check if we're after a "." (column completion)
			const lineContent = model.getLineContent(position.lineNumber);
			const textBefore = lineContent.substring(0, position.column - 1);
			const dotMatch = textBefore.match(/(\w+)\.\s*$/);

			const { schema } = useSchemaStore.getState();

			if (dotMatch && schema) {
				// Table.column completion
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
				}
			} else {
				// Keyword completions
				for (const kw of SQL_KEYWORDS) {
					suggestions.push({
						label: kw,
						kind: 14, // Keyword
						insertText: kw,
						range,
					});
				}

				// Table completions from schema
				if (schema) {
					for (const table of schema.tables) {
						suggestions.push({
							label: table.name,
							kind: 1, // Text → we'll use Class for tables
							detail: `${table.columns.length} columns`,
							insertText: table.name,
							range,
						});
					}
				}
			}

			return { suggestions };
		},
	};
}
