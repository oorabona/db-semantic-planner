/**
 * DEMO-E2E: Assertion Parser for .assert.dbsp files
 *
 * Parses YAML-like assertion files that validate REPL query output.
 * Each assertion block starts with "---" followed by query reference.
 */

// Valid assertion types
export const ASSERTION_TYPES = [
	// Existing (keep for backward compat)
	'output.contains',
	'output.equals',
	'output.matches',
	'sql.contains',
	'sql.equals',
	'sql.matches',
	'params.equals',
	'params.length',
	'plan.contains',
	'success',
	'error.contains',

	// NEW: Typed SQL assertions
	'sql.table', // Table name (logical or physical)
	'sql.column', // Column name in SQL
	'sql.join', // JOIN clause present

	// NEW: Typed params assertions
	'params.type', // Type validation per param
	'params.value', // Specific param value by index

	// NEW: DB-only assertions (skipped in dry-run)
	'db.rows.equals', // Exact row count
	'db.rows.min', // At least N rows
	'db.rows.max', // At most N rows
	'db.column.exists', // Column in result
	'db.value.equals', // Specific cell value
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

/**
 * Check if an assertion type requires database connection
 * All db.* assertions need actual query execution
 */
export function requiresDatabase(type: AssertionType): boolean {
	return type.startsWith('db.');
}

/**
 * A single assertion within a block
 */
export interface Assertion {
	type: AssertionType;
	value: string | number | boolean | unknown[];
	line: number;
}

/**
 * A block of assertions for a single query
 */
export interface AssertionBlock {
	/** Query index (0-based) if using "query: N" */
	queryIndex?: number;
	/** Query text pattern if using "match: text" */
	queryMatch?: string;
	/** Line number where the block starts */
	startLine: number;
	/** All assertions in this block */
	assertions: Assertion[];
}

/**
 * Result of parsing an assertion file
 */
export interface ParseResult {
	blocks: AssertionBlock[];
	errors: ParseError[];
}

/**
 * A parsing error with location information
 */
export interface ParseError {
	line: number;
	message: string;
}

/**
 * Parse an assertion file content into structured blocks
 *
 * @param content - The raw content of the .assert.dbsp file
 * @returns ParseResult with blocks and any parsing errors
 */
export function parseAssertionFile(content: string): ParseResult {
	const lines = content.split('\n');
	const blocks: AssertionBlock[] = [];
	const errors: ParseError[] = [];

	let currentBlock: AssertionBlock | null = null;

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1; // 1-based line numbers for user display
		const line = lines[i];
		if (line === undefined) continue;
		const trimmed = line.trim();

		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		// Check for block start: --- query: N or --- match: text
		if (trimmed.startsWith('---')) {
			// Save previous block if exists
			if (currentBlock) {
				blocks.push(currentBlock);
			}

			const blockHeader = trimmed.slice(3).trim();
			const parsed = parseBlockHeader(blockHeader, lineNum);

			if (parsed.error || !parsed.block) {
				errors.push({
					line: lineNum,
					message: parsed.error ?? 'Invalid block header',
				});
				currentBlock = null;
			} else {
				currentBlock = {
					...parsed.block,
					startLine: lineNum,
					assertions: [],
				};
			}
			continue;
		}

		// Parse assertion line within a block
		if (currentBlock) {
			const assertion = parseAssertionLine(trimmed, lineNum);
			if (assertion.error) {
				errors.push({ line: lineNum, message: assertion.error });
			} else if (assertion.assertion) {
				currentBlock.assertions.push(assertion.assertion);
			}
		} else {
			// Assertion outside of any block
			errors.push({
				line: lineNum,
				message:
					'Assertion found outside of any block. Start a block with "--- query: N" or "--- match: text"',
			});
		}
	}

	// Don't forget the last block
	if (currentBlock) {
		blocks.push(currentBlock);
	}

	return { blocks, errors };
}

/**
 * Parse a block header (after the "---")
 */
function parseBlockHeader(
	header: string,
	_line: number,
): { block?: Partial<AssertionBlock>; error?: string } {
	// Handle "query: N"
	const queryMatch = header.match(/^query:\s*(\d+)$/);
	const queryIndexStr = queryMatch?.[1];
	if (queryIndexStr !== undefined) {
		const index = parseInt(queryIndexStr, 10);
		return { block: { queryIndex: index } };
	}

	// Handle "match: text"
	const matchMatch = header.match(/^match:\s*(.+)$/);
	const matchText = matchMatch?.[1];
	if (matchText !== undefined) {
		const text = matchText.trim();
		if (!text) {
			return { error: 'Empty match pattern' };
		}
		return { block: { queryMatch: text } };
	}

	// Invalid header format
	return {
		error: `Invalid block header: "${header}". Expected "query: N" or "match: text"`,
	};
}

/**
 * Parse a single assertion line
 */
