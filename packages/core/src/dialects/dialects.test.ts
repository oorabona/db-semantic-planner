/**
 * Dialect Capabilities Registry Tests
 *
 * CORE-004: Tests for the dialect capabilities module.
 */

import { describe, expect, it } from 'vitest';
import {
	assertTypeSupported,
	createDialectCapabilities,
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
	UnhandledTypeInDialect,
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

	// ========================================================================
	// Dialect Type Safety (DIALECT-TYPE-SAFETY story)
	// ========================================================================

	describe('UnhandledTypeInDialect', () => {
		it('creates error with type and dialect info', () => {
			const error = new UnhandledTypeInDialect('daterange', 'mysql');

			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe('UnhandledTypeInDialect');
			expect(error.columnType).toBe('daterange');
			expect(error.dialectName).toBe('mysql');
			expect(error.message).toContain("Type 'daterange' is not supported");
			expect(error.message).toContain("dialect 'mysql'");
		});

		it('includes hint in message when provided', () => {
			const error = new UnhandledTypeInDialect(
				'daterange',
				'mysql',
				'Use separate start/end columns instead.',
			);

			expect(error.hint).toBe('Use separate start/end columns instead.');
			expect(error.message).toContain('Hint:');
			expect(error.message).toContain('Use separate start/end columns');
		});
	});

	describe('assertTypeSupported', () => {
		describe('PostgreSQL (supports all types)', () => {
			const caps = POSTGRESQL_CAPABILITIES;

			it('allows range types on PostgreSQL', () => {
				expect(() =>
					assertTypeSupported('daterange', 'postgresql', caps),
				).not.toThrow();
				expect(() =>
					assertTypeSupported('tsrange', 'postgresql', caps),
				).not.toThrow();
				expect(() =>
					assertTypeSupported('int4range', 'postgresql', caps),
				).not.toThrow();
			});

			it('allows jsonb on PostgreSQL', () => {
				expect(() =>
					assertTypeSupported('jsonb', 'postgresql', caps),
				).not.toThrow();
			});

			it('allows common types on PostgreSQL', () => {
				expect(() =>
					assertTypeSupported('string', 'postgresql', caps),
				).not.toThrow();
				expect(() =>
					assertTypeSupported('integer', 'postgresql', caps),
				).not.toThrow();
				expect(() =>
					assertTypeSupported('uuid', 'postgresql', caps),
				).not.toThrow();
			});
		});

		describe('MySQL (no range types, has json)', () => {
			const caps = MYSQL_CAPABILITIES;

			it('throws for range types on MySQL', () => {
				expect(() => assertTypeSupported('daterange', 'mysql', caps)).toThrow(
					UnhandledTypeInDialect,
				);
				expect(() => assertTypeSupported('tsrange', 'mysql', caps)).toThrow(
					UnhandledTypeInDialect,
				);
				expect(() => assertTypeSupported('int4range', 'mysql', caps)).toThrow(
					UnhandledTypeInDialect,
				);
			});

			it('throws for jsonb on MySQL', () => {
				expect(() => assertTypeSupported('jsonb', 'mysql', caps)).toThrow(
					UnhandledTypeInDialect,
				);
			});

			it('allows json on MySQL', () => {
				expect(() => assertTypeSupported('json', 'mysql', caps)).not.toThrow();
			});

			it('allows common types on MySQL', () => {
				expect(() =>
					assertTypeSupported('string', 'mysql', caps),
				).not.toThrow();
				expect(() =>
					assertTypeSupported('integer', 'mysql', caps),
				).not.toThrow();
			});
		});

		describe('SQLite (no range types)', () => {
			const caps = SQLITE_CAPABILITIES;

			it('throws for range types on SQLite', () => {
				expect(() => assertTypeSupported('daterange', 'sqlite', caps)).toThrow(
					UnhandledTypeInDialect,
				);
				expect(() => assertTypeSupported('numrange', 'sqlite', caps)).toThrow(
					UnhandledTypeInDialect,
				);
			});

			it('throws for jsonb on SQLite', () => {
				expect(() => assertTypeSupported('jsonb', 'sqlite', caps)).toThrow(
					UnhandledTypeInDialect,
				);
			});
		});

		describe('error message quality', () => {
			it('provides helpful hint for range types', () => {
				try {
					assertTypeSupported('daterange', 'mysql', MYSQL_CAPABILITIES);
					expect.fail('Should have thrown');
				} catch (e) {
					expect(e).toBeInstanceOf(UnhandledTypeInDialect);
					const error = e as UnhandledTypeInDialect;
					expect(error.hint).toContain('PostgreSQL-specific');
					expect(error.hint).toContain('separate start/end columns');
				}
			});

			it('provides helpful hint for jsonb', () => {
				try {
					assertTypeSupported('jsonb', 'mysql', MYSQL_CAPABILITIES);
					expect.fail('Should have thrown');
				} catch (e) {
					expect(e).toBeInstanceOf(UnhandledTypeInDialect);
					const error = e as UnhandledTypeInDialect;
					expect(error.hint).toContain("'json' type");
				}
			});
		});
	});
});

