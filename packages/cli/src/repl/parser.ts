/**
 * DX-030 Block 2: Natural Query Parser
 *
 * Parses natural language queries like:
 * - "users" → select all from users
 * - "users where active = true" → filter by condition
 * - "users include posts" → include relation
 * - "users limit 10" → limit results
 * - "users where active = true include posts limit 10"
 */

import type { ResolvedSchema } from '@dbsp/core';
import type {
	Assignment,
	MutationType,
	MutationValue,
	OnConflictClause,
	ParsedMutation,
} from './types.js';

// Re-export mutation types for convenience
export type {
	MutationType,
	MutationValue,
	Assignment,
	OnConflictClause,
	ParsedMutation,
};

// =============================================================================
// CLI-MUT: Mutation Constants and Helpers
// =============================================================================

/**
 * CLI-MUT: Mutation keywords
 */
export const MUTATION_KEYWORDS = [
	'insert',
	'update',
	'delete',
	'upsert',
] as const;

/**
 * CLI-MUT: Check if a token is a mutation keyword
 */
export function isMutationKeyword(token: string): token is MutationType {
	return MUTATION_KEYWORDS.includes(token.toLowerCase() as MutationType);
}

/**
 * CLI-MUT: Parse a value token into MutationValue
 * Handles: strings, numbers, booleans, null, JSON, function calls
 */
export function parseMutationValue(raw: string): MutationValue {
	const trimmed = raw.trim();

	// null
	if (trimmed.toLowerCase() === 'null') {
		return { type: 'null', raw, value: null };
	}

	// boolean
	if (trimmed.toLowerCase() === 'true') {
		return { type: 'boolean', raw, value: true };
	}
	if (trimmed.toLowerCase() === 'false') {
		return { type: 'boolean', raw, value: false };
	}

	// number (integer or float)
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		const num = trimmed.includes('.')
			? parseFloat(trimmed)
			: parseInt(trimmed, 10);
		return { type: 'number', raw, value: num };
	}

	// function call (e.g., now(), uuid_generate_v4())
	if (/^[a-z_][a-z0-9_]*\([^)]*\)$/i.test(trimmed)) {
		return { type: 'function', raw, value: trimmed };
	}

	// JSON object or array (starts with { or [)
	if (
		(trimmed.startsWith('{') || trimmed.startsWith('[')) &&
		(trimmed.endsWith('}') || trimmed.endsWith(']'))
	) {
		try {
			const parsed = JSON.parse(trimmed);
			return { type: 'json', raw, value: parsed };
		} catch {
			// Not valid JSON, treat as string
			return { type: 'string', raw, value: trimmed };
		}
	}

	// String (already unquoted by tokenizer, or raw value)
	return { type: 'string', raw, value: trimmed };
}

/**
 * CLI-MUT: Parse a single assignment (column = value)
 * Returns the assignment and the next token index
 */
export function parseAssignment(
	tokens: string[],
	startIndex: number,
): { assignment: Assignment; nextIndex: number } {
	const column = tokens[startIndex];
	if (!column) {
		throw new ParseError('Expected column name', startIndex);
	}

	// Expect '='
	const eqSign = tokens[startIndex + 1];
	if (eqSign !== '=') {
		throw new ParseError(
			`Expected "=" after column "${column}", got "${eqSign ?? 'end of input'}"`,
			startIndex + 1,
		);
	}

	// Get value
	const valueToken = tokens[startIndex + 2];
	if (valueToken === undefined) {
		throw new ParseError(`Expected value after "${column} ="`, startIndex + 2);
	}

	const value = parseMutationValue(valueToken);

	return {
		assignment: { column, value },
		nextIndex: startIndex + 3,
	};
}

/**
 * CLI-MUT: Parse multiple assignments separated by commas
 * Stops when encountering a keyword (where, on, !)
 */
export function parseAssignments(
	tokens: string[],
	startIndex: number,
): { assignments: Assignment[]; nextIndex: number } {
	const assignments: Assignment[] = [];
	let i = startIndex;

	// Keywords that end assignment parsing
	const stopKeywords = ['where', 'on', 'set', '!'];

	while (i < tokens.length) {
		const token = tokens[i]?.toLowerCase();

		// Stop on keywords
		if (token && stopKeywords.includes(token)) {
			break;
		}

		// Stop on '!' at end
		if (tokens[i] === '!') {
			break;
		}

		// Parse assignment
		const { assignment, nextIndex } = parseAssignment(tokens, i);
		assignments.push(assignment);
		i = nextIndex;

		// Check for comma (skip it) or stop keyword
		if (tokens[i] === ',') {
			i++;
		} else {
			const nextToken = tokens[i]?.toLowerCase();
			if (nextToken && stopKeywords.includes(nextToken)) {
				break;
			}
			// If next token is not a comma or stop keyword, stop
			// (allows for 'users insert name = "Alice" !' pattern)
			if (i < tokens.length && tokens[i] !== '!') {
				// Check if it looks like another column assignment
				if (tokens[i + 1] !== '=') {
					break;
				}
			}
		}
	}

	return { assignments, nextIndex: i };
}

/**
 * CLI-MUT: Validate column exists in table schema
 */
export function validateColumn(
	column: string,
	table: string,
	schema: ResolvedSchema,
): void {
	const tableSchema = schema.tables[table];
	if (!tableSchema) {
		throw new ParseError(`Unknown table: "${table}"`);
	}
	if (!(column in tableSchema)) {
		const columns = Object.keys(tableSchema);
		const suggestion = columns.find(
			(c) =>
				c.toLowerCase() === column.toLowerCase() ||
				c.toLowerCase().startsWith(column.toLowerCase()),
		);
		throw new ParseError(
			`Column "${column}" does not exist in table "${table}"${suggestion ? `. Did you mean "${suggestion}"?` : ''}`,
		);
	}
}

