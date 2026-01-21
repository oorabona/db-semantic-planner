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
	ExistenceCheck,
	FromClause,
	MutationType,
	MutationValue,
	OnConflictClause,
	ParsedMutation,
	ParsedSubquery,
	PathExpression,
	PathSegment,
	RecursiveDirection,
	RecursiveRelationInfo,
	SubqueryValue,
} from './types.js';

// Re-export mutation types for convenience
export type {
	MutationType,
	MutationValue,
	Assignment,
	OnConflictClause,
	ParsedMutation,
	ParsedSubquery,
	SubqueryValue,
	ExistenceCheck,
	FromClause,
};

// Re-export path expression types
export type { PathExpression, PathSegment };

// Re-export recursive relation types (Block 7)
export type { RecursiveDirection, RecursiveRelationInfo };

// =============================================================================
// CLI-NQL: Path Expression Parser
// =============================================================================

/**
 * CLI-NQL: Reserved keywords that require quoting when used as identifiers.
 * Using SQL standard reserved words + NQL-specific keywords.
 */
export const RESERVED_KEYWORDS = new Set([
	// SQL standard
	'select',
	'from',
	'where',
	'and',
	'or',
	'not',
	'in',
	'is',
	'null',
	'true',
	'false',
	'like',
	'between',
	'order',
	'by',
	'asc',
	'desc',
	'limit',
	'offset',
	'group',
	'having',
	'as',
	'on',
	'join',
	'left',
	'right',
	'inner',
	'outer',
	'full',
	'cross',
	'union',
	'intersect',
	'except',
	'case',
	'when',
	'then',
	'else',
	'end',
	'distinct',
	'all',
	// NQL-specific
	'include',
	'insert',
	'update',
	'delete',
	'upsert',
	'set',
	'do',
	'nothing',
	'conflict',
	'has',
	'ancestors',
	'descendants',
	'over',
	'partition',
	'for',
	'each',
]);

/**
 * CLI-NQL: Check if a token is a quoted identifier (double-quoted).
 */
export function isQuotedIdentifier(token: string): boolean {
	return token.startsWith('"') && token.endsWith('"') && token.length >= 2;
}

/**
 * CLI-NQL: Extract the identifier name from a potentially quoted token.
 * Returns the name without quotes and whether it was quoted.
 */
export function parseIdentifier(token: string): PathSegment {
	if (isQuotedIdentifier(token)) {
		return {
			name: token.slice(1, -1), // Remove surrounding quotes
			quoted: true,
		};
	}
	return {
		name: token,
		quoted: false,
	};
}

/**
 * CLI-NQL: Parse a path expression from a single token.
 * Handles dot-separated paths like "category.parent.name" or "category"."parent"."name".
 *
 * @param token - The raw token (may contain dots)
 * @returns PathExpression with segments and metadata
 *
 * @example
 * parsePathExpression("category.parent.name")
 * // → { segments: [{name:"category",quoted:false}, {name:"parent",quoted:false}, {name:"name",quoted:false}], raw: "category.parent.name" }
 *
 * @example
 * parsePathExpression("\"children\"")
 * // → { segments: [{name:"children",quoted:true}], raw: "\"children\"" }
 */
export function parsePathExpression(token: string): PathExpression {
	const raw = token;
	const segments: PathSegment[] = [];

	// Handle quoted identifiers that might contain dots literally
	if (isQuotedIdentifier(token)) {
		// Single quoted identifier (e.g., "table.name" as a literal identifier)
		segments.push(parseIdentifier(token));
		return { segments, raw };
	}

	// Split by dots, but handle quoted segments
	// Simple approach: split by '.' for unquoted tokens
	const parts = token.split('.');

	for (const part of parts) {
		if (part === '') continue; // Skip empty segments from leading/trailing dots
		segments.push(parseIdentifier(part));
	}

	if (segments.length === 0) {
		// Edge case: empty or only dots
		throw new ParseError(`Invalid path expression: "${token}"`);
	}

	return { segments, raw };
}

/**
 * CLI-NQL: Convert a PathExpression back to string representation.
 * Useful for error messages and debugging.
 */
export function pathToString(path: PathExpression): string {
	return path.segments
		.map((s) => (s.quoted ? `"${s.name}"` : s.name))
		.join('.');
}

