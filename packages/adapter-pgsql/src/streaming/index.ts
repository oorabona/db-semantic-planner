/**
 * Cursor-Based Streaming Support
 */

export {
	buildCloseCursor,
	buildDeclareCursor,
	buildFetch,
	buildFetchAll,
	buildFetchFirst,
	buildFetchForward,
	buildFetchNext,
	buildStreamingStatements,
	type CursorHoldOption,
	type CursorOptions,
	type CursorScrollOption,
	type FetchDirection,
	type FetchOptions,
	generateCursorName,
	type StreamConfig,
} from './cursor.js';
