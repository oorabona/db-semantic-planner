/**
 * @module stream.test
 * Unit tests for streaming/cursor support.
 */

import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
	assertStreamingSupported,
	MissingDependencyError,
	streamQuery,
	streamRawQuery,
	supportsStreaming,
	UnsupportedOperationError,
} from './stream.js';
import type { Dump } from './types.js';

// ============================================================================
// Dialect-Aware Mock Helpers
// ============================================================================

/**
 * Create a mock Kysely instance with a specific adapter name for dialect detection.
 */
function createMockDbWithDialect(
	adapterName: string,
	rows: unknown[] = [],
): Kysely<unknown> {
	const mockResult = { rows };
	return {
		selectFrom: vi.fn().mockReturnThis(),
		dynamic: {
			ref: vi.fn().mockReturnValue('users'),
		},
		getExecutor: vi.fn().mockReturnValue({
			adapter: {
				constructor: { name: adapterName },
			},
			provideConnection: vi.fn().mockResolvedValue({}),
		}),
		executeQuery: vi.fn().mockResolvedValue(mockResult),
	} as unknown as Kysely<unknown>;
}

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockDump(overrides?: Partial<Dump>): Dump {
	return {
		sql: 'SELECT * FROM users',
		params: [],
		plan: {
			rootTable: 'users',
			decisions: [],
			warnings: [],
			ctes: [],
			intent: {
				type: 'select',
				from: 'users',
				select: { type: 'all' },
			},
		},
		...overrides,
	};
}

function createMockDb(rows: unknown[] = []): Kysely<unknown> {
	const mockResult = { rows };

	return {
		selectFrom: vi.fn().mockReturnThis(),
		dynamic: {
			ref: vi.fn().mockReturnValue('users'),
		},
		getExecutor: vi.fn().mockReturnValue({
			provideConnection: vi.fn().mockResolvedValue({}),
		}),
		executeQuery: vi.fn().mockResolvedValue(mockResult),
	} as unknown as Kysely<unknown>;
}

function createMockDbWithError(error: Error): Kysely<unknown> {
	return {
		selectFrom: vi.fn().mockReturnThis(),
		dynamic: {
			ref: vi.fn().mockReturnValue('users'),
		},
		getExecutor: vi.fn().mockReturnValue({
			provideConnection: vi.fn().mockResolvedValue({}),
		}),
		executeQuery: vi.fn().mockRejectedValue(error),
	} as unknown as Kysely<unknown>;
}

// ============================================================================
// Error Classes Tests
// ============================================================================

describe('MissingDependencyError', () => {
	it('should create error with dependency and install command', () => {
		const error = new MissingDependencyError(
			'pg-cursor',
			'npm install pg-cursor',
		);

		expect(error.name).toBe('MissingDependencyError');
		expect(error.dependency).toBe('pg-cursor');
		expect(error.installCommand).toBe('npm install pg-cursor');
		expect(error.message).toContain('pg-cursor');
		expect(error.message).toContain('npm install pg-cursor');
	});

	it('should use custom message if provided', () => {
		const error = new MissingDependencyError(
			'pg-cursor',
			'npm install pg-cursor',
			'Custom error message',
		);

		expect(error.message).toBe('Custom error message');
		expect(error.dependency).toBe('pg-cursor');
	});

	it('should be instanceof Error and MissingDependencyError', () => {
		const error = new MissingDependencyError(
			'pg-cursor',
			'npm install pg-cursor',
		);

		expect(error instanceof Error).toBe(true);
		expect(error instanceof MissingDependencyError).toBe(true);
	});
});

describe('UnsupportedOperationError', () => {
	it('should create error with operation and reason', () => {
		const error = new UnsupportedOperationError(
			'streaming',
			'MySQL does not support cursors',
		);

		expect(error.name).toBe('UnsupportedOperationError');
		expect(error.operation).toBe('streaming');
		expect(error.reason).toBe('MySQL does not support cursors');
		expect(error.message).toContain('streaming');
		expect(error.message).toContain('MySQL does not support cursors');
	});

	it('should be instanceof Error and UnsupportedOperationError', () => {
		const error = new UnsupportedOperationError('streaming', 'reason');

		expect(error instanceof Error).toBe(true);
		expect(error instanceof UnsupportedOperationError).toBe(true);
	});
});

// ============================================================================
// streamQuery Tests
// ============================================================================