/**
 * CLI-NQL: Check if a path expression is a simple column reference (single unquoted segment).
 */
export function isSimpleColumn(path: PathExpression): boolean {
	return (
		path.segments.length === 1 &&
		path.segments[0] !== undefined &&
		!path.segments[0].quoted
	);
}

/**
 * CLI-NQL: Check if a path expression is a qualified column (table.column or relation.column).
 */
export function isQualifiedPath(path: PathExpression): boolean {
	return path.segments.length > 1;
}

/**
 * CLI-NQL: Get the first segment (table or relation name in qualified paths).
 */
export function getPathRoot(path: PathExpression): PathSegment | undefined {
	return path.segments[0];
}

/**
 * CLI-NQL: Get the last segment (column name in most cases).
 */
export function getPathLeaf(path: PathExpression): PathSegment | undefined {
	return path.segments[path.segments.length - 1];
}

/**
 * CLI-NQL: Convert legacy string column to PathExpression.
 * For backward compatibility with existing code.
 */
export function columnToPath(column: string): PathExpression {
	return parsePathExpression(column);
}

// =============================================================================
// CLI-NQL: Subquery Parser (Block 3)
// =============================================================================

/**
 * CLI-NQL: Parse a subquery from tokens.
 * Subquery syntax: `(table [where conditions] [select column])`
 *
 * Note: Due to tokenizer behavior, `(table` comes as a single token.
 * The subquery ends when we find a closing `)` token.
 *
 * @example
 * // Scalar subquery (implicit primary key selection)
 * parseSubquery(['(categories', 'where', 'name', '=', 'Electronics', ')'], 0)
 * // → { subquery: { table: 'categories', where: [...] }, nextIndex: 6 }
 *
 * @example
 * // Explicit column selection
 * parseSubquery(['(categories', 'where', 'active', '=', 'true', 'select', 'id', ')'], 0)
 * // → { subquery: { table: 'categories', where: [...], selectColumn: 'id' }, nextIndex: 8 }
 */
export function parseSubquery(
	tokens: string[],
	startIndex: number,
): { subquery: ParsedSubquery; nextIndex: number } {
	let i = startIndex;

	// First token should be "(tableName"
	const firstToken = tokens[i];
	if (!firstToken || !firstToken.startsWith('(')) {
		throw new ParseError(
			`Expected '(' to start subquery, got "${firstToken ?? 'end of input'}"`,
			i,
		);
	}

	// Extract table name from "(tableName" or "(tableName)"
	let table = firstToken.slice(1); // Remove leading '('
	if (!table) {
		throw new ParseError('Expected table name in subquery', i);
	}

	// Handle case where token is "(tableName)" - complete subquery in one token
	let completeInOneToken = false;
	if (table.endsWith(')')) {
		table = table.slice(0, -1);
		completeInOneToken = true;
	}
	i++;

	const subquery: ParsedSubquery = { table };

	// If the entire subquery was in one token (no WHERE, no SELECT), return early
	if (completeInOneToken) {
		return { subquery, nextIndex: i };
	}

	// Parse optional WHERE clause
	if (tokens[i]?.toLowerCase() === 'where') {
		i++;
		subquery.where = [];

		while (i < tokens.length) {
			const token = tokens[i];
			if (!token) break;

			// Stop on closing parenthesis
			if (token === ')' || token.endsWith(')')) break;

			// Stop on 'select' keyword (explicit column selection)
			if (token.toLowerCase() === 'select') break;

			// Handle 'and' connector
			if (token.toLowerCase() === 'and') {
				i++;
				continue;
			}

			// Parse condition: column operator value
			const column = tokens[i];
			const operator = tokens[i + 1];
			let valueToken = tokens[i + 2];

			if (!column || !operator || valueToken === undefined) {
				throw new ParseError('Incomplete WHERE condition in subquery', i);
			}

			// Handle value that ends with ')' - it's the last value in subquery
			let endsSubquery = false;
			if (valueToken.endsWith(')')) {
				valueToken = valueToken.slice(0, -1); // Remove trailing ')'
				endsSubquery = true;
			}

			// Parse value (simple for now - will be enhanced in later blocks)
			let value: unknown;
			const lowerValue = valueToken.toLowerCase();
			if (lowerValue === 'true') {
				value = true;
			} else if (lowerValue === 'false') {
				value = false;
			} else if (lowerValue === 'null') {
				value = null;
			} else if (!Number.isNaN(Number(valueToken))) {
				value = Number(valueToken);
			} else {
				// String value
				value = valueToken;
			}

			subquery.where.push({ column, operator, value });
			i += 3;

			if (endsSubquery) {
				// The ')' was already consumed from valueToken
				return { subquery, nextIndex: i };
			}

			// Check for 'and' to continue
			if (tokens[i]?.toLowerCase() !== 'and') {
				break;
			}
		}
	}

	// Parse optional SELECT clause for explicit column
	if (tokens[i]?.toLowerCase() === 'select') {
		i++;
		let selectCol = tokens[i];
		if (!selectCol) {
			throw new ParseError('Expected column name after SELECT in subquery', i);
		}

		// Handle select column that ends with ')'
		if (selectCol.endsWith(')')) {
			selectCol = selectCol.slice(0, -1);
			subquery.selectColumn = selectCol;
			i++;
			return { subquery, nextIndex: i };
		}

		subquery.selectColumn = selectCol;
		i++;
	}

	// Expect closing parenthesis
	if (tokens[i] !== ')') {
		throw new ParseError(
			`Expected ')' to close subquery, got "${tokens[i] ?? 'end of input'}"`,
			i,
		);
	}
	i++;

	return { subquery, nextIndex: i };
}

