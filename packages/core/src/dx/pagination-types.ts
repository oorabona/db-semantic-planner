/**
 * @fileoverview Pagination and streaming type definitions for the DX layer.
 *
 * Contains types for offset-based pagination, cursor-based pagination,
 * and streaming query execution.
 *
 * @module pagination-types
 * @since R01
 */

import type { Dump } from '../adapter.js';

/**
 * Options for streaming query execution.
 * Options for configuring streaming behavior.
 */
export interface StreamOptions {
	/**
	 * Number of rows to fetch per batch from the database.
	 * Only affects PostgreSQL with pg-cursor configured.
	 * @default 100
	 */
	readonly chunkSize?: number;

	/**
	 * Callback invoked before streaming starts.
	 * Receives the query dump for observability/logging.
	 */
	readonly onStart?: (dump: Dump) => void;
}

/**
 * Options for offset-based pagination.
 */
export interface PaginateOptions {
	/**
	 * Page number (1-indexed).
	 * @default 1
	 */
	readonly page?: number;

	/**
	 * Number of items per page.
	 * @default 20
	 */
	readonly perPage?: number;

	/**
	 * Whether to include total count (requires additional COUNT query).
	 * Set to false for better performance when total is not needed.
	 * @default true
	 */
	readonly withCount?: boolean;
}

/**
 * Result of offset-based pagination.
 */
export interface PaginatedResult<T> {
	/** The data for the current page */
	readonly data: T[];

	/** Pagination metadata */
	readonly pagination: {
		/** Current page number (1-indexed) */
		readonly page: number;

		/** Items per page */
		readonly perPage: number;

		/** Total number of items (only if withCount: true) */
		readonly total?: number;

		/** Total number of pages (only if withCount: true) */
		readonly totalPages?: number;

		/** Whether there is a next page */
		readonly hasNextPage: boolean;

		/** Whether there is a previous page */
		readonly hasPrevPage: boolean;
	};
}

/**
 * Options for cursor-based pagination.
 */
export interface CursorPaginateOptions {
	/**
	 * Cursor pointing to the last item of the previous page.
	 * Pass undefined/null for the first page.
	 */
	readonly cursor?: string | null;

	/**
	 * Number of items to fetch.
	 * @default 20
	 */
	readonly limit?: number;

	/**
	 * Direction of pagination.
	 * - 'forward': fetch items after cursor (default)
	 * - 'backward': fetch items before cursor
	 * @default 'forward'
	 */
	readonly direction?: 'forward' | 'backward';
}

/**
 * Result of cursor-based pagination.
 */
export interface CursorPaginatedResult<T> {
	/** The data for the current page */
	readonly data: T[];

	/** Cursor for the next page (null if no more items) */
	readonly nextCursor: string | null;

	/** Cursor for the previous page (null if at the beginning) */
	readonly prevCursor: string | null;

	/** Whether there are more items after this page */
	readonly hasNextPage: boolean;

	/** Whether there are items before this page */
	readonly hasPrevPage: boolean;
}
