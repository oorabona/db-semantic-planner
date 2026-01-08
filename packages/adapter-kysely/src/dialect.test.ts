/**
 * Tests for dialect detection and capability management.
 *
 * @module dialect.test
 */

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
	assertCapability,
	type DialectCapabilities,
	type DialectName,
	detectDialect,
	getCapabilities,
	getCapabilitiesForDialect,
	getDialectName,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
	SQLITE_CAPABILITIES,
	skipIfMissingCapability,
	UNKNOWN_CAPABILITIES,
	withMockedCapabilities,
} from './dialect.js';
import { UnsupportedOperationError } from './stream.js';

/**
 * Create a mock Kysely instance with a specific adapter name.
 */
function createMockDb(adapterName: string): Kysely<unknown> {
	return {
		getExecutor: () => ({
			adapter: {
				constructor: {
					name: adapterName,
				},
			},
		}),
	} as unknown as Kysely<unknown>;
}

/**
 * Create a mock Kysely instance without executor.
 */
function createMockDbWithoutExecutor(): Kysely<unknown> {
	return {} as Kysely<unknown>;
}

describe('dialect detection', () => {
	describe('detectDialect', () => {
		it('should detect PostgreSQL dialect', () => {
			const db = createMockDb('PostgresDialectAdapter');
			expect(detectDialect(db)).toBe('postgresql');
		});

		it('should detect PostgreSQL dialect (lowercase)', () => {
			const db = createMockDb('postgresadapter');
			expect(detectDialect(db)).toBe('postgresql');
		});

		it('should detect MySQL dialect', () => {
			const db = createMockDb('MysqlDialectAdapter');
			expect(detectDialect(db)).toBe('mysql');
		});

		it('should detect MySQL dialect (lowercase)', () => {
			const db = createMockDb('mysqladapter');
			expect(detectDialect(db)).toBe('mysql');
		});

		it('should detect SQLite dialect', () => {
			const db = createMockDb('SqliteDialectAdapter');
			expect(detectDialect(db)).toBe('sqlite');
		});

		it('should detect SQLite dialect (lowercase)', () => {
			const db = createMockDb('sqliteadapter');
			expect(detectDialect(db)).toBe('sqlite');
		});

		it('should detect MSSQL dialect', () => {
			const db = createMockDb('MssqlDialectAdapter');
			expect(detectDialect(db)).toBe('mssql');
		});

		it('should return unknown for unrecognized adapter', () => {
			const db = createMockDb('CustomDialectAdapter');
			expect(detectDialect(db)).toBe('unknown');
		});

		it('should return unknown when executor is missing', () => {
			const db = createMockDbWithoutExecutor();
			expect(detectDialect(db)).toBe('unknown');
		});

		it('should return unknown when adapter is missing', () => {
			const db = {
				getExecutor: () => ({}),
			} as unknown as Kysely<unknown>;
			expect(detectDialect(db)).toBe('unknown');
		});
	});
});