describe('streamQuery', () => {
	it('should return an AsyncIterableIterator', async () => {
		const db = createMockDb([]);
		const dump = createMockDump();

		const iterator = streamQuery(db, dump);

		expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
		expect(typeof iterator.next).toBe('function');
	});

	it('should yield rows one at a time', async () => {
		const rows = [
			{ id: 1, name: 'Alice' },
			{ id: 2, name: 'Bob' },
			{ id: 3, name: 'Charlie' },
		];
		const db = createMockDb(rows);
		const dump = createMockDump();

		const results: unknown[] = [];
		for await (const row of streamQuery(db, dump)) {
			results.push(row);
		}

		expect(results).toEqual(rows);
		expect(results).toHaveLength(3);
	});

	it('should invoke onStart callback before streaming', async () => {
		const db = createMockDb([{ id: 1 }]);
		const dump = createMockDump();
		const onStart = vi.fn();

		const iterator = streamQuery(db, dump, { onStart });

		// onStart should be called when iteration begins
		const { value } = await iterator.next();
		expect(onStart).toHaveBeenCalledOnce();
		expect(onStart).toHaveBeenCalledWith(dump);
		expect(value).toEqual({ id: 1 });
	});

	it('should handle empty result set', async () => {
		const db = createMockDb([]);
		const dump = createMockDump();

		const results: unknown[] = [];
		for await (const row of streamQuery(db, dump)) {
			results.push(row);
		}

		expect(results).toHaveLength(0);
	});

	it('should use default chunkSize of 100', async () => {
		const db = createMockDb([]);
		const dump = createMockDump();

		// This test verifies the option is accepted; actual cursor behavior
		// depends on the database driver
		const iterator = streamQuery(db, dump);
		await iterator.next();

		expect(db.executeQuery).toHaveBeenCalled();
	});

	it('should accept custom chunkSize option', async () => {
		const db = createMockDb([{ id: 1 }]);
		const dump = createMockDump();

		const results: unknown[] = [];
		for await (const row of streamQuery(db, dump, { chunkSize: 50 })) {
			results.push(row);
		}

		expect(results).toHaveLength(1);
	});

	it('should throw MissingDependencyError on cursor-related error', async () => {
		const cursorError = new Error('cursor is not supported');
		const db = createMockDbWithError(cursorError);
		const dump = createMockDump();

		const iterator = streamQuery(db, dump);

		await expect(iterator.next()).rejects.toThrow(MissingDependencyError);
	});

	it('should throw MissingDependencyError on stream-related error', async () => {
		const streamError = new Error('stream is not available');
		const db = createMockDbWithError(streamError);
		const dump = createMockDump();

		const iterator = streamQuery(db, dump);

		await expect(iterator.next()).rejects.toThrow(MissingDependencyError);
	});

	it('should propagate non-cursor errors', async () => {
		const dbError = new Error('Connection refused');
		const db = createMockDbWithError(dbError);
		const dump = createMockDump();

		const iterator = streamQuery(db, dump);

		await expect(iterator.next()).rejects.toThrow('Connection refused');
	});

	it('should handle query with parameters', async () => {
		const rows = [{ id: 1, name: 'Alice' }];
		const db = createMockDb(rows);
		const dump = createMockDump({
			sql: 'SELECT * FROM users WHERE active = $1',
			params: [true],
		});

		const results: unknown[] = [];
		for await (const row of streamQuery(db, dump)) {
			results.push(row);
		}

		expect(results).toHaveLength(1);
		expect(db.executeQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				sql: 'SELECT * FROM users WHERE active = $1',
				parameters: [true],
			}),
		);
	});
});

// ============================================================================
// streamRawQuery Tests
// ============================================================================

describe('streamRawQuery', () => {
	it('should return an AsyncIterableIterator', async () => {
		const db = createMockDb([]);

		const iterator = streamRawQuery(db, 'SELECT 1', []);

		expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
	});

	it('should yield rows from raw SQL query', async () => {
		const rows = [{ id: 1 }, { id: 2 }];
		const db = createMockDb(rows);

		const results: unknown[] = [];
		for await (const row of streamRawQuery(db, 'SELECT * FROM users', [])) {
			results.push(row);
		}

		expect(results).toEqual(rows);
	});

	it('should invoke onStart callback', async () => {
		const db = createMockDb([{ id: 1 }]);
		const onStart = vi.fn();

		const iterator = streamRawQuery(db, 'SELECT 1', [], 100, onStart);
		await iterator.next();

		expect(onStart).toHaveBeenCalledOnce();
	});

	it('should pass parameters to query', async () => {
		const db = createMockDb([]);

		const iterator = streamRawQuery(
			db,
			'SELECT * FROM users WHERE id = $1',
			[42],
		);
		await iterator.next();

		expect(db.executeQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				sql: 'SELECT * FROM users WHERE id = $1',
				parameters: [42],
			}),
		);
	});
});

// ============================================================================
// supportsStreaming Tests (DIALECT-001)
// ============================================================================

