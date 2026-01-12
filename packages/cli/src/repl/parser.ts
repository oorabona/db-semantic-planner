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

import type { ResolvedSchema } from '@db-semantic-planner/schema';

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
}

export interface WhereClause {
	column: string;
	operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'like' | 'in' | 'is';
	value: unknown;
}

export interface OrderByClause {
	column: string;
	direction: 'asc' | 'desc';
}

/**
 * CLI-014: Parsed include with optional filters
 */
export interface ParsedInclude {
	relation: string;
	where?: WhereClause[];
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

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (inQuote) {
			if (char === quoteChar) {
				inQuote = false;
				tokens.push(current);
				current = '';
			} else {
				current += char;
			}
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
 * Parse a value from token
 */
function parseValue(token: string): unknown {
	// Boolean
	if (token.toLowerCase() === 'true') return true;
	if (token.toLowerCase() === 'false') return false;

	// Null
	if (token.toLowerCase() === 'null') return null;

	// Number
	const num = Number(token);
	if (!Number.isNaN(num)) return num;

	// String (already unquoted by tokenizer)
	return token;
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
				// Parse include relations (CLI-014: with optional where filters)
				result.include = result.include ?? [];
				i++;

				while (i < tokens.length) {
					const rel = tokens[i];
					if (!rel) break;

					// Stop if we hit another keyword (except 'where' which is handled below)
					// CLI-014: Also stop on 'and'/'or' which signals main table filters
					if (
						['limit', 'offset', 'order', 'include', 'and', 'or'].includes(
							rel.toLowerCase(),
						)
					) {
						break;
					}

					// CLI-014: If 'where' appears without a preceding relation, it's a main table filter
					// This can happen with "tags include posts, include comments where x = y"
					// The 'where' applies to the main table, not the include
					if (rel.toLowerCase() === 'where') {
						break;
					}

					// Validate relation exists
					// Relations can be keyed in two ways:
					// 1. Qualified: "posts.author" (from defineSchema with FK inference)
					// 2. Simple: "author" (from manual schema or tests)
					// User can type either format
					let relName = rel;
					let foundRelation = false;

					if (rel.includes('.')) {
						// Already qualified (e.g., "posts.author")
						const [sourceTable, ...relParts] = rel.split('.');
						const simpleRel = relParts.join('.');

						if (schema.relations[rel]) {
							// Check if the qualified relation matches the current table
							if (sourceTable !== result.table) {
								throw new ParseError(
									`Relation "${rel}" belongs to table "${sourceTable}", not "${result.table}". ` +
										`Use just "${simpleRel}" or query from "${sourceTable}" table.`,
								);
							}
							foundRelation = true;
							// Extract just the relation name for the ORM
							relName = simpleRel;
						}
					} else {
						// Simple name (e.g., "author")
						// Try qualified format first: table.relation
						const qualifiedRelation = `${result.table}.${rel}`;
						if (schema.relations[qualifiedRelation]) {
							foundRelation = true;
							relName = rel;
						}
						// Also check simple format for backward compatibility
						else if (schema.relations[rel]) {
							foundRelation = true;
							relName = rel;
						}
					}

					if (!foundRelation) {
						const relations = Object.keys(schema.relations);
						// Find relations that belong to the current table (qualified format)
						const tableRelations = relations.filter((r) =>
							r.startsWith(`${result.table}.`),
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

					i++;

					// CLI-014: Check if next token is 'where' - filter on this relation
					const nextToken = tokens[i];
					let includeFilters: WhereClause[] | undefined;

					if (nextToken?.toLowerCase() === 'where') {
						includeFilters = [];
						i++; // Skip 'where'

						// Parse where clauses until we hit another keyword or relation
						while (i < tokens.length) {
							const possibleClause = tokens[i];
							if (!possibleClause) break;

							// Stop on keywords that end the include filter (except 'and' which continues)
							if (
								['limit', 'offset', 'order', 'include'].includes(
									possibleClause.toLowerCase(),
								)
							) {
								break;
							}

							// Handle 'and' - continue parsing
							if (possibleClause.toLowerCase() === 'and') {
								i++;
								continue;
							}

							// Try to parse a where condition
							try {
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
									// Unqualified column → implicit scoping to current include
									includeFilters.push(clause);
								}

								i = nextIndex;

								// Check for 'and' to continue, or stop
								const nextTok = tokens[i]?.toLowerCase();
								if (nextTok !== 'and') {
									break;
								}
								// 'and' found - loop will handle it
							} catch {
								// Not a valid where condition, stop parsing filters
								break;
							}
						}
					}

					result.include.push({
						relation: relName,
						...(includeFilters &&
							includeFilters.length > 0 && { where: includeFilters }),
					});
				}
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
						['where', 'limit', 'offset', 'include'].includes(col.toLowerCase())
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
				const relation = schema.relations[qualifiedRel] ?? schema.relations[inc.relation];
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
						const relation = schema.relations[qualifiedRel] ?? schema.relations[inc.relation];
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
