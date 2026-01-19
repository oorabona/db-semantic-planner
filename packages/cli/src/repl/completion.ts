/**
 * DX-030 Block 6: Autocompletion
 *
 * Provides context-aware autocompletion suggestions for the REPL.
 */

import type { ResolvedSchema } from '@dbsp/core';

/**
 * Completion suggestion
 */
export interface CompletionSuggestion {
	/** Text to insert */
	text: string;
	/** Display label (may differ from text) */
	label: string;
	/** Type of completion (table, column, keyword, command) */
	type: 'table' | 'column' | 'keyword' | 'command' | 'relation';
	/** Optional description */
	description?: string;
}

/**
 * Dot commands for completion
 */
const DOT_COMMANDS: CompletionSuggestion[] = [
	{ text: '.help', label: '.help', type: 'command', description: 'Show help' },
	{
		text: '.tables',
		label: '.tables',
		type: 'command',
		description: 'List tables',
	},
	{
		text: '.schema',
		label: '.schema',
		type: 'command',
		description: 'Show schema',
	},
	{
		text: '.relations',
		label: '.relations',
		type: 'command',
		description: 'List relations',
	},
	{
		text: '.history',
		label: '.history',
		type: 'command',
		description: 'Show history',
	},
	{
		text: '.sql',
		label: '.sql',
		type: 'command',
		description: 'Switch to SQL mode',
	},
	{
		text: '.natural',
		label: '.natural',
		type: 'command',
		description: 'Switch to natural mode',
	},
	{
		text: '.split',
		label: '.split',
		type: 'command',
		description: 'Toggle split view',
	},
	{
		text: '.clear',
		label: '.clear',
		type: 'command',
		description: 'Clear screen',
	},
	{
		text: '.exit',
		label: '.exit',
		type: 'command',
		description: 'Exit REPL',
	},
	{
		text: '.quit',
		label: '.quit',
		type: 'command',
		description: 'Exit REPL (alias)',
	},
	{
		text: '.aliasing',
		label: '.aliasing',
		type: 'command',
		description: 'Toggle column aliasing mode',
	},
	{
		text: '.strategy',
		label: '.strategy',
		type: 'command',
		description: 'Show/set include strategy',
	},
	{
		text: '.dialect',
		label: '.dialect',
		type: 'command',
		description: 'Show/set SQL dialect',
	},
];

/**
 * Natural query keywords for completion
 */
const KEYWORDS: CompletionSuggestion[] = [
	{
		text: 'where',
		label: 'where',
		type: 'keyword',
		description: 'Filter results',
	},
	{
		text: 'include',
		label: 'include',
		type: 'keyword',
		description: 'Include related data',
	},
	{ text: 'limit', label: 'limit', type: 'keyword', description: 'Limit rows' },
	{
		text: 'offset',
		label: 'offset',
		type: 'keyword',
		description: 'Skip rows',
	},
	{
		text: 'order by',
		label: 'order by',
		type: 'keyword',
		description: 'Sort results',
	},
	{
		text: 'asc',
		label: 'asc',
		type: 'keyword',
		description: 'Ascending order',
	},
	{
		text: 'desc',
		label: 'desc',
		type: 'keyword',
		description: 'Descending order',
	},
	{ text: 'and', label: 'and', type: 'keyword', description: 'Logical AND' },
	{ text: 'or', label: 'or', type: 'keyword', description: 'Logical OR' },
	{
		text: 'true',
		label: 'true',
		type: 'keyword',
		description: 'Boolean true',
	},
	{
		text: 'false',
		label: 'false',
		type: 'keyword',
		description: 'Boolean false',
	},
	{ text: 'null', label: 'null', type: 'keyword', description: 'Null value' },
	// Range operators (PostgreSQL)
	{
		text: 'overlaps',
		label: 'overlaps',
		type: 'keyword',
		description: 'Range overlap operator (&&)',
	},
	{
		text: 'contains',
		label: 'contains',
		type: 'keyword',
		description: 'Range contains element (@>)',
	},
	{
		text: 'containedBy',
		label: 'containedBy',
		type: 'keyword',
		description: 'Range within another (<@)',
	},
	// String operators
	{
		text: 'like',
		label: 'like',
		type: 'keyword',
		description: 'Pattern matching (LIKE)',
	},
	// Set operators
	{
		text: 'in',
		label: 'in',
		type: 'keyword',
		description: 'Value in set (IN)',
	},
];