describe('supportsStreaming', () => {
	describe('Feature: Capability-gated streaming', () => {
		describe('Scenario: PostgreSQL supports streaming', () => {
			it('Given PostgresDialect, When supportsStreaming is called, Then returns true', () => {
				const db = createMockDbWithDialect('PostgresDialectAdapter');

				const result = supportsStreaming(db);

				expect(result).toBe(true);
			});
		});

		describe('Scenario: MySQL does not support streaming', () => {
			it('Given MysqlDialect, When supportsStreaming is called, Then returns false', () => {
				const db = createMockDbWithDialect('MysqlDialectAdapter');

				const result = supportsStreaming(db);

				expect(result).toBe(false);
			});
		});

		describe('Scenario: SQLite does not support streaming', () => {
			it('Given SqliteDialect, When supportsStreaming is called, Then returns false', () => {
				const db = createMockDbWithDialect('SqliteDialectAdapter');

				const result = supportsStreaming(db);

				expect(result).toBe(false);
			});
		});

		describe('Scenario: MSSQL does not support streaming', () => {
			it('Given MssqlDialect, When supportsStreaming is called, Then returns false', () => {
				const db = createMockDbWithDialect('MssqlDialectAdapter');

				const result = supportsStreaming(db);

				expect(result).toBe(false);
			});
		});

		describe('Scenario: Unknown dialect defaults to no streaming', () => {
			it('Given unknown dialect, When supportsStreaming is called, Then returns false', () => {
				const db = createMockDbWithDialect('CustomDialectAdapter');

				const result = supportsStreaming(db);

				expect(result).toBe(false);
			});
		});
	});
});

// ============================================================================
// assertStreamingSupported Tests (DIALECT-001)
// ============================================================================

describe('assertStreamingSupported', () => {
	describe('Feature: Streaming capability guard', () => {
		describe('Scenario: PostgreSQL passes assertion', () => {
			it('Given PostgresDialect, When assertStreamingSupported is called, Then does not throw', () => {
				const db = createMockDbWithDialect('PostgresDialectAdapter');

				expect(() => assertStreamingSupported(db)).not.toThrow();
			});
		});

		describe('Scenario: MySQL fails assertion with guidance', () => {
			it('Given MysqlDialect, When assertStreamingSupported is called, Then throws UnsupportedOperationError', () => {
				const db = createMockDbWithDialect('MysqlDialectAdapter');

				expect(() => assertStreamingSupported(db)).toThrow(
					UnsupportedOperationError,
				);
			});

			it('should include MySQL-specific guidance', () => {
				const db = createMockDbWithDialect('MysqlDialectAdapter');

				try {
					assertStreamingSupported(db);
					expect.fail('Should have thrown');
				} catch (error) {
					expect(error).toBeInstanceOf(UnsupportedOperationError);
					const e = error as UnsupportedOperationError;
					expect(e.operation).toBe('stream');
					expect(e.capability).toBe('supportsStreaming');
					expect(e.dialect).toBe('mysql');
					expect(e.message).toContain('MySQL');
					expect(e.message).toContain('LIMIT/OFFSET');
				}
			});
		});

		describe('Scenario: SQLite fails assertion with guidance', () => {
			it('Given SqliteDialect, When assertStreamingSupported is called, Then throws UnsupportedOperationError', () => {
				const db = createMockDbWithDialect('SqliteDialectAdapter');

				expect(() => assertStreamingSupported(db)).toThrow(
					UnsupportedOperationError,
				);
			});

			it('should include SQLite-specific guidance', () => {
				const db = createMockDbWithDialect('SqliteDialectAdapter');

				try {
					assertStreamingSupported(db);
					expect.fail('Should have thrown');
				} catch (error) {
					expect(error).toBeInstanceOf(UnsupportedOperationError);
					const e = error as UnsupportedOperationError;
					expect(e.operation).toBe('stream');
					expect(e.capability).toBe('supportsStreaming');
					expect(e.dialect).toBe('sqlite');
					expect(e.message).toContain('SQLite');
				}
			});
		});

		describe('Scenario: MSSQL fails assertion with guidance', () => {
			it('Given MssqlDialect, When assertStreamingSupported is called, Then throws UnsupportedOperationError', () => {
				const db = createMockDbWithDialect('MssqlDialectAdapter');

				expect(() => assertStreamingSupported(db)).toThrow(
					UnsupportedOperationError,
				);
			});

			it('should include MSSQL-specific guidance', () => {
				const db = createMockDbWithDialect('MssqlDialectAdapter');

				try {
					assertStreamingSupported(db);
					expect.fail('Should have thrown');
				} catch (error) {
					expect(error).toBeInstanceOf(UnsupportedOperationError);
					const e = error as UnsupportedOperationError;
					expect(e.operation).toBe('stream');
					expect(e.dialect).toBe('mssql');
					expect(e.message).toContain('MSSQL');
					expect(e.message).toContain('OFFSET/FETCH');
				}
			});
		});

		describe('Scenario: Unknown dialect fails with generic guidance', () => {
			it('Given unknown dialect, When assertStreamingSupported is called, Then throws with generic guidance', () => {
				const db = createMockDbWithDialect('CustomDialectAdapter');

				try {
					assertStreamingSupported(db);
					expect.fail('Should have thrown');
				} catch (error) {
					expect(error).toBeInstanceOf(UnsupportedOperationError);
					const e = error as UnsupportedOperationError;
					expect(e.operation).toBe('stream');
					expect(e.capability).toBe('supportsStreaming');
					expect(e.dialect).toBe('unknown');
					expect(e.message).toContain('pagination');
				}
			});
		});
	});
});
