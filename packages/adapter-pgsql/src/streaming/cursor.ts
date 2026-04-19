/**
 * Cursor-Based Streaming Support
 *
 * Generates PostgreSQL cursor statements for streaming large result sets.
 * Supports:
 * - DECLARE CURSOR
 * - FETCH (forward, backward, all)
 * - CLOSE CURSOR
 *
 * Note: This generates AST nodes for cursor operations.
 * Actual cursor execution requires a transaction context.
 */

import type { Node, FetchDirection as PgsqlFetchDirection } from '@pgsql/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Cursor scroll options.
 */
export type CursorScrollOption = 'scroll' | 'no_scroll';

/**
 * Cursor hold option (whether cursor survives transaction commit).
 */
export type CursorHoldOption = 'with_hold' | 'without_hold';

/**
 * Fetch direction for cursor.
 */
export type FetchDirection =
	| 'next'
	| 'prior'
	| 'first'
	| 'last'
	| 'absolute'
	| 'relative'
	| 'forward'
	| 'backward'
	| 'forward_all'
	| 'backward_all';

/**
 * Options for DECLARE CURSOR.
 */
export interface CursorOptions {
	/** Cursor name */
	name: string;
	/** The query to execute */
	query: Node;
	/** Scroll option (default: no_scroll) */
	scroll?: CursorScrollOption;
	/** Hold option (default: without_hold) */
	hold?: CursorHoldOption;
	/** Binary output (rarely used) */
	binary?: boolean;
}

/**
 * Options for FETCH.
 */
export interface FetchOptions {
	/** Cursor name */
	cursorName: string;
	/** Fetch direction */
	direction?: FetchDirection;
	/** Number of rows to fetch (for forward/backward) */
	count?: number;
}

// ============================================================================
// Cursor Builders
// ============================================================================

/**
 * Build a DECLARE CURSOR statement.
 *
 * @param options - Cursor declaration options
 * @returns DeclareCursorStmt AST node
 *
 * @example
 * ```typescript
 * const selectAst = { SelectStmt: { ... } };
 * const cursorAst = buildDeclareCursor({
 *   name: 'my_cursor',
 *   query: selectAst,
 *   scroll: 'no_scroll',
 *   hold: 'without_hold'
 * });
 * // Produces: DECLARE my_cursor NO SCROLL CURSOR WITHOUT HOLD FOR SELECT ...
 * ```
 */
export function buildDeclareCursor(options: CursorOptions): Node {
	let cursorOptions = 0;

	// Set options bitmask based on PostgreSQL constants
	if (options.binary) {
		cursorOptions |= 0x0001; // CURSOR_OPT_BINARY
	}
	if (options.scroll === 'scroll') {
		cursorOptions |= 0x0002; // CURSOR_OPT_SCROLL
	}
	if (options.scroll === 'no_scroll') {
		cursorOptions |= 0x0004; // CURSOR_OPT_NO_SCROLL
	}
	if (options.hold === 'with_hold') {
		cursorOptions |= 0x0010; // CURSOR_OPT_HOLD
	}

	return {
		DeclareCursorStmt: {
			portalname: options.name,
			options: cursorOptions,
			query: options.query,
		},
	};
}

/**
 * Build a FETCH statement.
 *
 * @param options - Fetch options
 * @returns FetchStmt AST node
 *
 * @example
 * ```typescript
 * const fetchAst = buildFetch({
 *   cursorName: 'my_cursor',
 *   direction: 'forward',
 *   count: 100
 * });
 * // Produces: FETCH FORWARD 100 FROM my_cursor
 * ```
 */
export function buildFetch(options: FetchOptions): Node {
	const dir = options.direction ?? 'next';

	// Calculate direction and howMany based on FetchDirection.
	// PostgreSQL semantics: FETCH FORWARD ALL / FETCH BACKWARD ALL fetches all remaining rows.
	//
	// TYPE HONESTY NOTE: @pgsql/types declares FetchStmt.howMany as `bigint`, but the
	// pgsql-deparser performs a strict Number identity check internally:
	//   if (node.howMany === 9223372036854776000) → emits "ALL"
	// A real BigInt (e.g. BigInt('9223372036854775807')) does NOT trigger this branch —
	// the deparser emits the literal number string instead of "ALL". This was verified
	// empirically: deparseSync({FetchStmt:{howMany:BigInt('9223372036854775807'),...}})
	// → "FETCH FORWARD 9223372036854775807 c" (not "FETCH FORWARD ALL c").
	//
	// Therefore the ALL sentinel must be assigned as a Number. We use `number | bigint`
	// to document that the variable holds either a real bigint (for counted fetches) or
	// a Number sentinel (for ALL). The `as unknown as bigint` cast on the sentinel line
	// satisfies the FetchStmt.howMany type while preserving the Number runtime value.
	//
	// TODO: file upstream issue against pgsql-deparser — FetchStmt.howMany comparison
	// should use Number() conversion to support real BigInt ALL sentinels.
	let direction: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let howMany: number | bigint;

	switch (dir) {
		case 'first':
			direction = 'FETCH_ABSOLUTE';
			howMany = BigInt(1);
			break;
		case 'last':
			direction = 'FETCH_ABSOLUTE';
			howMany = BigInt(-1);
			break;
		case 'forward_all':
			// FETCH FORWARD ALL — deparser sentinel: Number 9223372036854776000 (float64 ≈ INT64_MAX)
			direction = 'FETCH_FORWARD';
			howMany = 9223372036854776000 as unknown as bigint;
			break;
		case 'backward_all':
			// FETCH BACKWARD ALL — deparser sentinel: Number 9223372036854776000 (float64 ≈ INT64_MAX)
			direction = 'FETCH_BACKWARD';
			howMany = 9223372036854776000 as unknown as bigint;
			break;
		default:
			direction = mapFetchDirection(dir);
			howMany = BigInt(options.count ?? 1);
	}

	return {
		FetchStmt: {
			direction: direction as PgsqlFetchDirection,
			howMany,
			portalname: options.cursorName,
			ismove: false,
		},
	};
}