/**
 * CLI-MUT: Parse INSERT mutation
 * Syntax: users insert name = "Alice", email = "a@e.com" [!]
 */
export function parseInsert(
	tokens: string[],
	table: string,
	startIndex: number,
	schema: ResolvedSchema,
): ParsedMutation {
	// Skip 'insert' keyword
	let i = startIndex;

	// Parse assignments
	const { assignments, nextIndex } = parseAssignments(tokens, i);
	i = nextIndex;

	if (assignments.length === 0) {
		throw new ParseError(
			'INSERT requires at least one column assignment (e.g., name = "value")',
			i,
		);
	}

	// Validate all columns exist in table
	for (const assignment of assignments) {
		validateColumn(assignment.column, table, schema);
	}

	// Check for execute immediate flag
	const executeImmediate = tokens[i] === '!';
	if (executeImmediate) {
		i++;
	}

	return {
		type: 'insert',
		table,
		assignments,
		executeImmediate,
	};
}

/**
 * CLI-MUT: Parse UPDATE mutation
 * Syntax: users update set name = "Bob", active = false where id = 1 [!]
 */
export function parseUpdate(
	tokens: string[],
	table: string,
	startIndex: number,
	schema: ResolvedSchema,
): ParsedMutation {
	let i = startIndex;

	// Expect 'set' keyword
	const setKeyword = tokens[i]?.toLowerCase();
	if (setKeyword !== 'set') {
		throw new ParseError(
			`UPDATE requires SET keyword (e.g., users update set name = "value")`,
			i,
		);
	}
	i++;

	// Parse assignments
	const { assignments, nextIndex } = parseAssignments(tokens, i);
	i = nextIndex;

	if (assignments.length === 0) {
		throw new ParseError(
			'UPDATE SET requires at least one column assignment',
			i,
		);
	}

	// Validate all columns exist in table
	for (const assignment of assignments) {
		validateColumn(assignment.column, table, schema);
	}

	// Parse optional WHERE clause
	let where: WhereClause[] | undefined;
	const whereKeyword = tokens[i]?.toLowerCase();
	if (whereKeyword === 'where') {
		i++;
		where = [];
		while (i < tokens.length) {
			// Stop on ! or end
			if (tokens[i] === '!') break;

			const { clause, nextIndex: nextI } = parseWhereCondition(tokens, i);
			where.push(clause);
			i = nextI;

			// Check for "and" to continue
			const nextToken = tokens[i]?.toLowerCase();
			if (nextToken === 'and') {
				i++;
			} else {
				break;
			}
		}
	}

	// Check for execute immediate flag
	const executeImmediate = tokens[i] === '!';
	if (executeImmediate) {
		i++;
	}

	// Safety: require WHERE clause unless ! is used
	if (!where && !executeImmediate) {
		throw new ParseError(
			'UPDATE without WHERE clause requires ! suffix (e.g., users update set active = false !)',
		);
	}

	// Build result - use conditional property to satisfy exactOptionalPropertyTypes
	const result: ParsedMutation = {
		type: 'update',
		table,
		assignments,
		executeImmediate,
	};
	if (where !== undefined) {
		result.where = where;
	}
	return result;
}

/**
 * CLI-MUT: Parse DELETE mutation
 * Syntax: users delete where id = 1 [!]
 */
export function parseDelete(
	tokens: string[],
	table: string,
	startIndex: number,
	_schema: ResolvedSchema,
): ParsedMutation {
	let i = startIndex;

	// Parse WHERE clause (required for safety unless using !)
	let where: WhereClause[] | undefined;
	const whereKeyword = tokens[i]?.toLowerCase();

	if (whereKeyword === 'where') {
		i++;
		where = [];
		while (i < tokens.length) {
			// Stop on ! or end
			if (tokens[i] === '!') break;

			const { clause, nextIndex: nextI } = parseWhereCondition(tokens, i);
			where.push(clause);
			i = nextI;

			// Check for "and" to continue
			const nextToken = tokens[i]?.toLowerCase();
			if (nextToken === 'and') {
				i++;
			} else {
				break;
			}
		}
	} else if (tokens[i] !== '!' && tokens[i] !== undefined) {
		// Something other than WHERE or ! - error
		throw new ParseError(
			`DELETE requires WHERE clause (e.g., users delete where id = 1). Got "${tokens[i]}"`,
			i,
		);
	}

	// If no WHERE and no !, that's an error
	if (!where && tokens[i] !== '!') {
		throw new ParseError(
			'DELETE without WHERE is not allowed. Use "users delete where true !" to delete all.',
		);
	}

	// Check for execute immediate flag
	const executeImmediate = tokens[i] === '!';
	if (executeImmediate) {
		i++;
	}

	// Build result - use conditional property to satisfy exactOptionalPropertyTypes
	const result: ParsedMutation = {
		type: 'delete',
		table,
		executeImmediate,
	};
	if (where !== undefined) {
		result.where = where;
	}
	return result;
}

/**
 * CLI-MUT Block 4: Parse UPSERT mutation
 * Syntax: users upsert email = "a@e.com", name = "Alice" on email do nothing
 *         users upsert email = "a@e.com", name = "Alice" on email do update set name = excluded.name
 *         orders upsert user_id = 1, product_id = 2 on (user_id, product_id) do update set qty = excluded.qty
 */