describe('capability profiles', () => {
	describe('PostgreSQL capabilities', () => {
		it('should have all capabilities enabled', () => {
			expect(POSTGRESQL_CAPABILITIES).toEqual({
				supportsCTE: true,
				supportsExplain: true,
				supportsWithSchema: true,
				supportsReturning: true,
				supportsNullsFirstLast: true,
				supportsStreaming: true,
				supportsArrayType: true,
			});
		});
	});

	describe('MySQL capabilities', () => {
		it('should have correct capabilities', () => {
			expect(MYSQL_CAPABILITIES).toEqual({
				supportsCTE: true,
				supportsExplain: true,
				supportsWithSchema: false,
				supportsReturning: false,
				supportsNullsFirstLast: true,
				supportsStreaming: false,
				supportsArrayType: false,
			});
		});

		it('should not support schema switching', () => {
			expect(MYSQL_CAPABILITIES.supportsWithSchema).toBe(false);
		});

		it('should not support streaming', () => {
			expect(MYSQL_CAPABILITIES.supportsStreaming).toBe(false);
		});
	});

	describe('SQLite capabilities', () => {
		it('should have correct capabilities', () => {
			expect(SQLITE_CAPABILITIES).toEqual({
				supportsCTE: true,
				supportsExplain: true,
				supportsWithSchema: false,
				supportsReturning: true,
				supportsNullsFirstLast: true,
				supportsStreaming: false,
				supportsArrayType: false,
			});
		});

		it('should support RETURNING (SQLite 3.35+)', () => {
			expect(SQLITE_CAPABILITIES.supportsReturning).toBe(true);
		});

		it('should not support schema switching', () => {
			expect(SQLITE_CAPABILITIES.supportsWithSchema).toBe(false);
		});
	});

	describe('MSSQL capabilities', () => {
		it('should have correct capabilities', () => {
			expect(MSSQL_CAPABILITIES).toEqual({
				supportsCTE: true,
				supportsExplain: true,
				supportsWithSchema: true,
				supportsReturning: false,
				supportsNullsFirstLast: false,
				supportsStreaming: false,
				supportsArrayType: false,
			});
		});
	});

	describe('Unknown dialect capabilities', () => {
		it('should have safe defaults', () => {
			expect(UNKNOWN_CAPABILITIES).toEqual({
				supportsCTE: true,
				supportsExplain: false,
				supportsWithSchema: false,
				supportsReturning: false,
				supportsNullsFirstLast: false,
				supportsStreaming: false,
				supportsArrayType: false,
			});
		});

		it('should support CTEs (most modern DBs do)', () => {
			expect(UNKNOWN_CAPABILITIES.supportsCTE).toBe(true);
		});

		it('should not support EXPLAIN (safety)', () => {
			expect(UNKNOWN_CAPABILITIES.supportsExplain).toBe(false);
		});
	});
});

describe('getCapabilities', () => {
	it('should return PostgreSQL capabilities for PostgreSQL adapter', () => {
		const db = createMockDb('PostgresDialectAdapter');
		expect(getCapabilities(db)).toEqual(POSTGRESQL_CAPABILITIES);
	});

	it('should return MySQL capabilities for MySQL adapter', () => {
		const db = createMockDb('MysqlDialectAdapter');
		expect(getCapabilities(db)).toEqual(MYSQL_CAPABILITIES);
	});

	it('should return SQLite capabilities for SQLite adapter', () => {
		const db = createMockDb('SqliteDialectAdapter');
		expect(getCapabilities(db)).toEqual(SQLITE_CAPABILITIES);
	});

	it('should return MSSQL capabilities for MSSQL adapter', () => {
		const db = createMockDb('MssqlDialectAdapter');
		expect(getCapabilities(db)).toEqual(MSSQL_CAPABILITIES);
	});

	it('should return unknown capabilities for unknown adapter', () => {
		const db = createMockDb('CustomAdapter');
		expect(getCapabilities(db)).toEqual(UNKNOWN_CAPABILITIES);
	});
});

describe('getCapabilitiesForDialect', () => {
	const testCases: Array<{
		dialect: DialectName;
		expected: DialectCapabilities;
	}> = [
		{ dialect: 'postgresql', expected: POSTGRESQL_CAPABILITIES },
		{ dialect: 'mysql', expected: MYSQL_CAPABILITIES },
		{ dialect: 'sqlite', expected: SQLITE_CAPABILITIES },
		{ dialect: 'mssql', expected: MSSQL_CAPABILITIES },
		{ dialect: 'unknown', expected: UNKNOWN_CAPABILITIES },
	];

	for (const { dialect, expected } of testCases) {
		it(`should return correct capabilities for ${dialect}`, () => {
			expect(getCapabilitiesForDialect(dialect)).toEqual(expected);
		});
	}
});