/**
 * CLI-NQL: Check if a token starts a subquery (starts with '(' but is not a function call).
 * Function calls look like: count(, sum(, func_name(
 * Subqueries look like: (table_name
 */
export function isSubqueryStart(token: string | undefined): boolean {
	if (!token || !token.startsWith('(')) return false;

	// Extract what comes after '('
	let afterParen = token.slice(1);
	if (!afterParen) return false;

	// Handle case where token ends with ')' - e.g., "(categories)"
	if (afterParen.endsWith(')')) {
		afterParen = afterParen.slice(0, -1);
	}
	if (!afterParen) return false;

	// Function calls have format: funcname(arg...)
	// We detect this by checking if the token WITHOUT '(' would be a valid function start
	// Functions: count, sum, avg, min, max, now, uuid_generate_v4, etc.
	// Tables: lowercase identifiers that could also be function names...

	// Heuristic: if the entire token matches func(...) pattern, it's a function
	// If it's just "(identifier", it's a subquery start
	if (/^[a-z_][a-z0-9_]*\(/i.test(token)) {
		// This would be like "count(" - not our case since we have "(table"
		return false;
	}

	// It starts with '(' followed by an identifier - likely a subquery
	return /^[a-z_][a-z0-9_]*$/i.test(afterParen);
}

/**
 * CLI-NQL: Create a SubqueryValue from a ParsedSubquery.
 */
export function createSubqueryValue(subquery: ParsedSubquery): SubqueryValue {
	return { type: 'subquery', subquery };
}

// =============================================================================
// CLI-NQL: Existence Check Parser (has/not has)
// =============================================================================

/**
 * CLI-NQL: Check if the current position starts an existence check.
 * Patterns:
 * - "has <relation>"
 * - "not has <relation>"
 *
 * @param tokens - Array of tokens
 * @param index - Current position
 * @returns true if this is an existence check
 */
export function isExistenceCheck(tokens: string[], index: number): boolean {
	const token = tokens[index]?.toLowerCase();
	if (token === 'has') {
		return true;
	}
	if (token === 'not' && tokens[index + 1]?.toLowerCase() === 'has') {
		return true;
	}
	return false;
}

/**
 * CLI-NQL Block 4: Parse an existence check (has/not has relation [where ...]).
 *
 * Grammar:
 *   existence_check = ("has" | "not" "has") relation [existence_where]
 *   existence_where = "where" condition ("and" condition)*
 *
 * @example
 * "has products" → { type: 'exists', relation: 'products' }
 * "not has products" → { type: 'not_exists', relation: 'products' }
 * "has products where rating > 4" → { type: 'exists', relation: 'products', where: [...] }
 * "has ancestors where name = 'Root'" → { type: 'exists', relation: 'ancestors', recursive: {...} }
 *
 * @param tokens - Array of tokens
 * @param index - Current position (at 'has' or 'not')
 * @param schema - Optional schema for recursive relation detection (Block 7)
 * @param currentTable - Optional current table context for relation lookup
 * @returns Parsed existence check and next index
 */
export function parseExistenceCheck(
	tokens: string[],
	index: number,
	schema?: ResolvedSchema,
	currentTable?: string,
): {
	check: ExistenceCheck;
	nextIndex: number;
} {
	let i = index;
	let type: 'exists' | 'not_exists' = 'exists';

	// Check for "not has"
	if (tokens[i]?.toLowerCase() === 'not') {
		type = 'not_exists';
		i++; // Skip 'not'
	}

	// Skip 'has'
	if (tokens[i]?.toLowerCase() !== 'has') {
		throw new ParseError('Expected "has" in existence check');
	}
	i++;

	// Get relation name
	const relation = tokens[i];
	if (!relation) {
		throw new ParseError('Expected relation name after "has"');
	}
	i++;

	const check: ExistenceCheck = { type, relation };

	// CLI-NQL Block 7: Check if this is a recursive relation
	if (schema && currentTable) {
		const qualifiedKey = `${currentTable}.${relation}`;
		const recursiveInfo =
			getRecursiveRelationInfo(qualifiedKey, schema) ||
			getRecursiveRelationInfo(relation, schema);
		if (recursiveInfo) {
			check.recursive = recursiveInfo;
		}
	}

	// Check for optional "where" clause
	if (tokens[i]?.toLowerCase() === 'where') {
		i++; // Skip 'where'
		check.where = [];

		// Parse conditions until we hit a non-condition keyword
		while (i < tokens.length) {
			const column = tokens[i];
			const operator = tokens[i + 1];
			const valueToken = tokens[i + 2];

			if (!column || !operator || !valueToken) {
				break;
			}

			// Stop if we hit a top-level keyword (not an operator or condition part)
			const columnLower = column.toLowerCase();
			if (
				[
					'include',
					'limit',
					'offset',
					'order',
					'orderby',
					'select',
					'group',
					'having',
					'distinct',
				].includes(columnLower)
			) {
				break;
			}

			// Also stop if we hit another 'has' or 'not has' (new existence check)
			if (columnLower === 'has' || columnLower === 'not') {
				break;
			}

			// Parse the value (use parseExistenceValue for proper type handling)
			const value = parseExistenceValue(valueToken);

			check.where.push({
				column,
				operator,
				value,
			});

			i += 3;

			// Check for 'and' to continue
			const nextToken = tokens[i]?.toLowerCase();
			if (nextToken === 'and') {
				// Check if next token after 'and' is a column (continue) or 'has'/'not has' (stop)
				const afterAnd = tokens[i + 1]?.toLowerCase();
				if (afterAnd === 'has' || afterAnd === 'not') {
					// This 'and' connects to another existence check, not a condition
					break;
				}
				i++; // Skip 'and' and continue parsing conditions
			} else {
				break;
			}
		}
	}

	return { check, nextIndex: i };
}

/**
 * CLI-NQL: Parse a value for existence check where clauses.
 * Handles: strings (quoted), numbers, booleans, null.
 */
function parseExistenceValue(token: string): unknown {
	const trimmed = token.trim();

	// null
	if (trimmed.toLowerCase() === 'null') {
		return null;
	}

	// boolean
	if (trimmed.toLowerCase() === 'true') {
		return true;
	}
	if (trimmed.toLowerCase() === 'false') {
		return false;
	}

	// number (integer or float)
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
	}

	// Quoted string - remove quotes
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1);
	}

	// Unquoted value - return as-is
	return trimmed;
}

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

	// CLI-NQL Block 6: Parse optional FROM clause for FK lookup or bulk insert
	let fromClause: FromClause | undefined;
	if (tokens[i]?.toLowerCase() === 'from') {
		const result = parseFromClause(tokens, i);
		fromClause = result.fromClause;
		i = result.nextIndex;
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
		...(fromClause && { fromClause }),
		executeImmediate,
	};
}