export function parseUpsert(
	tokens: string[],
	table: string,
	startIndex: number,
	schema: ResolvedSchema,
): ParsedMutation {
	let i = startIndex;

	// Parse assignments (same as INSERT)
	const { assignments, nextIndex } = parseAssignments(tokens, i);
	i = nextIndex;

	if (assignments.length === 0) {
		throw new ParseError('UPSERT requires at least one column assignment', i);
	}

	// Validate all columns exist in table
	for (const assignment of assignments) {
		validateColumn(assignment.column, table, schema);
	}

	// Expect 'on' keyword
	const onKeyword = tokens[i]?.toLowerCase();
	if (onKeyword !== 'on') {
		throw new ParseError(
			'UPSERT requires ON conflict clause (e.g., on email do nothing)',
			i,
		);
	}
	i++;

	// Parse conflict columns - either single column or (col1, col2)
	const conflictColumns: string[] = [];
	if (tokens[i] === '(') {
		i++; // Skip opening paren
		while (i < tokens.length && tokens[i] !== ')') {
			const col = tokens[i];
			if (col && col !== ',') {
				conflictColumns.push(col);
			}
			i++;
		}
		if (tokens[i] !== ')') {
			throw new ParseError('Expected ) to close conflict columns', i);
		}
		i++; // Skip closing paren
	} else {
		// Single column
		const col = tokens[i];
		if (!col) {
			throw new ParseError('Expected conflict column after ON', i);
		}
		conflictColumns.push(col);
		i++;
	}

	// Validate conflict columns
	for (const col of conflictColumns) {
		validateColumn(col, table, schema);
	}

	// Expect 'do' keyword
	const doKeyword = tokens[i]?.toLowerCase();
	if (doKeyword !== 'do') {
		throw new ParseError(
			'UPSERT requires DO action (e.g., do nothing, do update)',
			i,
		);
	}
	i++;

	// Parse action: 'nothing' or 'update'
	const actionKeyword = tokens[i]?.toLowerCase();
	let onConflict: OnConflictClause;

	if (actionKeyword === 'nothing') {
		i++;
		onConflict = { columns: conflictColumns, action: 'nothing' };
	} else if (actionKeyword === 'update') {
		i++;
		// Expect 'set' keyword
		const setKeyword = tokens[i]?.toLowerCase();
		if (setKeyword !== 'set') {
			throw new ParseError(
				'DO UPDATE requires SET keyword (e.g., do update set name = excluded.name)',
				i,
			);
		}
		i++;

		// Parse update assignments (can reference excluded.*)
		const updateAssignments: Assignment[] = [];
		while (i < tokens.length) {
			// Stop on ! or end
			if (tokens[i] === '!') break;

			const col = tokens[i];
			if (!col) break;

			// Check for column name (might start new assignment or be continuation)
			const eqSign = tokens[i + 1];
			if (eqSign !== '=') {
				break; // Not an assignment, end of SET clause
			}

			const valueToken = tokens[i + 2];
			if (valueToken === undefined) {
				throw new ParseError(`Expected value after "${col} ="`, i + 2);
			}

			const value = parseMutationValue(valueToken);
			updateAssignments.push({ column: col, value });
			i += 3;

			// Check for comma to continue
			if (tokens[i] === ',') {
				i++;
			} else {
				break;
			}
		}

		if (updateAssignments.length === 0) {
			throw new ParseError('DO UPDATE SET requires at least one assignment', i);
		}

		onConflict = {
			columns: conflictColumns,
			action: 'update',
			updateAssignments,
		};
	} else {
		throw new ParseError(
			`Invalid DO action "${actionKeyword}". Expected: nothing, update`,
			i,
		);
	}

	// Check for execute immediate flag
	const executeImmediate = tokens[i] === '!';
	if (executeImmediate) {
		i++;
	}

	// Build result
	return {
		type: 'upsert',
		table,
		assignments,
		onConflict,
		executeImmediate,
	};
}

/**
 * CLI-MUT: Check if query is a mutation and parse accordingly
 * Returns ParsedMutation if mutation, null if SELECT query
 */
export function parseMutation(
	input: string,
	schema: ResolvedSchema,
): ParsedMutation | null {
	const tokens = tokenize(input.trim());

	if (tokens.length < 2) {
		return null;
	}

	// First token is table name
	const tableName = tokens[0];
	if (!tableName || !schema.tables[tableName]) {
		return null; // Let parseNaturalQuery handle the error
	}

	// Second token might be a mutation keyword
	const action = tokens[1]?.toLowerCase();
	if (!action || !isMutationKeyword(action)) {
		return null; // Not a mutation
	}

	// Dispatch to appropriate parser
	switch (action) {
		case 'insert':
			return parseInsert(tokens, tableName, 2, schema);
		case 'update':
			return parseUpdate(tokens, tableName, 2, schema);
		case 'delete':
			return parseDelete(tokens, tableName, 2, schema);
		case 'upsert':
			return parseUpsert(tokens, tableName, 2, schema);
		default:
			return null;
	}
}

/**
 * CLI-016: Parsed aggregate expression
 */
export interface ParsedAggregate {
	function: 'count' | 'sum' | 'avg' | 'min' | 'max';
	field?: string; // undefined for count(*)
	as?: string;
	distinct?: boolean;
}

/**
 * Parsed query result
 */
export interface ParsedQuery {
	table: string;
	where?: WhereClause[];
	/** CLI-014: Now supports per-relation filters */
	include?: ParsedInclude[];
	limit?: number;
	offset?: number;
	orderBy?: OrderByClause[];
	/** CLI-016: Aggregate expressions */
	aggregates?: ParsedAggregate[];
	/** CLI-016: GROUP BY fields */
	groupBy?: string[];
	/** CLI-016: HAVING clause */
	having?: WhereClause[];
	/** CLI-016: SELECT DISTINCT */
	distinct?: boolean;
}