/**
 * Build a CLOSE cursor statement.
 *
 * @param cursorName - Name of cursor to close (or '*' for all)
 * @returns ClosePortalStmt AST node
 */
export function buildCloseCursor(cursorName: string): Node {
	// CLOSE ALL uses empty string or no portalname
	const stmt: { portalname?: string } = {};
	if (cursorName !== '*') {
		stmt.portalname = cursorName;
	}
	return { ClosePortalStmt: stmt };
}

// ============================================================================
// Convenience Builders
// ============================================================================

/**
 * Build FETCH NEXT (single row).
 */
export function buildFetchNext(cursorName: string): Node {
	return buildFetch({ cursorName, direction: 'next', count: 1 });
}

/**
 * Build FETCH FORWARD N (multiple rows).
 */
export function buildFetchForward(cursorName: string, count: number): Node {
	return buildFetch({ cursorName, direction: 'forward', count });
}

/**
 * Build FETCH ALL (remaining rows).
 */
export function buildFetchAll(cursorName: string): Node {
	return buildFetch({ cursorName, direction: 'forward_all' });
}

/**
 * Build FETCH FIRST (move to start and get first row).
 */
export function buildFetchFirst(cursorName: string): Node {
	return buildFetch({ cursorName, direction: 'first' });
}

// ============================================================================
// Streaming Iterator Pattern
// ============================================================================

/**
 * Configuration for streaming query execution.
 */
export interface StreamConfig {
	/** Cursor name prefix (will be appended with unique ID) */
	cursorPrefix?: string;
	/** Batch size for each fetch (default: 100) */
	batchSize?: number;
	/** Whether cursor should survive transaction (default: false) */
	withHold?: boolean;
}

/**
 * Generate a unique cursor name.
 *
 * @param prefix - Cursor name prefix
 * @returns Unique cursor name
 */
export function generateCursorName(prefix = '__cursor'): string {
	const timestamp = Date.now().toString(36);
	const random = crypto.randomUUID().substring(0, 8);
	return `${prefix}_${timestamp}_${random}`;
}

/**
 * Build all statements needed for streaming query execution.
 *
 * @param query - The SELECT query to stream
 * @param config - Streaming configuration
 * @returns Object with cursor name and statement builders
 *
 * @example
 * ```typescript
 * const { cursorName, declare, fetchBatch, close } = buildStreamingStatements(
 *   selectAst,
 *   { batchSize: 100 }
 * );
 *
 * // In transaction:
 * // 1. Execute declare
 * // 2. Loop: execute fetchBatch, process rows, until empty
 * // 3. Execute close
 * ```
 */
export function buildStreamingStatements(
	query: Node,
	config: StreamConfig = {},
): {
	cursorName: string;
	declare: Node;
	fetchBatch: Node;
	fetchAll: Node;
	close: Node;
} {
	const cursorName = generateCursorName(config.cursorPrefix);
	const batchSize = config.batchSize ?? 100;

	return {
		cursorName,
		declare: buildDeclareCursor({
			name: cursorName,
			query,
			scroll: 'no_scroll',
			hold: config.withHold ? 'with_hold' : 'without_hold',
		}),
		fetchBatch: buildFetchForward(cursorName, batchSize),
		fetchAll: buildFetchAll(cursorName),
		close: buildCloseCursor(cursorName),
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map FetchDirection to PostgreSQL enum value.
 */
function mapFetchDirection(direction: FetchDirection): string {
	const mapping: Record<FetchDirection, string> = {
		next: 'FETCH_FORWARD',
		prior: 'FETCH_BACKWARD',
		first: 'FETCH_ABSOLUTE',
		last: 'FETCH_ABSOLUTE',
		absolute: 'FETCH_ABSOLUTE',
		relative: 'FETCH_RELATIVE',
		forward: 'FETCH_FORWARD',
		backward: 'FETCH_BACKWARD',
		forward_all: 'FETCH_FORWARD_ALL',
		backward_all: 'FETCH_BACKWARD_ALL',
	};

	return mapping[direction];
}