describe('assertCapability', () => {
	describe('when capability is supported', () => {
		it('should not throw for PostgreSQL with supportsWithSchema', () => {
			const db = createMockDb('PostgresDialectAdapter');
			expect(() =>
				assertCapability(db, 'supportsWithSchema', 'forTenant'),
			).not.toThrow();
		});

		it('should not throw for MySQL with supportsCTE', () => {
			const db = createMockDb('MysqlDialectAdapter');
			expect(() => assertCapability(db, 'supportsCTE', 'useCTE')).not.toThrow();
		});

		it('should not throw for SQLite with supportsReturning', () => {
			const db = createMockDb('SqliteDialectAdapter');
			expect(() =>
				assertCapability(db, 'supportsReturning', 'returning'),
			).not.toThrow();
		});
	});

	describe('when capability is not supported', () => {
		it('should throw UnsupportedOperationError for MySQL with supportsWithSchema', () => {
			const db = createMockDb('MysqlDialectAdapter');
			expect(() =>
				assertCapability(db, 'supportsWithSchema', 'forTenant'),
			).toThrow(UnsupportedOperationError);
		});

		it('should throw UnsupportedOperationError for SQLite with supportsWithSchema', () => {
			const db = createMockDb('SqliteDialectAdapter');
			expect(() =>
				assertCapability(db, 'supportsWithSchema', 'forTenant'),
			).toThrow(UnsupportedOperationError);
		});

		it('should throw UnsupportedOperationError for MySQL with supportsStreaming', () => {
			const db = createMockDb('MysqlDialectAdapter');
			expect(() => assertCapability(db, 'supportsStreaming', 'stream')).toThrow(
				UnsupportedOperationError,
			);
		});

		it('should include operation name in error', () => {
			const db = createMockDb('MysqlDialectAdapter');
			try {
				assertCapability(db, 'supportsWithSchema', 'forTenant');
			} catch (error) {
				expect(error).toBeInstanceOf(UnsupportedOperationError);
				expect((error as UnsupportedOperationError).operation).toBe(
					'forTenant',
				);
			}
		});

		it('should include capability name in error', () => {
			const db = createMockDb('MysqlDialectAdapter');
			try {
				assertCapability(db, 'supportsWithSchema', 'forTenant');
			} catch (error) {
				expect(error).toBeInstanceOf(UnsupportedOperationError);
				expect((error as UnsupportedOperationError).capability).toBe(
					'supportsWithSchema',
				);
			}
		});

		it('should include dialect name in error', () => {
			const db = createMockDb('MysqlDialectAdapter');
			try {
				assertCapability(db, 'supportsWithSchema', 'forTenant');
			} catch (error) {
				expect(error).toBeInstanceOf(UnsupportedOperationError);
				expect((error as UnsupportedOperationError).dialect).toBe('mysql');
			}
		});

		it('should include helpful guidance in error message', () => {
			const db = createMockDb('MysqlDialectAdapter');
			try {
				assertCapability(db, 'supportsWithSchema', 'forTenant');
			} catch (error) {
				expect(error).toBeInstanceOf(UnsupportedOperationError);
				expect((error as Error).message).toContain('database switching');
				expect((error as Error).message).toContain(
					'separate database connections',
				);
			}
		});

		it('should use custom guidance when provided', () => {
			const db = createMockDb('MysqlDialectAdapter');
			const customGuidance = 'Custom guidance message';
			try {
				assertCapability(db, 'supportsWithSchema', 'forTenant', customGuidance);
			} catch (error) {
				expect(error).toBeInstanceOf(UnsupportedOperationError);
				expect((error as Error).message).toContain(customGuidance);
			}
		});
	});
});