export interface WhereClause {
	column: string;
	operator:
		| '='
		| '!='
		| '>'
		| '<'
		| '>='
		| '<='
		| 'like'
		| 'in'
		| 'is'
		| 'overlaps'
		| 'contains'
		| 'containedBy';
	value: unknown;
}

export interface OrderByClause {
	column: string;
	direction: 'asc' | 'desc';
}

/**
 * CLI-014: Parsed include with optional filters and nested includes
 */
export interface ParsedInclude {
	relation: string;
	where?: WhereClause[];
	/** Nested includes for deep relation loading (e.g., posts include comments include author) */
	include?: ParsedInclude[];
	/** If true, recursively fetch all ancestors or descendants via CTE */
	recursive?: boolean;
	/** Optional maximum depth for recursive includes (default: unlimited) */
	maxDepth?: number;
	/** If true, include a 'depth' column in recursive results (CLI-018) */
	includeDepth?: boolean;
}

/**
 * CLI-014: Qualified filter pending distribution
 * Stores filters with explicit table reference (e.g., "posts.title")
 * to be routed to the correct destination after parsing completes
 */
interface QualifiedFilter {
	targetTable: string;
	clause: WhereClause;
}

/**
 * Parse error with position info
 */
export class ParseError extends Error {
	constructor(
		message: string,
		public position?: number,
	) {
		super(message);
		this.name = 'ParseError';
	}
}

/**
 * Tokenize input string
 */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let inQuote = false;
	let quoteChar = '';
	let inRange = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		// Handle PostgreSQL range literals [lower, upper) or (lower, upper]
		// Only [ starts a range (not ( which is used for function calls)
		// Closing bracket can be ] or ) regardless of opening bracket
		if (inRange) {
			current += char;
			if (char === ')' || char === ']') {
				inRange = false;
				tokens.push(current);
				current = '';
			}
			continue;
		}

		if (inQuote) {
			if (char === quoteChar) {
				inQuote = false;
				tokens.push(current);
				current = '';
			} else {
				current += char;
			}
		} else if (char === '[') {
			// Start of PostgreSQL range literal (only [ starts range, not ()
			if (current) {
				tokens.push(current);
				current = '';
			}
			inRange = true;
			current = char;
		} else if (char === '"' || char === "'") {
			if (current) {
				tokens.push(current);
				current = '';
			}
			inQuote = true;
			quoteChar = char;
		} else if (char === ' ' || char === '\t') {
			if (current) {
				tokens.push(current);
				current = '';
			}
		} else if (
			char === '=' ||
			char === '>' ||
			char === '<' ||
			char === '!' ||
			char === ','
		) {
			if (current) {
				tokens.push(current);
				current = '';
			}
			// Handle multi-char operators
			const next = input[i + 1];
			if (char === '!' && next === '=') {
				tokens.push('!=');
				i++;
			} else if (char === '>' && next === '=') {
				tokens.push('>=');
				i++;
			} else if (char === '<' && next === '=') {
				tokens.push('<=');
				i++;
			} else if (char !== ',') {
				// Skip commas, they're just separators
				tokens.push(char);
			}
		} else {
			current += char;
		}
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Parse a PostgreSQL range literal like "[2024-01-01, 2024-01-15)" into a RangeValue object.
 * Supports formats:
 * - "[lower, upper)" or "(lower, upper]" - standard PostgreSQL range notation
 * - "lower..upper" - shorthand for inclusive range [lower, upper]
 *
 * @returns RangeValue object or null if not a valid range literal
 */
function parseRangeLiteral(
	token: string,
): { lower: string | number; upper: string | number; bounds?: string } | null {
	// Standard PostgreSQL range format: [lower, upper) or (lower, upper]
	const pgRangeMatch = token.match(/^([[(])([^,]*),\s*([^\])]*)([\])])$/);
	if (pgRangeMatch) {
		const [, lowerBound, lower = '', upper = '', upperBound] = pgRangeMatch;
		const bounds = `${lowerBound}${upperBound}`; // e.g., "[)" or "(]"
		return {
			lower: parseSimpleValue(lower.trim()),
			upper: parseSimpleValue(upper.trim()),
			bounds,
		};
	}

	// Shorthand format: lower..upper (inclusive)
	const shorthandMatch = token.match(/^(.+)\.\.(.+)$/);
	if (shorthandMatch) {
		const [, lower = '', upper = ''] = shorthandMatch;
		return {
			lower: parseSimpleValue(lower.trim()),
			upper: parseSimpleValue(upper.trim()),
			bounds: '[]', // inclusive both sides
		};
	}

	return null;
}

/**
 * Parse a simple value (number or string) without range detection
 */
function parseSimpleValue(token: string): string | number {
	const num = Number(token);
	if (!Number.isNaN(num)) return num;
	return token;
}

function parseValue(token: string): unknown {
	// Boolean
	if (token.toLowerCase() === 'true') return true;
	if (token.toLowerCase() === 'false') return false;

	// Null
	if (token.toLowerCase() === 'null') return null;

	// Range literal (PostgreSQL)
	const rangeValue = parseRangeLiteral(token);
	if (rangeValue) return rangeValue;

	// Number
	const num = Number(token);
	if (!Number.isNaN(num)) return num;

	// String (already unquoted by tokenizer)
	return token;
}