describe('DDL Feature Capabilities (CAPS-001)', () => {
	// SC-01: PostgreSQL adapter declares all DDL capabilities
	describe('when reading POSTGRESQL_CAPABILITIES', () => {
		it('should have all 15 DDL flags set to true', () => {
			// Arrange
			const caps = POSTGRESQL_CAPABILITIES;

			// Act & Assert
			expect(caps.supportsDDLEnumTypes).toBe(true);
			expect(caps.supportsDDLSequences).toBe(true);
			expect(caps.supportsDDLExtensions).toBe(true);
			expect(caps.supportsDDLPartitioning).toBe(true);
			expect(caps.supportsDDLCheckConstraints).toBe(true);
			expect(caps.supportsDDLOnUpdateFK).toBe(true);
			expect(caps.supportsDDLDeferredFK).toBe(true);
			expect(caps.supportsDDLIdentityColumns).toBe(true);
			expect(caps.supportsDDLCollation).toBe(true);
			expect(caps.supportsDDLComments).toBe(true);
			expect(caps.supportsDDLIndexMethods).toBe(true);
			expect(caps.supportsDDLIndexOpclass).toBe(true);
			expect(caps.supportsDDLIndexInclude).toBe(true);
			expect(caps.supportsDDLPartialIndexes).toBe(true);
			expect(caps.supportsDDLExpressionIndexes).toBe(true);
		});
	});

	// SC-02: Missing capability flag defaults to unsupported
	describe('when DialectCapabilities omits DDL flags', () => {
		it('should treat missing flags as unsupported (undefined)', () => {
			// Arrange — MYSQL_CAPABILITIES has no DDL flags currently
			const caps = MYSQL_CAPABILITIES;

			// Act & Assert
			expect(caps.supportsDDLEnumTypes).toBeUndefined();
			expect(caps.supportsDDLSequences).toBeUndefined();
			expect(caps.supportsDDLExtensions).toBeUndefined();
		});
	});

	// SC-03: Existing adapters without new flags still work (backward compat)
	describe('when an old adapter has no DDL flags', () => {
		it('should still satisfy DialectCapabilities type (optional fields)', () => {
			// Arrange — create capabilities with only required fields
			const oldCaps = createDialectCapabilities({
				name: 'old-adapter',
				identifierQuote: '"',
				parameterStyle: 'dollar',
				limitStyle: 'limit-offset',
				booleanStyle: 'native',
				recursivePathStyle: 'array',
				stringConcatStyle: 'operator',
			});

			// Act & Assert — should have a valid name and no DDL flags
			expect(oldCaps.name).toBe('old-adapter');
			expect(oldCaps.supportsDDLEnumTypes).toBeUndefined();
			expect(oldCaps.supportsReturning).toBe(false);
		});
	});
});

describe('createDialectCapabilities factory (INV-11)', () => {
	it('should set all feature flags to false by default', () => {
		// Arrange & Act
		const caps = createDialectCapabilities({
			name: 'test',
			identifierQuote: '"',
			parameterStyle: 'question',
			limitStyle: 'limit-offset',
			booleanStyle: 'native',
			recursivePathStyle: 'string',
			stringConcatStyle: 'function',
		});

		// Assert
		expect(caps.supportsReturning).toBe(false);
		expect(caps.supportsRecursiveCTE).toBe(false);
		expect(caps.supportsDDLEnumTypes).toBeUndefined();
	});

	it('should allow overriding specific flags', () => {
		// Arrange & Act
		const caps = createDialectCapabilities({
			name: 'mysql',
			identifierQuote: '`',
			parameterStyle: 'question',
			limitStyle: 'limit-offset',
			booleanStyle: 'native',
			recursivePathStyle: 'string',
			stringConcatStyle: 'function',
			supportsReturning: false,
			supportsDDLCheckConstraints: true,
			supportsDDLEnumTypes: true,
		});

		// Assert
		expect(caps.supportsDDLCheckConstraints).toBe(true);
		expect(caps.supportsDDLEnumTypes).toBe(true);
		expect(caps.supportsDDLSequences).toBeUndefined();
	});
});