describe('BDD Scenarios', () => {
	describe('Feature: Multi-tenant Capability Guard', () => {
		describe('Scenario: forTenant works on PostgreSQL', () => {
			it('Given a Kysely instance with PostgresDialect And supportsWithSchema is true, When assertCapability for supportsWithSchema is called, Then no error is thrown', () => {
				// Given
				const db = createMockDb('PostgresDialectAdapter');
				const caps = getCapabilities(db);
				expect(caps.supportsWithSchema).toBe(true);

				// When/Then
				expect(() =>
					assertCapability(db, 'supportsWithSchema', 'forTenant'),
				).not.toThrow();
			});
		});

		describe('Scenario: forTenant throws on MySQL', () => {
			it('Given a Kysely instance with MysqlDialect And supportsWithSchema is false, When assertCapability for supportsWithSchema is called, Then UnsupportedOperationError is thrown', () => {
				// Given
				const db = createMockDb('MysqlDialectAdapter');
				const caps = getCapabilities(db);
				expect(caps.supportsWithSchema).toBe(false);

				// When/Then
				try {
					assertCapability(db, 'supportsWithSchema', 'forTenant');
					expect.fail('Expected UnsupportedOperationError to be thrown');
				} catch (error) {
					// Then
					expect(error).toBeInstanceOf(UnsupportedOperationError);
					expect((error as UnsupportedOperationError).operation).toBe(
						'forTenant',
					);
					expect((error as Error).message).toContain('supportsWithSchema');
					expect((error as Error).message).toContain('mysql');
				}
			});
		});

		describe('Scenario: forTenant throws on SQLite', () => {
			it('Given a Kysely instance with SqliteDialect, When assertCapability for supportsWithSchema is called, Then UnsupportedOperationError is thrown And error.message contains "SQLite"', () => {
				// Given
				const db = createMockDb('SqliteDialectAdapter');

				// When/Then
				try {
					assertCapability(db, 'supportsWithSchema', 'forTenant');
					expect.fail('Expected UnsupportedOperationError to be thrown');
				} catch (error) {
					// Then
					expect(error).toBeInstanceOf(UnsupportedOperationError);
					expect((error as Error).message.toLowerCase()).toContain('sqlite');
				}
			});
		});
	});

	describe('Feature: Dialect Detection', () => {
		describe('Scenario: Detect PostgreSQL dialect', () => {
			it('Given a Kysely instance configured with PostgresDialect, When getCapabilities(db) is called, Then all capabilities return true', () => {
				// Given
				const db = createMockDb('PostgresDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsCTE).toBe(true);
				expect(caps.supportsExplain).toBe(true);
				expect(caps.supportsWithSchema).toBe(true);
				expect(caps.supportsReturning).toBe(true);
				expect(caps.supportsNullsFirstLast).toBe(true);
				expect(caps.supportsStreaming).toBe(true);
			});

			it('And getDialectName(db) returns "postgresql"', () => {
				// Given
				const db = createMockDb('PostgresDialectAdapter');

				// When
				const dialect = detectDialect(db);

				// Then
				expect(dialect).toBe('postgresql');
			});
		});

		describe('Scenario: Detect MySQL dialect', () => {
			it('Given a Kysely instance configured with MysqlDialect, When getCapabilities(db) is called, Then supportsWithSchema returns false', () => {
				// Given
				const db = createMockDb('MysqlDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsWithSchema).toBe(false);
			});

			it('And supportsStreaming returns false', () => {
				// Given
				const db = createMockDb('MysqlDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsStreaming).toBe(false);
			});

			it('And supportsCTE returns true', () => {
				// Given
				const db = createMockDb('MysqlDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsCTE).toBe(true);
			});

			it('And getDialectName(db) returns "mysql"', () => {
				// Given
				const db = createMockDb('MysqlDialectAdapter');

				// When
				const dialect = detectDialect(db);

				// Then
				expect(dialect).toBe('mysql');
			});
		});

		describe('Scenario: Detect SQLite dialect', () => {
			it('Given a Kysely instance configured with SqliteDialect, When getCapabilities(db) is called, Then supportsWithSchema returns false', () => {
				// Given
				const db = createMockDb('SqliteDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsWithSchema).toBe(false);
			});

			it('And supportsReturning returns true', () => {
				// Given
				const db = createMockDb('SqliteDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsReturning).toBe(true);
			});

			it('And getDialectName(db) returns "sqlite"', () => {
				// Given
				const db = createMockDb('SqliteDialectAdapter');

				// When
				const dialect = detectDialect(db);

				// Then
				expect(dialect).toBe('sqlite');
			});
		});

		describe('Scenario: Unknown dialect returns safe defaults', () => {
			it('Given a Kysely instance with an unknown dialect, When getCapabilities(db) is called, Then all capabilities return false except supportsCTE', () => {
				// Given
				const db = createMockDb('UnknownDialectAdapter');

				// When
				const caps = getCapabilities(db);

				// Then
				expect(caps.supportsCTE).toBe(true);
				expect(caps.supportsExplain).toBe(false);
				expect(caps.supportsWithSchema).toBe(false);
				expect(caps.supportsReturning).toBe(false);
				expect(caps.supportsNullsFirstLast).toBe(false);
				expect(caps.supportsStreaming).toBe(false);
			});

			it('And getDialectName(db) returns "unknown"', () => {
				// Given
				const db = createMockDb('UnknownDialectAdapter');

				// When
				const dialect = detectDialect(db);

				// Then
				expect(dialect).toBe('unknown');
			});
		});
	});
});

// ============================================================================
// Test Helpers Tests (DIALECT-001 Block 5)
// ============================================================================

describe('test helpers', () => {
	describe('getDialectName', () => {
		it('should return dialect name as string', () => {
			const db = createMockDb('PostgresDialectAdapter');
			expect(getDialectName(db)).toBe('postgresql');
		});

		it('should work with all dialects', () => {
			expect(getDialectName(createMockDb('MysqlDialectAdapter'))).toBe('mysql');
			expect(getDialectName(createMockDb('SqliteDialectAdapter'))).toBe(
				'sqlite',
			);
			expect(getDialectName(createMockDb('MssqlDialectAdapter'))).toBe('mssql');
			expect(getDialectName(createMockDb('CustomAdapter'))).toBe('unknown');
		});
	});

	describe('skipIfMissingCapability', () => {
		it('should return false for supported capability', () => {
			const db = createMockDb('PostgresDialectAdapter');
			expect(skipIfMissingCapability(db, 'supportsStreaming')).toBe(false);
		});

		it('should return true for unsupported capability', () => {
			const db = createMockDb('MysqlDialectAdapter');
			expect(skipIfMissingCapability(db, 'supportsStreaming')).toBe(true);
		});

		it('should check supportsWithSchema correctly', () => {
			expect(
				skipIfMissingCapability(
					createMockDb('PostgresDialectAdapter'),
					'supportsWithSchema',
				),
			).toBe(false);
			expect(
				skipIfMissingCapability(
					createMockDb('MysqlDialectAdapter'),
					'supportsWithSchema',
				),
			).toBe(true);
		});

		it('should check supportsReturning correctly', () => {
			expect(
				skipIfMissingCapability(
					createMockDb('PostgresDialectAdapter'),
					'supportsReturning',
				),
			).toBe(false);
			expect(
				skipIfMissingCapability(
					createMockDb('MysqlDialectAdapter'),
					'supportsReturning',
				),
			).toBe(true);
			expect(
				skipIfMissingCapability(
					createMockDb('SqliteDialectAdapter'),
					'supportsReturning',
				),
			).toBe(false);
		});
	});

	describe('withMockedCapabilities', () => {
		it('should create a mock PostgreSQL db', () => {
			const mockDb = withMockedCapabilities('postgresql');
			expect(detectDialect(mockDb)).toBe('postgresql');
			expect(getCapabilities(mockDb).supportsStreaming).toBe(true);
		});

		it('should create a mock MySQL db', () => {
			const mockDb = withMockedCapabilities('mysql');
			expect(detectDialect(mockDb)).toBe('mysql');
			expect(getCapabilities(mockDb).supportsStreaming).toBe(false);
			expect(getCapabilities(mockDb).supportsWithSchema).toBe(false);
		});

		it('should create a mock SQLite db', () => {
			const mockDb = withMockedCapabilities('sqlite');
			expect(detectDialect(mockDb)).toBe('sqlite');
			expect(getCapabilities(mockDb).supportsReturning).toBe(true);
		});

		it('should create a mock MSSQL db', () => {
			const mockDb = withMockedCapabilities('mssql');
			expect(detectDialect(mockDb)).toBe('mssql');
			expect(getCapabilities(mockDb).supportsWithSchema).toBe(true);
		});

		it('should create a mock unknown db', () => {
			const mockDb = withMockedCapabilities('unknown');
			expect(detectDialect(mockDb)).toBe('unknown');
			expect(getCapabilities(mockDb).supportsCTE).toBe(true);
			expect(getCapabilities(mockDb).supportsStreaming).toBe(false);
		});

		it('should be usable with assertCapability', () => {
			const pgDb = withMockedCapabilities('postgresql');
			expect(() =>
				assertCapability(pgDb, 'supportsWithSchema', 'forTenant'),
			).not.toThrow();

			const mysqlDb = withMockedCapabilities('mysql');
			expect(() =>
				assertCapability(mysqlDb, 'supportsWithSchema', 'forTenant'),
			).toThrow(UnsupportedOperationError);
		});
	});
});