/**
 * CLI-NQL Block 6: Parse FROM clause for INSERT mutations
 * Syntax: from [each] table [as alias] [where conditions] [for update [skip locked]]
 */
export function parseFromClause(
	tokens: string[],
	startIndex: number,
): { fromClause: FromClause; nextIndex: number } {
	let i = startIndex;

	// Skip 'from' keyword
	if (tokens[i]?.toLowerCase() !== 'from') {
		throw new ParseError(`Expected 'from' keyword, got "${tokens[i]}"`, i);
	}
	i++;

	// Check for 'each' keyword (bulk insert mode)
	let bulk = false;
	if (tokens[i]?.toLowerCase() === 'each') {
		bulk = true;
		i++;
	}

	// Parse source table name
	const table = tokens[i];
	if (!table) {
		throw new ParseError('Expected table name after FROM', i);
	}
	i++;

	// Check for optional alias (as alias)
	let alias: string | undefined;
	if (tokens[i]?.toLowerCase() === 'as') {
		i++;
		alias = tokens[i];
		if (!alias) {
			throw new ParseError('Expected alias after AS', i);
		}
		i++;
	}

	// Parse optional WHERE clause
	let where:
		| Array<{ column: string; operator: string; value: unknown }>
		| undefined;
	if (tokens[i]?.toLowerCase() === 'where') {
		i++;
		where = [];

		while (i < tokens.length) {
			const token = tokens[i];
			if (!token) break;

			// Stop on keywords that end the WHERE clause
			const lowerToken = token.toLowerCase();
			if (lowerToken === 'for' || lowerToken === '!') {
				break;
			}

			// Handle 'and' connector
			if (lowerToken === 'and') {
				i++;
				continue;
			}

			// Parse condition: column operator value
			const column = tokens[i];
			const operator = tokens[i + 1];
			const valueToken = tokens[i + 2];

			if (!column || !operator || valueToken === undefined) {
				throw new ParseError('Incomplete WHERE condition in FROM clause', i);
			}

			// Parse value
			let value: unknown;
			const lowerValue = valueToken.toLowerCase();
			if (lowerValue === 'true') {
				value = true;
			} else if (lowerValue === 'false') {
				value = false;
			} else if (lowerValue === 'null') {
				value = null;
			} else if (!Number.isNaN(Number(valueToken))) {
				value = Number(valueToken);
			} else {
				// String value - remove quotes if present
				value = valueToken.replace(/^["']|["']$/g, '');
			}

			where.push({ column, operator, value });
			i += 3;

			// Check for 'and' to continue
			if (tokens[i]?.toLowerCase() !== 'and') {
				break;
			}
		}
	}

	// Parse optional FOR UPDATE clause
	let forUpdate = false;
	let skipLocked = false;
	if (tokens[i]?.toLowerCase() === 'for') {
		if (tokens[i + 1]?.toLowerCase() === 'update') {
			forUpdate = true;
			i += 2;

			// Check for SKIP LOCKED
			if (
				tokens[i]?.toLowerCase() === 'skip' &&
				tokens[i + 1]?.toLowerCase() === 'locked'
			) {
				skipLocked = true;
				i += 2;
			}
		}
	}

	const fromClause: FromClause = {
		table,
		bulk,
	};

	if (alias) {
		fromClause.alias = alias;
	}
	if (where && where.length > 0) {
		fromClause.where = where;
	}
	if (forUpdate) {
		fromClause.forUpdate = true;
		if (skipLocked) {
			fromClause.skipLocked = true;
		}
	}

	return { fromClause, nextIndex: i };
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
/**
 * CLI-NQL: Parsed column specification
 */
export interface ParsedColumn {
	/** Column name */
	column: string;
	/** Optional alias (AS clause) */
	alias?: string;
}

export interface ParsedQuery {
	table: string;
	/** CLI-NQL: Column projection (select name, price as p) */
	columns?: ParsedColumn[];
	where?: WhereClause[];
	/** CLI-NQL: Existence checks (has/not has) */
	existenceChecks?: ExistenceCheck[];
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
		| 'not in'
		| 'is'
		| 'is not'
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
				// CLI-NQL: Preserve closing double quote for identifiers
				if (quoteChar === '"') {
					current += '"';
				}
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
			// CLI-NQL: Preserve double quotes for quoted identifiers
			// Single quotes = string literal (stripped)
			// Double quotes = identifier (preserved)
			if (char === '"') {
				current = '"'; // Start with the quote to mark it as quoted identifier
			}
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
	let valueOffset = 2; // Default: column op value (3 tokens)

	// CLI-NQL: Handle "not in" as two-token operator
	if (op.toLowerCase() === 'not' && tokens[index + 2]?.toLowerCase() === 'in') {
		operator = 'not in';
		valueOffset = 3; // column not in value (4 tokens)
	} else if (
		op.toLowerCase() === 'is' &&
		tokens[index + 2]?.toLowerCase() === 'not'
	) {
		// CLI-NQL: Handle "is not" as two-token operator (e.g., "is not null")
		operator = 'is not';
		valueOffset = 3; // column is not value (4 tokens)
	} else {
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
	}

	const valueToken = tokens[index + valueOffset];
	if (!valueToken) {
		throw new ParseError(`Expected value after "${op}"`);
	}

	// CLI-NQL: Check for subquery (value starts with '(' followed by table name)
	if (isSubqueryStart(valueToken)) {
		const { subquery, nextIndex } = parseSubquery(tokens, index + valueOffset);
		return {
			clause: {
				column,
				operator,
				value: createSubqueryValue(subquery),
			},
			nextIndex,
		};
	}

	const value = parseValue(valueToken);

	return {
		clause: { column, operator, value },
		nextIndex: index + valueOffset + 1,
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
 * CLI-NQL Block 7: Check if a relation is recursive and return its metadata.
 *
 * Supports extended schema format where relations can have a `recursive` property:
 * ```
 * relations: {
 *   'categories.ancestors': {
 *     kind: 'hasMany',
 *     target: 'categories',
 *     foreignKey: 'parentId',
 *     recursive: { direction: 'up', through: 'parent', maxDepth: 10 }
 *   }
 * }
 * ```
 *
 * @returns RecursiveRelationInfo if the relation is recursive, undefined otherwise
 */
export function getRecursiveRelationInfo(
	relationKey: string,
	schema: ResolvedSchema,
): RecursiveRelationInfo | undefined {
	const relation = schema.relations[relationKey] as
		| (typeof schema.relations)[string]
		| undefined;
	if (!relation) return undefined;

	// Check for extended schema format with recursive property
	const extended = relation as {
		recursive?: {
			direction: RecursiveDirection;
			through: string;
			maxDepth?: number;
		};
	};

	if (extended.recursive) {
		return {
			direction: extended.recursive.direction,
			through: extended.recursive.through,
			maxDepth: extended.recursive.maxDepth ?? 10,
		};
	}

	return undefined;
}

// =============================================================================
// CLI-NQL Block 8: Window Expression Parser
// =============================================================================

/** Window-only functions that can ONLY be used with OVER clause */
const WINDOW_ONLY_FUNCTIONS = new Set([
	'rank',
	'dense_rank',
	'row_number',
	'lag',
	'lead',
]);

/** Aggregate functions that can be used with OVER clause */
const AGGREGATE_FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);

/** All functions usable in window expressions */
const WINDOW_FUNCTIONS = new Set([
	...WINDOW_ONLY_FUNCTIONS,
	...AGGREGATE_FUNCTIONS,
]);

/**
 * CLI-NQL Block 8: Check if a token is a window function name.
 */
export function isWindowFunction(token: string): boolean {
	return WINDOW_FUNCTIONS.has(token.toLowerCase());
}

/**
 * CLI-NQL Block 8: Check if a token is a window-only function.
 */
export function isWindowOnlyFunction(token: string): boolean {
	return WINDOW_ONLY_FUNCTIONS.has(token.toLowerCase());
}

/**
 * CLI-NQL Block 8: Parse window order clause items.
 * Handles: "order by price desc, name asc"
 */
function parseWindowOrderClause(
	tokens: string[],
	startIndex: number,
): { items: import('./types.js').WindowOrderItem[]; nextIndex: number } {
	const items: import('./types.js').WindowOrderItem[] = [];
	let i = startIndex;

	// Skip "order by"
	if (
		tokens[i]?.toLowerCase() === 'order' &&
		tokens[i + 1]?.toLowerCase() === 'by'
	) {
		i += 2;
	}

	while (i < tokens.length) {
		const token = tokens[i];
		if (!token || token === ')' || token === 'as') break;

		// Skip comma
		if (token === ',') {
			i++;
			continue;
		}

		// Column name
		const column = token;
		i++;

		// Optional direction
		let direction: 'asc' | 'desc' = 'asc';
		const nextToken = tokens[i]?.toLowerCase();
		if (nextToken === 'asc' || nextToken === 'desc') {
			direction = nextToken;
			i++;
		}

		items.push({ column, direction });

		// Check for comma to continue
		if (tokens[i] !== ',') break;
	}

	return { items, nextIndex: i };
}

/**
 * CLI-NQL Block 8: Parse window specification from OVER clause.
 * Handles: "(partition by categoryId order by price desc)"
 */
function parseWindowSpec(
	tokens: string[],
	startIndex: number,
): { spec: import('./types.js').WindowSpec; nextIndex: number } {
	const spec: import('./types.js').WindowSpec = {};
	let i = startIndex;

	// Skip opening parenthesis
	if (tokens[i] === '(') i++;

	while (i < tokens.length && tokens[i] !== ')') {
		const token = tokens[i]?.toLowerCase();

		// PARTITION BY clause
		if (token === 'partition' && tokens[i + 1]?.toLowerCase() === 'by') {
			i += 2;
			const partitionBy: string[] = [];

			while (i < tokens.length) {
				const col = tokens[i];
				if (
					!col ||
					col === ')' ||
					col.toLowerCase() === 'order' ||
					col.toLowerCase() === 'as'
				)
					break;
				if (col !== ',') {
					partitionBy.push(col);
				}
				i++;
			}

			spec.partitionBy = partitionBy;
		}
		// ORDER BY clause
		else if (token === 'order' && tokens[i + 1]?.toLowerCase() === 'by') {
			const { items, nextIndex } = parseWindowOrderClause(tokens, i);
			spec.orderBy = items;
			i = nextIndex;
		} else {
			i++;
		}
	}

	// Skip closing parenthesis
	if (tokens[i] === ')') i++;

	return { spec, nextIndex: i };
}

/**
 * CLI-NQL Block 8: Parse a window expression.
 *
 * Syntax: function(args) over (partition by ... order by ...) [as alias]
 *
 * @example
 * rank() over (partition by categoryId order by price desc) as priceRank
 * sum(total) over (order by createdAt) as runningTotal
 * lag(price, 1, 0) over (order by id)
 */
export function parseWindowExpression(
	tokens: string[],
	startIndex: number,
): { expr: import('./types.js').ParsedWindowExpression; nextIndex: number } {
	let i = startIndex;

	// Get function name
	const funcName = tokens[i]?.toLowerCase();
	if (!funcName || !isWindowFunction(funcName)) {
		throw new ParseError(`Expected window function, got: ${funcName}`, i);
	}
	i++;

	// Expect opening parenthesis for function args
	if (tokens[i] !== '(') {
		throw new ParseError(`Expected '(' after ${funcName}`, i);
	}
	i++;

	// Parse function arguments (until closing paren)
	const args: string[] = [];
	while (i < tokens.length && tokens[i] !== ')') {
		const arg = tokens[i];
		if (arg && arg !== ',') {
			args.push(arg);
		}
		i++;
	}

	// Skip closing paren of function
	if (tokens[i] === ')') i++;

	// Expect "over" keyword
	if (tokens[i]?.toLowerCase() !== 'over') {
		throw new ParseError(`Expected 'over' after ${funcName}()`, i);
	}
	i++;

	// Parse window spec
	const { spec, nextIndex } = parseWindowSpec(tokens, i);
	i = nextIndex;

	// Optional alias
	let alias: string | undefined;
	if (tokens[i]?.toLowerCase() === 'as' && tokens[i + 1]) {
		i++; // skip 'as'
		alias = tokens[i];
		i++;
	}

	return {
		expr: {
			function: funcName as import('./types.js').WindowFunction,
			args,
			spec,
			...(alias && { alias }),
		},
		nextIndex: i,
	};
}

/**
 * CLI-NQL Block 8: Check if tokens at position start a window expression.
 * Window expressions start with: function_name ( ... ) over
 */
export function isWindowExpression(
	tokens: string[],
	startIndex: number,
): boolean {
	const funcName = tokens[startIndex]?.toLowerCase();
	if (!funcName || !isWindowFunction(funcName)) return false;

	// Look for pattern: func ( ... ) over
	let i = startIndex + 1;
	if (tokens[i] !== '(') return false;

	// Skip to closing paren
	let depth = 1;
	i++;
	while (i < tokens.length && depth > 0) {
		if (tokens[i] === '(') depth++;
		else if (tokens[i] === ')') depth--;
		i++;
	}

	// Check for 'over' keyword after function
	return tokens[i]?.toLowerCase() === 'over';
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
				// CLI-NQL: Also handles existence checks (has/not has)
				i++;

				while (i < tokens.length) {
					// CLI-NQL: Check for existence check (has/not has)
					if (isExistenceCheck(tokens, i)) {
						// Block 7: Pass schema and table for recursive relation detection
						const { check, nextIndex } = parseExistenceCheck(
							tokens,
							i,
							schema,
							tableName,
						);
						result.existenceChecks = result.existenceChecks ?? [];
						result.existenceChecks.push(check);
						i = nextIndex;
					} else {
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
					}

					// Check for "and" to continue
					const nextToken = tokens[i]?.toLowerCase();
					if (nextToken === 'and') {
						i++;
						// Check if next is existence check to handle "and has/not has"
						// The existence check parser will handle "not has" as well
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
				// CLI-NQL: Parse select clause - aggregates, columns, or *
				// Syntax: select count(*), sum(field) as alias, name, price as p, *
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
						// Continue parsing columns after distinct (e.g., "select distinct name, email")
						// Fall through to column parsing below
					}
				}

				// Keywords that end select clause
				const selectEndKeywords = [
					'where',
					'limit',
					'offset',
					'include',
					'order',
					'orderby',
					'group',
					'having',
					'from', // CLI-MUT: for INSERT...FROM
				];

				// Parse select items: aggregates or columns
				while (i < tokens.length) {
					const token = tokens[i];
					if (!token) break;

					// Stop if we hit a keyword
					if (selectEndKeywords.includes(token.toLowerCase())) {
						break;
					}

					// Try to parse as aggregate first
					const parsed = parseAggregateExpression(tokens, i);
					if (parsed) {
						result.aggregates = result.aggregates ?? [];
						result.aggregates.push(parsed.aggregate);
						i = parsed.nextIndex;
						continue;
					}

					// CLI-NQL: Not an aggregate, treat as column name
					// Handle: *, column, column as alias
					if (token === '*') {
						// Wildcard - select all columns (don't add to columns array, it means "all")
						// We could add a flag but leaving columns undefined means "all" in most ORMs
						i++;
						continue;
					}

					// It's a column name - check for optional "as alias"
					const columnName = token;
					i++;

					// Check for "as alias"
					const parsedColumn: ParsedColumn = { column: columnName };
					if (tokens[i]?.toLowerCase() === 'as') {
						i++; // skip 'as'
						const alias = tokens[i];
						if (!alias) {
							throw new ParseError('Expected alias after "as"');
						}
						// Check if alias is a keyword (shouldn't be)
						if (selectEndKeywords.includes(alias.toLowerCase())) {
							throw new ParseError(
								`Invalid alias "${alias}" - cannot use keyword as alias`,
							);
						}
						parsedColumn.alias = alias;
						i++;
					}

					result.columns = result.columns ?? [];
					result.columns.push(parsedColumn);
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
				// CLI-NQL: Check if qf.targetTable is a relation NAME (not target table)
				// This enables auto-include when using relation paths in WHERE
				// e.g., "products where category.name = 'X'" auto-includes category
				const qualifiedRelKey = `${result.table}.${qf.targetTable}`;
				const relationByName =
					schema.relations[qualifiedRelKey] ?? schema.relations[qf.targetTable];

				if (relationByName) {
					// Found relation by name → auto-add include with the where clause
					const newInclude: ParsedInclude = {
						relation: qf.targetTable,
						where: [qf.clause],
					};
					result.include = result.include ?? [];
					result.include.push(newInclude);
				} else {
					// Table not found in query - error
					const availableTables = [
						result.table,
						...(result.include?.map((inc) => {
							const qualifiedRel = `${result.table}.${inc.relation}`;
							const relation =
								schema.relations[qualifiedRel] ??
								schema.relations[inc.relation];
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