/**
 * CLI-016: Parse aggregate expression like count(*), sum(field) as alias
 * Syntax: func([distinct] field) [as alias]
 * Examples:
 *   count(*) → { function: 'count' }
 *   count(id) → { function: 'count', field: 'id' }
 *   sum(amount) as total → { function: 'sum', field: 'amount', as: 'total' }
 *   count(distinct user_id) → { function: 'count', field: 'user_id', distinct: true }
 */
function parseAggregateExpression(
	tokens: string[],
	index: number,
): { aggregate: ParsedAggregate; nextIndex: number } | null {
	const token = tokens[index];
	if (!token) return null;

	// Check if token is an aggregate function call: func(...)
	const match = token.match(/^(count|sum|avg|min|max)\((.*)$/i);
	if (!match) return null;

	const func = match[1]?.toLowerCase() as ParsedAggregate['function'];
	let argPart = match[2] ?? '';

	// Collect tokens until we find the closing parenthesis
	let currentIndex = index;
	while (!argPart.endsWith(')') && currentIndex < tokens.length - 1) {
		currentIndex++;
		const nextToken = tokens[currentIndex];
		if (nextToken) {
			argPart += ` ${nextToken}`;
		}
	}

	// Remove closing parenthesis
	if (!argPart.endsWith(')')) {
		return null; // Malformed
	}
	argPart = argPart.slice(0, -1).trim();

	// Parse arguments: could be *, field, or distinct field
	let field: string | undefined;
	let distinct = false;

	if (argPart === '*' || argPart === '') {
		// count(*) or count()
		field = undefined;
	} else if (argPart.toLowerCase().startsWith('distinct ')) {
		// count(distinct field)
		distinct = true;
		field = argPart.slice(9).trim();
	} else {
		field = argPart;
	}

	currentIndex++;

	// Check for 'as alias'
	let as: string | undefined;
	if (tokens[currentIndex]?.toLowerCase() === 'as') {
		currentIndex++;
		as = tokens[currentIndex];
		if (as) currentIndex++;
	}

	const aggregate: ParsedAggregate = { function: func };
	if (field) aggregate.field = field;
	if (as) aggregate.as = as;
	if (distinct) aggregate.distinct = true;

	return { aggregate, nextIndex: currentIndex };
}

/**
 * Parse a where condition from tokens
 */
function parseWhereCondition(
	tokens: string[],
	index: number,
): {
	clause: WhereClause;
	nextIndex: number;
} {
	const column = tokens[index];
	if (!column) {
		throw new ParseError('Expected column name after "where"');
	}

	const op = tokens[index + 1];
	if (!op) {
		throw new ParseError(`Expected operator after "${column}"`);
	}

	// Normalize operator
	let operator: WhereClause['operator'];
	switch (op.toLowerCase()) {
		case '=':
			operator = '=';
			break;
		case '!=':
			operator = '!=';
			break;
		case '>':
			operator = '>';
			break;
		case '<':
			operator = '<';
			break;
		case '>=':
			operator = '>=';
			break;
		case '<=':
			operator = '<=';
			break;
		case 'like':
			operator = 'like';
			break;
		case 'in':
			operator = 'in';
			break;
		case 'is':
			operator = 'is';
			break;
		// Range operators (PostgreSQL)
		case 'overlaps':
			operator = 'overlaps';
			break;
		case 'contains':
			operator = 'contains';
			break;
		case 'containedby':
			operator = 'containedBy';
			break;
		default:
			throw new ParseError(`Unknown operator: ${op}`);
	}

	const valueToken = tokens[index + 2];
	if (!valueToken) {
		throw new ParseError(`Expected value after "${op}"`);
	}

	const value = parseValue(valueToken);

	return {
		clause: { column, operator, value },
		nextIndex: index + 3,
	};
}

/**
 * Get the target table of a relation
 */
function getRelationTargetTable(
	relationKey: string,
	schema: ResolvedSchema,
): string | undefined {
	const relation = schema.relations[relationKey];
	if (!relation) return undefined;
	return relation.target;
}

/**
 * Validate and resolve a relation name against the current table context
 * Returns the simple relation name if valid, throws if not found
 */
function validateRelation(
	rel: string,
	currentTable: string,
	schema: ResolvedSchema,
): { relName: string; qualifiedKey: string } {
	if (rel.includes('.')) {
		// Already qualified (e.g., "posts.author")
		const [sourceTable, ...relParts] = rel.split('.');
		const simpleRel = relParts.join('.');

		if (schema.relations[rel]) {
			if (sourceTable !== currentTable) {
				throw new ParseError(
					`Relation "${rel}" belongs to table "${sourceTable}", not "${currentTable}". ` +
						`Use just "${simpleRel}" or query from "${sourceTable}" table.`,
				);
			}
			return { relName: simpleRel, qualifiedKey: rel };
		}
	} else {
		// Simple name (e.g., "author")
		const qualifiedRelation = `${currentTable}.${rel}`;
		if (schema.relations[qualifiedRelation]) {
			return { relName: rel, qualifiedKey: qualifiedRelation };
		}
		// Also check simple format for backward compatibility
		if (schema.relations[rel]) {
			return { relName: rel, qualifiedKey: rel };
		}
	}

	// Not found - generate suggestion
	const relations = Object.keys(schema.relations);
	const tableRelations = relations.filter((r) =>
		r.startsWith(`${currentTable}.`),
	);
	const suggestion =
		tableRelations.find((r) => {
			const name = r.split('.').slice(1).join('.');
			return (
				name.toLowerCase() === rel.toLowerCase() ||
				name.toLowerCase().startsWith(rel.toLowerCase())
			);
		}) ||
		relations.find(
			(r) =>
				r.toLowerCase() === rel.toLowerCase() ||
				r.toLowerCase().includes(rel.toLowerCase()),
		);

	throw new ParseError(
		`Unknown relation: "${rel}"${suggestion ? `. Did you mean "${suggestion}"?` : ''}`,
	);
}

/**
 * Parse include chain recursively - handles nested includes like "posts include comments include author"
 */
function parseIncludeChain(
	tokens: string[],
	startIndex: number,
	currentTable: string,
	schema: ResolvedSchema,
	pendingQualifiedFilters: { targetTable: string; clause: WhereClause }[],
): { includes: ParsedInclude[]; nextIndex: number } {
	const includes: ParsedInclude[] = [];
	let i = startIndex;

	while (i < tokens.length) {
		const tok = tokens[i];
		if (!tok) break;

		// Stop on keywords that aren't part of the include chain
		const lowerTok = tok.toLowerCase();
		if (['limit', 'offset', 'order', 'and', 'or'].includes(lowerTok)) {
			break;
		}

		// 'where' without a relation means main table filter
		if (lowerTok === 'where') {
			break;
		}

		// 'include' at this position means a new sibling include
		if (lowerTok === 'include') {
			i++; // skip 'include'
			continue;
		}

		// Check for 'all' keyword for recursive includes
		let isRecursive = false;
		if (lowerTok === 'all') {
			isRecursive = true;
			i++; // skip 'all'
		}

		const rel = tokens[i];
		if (!rel) break;

		// Validate the relation against the current table context
		const { relName, qualifiedKey } = validateRelation(
			rel,
			currentTable,
			schema,
		);
		i++;

		// Get the target table of this relation for nested includes
		const targetTable = getRelationTargetTable(qualifiedKey, schema);

		// CLI-018: Parse recursive options (depth N, max N, with depth)
		let maxDepth: number | undefined;
		let includeDepth = false;

		if (isRecursive) {
			// Check for 'depth N' or 'max N' (maxDepth)
			const depthKeyword = tokens[i]?.toLowerCase();
			if (depthKeyword === 'depth' || depthKeyword === 'max') {
				i++; // skip 'depth' or 'max'
				const depthValue = tokens[i];
				if (depthValue && /^\d+$/.test(depthValue)) {
					maxDepth = parseInt(depthValue, 10);
					i++; // skip the number
				}
			}

			// Check for 'with depth' (includeDepth)
			if (
				tokens[i]?.toLowerCase() === 'with' &&
				tokens[i + 1]?.toLowerCase() === 'depth'
			) {
				includeDepth = true;
				i += 2; // skip 'with depth'
			}
		}

		// Check for where clause on this include
		let includeFilters: WhereClause[] | undefined;
		if (tokens[i]?.toLowerCase() === 'where') {
			includeFilters = [];
			i++; // skip 'where'

			while (i < tokens.length) {
				const whereTok = tokens[i];
				if (!whereTok) break;

				const lowerWhereTok = whereTok.toLowerCase();
				// Stop on keywords that end the include filter
				if (['limit', 'offset', 'order', 'include'].includes(lowerWhereTok)) {
					break;
				}

				// Handle 'and' - continue parsing filters
				if (lowerWhereTok === 'and') {
					i++;
					continue;
				}

				// Try to parse a where condition
				try {
					const { clause, nextIndex } = parseWhereCondition(tokens, i);

					if (clause.column.includes('.')) {
						const [tablePrefix, ...columnParts] = clause.column.split('.');
						if (tablePrefix) {
							pendingQualifiedFilters.push({
								targetTable: tablePrefix,
								clause: { ...clause, column: columnParts.join('.') },
							});
						}
					} else {
						includeFilters.push(clause);
					}

					i = nextIndex;

					const nextTok = tokens[i]?.toLowerCase();
					if (nextTok !== 'and') {
						break;
					}
				} catch {
					break;
				}
			}
		}

		// Check for nested includes (e.g., "posts include comments")
		// But distinguish from siblings: if next relation belongs to currentTable, it's a sibling
		let nestedIncludes: ParsedInclude[] | undefined;
		if (tokens[i]?.toLowerCase() === 'include' && targetTable) {
			const nextRel = tokens[i + 1];
			// Handle 'include all' case - look ahead past 'all' keyword
			const lookAheadRel =
				nextRel?.toLowerCase() === 'all' ? tokens[i + 2] : nextRel;
			if (lookAheadRel) {
				// Check if nextRel is a relation of currentTable (sibling) or targetTable (nested)
				const isSiblingOfCurrent =
					schema.relations[`${currentTable}.${lookAheadRel}`] ||
					schema.relations[lookAheadRel];
				const isNestedOfTarget =
					schema.relations[`${targetTable}.${lookAheadRel}`];

				if (isNestedOfTarget && !isSiblingOfCurrent) {
					// It's a nested include - recurse with targetTable context
					i++; // skip 'include'
					const nested = parseIncludeChain(
						tokens,
						i,
						targetTable,
						schema,
						pendingQualifiedFilters,
					);
					nestedIncludes =
						nested.includes.length > 0 ? nested.includes : undefined;
					i = nested.nextIndex;
				}
				// else: it's a sibling, don't consume 'include', let main loop handle it
			}
		}

		includes.push({
			relation: relName,
			...(includeFilters &&
				includeFilters.length > 0 && { where: includeFilters }),
			...(nestedIncludes && { include: nestedIncludes }),
			...(isRecursive && { recursive: true }),
			...(maxDepth !== undefined && { maxDepth }),
			...(includeDepth && { includeDepth: true }),
		});

		// After parsing one include, check if there's a comma for more siblings
		// or another 'include' keyword
		if (tokens[i] === ',') {
			i++;
		}
	}

	return { includes, nextIndex: i };
}

/**
 * Parse a natural query string
 */
export function parseNaturalQuery(
	input: string,
	schema: ResolvedSchema,
): ParsedQuery {
	const tokens = tokenize(input.trim());

	if (tokens.length === 0) {
		throw new ParseError('Empty query');
	}

	// First token must be a table name
	const tableName = tokens[0];
	if (!tableName || !schema.tables[tableName]) {
		// Try to find a close match
		const tables = Object.keys(schema.tables);
		const suggestion = tableName
			? tables.find(
					(t) =>
						t.toLowerCase() === tableName.toLowerCase() ||
						t.toLowerCase().startsWith(tableName.toLowerCase()),
				)
			: undefined;
		throw new ParseError(
			`Unknown table: "${tableName ?? ''}"${suggestion ? `. Did you mean "${suggestion}"?` : ''}`,
		);
	}

	const result: ParsedQuery = { table: tableName };

	// CLI-014: Collect qualified filters for distribution after parsing
	const pendingQualifiedFilters: QualifiedFilter[] = [];

	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i]?.toLowerCase() ?? '';

		switch (token) {
			case 'where': {
				// Parse where clauses (can have multiple with "and")
				i++;

				while (i < tokens.length) {
					const { clause, nextIndex } = parseWhereCondition(tokens, i);

					// CLI-014: Check if column is qualified (table.column)
					if (clause.column.includes('.')) {
						const [tablePrefix, ...columnParts] = clause.column.split('.');
						if (tablePrefix) {
							// Qualified column → store for distribution later
							pendingQualifiedFilters.push({
								targetTable: tablePrefix,
								clause: { ...clause, column: columnParts.join('.') },
							});
						}
					} else {
						// Unqualified column → implicit scoping to main table
						result.where = result.where ?? [];
						result.where.push(clause);
					}

					i = nextIndex;

					// Check for "and" to continue
					const nextToken = tokens[i]?.toLowerCase();
					if (nextToken === 'and') {
						i++;
					} else {
						break;
					}
				}
				break;
			}

			case 'include': {
				// Parse include relations recursively (supports nested includes)
				i++; // Skip 'include'
				const { includes, nextIndex } = parseIncludeChain(
					tokens,
					i,
					result.table,
					schema,
					pendingQualifiedFilters,
				);
				result.include = result.include ?? [];
				result.include.push(...includes);
				i = nextIndex;
				break;
			}

			case 'limit': {
				i++;
				const limitToken = tokens[i];
				if (!limitToken) {
					throw new ParseError('Expected number after "limit"');
				}
				const limit = Number.parseInt(limitToken, 10);
				if (Number.isNaN(limit) || limit < 0) {
					throw new ParseError(`Invalid limit: "${limitToken}"`);
				}
				result.limit = limit;
				i++;
				break;
			}

			case 'offset': {
				i++;
				const offsetToken = tokens[i];
				if (!offsetToken) {
					throw new ParseError('Expected number after "offset"');
				}
				const offset = Number.parseInt(offsetToken, 10);
				if (Number.isNaN(offset) || offset < 0) {
					throw new ParseError(`Invalid offset: "${offsetToken}"`);
				}
				result.offset = offset;
				i++;
				break;
			}

			case 'order':
			case 'orderby': {
				// Handle "order by" or "orderby"
				if (token === 'order') {
					const byToken = tokens[i + 1]?.toLowerCase();
					if (byToken !== 'by') {
						throw new ParseError('Expected "by" after "order"');
					}
					i += 2;
				} else {
					i++;
				}

				result.orderBy = result.orderBy ?? [];

				while (i < tokens.length) {
					const col = tokens[i];
					if (!col) break;

					// Stop if we hit another keyword
					if (
						[
							'where',
							'limit',
							'offset',
							'include',
							'select',
							'group',
							'having',
							'distinct',
						].includes(col.toLowerCase())
					) {
						break;
					}

					let direction: 'asc' | 'desc' = 'asc';
					const nextToken = tokens[i + 1]?.toLowerCase();
					if (nextToken === 'asc' || nextToken === 'desc') {
						direction = nextToken;
						i++;
					}

					result.orderBy.push({ column: col, direction });
					i++;
				}
				break;
			}

			case 'and': {
				// CLI-014: Handle 'and' after include filter parsing
				// This happens when: "tags include posts where published = true and tags.name = x"
				// The include filter parsing stops at "and tags.name", leaving "and" for outer parser
				i++;

				while (i < tokens.length) {
					const { clause, nextIndex } = parseWhereCondition(tokens, i);

					// CLI-014: Check if column is qualified (table.column)
					if (clause.column.includes('.')) {
						const [tablePrefix, ...columnParts] = clause.column.split('.');
						if (tablePrefix) {
							// Store as pending qualified filter for distribution later
							pendingQualifiedFilters.push({
								targetTable: tablePrefix,
								clause: { ...clause, column: columnParts.join('.') },
							});
						}
					} else {
						// Unqualified column → add to main where (implicit scoping)
						result.where = result.where ?? [];
						result.where.push(clause);
					}

					i = nextIndex;

					// Check for more 'and' conditions
					const nextToken = tokens[i]?.toLowerCase();
					if (nextToken === 'and') {
						i++;
					} else {
						break;
					}
				}
				break;
			}

			case 'select': {
				// CLI-016: Parse aggregate expressions after 'select'
				// Syntax: select count(*), sum(field) as alias, ...
				// Also handles: select distinct
				// Note: commas are stripped by tokenizer, so we just keep parsing
				i++;

				// Check for 'distinct' immediately after select
				if (tokens[i]?.toLowerCase() === 'distinct') {
					// Check if next token is an aggregate or a field
					const nextAfterDistinct = tokens[i + 1];
					if (
						nextAfterDistinct &&
						/^(count|sum|avg|min|max)\(/i.test(nextAfterDistinct)
					) {
						// select distinct count(...) - distinct applies to aggregate
						i++; // Skip 'distinct', handled below
					} else {
						// select distinct - SELECT DISTINCT query
						result.distinct = true;
						i++;
						break;
					}
				}

				// Parse aggregate expressions (keep going while we find aggregates)
				while (i < tokens.length) {
					const parsed = parseAggregateExpression(tokens, i);
					if (!parsed) break;

					result.aggregates = result.aggregates ?? [];
					result.aggregates.push(parsed.aggregate);
					i = parsed.nextIndex;
					// No comma check needed - tokenizer strips commas
				}
				break;
			}

			case 'group': {
				// CLI-016: Parse GROUP BY clause
				// Syntax: group by field1, field2
				// Note: commas are stripped by tokenizer
				i++;
				const byToken = tokens[i]?.toLowerCase();
				if (byToken !== 'by') {
					throw new ParseError('Expected "by" after "group"');
				}
				i++;

				result.groupBy = result.groupBy ?? [];

				while (i < tokens.length) {
					const field = tokens[i];
					if (!field) break;

					// Stop if we hit a keyword
					if (
						[
							'where',
							'limit',
							'offset',
							'include',
							'order',
							'orderby',
							'having',
							'select',
							'distinct',
						].includes(field.toLowerCase())
					) {
						break;
					}

					result.groupBy.push(field);
					i++;
					// No comma check needed - tokenizer strips commas
				}
				break;
			}

			case 'having': {
				// CLI-016: Parse HAVING clause (same syntax as where)
				i++;

				while (i < tokens.length) {
					const { clause, nextIndex } = parseWhereCondition(tokens, i);
					result.having = result.having ?? [];
					result.having.push(clause);
					i = nextIndex;

					// Check for "and" to continue
					const nextToken = tokens[i]?.toLowerCase();
					if (nextToken === 'and') {
						i++;
					} else {
						break;
					}
				}
				break;
			}

			case 'distinct': {
				// CLI-016: SELECT DISTINCT (when used without 'select' keyword)
				result.distinct = true;
				i++;
				break;
			}

			default:
				throw new ParseError(`Unexpected token: "${token}"`);
		}
	}

	// CLI-014: Distribute qualified filters to their target destinations
	for (const qf of pendingQualifiedFilters) {
		const targetTableLower = qf.targetTable.toLowerCase();

		if (targetTableLower === result.table.toLowerCase()) {
			// Target is main table → add to result.where
			result.where = result.where ?? [];
			result.where.push(qf.clause);
		} else {
			// Target is an include table → find and add to that include's where
			const targetInclude = result.include?.find((inc) => {
				// Check if include's target table matches
				// The relation name might be different from the table name,
				// so we need to look up the relation's target
				const qualifiedRel = `${result.table}.${inc.relation}`;
				const relation =
					schema.relations[qualifiedRel] ?? schema.relations[inc.relation];
				return relation?.target.toLowerCase() === targetTableLower;
			});

			if (targetInclude) {
				targetInclude.where = targetInclude.where ?? [];
				targetInclude.where.push(qf.clause);
			} else {
				// Table not found in query - error
				const availableTables = [
					result.table,
					...(result.include?.map((inc) => {
						const qualifiedRel = `${result.table}.${inc.relation}`;
						const relation =
							schema.relations[qualifiedRel] ?? schema.relations[inc.relation];
						return relation?.target ?? inc.relation;
					}) ?? []),
				];
				throw new ParseError(
					`Qualified column "${qf.targetTable}.${qf.clause.column}" references table "${qf.targetTable}" ` +
						`which is not in the query. Available tables: ${availableTables.join(', ')}`,
				);
			}
		}
	}

	return result;
}