/**
 * Completion provider for the REPL
 */
export class CompletionProvider {
	private tables: CompletionSuggestion[] = [];
	private columns: Map<string, CompletionSuggestion[]> = new Map();
	private relations: CompletionSuggestion[] = [];
	// Relations per table - key is table name, value is relations for that table
	private tableRelations: Map<string, CompletionSuggestion[]> = new Map();

	constructor(schema: ResolvedSchema) {
		this.initializeFromSchema(schema);
	}

	/**
	 * Initialize completions from schema
	 */
	private initializeFromSchema(schema: ResolvedSchema): void {
		// Build table completions
		for (const tableName of Object.keys(schema.tables)) {
			this.tables.push({
				text: tableName,
				label: tableName,
				type: 'table',
				description: 'Table',
			});

			// Build column completions for this table
			const table = schema.tables[tableName];
			if (table) {
				const tableColumns: CompletionSuggestion[] = [];
				for (const [colName, colDef] of Object.entries(table)) {
					if (colDef) {
						tableColumns.push({
							text: colName,
							label: colName,
							type: 'column',
							description: colDef.type,
						});
					}
				}
				this.columns.set(tableName, tableColumns);
			}
		}

		// Build relation completions
		for (const relName of Object.keys(schema.relations)) {
			this.relations.push({
				text: relName,
				label: relName,
				type: 'relation',
				description: 'Relation',
			});

			// Also build per-table relations for context-aware completion
			// Relations are keyed as "table.relationName" (qualified format)
			if (relName.includes('.')) {
				const [tableName, ...relParts] = relName.split('.');
				// tableName is guaranteed to exist because relName.includes('.')
				if (!tableName) continue;
				const simpleRelName = relParts.join('.');
				if (!this.tableRelations.has(tableName)) {
					this.tableRelations.set(tableName, []);
				}
				this.tableRelations.get(tableName)?.push({
					text: simpleRelName,
					label: simpleRelName,
					type: 'relation',
					description: `Relation from ${tableName}`,
				});
			}
		}
	}

	/**
	 * Get completions for the given input
	 */
	complete(input: string): CompletionSuggestion[] {
		const trimmed = input.trim();

		// Empty input - suggest tables or dot commands
		if (!trimmed) {
			return [...this.tables, ...DOT_COMMANDS.slice(0, 5)];
		}

		// Dot commands
		if (trimmed.startsWith('.')) {
			return this.filterSuggestions(DOT_COMMANDS, trimmed);
		}

		// Parse context from input (use original to preserve trailing space)
		const context = this.parseContext(input);

		switch (context.expecting) {
			case 'table':
				return this.filterSuggestions(this.tables, context.partial);

			case 'keyword':
				return this.filterSuggestions(KEYWORDS, context.partial);

			case 'column': {
				const tableCols = this.columns.get(context.table ?? '') ?? [];
				return this.filterSuggestions(
					[...tableCols, ...KEYWORDS],
					context.partial,
				);
			}

			case 'relation': {
				// Use table-specific relations if table is known
				const tableRels = context.table
					? (this.tableRelations.get(context.table) ?? [])
					: [];
				// Fall back to all relations if no table-specific ones found
				const relSuggestions =
					tableRels.length > 0 ? tableRels : this.relations;
				return this.filterSuggestions(relSuggestions, context.partial);
			}

			case 'value':
				// For values, only suggest boolean/null keywords
				return this.filterSuggestions(
					KEYWORDS.filter((k) => ['true', 'false', 'null'].includes(k.text)),
					context.partial,
				);

			default:
				return this.filterSuggestions(
					[...this.tables, ...KEYWORDS],
					context.partial,
				);
		}
	}

	/**
	 * Parse input to determine completion context
	 */
	private parseContext(input: string): CompletionContext {
		// Handle trailing space - user wants completions for NEXT word
		const endsWithSpace = input.endsWith(' ');
		const words = input
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 0);