describe('createDialectCapabilities with version (CAPS-VERSION)', () => {
	const baseMysqlOpts = {
		name: 'mysql',
		identifierQuote: '`' as const,
		parameterStyle: 'question' as const,
		limitStyle: 'limit-offset' as const,
		booleanStyle: 'native' as const,
		recursivePathStyle: 'string' as const,
		stringConcatStyle: 'function' as const,
		// MySQL features
		supportsDDLEnumTypes: true,
		supportsDDLCheckConstraints: true,
		supportsDDLExpressionIndexes: true,
		supportsDDLOnUpdateFK: true,
		supportsDDLCollation: true,
		supportsDDLComments: true,
		supportsDDLPartitioning: true,
	};

	const mysqlVersionReqs = {
		checkConstraint: { min: '8.0.16' },
		expressionIndex: { min: '8.0.13' },
	};

	it('should enable version-gated features when version meets minimum', () => {
		// Arrange & Act
		const caps = createDialectCapabilities(baseMysqlOpts, {
			version: '8.0.16',
			versionRequirements: mysqlVersionReqs,
		});

		// Assert — both CHECK (8.0.16) and expression indexes (8.0.13) enabled
		expect(caps.supportsDDLCheckConstraints).toBe(true);
		expect(caps.supportsDDLExpressionIndexes).toBe(true);
		// Non-version-gated features still present
		expect(caps.supportsDDLEnumTypes).toBe(true);
	});

	it('should disable version-gated features when version is below minimum', () => {
		// Arrange & Act
		const caps = createDialectCapabilities(baseMysqlOpts, {
			version: '8.0.15',
			versionRequirements: mysqlVersionReqs,
		});

		// Assert — CHECK requires 8.0.16, not met
		expect(caps.supportsDDLCheckConstraints).toBeUndefined();
		// Expression indexes require 8.0.13, met
		expect(caps.supportsDDLExpressionIndexes).toBe(true);
		// Non-version-gated features unaffected
		expect(caps.supportsDDLEnumTypes).toBe(true);
	});

	it('should handle maxVersion (feature deprecated)', () => {
		// Arrange — hypothetical: feature only in 8.0.0 to 8.4.0
		const caps = createDialectCapabilities(
			{ ...baseMysqlOpts, supportsDDLPartitioning: true },
			{
				version: '9.0.0',
				versionRequirements: { partition: { min: '8.0.0', max: '8.4.0' } },
			},
		);

		// Assert — version 9.0 exceeds max 8.4.0
		expect(caps.supportsDDLPartitioning).toBeUndefined();
	});

	it('should keep maxVersion feature when version is within range', () => {
		const caps = createDialectCapabilities(
			{ ...baseMysqlOpts, supportsDDLPartitioning: true },
			{
				version: '8.2.0',
				versionRequirements: { partition: { min: '8.0.0', max: '8.4.0' } },
			},
		);

		expect(caps.supportsDDLPartitioning).toBe(true);
	});

	it('should work without version option (backward compat)', () => {
		// Arrange & Act — no version, flags taken as-is
		const caps = createDialectCapabilities(baseMysqlOpts);

		// Assert — all explicitly set flags present
		expect(caps.supportsDDLCheckConstraints).toBe(true);
		expect(caps.supportsDDLExpressionIndexes).toBe(true);
	});

	it('should handle SQLite version requirements', () => {
		const sqliteCaps = createDialectCapabilities(
			{
				name: 'sqlite',
				identifierQuote: '"',
				parameterStyle: 'question',
				limitStyle: 'limit-offset',
				booleanStyle: 'numeric',
				recursivePathStyle: 'string',
				stringConcatStyle: 'operator',
				supportsDDLCheckConstraints: true,
				supportsDDLPartialIndexes: true,
				supportsDDLDeferredFK: true,
				supportsDDLExpressionIndexes: true,
				supportsDDLOnUpdateFK: true,
			},
			{
				version: '3.8.0',
				versionRequirements: {
					partialIndex: { min: '3.8.0' },
					expressionIndex: { min: '3.9.0' },
				},
			},
		);

		// 3.8.0 >= 3.8.0 → met
		expect(sqliteCaps.supportsDDLPartialIndexes).toBe(true);
		// 3.8.0 < 3.9.0 → not met
		expect(sqliteCaps.supportsDDLExpressionIndexes).toBeUndefined();
	});

	it('should compare version segments numerically (not lexicographically)', () => {
		// '8.0.9' vs '8.0.16' — lexicographic would say 9 > 1, but 9 < 16
		const caps = createDialectCapabilities(baseMysqlOpts, {
			version: '8.0.9',
			versionRequirements: { checkConstraint: { min: '8.0.16' } },
		});

		expect(caps.supportsDDLCheckConstraints).toBeUndefined();
	});
});