/**
 * Convert parsed query to SQL-like string for display
 */
export function parsedQueryToSql(query: ParsedQuery): string {
	let sql = `SELECT * FROM ${query.table}`;

	if (query.where && query.where.length > 0) {
		const conditions = query.where.map((w) => {
			const value =
				typeof w.value === 'string' ? `'${w.value}'` : String(w.value);
			return `${w.column} ${w.operator} ${value}`;
		});
		sql += ` WHERE ${conditions.join(' AND ')}`;
	}

	if (query.orderBy && query.orderBy.length > 0) {
		const orders = query.orderBy.map(
			(o) => `${o.column} ${o.direction.toUpperCase()}`,
		);
		sql += ` ORDER BY ${orders.join(', ')}`;
	}

	if (query.limit !== undefined) {
		sql += ` LIMIT ${query.limit}`;
	}

	if (query.offset !== undefined) {
		sql += ` OFFSET ${query.offset}`;
	}

	// Note: includes would be handled by JOIN or subquery in real SQL
	// CLI-014: Include can now have filters
	if (query.include && query.include.length > 0) {
		const includeDescriptions = query.include.map((inc) => {
			if (inc.where && inc.where.length > 0) {
				const filters = inc.where
					.map((w) => {
						const value =
							typeof w.value === 'string' ? `'${w.value}'` : String(w.value);
						return `${w.column} ${w.operator} ${value}`;
					})
					.join(' AND ');
				return `${inc.relation} WHERE ${filters}`;
			}
			return inc.relation;
		});
		sql += `\n-- Includes: ${includeDescriptions.join(', ')}`;
	}

	return sql;
}