		// No words - expect table
		if (words.length === 0) {
			return { expecting: 'table', partial: '' };
		}

		// If ends with space, we're looking for next word (partial is empty)
		// Otherwise, we're completing the last word
		const partial = endsWithSpace ? '' : (words[words.length - 1] ?? '');
		const contextWords = endsWithSpace ? words : words.slice(0, -1);
		const lastContextWord = contextWords[contextWords.length - 1];

		// After 'include' - expect relation (with table context)
		if (lastContextWord === 'include') {
			const table = this.findTableInInput(words);
			return { expecting: 'relation', partial, table };
		}

		// After 'where' - expect column
		if (lastContextWord === 'where') {
			const table = this.findTableInInput(words);
			return { expecting: 'column', partial, table };
		}

		// After 'and' or 'or' - expect column
		if (lastContextWord === 'and' || lastContextWord === 'or') {
			const table = this.findTableInInput(words);
			return { expecting: 'column', partial, table };
		}

		// After operator (=, !=, >, <, etc.) - expect value
		if (lastContextWord && /^[=!<>]+$/.test(lastContextWord)) {
			return { expecting: 'value', partial };
		}

		// First word position (no context words) - expect table
		if (contextWords.length === 0) {
			return { expecting: 'table', partial };
		}

		// After table name - expect keyword
		const firstWordIsTable = this.tables.some(
			(t) => t.text.toLowerCase() === contextWords[0],
		);
		if (firstWordIsTable) {
			return {
				expecting: 'keyword',
				partial,
				table: contextWords[0],
			};
		}

		return { expecting: 'any', partial };
	}

	/**
	 * Find table name in the input words
	 */
	private findTableInInput(words: string[]): string | undefined {
		for (const word of words) {
			if (this.tables.some((t) => t.text.toLowerCase() === word)) {
				return word;
			}
		}
		return undefined;
	}

	/**
	 * Filter suggestions by prefix
	 */
	private filterSuggestions(
		suggestions: CompletionSuggestion[],
		prefix: string,
	): CompletionSuggestion[] {
		if (!prefix) return suggestions;

		const lower = prefix.toLowerCase();
		return suggestions.filter(
			(s) =>
				s.text.toLowerCase().startsWith(lower) ||
				s.label.toLowerCase().includes(lower),
		);
	}

	/**
	 * Get table names for direct access
	 */
	getTableNames(): string[] {
		return this.tables.map((t) => t.text);
	}

	/**
	 * Get column names for a table
	 */
	getColumnNames(tableName: string): string[] {
		return (this.columns.get(tableName) ?? []).map((c) => c.text);
	}

	/**
	 * Get relation names
	 */
	getRelationNames(): string[] {
		return this.relations.map((r) => r.text);
	}

	/**
	 * Apply a completion to the current input.
	 * Returns the new input text with the partial word replaced by the completion.
	 *
	 * @param input - Current input text
	 * @param completionText - The completion text to insert
	 * @returns New input text with completion applied
	 */
	applyCompletion(input: string, completionText: string): string {
		const endsWithSpace = input.endsWith(' ');

		// If input ends with space, just append the completion
		if (endsWithSpace) {
			return input + completionText;
		}

		// Otherwise, find and replace the partial word
		const words = input.split(/\s+/);
		if (words.length === 0) {
			return completionText;
		}

		// Replace the last word (partial) with the completion
		words[words.length - 1] = completionText;
		return words.join(' ');
	}
}

/**
 * Context for completion
 */
interface CompletionContext {
	expecting: 'table' | 'column' | 'keyword' | 'relation' | 'value' | 'any';
	partial: string;
	table?: string | undefined;
}

/**
 * Format completions for display
 */
export function formatCompletions(
	suggestions: CompletionSuggestion[],
	maxItems = 10,
): string {
	if (suggestions.length === 0) return '';

	const items = suggestions.slice(0, maxItems);
	const typeColors: Record<string, string> = {
		table: '🗃️',
		column: '📋',
		keyword: '🔑',
		command: '⚡',
		relation: '🔗',
	};

	return items.map((s) => `${typeColors[s.type] ?? ''} ${s.label}`).join('  ');
}
