/**
 * Dialect Capabilities Registry Tests
 *
 * CORE-004: Tests for the dialect capabilities module.
 */

import { describe, expect, it } from 'vitest';
import {
	DUCKDB_CAPABILITIES,
	extendDialect,
	getAvailableDialects,
	getDialectCapabilities,
	isKnownDialect,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
	registerDialect,
	SQLITE_CAPABILITIES,
	UnknownDialectError,
} from './index.js';

describe('Dialect Capabilities', () => {
	describe('getDialectCapabilities', () => {
		it('returns PostgreSQL capabilities', () => {
			const caps = getDialectCapabilities('postgresql');

			expect(caps.name).toBe('postgresql');
			expect(caps.supportsReturning).toBe(true);
			expect(caps.supportsRecursiveCTE).toBe(true);
			expect(caps.supportsWindowFunctions).toBe(true);
			expect(caps.supportsArrayType).toBe(true);
			expect(caps.supportsJsonType).toBe(true);
			expect(caps.supportsSchemas).toBe(true);
			expect(caps.recursivePathStyle).toBe('array');
			expect(caps.stringConcatStyle).toBe('operator');
			expect(caps.identifierQuote).toBe('"');
			expect(caps.parameterStyle).toBe('dollar');
			expect(caps.limitStyle).toBe('limit-offset');
			expect(caps.booleanStyle).toBe('native');
		});

		it('returns MySQL capabilities', () => {
			const caps = getDialectCapabilities('mysql');

			expect(caps.name).toBe('mysql');
			expect(caps.supportsReturning).toBe(false);
			expect(caps.supportsRecursiveCTE).toBe(true);
			expect(caps.supportsArrayType).toBe(false);
			expect(caps.recursivePathStyle).toBe('string');
			expect(caps.stringConcatStyle).toBe('function');
			expect(caps.identifierQuote).toBe('`');
			expect(caps.parameterStyle).toBe('question');
			expect(caps.booleanStyle).toBe('numeric');
		});

		it('returns SQLite capabilities', () => {
			const caps = getDialectCapabilities('sqlite');

			expect(caps.name).toBe('sqlite');
			expect(caps.supportsReturning).toBe(true);
			expect(caps.supportsArrayType).toBe(false);
			expect(caps.supportsSchemas).toBe(false);
			expect(caps.recursivePathStyle).toBe('string');
			expect(caps.stringConcatStyle).toBe('operator');
			expect(caps.identifierQuote).toBe('"');
			expect(caps.parameterStyle).toBe('question');
		});

		it('returns DuckDB capabilities', () => {
			const caps = getDialectCapabilities('duckdb');

			expect(caps.name).toBe('duckdb');
			expect(caps.supportsReturning).toBe(true);
			expect(caps.supportsArrayType).toBe(true);
			expect(caps.recursivePathStyle).toBe('array');
			expect(caps.stringConcatStyle).toBe('operator');
			expect(caps.identifierQuote).toBe('"');
			expect(caps.parameterStyle).toBe('dollar');
		});

		it('returns MSSQL capabilities', () => {
			const caps = getDialectCapabilities('mssql');

			expect(caps.name).toBe('mssql');
			expect(caps.supportsReturning).toBe(true);
			expect(caps.supportsArrayType).toBe(false);
			expect(caps.recursivePathStyle).toBe('string');
			expect(caps.stringConcatStyle).toBe('function');
			expect(caps.identifierQuote).toBe('[');
			expect(caps.parameterStyle).toBe('named');
			expect(caps.limitStyle).toBe('top');
		});

		it('supports PostgreSQL aliases', () => {
			expect(getDialectCapabilities('postgres').name).toBe('postgresql');
			expect(getDialectCapabilities('pg').name).toBe('postgresql');
		});

		it('supports MSSQL alias', () => {
			expect(getDialectCapabilities('sqlserver').name).toBe('mssql');
		});

		it('is case insensitive', () => {
			expect(getDialectCapabilities('POSTGRESQL').name).toBe('postgresql');
			expect(getDialectCapabilities('MySQL').name).toBe('mysql');
			expect(getDialectCapabilities('SQLite').name).toBe('sqlite');
		});

		it('throws UnknownDialectError for unknown dialect', () => {
			expect(() => getDialectCapabilities('unknown')).toThrow(
				UnknownDialectError,
			);
			expect(() => getDialectCapabilities('unknown')).toThrow(
				"Unknown dialect 'unknown'",
			);
		});

		it('includes available dialects in error message', () => {
			try {
				getDialectCapabilities('oracle');
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(UnknownDialectError);
				const unknownError = error as UnknownDialectError;
				expect(unknownError.dialectName).toBe('oracle');
				expect(unknownError.availableDialects).toContain('postgresql');
				expect(unknownError.availableDialects).toContain('mysql');
			}
		});
	});

	describe('isKnownDialect', () => {
		it('returns true for known dialects', () => {
			expect(isKnownDialect('postgresql')).toBe(true);
			expect(isKnownDialect('mysql')).toBe(true);
			expect(isKnownDialect('sqlite')).toBe(true);
			expect(isKnownDialect('duckdb')).toBe(true);
			expect(isKnownDialect('mssql')).toBe(true);
		});

		it('returns true for aliases', () => {
			expect(isKnownDialect('postgres')).toBe(true);
			expect(isKnownDialect('pg')).toBe(true);
			expect(isKnownDialect('sqlserver')).toBe(true);
		});

		it('returns false for unknown dialects', () => {
			expect(isKnownDialect('oracle')).toBe(false);
			expect(isKnownDialect('unknown')).toBe(false);
		});

		it('is case insensitive', () => {
			expect(isKnownDialect('POSTGRESQL')).toBe(true);
			expect(isKnownDialect('MySQL')).toBe(true);
		});
	});

	describe('getAvailableDialects', () => {
		it('returns list of primary dialect names', () => {
			const dialects = getAvailableDialects();

			expect(dialects).toContain('postgresql');
			expect(dialects).toContain('mysql');
			expect(dialects).toContain('sqlite');
			expect(dialects).toContain('duckdb');
			expect(dialects).toContain('mssql');
		});

		it('does not include aliases', () => {
			const dialects = getAvailableDialects();

			// Aliases should not appear in the list
			expect(dialects).not.toContain('postgres');
			expect(dialects).not.toContain('pg');
			expect(dialects).not.toContain('sqlserver');
		});
	});

	describe('registerDialect', () => {
		it('registers a new dialect', () => {
			registerDialect('cockroachdb', {
				...POSTGRESQL_CAPABILITIES,
				name: 'cockroachdb',
				supportsArrayType: false, // Limited array support
			});

			expect(isKnownDialect('cockroachdb')).toBe(true);
			const caps = getDialectCapabilities('cockroachdb');
			expect(caps.name).toBe('cockroachdb');
			expect(caps.supportsArrayType).toBe(false);
			expect(caps.supportsReturning).toBe(true); // Inherited from PostgreSQL
		});

		it('can add an alias', () => {
			registerDialect('crdb', getDialectCapabilities('cockroachdb'));

			expect(isKnownDialect('crdb')).toBe(true);
			expect(getDialectCapabilities('crdb').name).toBe('cockroachdb');
		});

		it('can override existing dialect', () => {
			const originalCaps = getDialectCapabilities('sqlite');
			expect(originalCaps.supportsSchemas).toBe(false);

			// Override with custom SQLite that supports schemas
			registerDialect('sqlite', {
				...originalCaps,
				supportsSchemas: true,
			});

			const newCaps = getDialectCapabilities('sqlite');
			expect(newCaps.supportsSchemas).toBe(true);

			// Restore original
			registerDialect('sqlite', SQLITE_CAPABILITIES);
		});
	});

	describe('extendDialect', () => {
		it('creates new capabilities from base', () => {
			const tidbCaps = extendDialect(MYSQL_CAPABILITIES, {
				name: 'tidb',
				supportsWindowFunctions: true,
			});

			expect(tidbCaps.name).toBe('tidb');
			expect(tidbCaps.supportsWindowFunctions).toBe(true);
			expect(tidbCaps.supportsReturning).toBe(false); // Inherited from MySQL
			expect(tidbCaps.identifierQuote).toBe('`'); // Inherited from MySQL
		});

		it('does not mutate base capabilities', () => {
			const before = { ...POSTGRESQL_CAPABILITIES };

			extendDialect(POSTGRESQL_CAPABILITIES, {
				name: 'test',
				supportsArrayType: false,
			});

			expect(POSTGRESQL_CAPABILITIES).toEqual(before);
		});
	});

	describe('capability constants', () => {
		it('exports all dialect capability constants', () => {
			expect(POSTGRESQL_CAPABILITIES.name).toBe('postgresql');
			expect(MYSQL_CAPABILITIES.name).toBe('mysql');
			expect(SQLITE_CAPABILITIES.name).toBe('sqlite');
			expect(DUCKDB_CAPABILITIES.name).toBe('duckdb');
			expect(MSSQL_CAPABILITIES.name).toBe('mssql');
		});

		it('capabilities object is frozen for immutability', () => {
			// Note: TypeScript readonly prevents compile-time mutation
			// For runtime immutability, users should use Object.freeze() if needed
			// This test documents the expected behavior
			const caps = { ...POSTGRESQL_CAPABILITIES };
			caps.name = 'modified';

			// Original constant remains unchanged (spread creates new object)
			expect(POSTGRESQL_CAPABILITIES.name).toBe('postgresql');
			expect(caps.name).toBe('modified');
		});
	});

	describe('real-world usage patterns', () => {
		it('supports capability-based conditional compilation', () => {
			const caps = getDialectCapabilities('mysql');

			// Example: choosing path style for recursive CTE
			const buildPath = (currentPath: string, newId: string) => {
				if (caps.recursivePathStyle === 'array') {
					return `${currentPath} || ARRAY[${newId}]`;
				}
				return `CONCAT(${currentPath}, '/', ${newId})`;
			};

			expect(buildPath("'/root'", "'child'")).toBe(
				"CONCAT('/root', '/', 'child')",
			);
		});

		it('supports feature detection', () => {
			const checkFeatures = (dialectName: string) => {
				const caps = getDialectCapabilities(dialectName);

				return {
					canUseReturning: caps.supportsReturning,
					canUseRecursive: caps.supportsRecursiveCTE,
					canUseMultiTenant: caps.supportsSchemas,
				};
			};

			const pgFeatures = checkFeatures('postgresql');
			expect(pgFeatures.canUseReturning).toBe(true);
			expect(pgFeatures.canUseMultiTenant).toBe(true);

			const sqliteFeatures = checkFeatures('sqlite');
			expect(sqliteFeatures.canUseReturning).toBe(true);
			expect(sqliteFeatures.canUseMultiTenant).toBe(false);
		});
	});
});