function parseAssertionLine(
	line: string,
	lineNum: number,
): { assertion?: Assertion; error?: string } {
	// Find the colon separator
	const colonIndex = line.indexOf(':');
	if (colonIndex === -1) {
		return {
			error: `Invalid assertion syntax: "${line}". Expected "type: value"`,
		};
	}

	const typeStr = line.slice(0, colonIndex).trim();
	const valueStr = line.slice(colonIndex + 1).trim();

	// Validate assertion type
	if (!isValidAssertionType(typeStr)) {
		return {
			error: `Unknown assertion type: "${typeStr}". Valid types: ${ASSERTION_TYPES.join(', ')}`,
		};
	}

	const type = typeStr as AssertionType;

	// Parse value based on type
	const parsedValue = parseAssertionValue(type, valueStr);
	if (parsedValue.error || parsedValue.value === undefined) {
		return { error: parsedValue.error ?? 'Failed to parse assertion value' };
	}

	return {
		assertion: {
			type,
			value: parsedValue.value,
			line: lineNum,
		},
	};
}

/**
 * Check if a string is a valid assertion type
 */
function isValidAssertionType(type: string): type is AssertionType {
	return ASSERTION_TYPES.includes(type as AssertionType);
}

/**
 * Parse the value part of an assertion based on its type
 */
function parseAssertionValue(
	type: AssertionType,
	valueStr: string,
): { value?: string | number | boolean | unknown[]; error?: string } {
	switch (type) {
		// Boolean value
		case 'success':
			if (valueStr === 'true') return { value: true };
			if (valueStr === 'false') return { value: false };
			return {
				error: `Invalid boolean value for "success": "${valueStr}". Expected "true" or "false"`,
			};

		// Numeric value
		case 'params.length': {
			const num = parseInt(valueStr, 10);
			if (Number.isNaN(num) || num < 0) {
				return {
					error: `Invalid number for "params.length": "${valueStr}". Expected non-negative integer`,
				};
			}
			return { value: num };
		}

		// JSON array value
		case 'params.equals':
			try {
				const parsed = JSON.parse(valueStr);
				if (!Array.isArray(parsed)) {
					return {
						error: `Invalid params.equals value: expected JSON array, got ${typeof parsed}`,
					};
				}
				return { value: parsed };
			} catch (_e) {
				return { error: `Invalid JSON for "params.equals": ${valueStr}` };
			}

		// String values (all others)
		case 'output.contains':
		case 'output.equals':
		case 'output.matches':
		case 'sql.contains':
		case 'sql.equals':
		case 'sql.matches':
		case 'plan.contains':
		case 'error.contains':
			// For regex types, validate the pattern
			if (type.endsWith('.matches')) {
				try {
					new RegExp(valueStr);
				} catch (_e) {
					return { error: `Invalid regex pattern: "${valueStr}"` };
				}
			}
			return { value: valueStr };

		default:
			return { error: `Unhandled assertion type: ${type}` };
	}
}

/**
 * Validate that all query references in assertion blocks are valid
 *
 * @param blocks - Parsed assertion blocks
 * @param queryCount - Number of queries in the query file
 * @param queries - The actual query strings (for match validation)
 * @returns Array of validation errors
 */
export function validateAssertionBlocks(
	blocks: AssertionBlock[],
	queryCount: number,
	queries: string[],
): ParseError[] {
	const errors: ParseError[] = [];

	for (const block of blocks) {
		// Validate query index
		if (block.queryIndex !== undefined) {
			if (block.queryIndex < 0 || block.queryIndex >= queryCount) {
				errors.push({
					line: block.startLine,
					message: `Query index ${block.queryIndex} out of bounds (0-${queryCount - 1})`,
				});
			}
		}

		// Validate query match and check for ambiguity
		if (block.queryMatch !== undefined) {
			const matchingIndices = queries
				.map((q, i) => (q.trim() === block.queryMatch?.trim() ? i : -1))
				.filter((i) => i !== -1);

			if (matchingIndices.length === 0) {
				errors.push({
					line: block.startLine,
					message: `No query matches "${block.queryMatch}"`,
				});
			} else if (matchingIndices.length > 1) {
				// ERR-06: Ambiguous match
				errors.push({
					line: block.startLine,
					message: `Ambiguous match: '${block.queryMatch}' matches queries ${matchingIndices.join(', ')}. Use query index instead.`,
				});
			}
		}

		// Warn if block has no assertions
		if (block.assertions.length === 0) {
			errors.push({
				line: block.startLine,
				message: 'Block has no assertions',
			});
		}
	}

	return errors;
}

/**
 * Resolve which query index a block refers to
 *
 * @param block - The assertion block
 * @param queries - The query strings
 * @returns The resolved query index, or -1 if not found
 */
export function resolveQueryIndex(
	block: AssertionBlock,
	queries: string[],
): number {
	if (block.queryIndex !== undefined) {
		return block.queryIndex;
	}

	if (block.queryMatch !== undefined) {
		const index = queries.findIndex(
			(q) => q.trim() === block.queryMatch?.trim(),
		);
		return index;
	}

	return -1;
}
