import type {
	DialectCapabilities,
	EnumIR,
	FeatureBehaviorConfig,
	ModelIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { POSTGRESQL_CAPABILITIES } from '../dialects/index.js';
import { ModelIRImpl } from '../model-impl.js';
import {
	DEFAULT_FEATURE_CHECKERS,
	type FeatureChecker,
	type FeatureUsage,
	negotiateFeatures,
	UnsupportedFeatureError,
} from './negotiate-features.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Minimal table with no FK, index, check, or partition features */
const MINIMAL_TABLE: TableIR = {
	name: 'users',
	columns: [{ name: 'id', type: 'number', nullable: false }],
	foreignKeys: [],
	indexes: [],
};

/** Build a ModelIR with no relations and an optional overrides map */
function makeModel(
	tables: Map<string, TableIR>,
	opts?: {
		enums?: Map<string, EnumIR>;
		extensions?: readonly string[];
		sequences?: Map<string, SequenceIR>;
	},
): ModelIR {
	return new ModelIRImpl(
		tables,
		new Map(),
		opts?.enums,
		opts?.extensions,
		opts?.sequences,
	);
}

/**
 * Minimal DialectCapabilities with no DDL support.
 * All optional DDL flags are omitted (undefined = false for isSupported checks).
 */
function noDDLCaps(): DialectCapabilities {
	return {
		name: 'test-adapter',
		supportsReturning: false,
		supportsRecursiveCTE: false,
		supportsWindowFunctions: false,
		supportsArrayType: false,
		supportsRangeTypes: false,
		supportsJsonType: false,
		supportsJsonOperators: false,
		supportsSchemas: false,
		supportsLateralJoin: false,
		supportsJsonAgg: false,
		recursivePathStyle: 'string',
		stringConcatStyle: 'function',
		identifierQuote: '"',
		parameterStyle: 'question',
		limitStyle: 'limit-offset',
		booleanStyle: 'native',
	};
}

// ============================================================================
// SC-04: Default warning mode
// ============================================================================

describe('negotiateFeatures (CAPS-003)', () => {
	describe('SC-04: warning mode (default)', () => {
		it('should emit a warning for an unsupported enum type', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([
					['status', { name: 'status', values: ['active', 'inactive'] }],
				]),
			});
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('enum');
			expect(result.warnings[0]!.adapter).toBe('test-adapter');
			expect(result.warnings[0]!.element).toBe('status');
			expect(result.warnings[0]!.message).toContain('"enum"');
			expect(result.warnings[0]!.message).toContain('"test-adapter"');
		});

		it('should default to warning behavior when behavior param is omitted', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				extensions: ['pgvector'],
			});
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps);

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('extension');
		});
	});

	// ============================================================================
	// SC-05: Error mode — fail-fast (ERR-02)
	// ============================================================================

	describe('SC-05: error mode (fail-fast)', () => {
		it('should throw UnsupportedFeatureError on first unsupported feature', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['active'] }]]),
			});
			const caps = noDDLCaps();

			// Act & Assert
			expect(() => negotiateFeatures(model, caps, 'error')).toThrow(
				UnsupportedFeatureError,
			);
		});

		it('should include feature, adapter, and element in the thrown error', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				sequences: new Map([['seq1', { name: 'seq1' } satisfies SequenceIR]]),
			});
			const caps = noDDLCaps();

			// Act & Assert
			expect(() => negotiateFeatures(model, caps, 'error')).toThrow(
				expect.objectContaining({
					feature: 'sequence',
					adapter: 'test-adapter',
					element: 'seq1',
				}),
			);
		});
	});

	// ============================================================================
	// SC-06: Ignore mode — silent
	// ============================================================================

	describe('SC-06: ignore mode (silent)', () => {
		it('should produce no warnings and no errors', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
				sequences: new Map([['seq1', { name: 'seq1' } satisfies SequenceIR]]),
				extensions: ['pgvector'],
			});
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'ignore');

			// Assert
			expect(result.warnings).toHaveLength(0);
		});
	});

	// ============================================================================
	// SC-07: Warning mode collects ALL warnings (ERR-03)
	// ============================================================================

	describe('SC-07: warning mode collects ALL unsupported features', () => {
		it('should collect warnings for enum, sequence, and extension simultaneously', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
				sequences: new Map([['seq1', { name: 'seq1' } satisfies SequenceIR]]),
				extensions: ['pgvector'],
			});
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert — 3 features unsupported → 3 warnings
			expect(result.warnings).toHaveLength(3);
			const features = result.warnings.map((w) => w.feature);
			expect(features).toContain('enum');
			expect(features).toContain('sequence');
			expect(features).toContain('extension');
		});
	});

	// ============================================================================
	// SC-08: Fully supported adapter (PostgreSQL) → no warnings
	// ============================================================================

	describe('SC-08: all features supported (PostgreSQL)', () => {
		it('should produce zero warnings for schema-level DDL features', () => {
			// Arrange — schema with enum, sequence, extension
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
				sequences: new Map([['seq1', { name: 'seq1' } satisfies SequenceIR]]),
				extensions: ['pgcrypto'],
			});

			// Act
			const result = negotiateFeatures(
				model,
				POSTGRESQL_CAPABILITIES,
				'warning',
			);

			// Assert
			expect(result.warnings).toHaveLength(0);
		});
	});

	// ============================================================================
	// FeatureBehaviorConfig — per-feature overrides
	// ============================================================================

	describe('FeatureBehaviorConfig: per-feature overrides', () => {
		it('should throw for a feature with override=error even when default is warning', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
			});
			const caps = noDDLCaps();
			const config: FeatureBehaviorConfig = {
				default: 'warning',
				overrides: { enum: 'error' },
			};

			// Act & Assert
			expect(() => negotiateFeatures(model, caps, config)).toThrow(
				UnsupportedFeatureError,
			);
		});

		it('should ignore a feature set to ignore even when default is warning', () => {
			// Arrange — enum: ignore, extension: warning (default)
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
				extensions: ['pgvector'],
			});
			const caps = noDDLCaps();
			const config: FeatureBehaviorConfig = {
				default: 'warning',
				overrides: { enum: 'ignore' },
			};

			// Act
			const result = negotiateFeatures(model, caps, config);

			// Assert — only extension warning (enum ignored)
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('extension');
		});

		it('should warn for all features when override has no match for the feature', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
				sequences: new Map([['seq1', { name: 'seq1' } satisfies SequenceIR]]),
			});
			const caps = noDDLCaps();
			const config: FeatureBehaviorConfig = {
				default: 'warning',
				overrides: { extension: 'ignore' }, // irrelevant — no extensions in model
			};

			// Act
			const result = negotiateFeatures(model, caps, config);

			// Assert — both enum and sequence should warn
			expect(result.warnings).toHaveLength(2);
		});
	});

	// ============================================================================
	// Table-level feature checks
	// ============================================================================

	describe('table-level: columns (identity, collation, comment)', () => {
		it('should detect identity columns when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [
					{ name: 'id', type: 'number', nullable: false, identity: 'always' },
				],
				foreignKeys: [],
				indexes: [],
			};
			const model = makeModel(new Map([['users', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('identity');
			expect(result.warnings[0]!.element).toBe('users.id');
		});

		it('should detect column collation when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [
					{
						name: 'name',
						type: 'string',
						nullable: false,
						collation: 'en_US.utf8',
					},
				],
				foreignKeys: [],
				indexes: [],
			};
			const model = makeModel(new Map([['users', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('collation');
			expect(result.warnings[0]!.element).toBe('users.name');
		});

		it('should detect column comments when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [
					{
						name: 'id',
						type: 'number',
						nullable: false,
						comment: 'Primary key',
					},
				],
				foreignKeys: [],
				indexes: [],
			};
			const model = makeModel(new Map([['users', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('comment');
			expect(result.warnings[0]!.element).toContain('users.id');
		});
	});

	describe('table-level: indexes (method, opclass, include, partial, expression, nulls not distinct)', () => {
		it('should detect non-btree index method when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [{ columns: ['body'], method: 'gin' }],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('indexMethod');
		});

		it('should NOT warn for btree method (always supported)', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [{ columns: ['id'], method: 'btree' }],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(0);
		});

		it('should detect partial index (WHERE clause) when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [{ columns: ['id'], where: 'active = true' }],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('partialIndex');
		});

		it('should detect expression index when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [{ columns: [], expressions: ['lower(email)'] }],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('expressionIndex');
		});

		it('should detect index INCLUDE columns when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [{ columns: ['id'], include: ['title', 'status'] }],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('indexInclude');
		});

		it('should reject NULLS NOT DISTINCT when unsupported and pass when supported', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [{ name: 'email', type: 'string', nullable: true }],
				foreignKeys: [],
				indexes: [
					{
						name: 'uk_users_email_nulls',
						columns: ['email'],
						unique: true,
						nullsNotDistinct: true,
					},
				],
			};
			const model = makeModel(new Map([['users', table]]));
			const unsupportedCaps: DialectCapabilities = {
				...POSTGRESQL_CAPABILITIES,
				supportsDDLIndexNullsNotDistinct: false,
			};
			const supportedCaps: DialectCapabilities = {
				...unsupportedCaps,
				supportsDDLIndexNullsNotDistinct: true,
			};

			// Act + Assert
			expect(() => negotiateFeatures(model, unsupportedCaps, 'error')).toThrow(
				expect.objectContaining({
					feature: 'indexNullsNotDistinct',
					element: 'uk_users_email_nulls',
				}),
			);
			expect(() =>
				negotiateFeatures(model, supportedCaps, 'error'),
			).not.toThrow();
		});

		it('should detect opclass when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [{ columns: ['title'], opclass: { title: 'gin_trgm_ops' } }],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('indexOpclass');
		});

		it('should detect multiple index warnings in one pass', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [
					{ name: 'id', type: 'number', nullable: false, identity: 'always' },
					{
						name: 'name',
						type: 'string',
						nullable: false,
						collation: 'en_US.utf8',
					},
				],
				foreignKeys: [],
				indexes: [
					{ columns: ['name'], method: 'gin' },
					{ columns: ['id'], where: 'active = true' },
				],
			};
			const model = makeModel(new Map([['users', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert — identity, collation, indexMethod, partialIndex = 4 warnings
			expect(result.warnings).toHaveLength(4);
			const features = result.warnings.map((w) => w.feature);
			expect(features).toContain('identity');
			expect(features).toContain('collation');
			expect(features).toContain('indexMethod');
			expect(features).toContain('partialIndex');
		});
	});

	describe('table-level: CHECK constraints', () => {
		it('should detect CHECK constraints when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'orders',
				columns: [{ name: 'amount', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [
					{ name: 'chk_positive_amount', expression: 'amount > 0' },
				],
			};
			const model = makeModel(new Map([['orders', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('checkConstraint');
			expect(result.warnings[0]!.element).toBe('orders.chk_positive_amount');
		});
	});

	describe('table-level: foreign key features (onUpdate, deferred)', () => {
		it('should detect ON UPDATE FK action when unsupported', () => {
			// Arrange — users table is the FK target
			const usersTable: TableIR = {
				name: 'users',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
			};
			const postsTable: TableIR = {
				name: 'posts',
				columns: [{ name: 'user_id', type: 'number', nullable: false }],
				foreignKeys: [
					{
						columns: ['user_id'],
						references: { table: 'users', columns: ['id'] },
						onUpdate: 'CASCADE',
					},
				],
				indexes: [],
			};
			const model = makeModel(
				new Map([
					['users', usersTable],
					['posts', postsTable],
				]),
			);
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('onUpdateFK');
			expect(result.warnings[0]!.element).toContain('posts FK → users');
		});

		it('should NOT warn for onUpdate=NO ACTION (always safe)', () => {
			// Arrange
			const usersTable: TableIR = {
				name: 'users',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
			};
			const postsTable: TableIR = {
				name: 'posts',
				columns: [{ name: 'user_id', type: 'number', nullable: false }],
				foreignKeys: [
					{
						columns: ['user_id'],
						references: { table: 'users', columns: ['id'] },
						onUpdate: 'NO ACTION',
					},
				],
				indexes: [],
			};
			const model = makeModel(
				new Map([
					['users', usersTable],
					['posts', postsTable],
				]),
			);
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(0);
		});

		it('should detect deferred FK when unsupported', () => {
			// Arrange
			const usersTable: TableIR = {
				name: 'users',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
			};
			const postsTable: TableIR = {
				name: 'posts',
				columns: [{ name: 'user_id', type: 'number', nullable: false }],
				foreignKeys: [
					{
						columns: ['user_id'],
						references: { table: 'users', columns: ['id'] },
						deferred: true,
					},
				],
				indexes: [],
			};
			const model = makeModel(
				new Map([
					['users', usersTable],
					['posts', postsTable],
				]),
			);
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('deferredFK');
		});
	});

	describe('table-level: table comment', () => {
		it('should detect table comment when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
				comment: 'User accounts',
			};
			const model = makeModel(new Map([['users', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('comment');
			expect(result.warnings[0]!.element).toBe('users (table)');
		});
	});

	describe('table-level: row-level security', () => {
		it('should detect rlsEnabled when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
				rlsEnabled: true,
			};
			const model = makeModel(new Map([['users', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('rowLevelSecurity');
			expect(result.warnings[0]!.element).toBe('users');
		});

		it('should detect policies array when unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'posts',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
				policies: [
					{
						name: 'tenant_isolation',
						using: "tenant_id = current_setting('app.tenant')::uuid",
					},
				],
			};
			const model = makeModel(new Map([['posts', table]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.feature).toBe('rowLevelSecurity');
			expect(result.warnings[0]!.element).toBe('posts');
		});

		it('should produce no warnings when supportsDDLRowLevelSecurity is true', () => {
			// Arrange
			const table: TableIR = {
				name: 'users',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
				rlsEnabled: true,
				policies: [{ name: 'tenant_policy' }],
			};
			const model = makeModel(new Map([['users', table]]));
			const caps: DialectCapabilities = {
				...noDDLCaps(),
				supportsDDLRowLevelSecurity: true,
			};

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(0);
		});

		it('should throw in error mode when RLS is unsupported', () => {
			// Arrange
			const table: TableIR = {
				name: 'orders',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
				rlsEnabled: true,
			};
			const model = makeModel(new Map([['orders', table]]));
			const caps = noDDLCaps();

			// Act + Assert
			expect(() => negotiateFeatures(model, caps, 'error')).toThrow();
		});

		it('should produce no warnings for a table without RLS', () => {
			// Arrange: MINIMAL_TABLE has no rlsEnabled and no policies
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(result.warnings).toHaveLength(0);
		});
	});

	describe('no modifications to ModelIR (INV-06)', () => {
		it('should not mutate the model object', () => {
			// Arrange
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]), {
				enums: new Map([['status', { name: 'status', values: ['a'] }]]),
			});
			const caps = noDDLCaps();
			const enumsBefore = model.enums?.size;

			// Act
			negotiateFeatures(model, caps, 'warning');

			// Assert
			expect(model.enums?.size).toBe(enumsBefore);
		});
	});

	// ============================================================================
	// OCP-001: Registry extensibility — custom FeatureChecker integration
	// ============================================================================

	describe('OCP-001: custom FeatureChecker integrates via checkers param', () => {
		it('should invoke a custom checker and emit a warning when detected', () => {
			// Arrange: a custom checker that detects any table named "restricted"
			const customChecker: FeatureChecker = {
				capability: 'supportsSchemas', // unsupported in noDDLCaps()
				feature: 'extension', // reuse an existing DDLFeature for the test
				detectUsage(model): readonly FeatureUsage[] {
					if (!model.tables) return [];
					const hits: FeatureUsage[] = [];
					for (const [tableName] of model.tables) {
						if (tableName === 'restricted') {
							hits.push({ table: tableName, detail: 'restricted table' });
						}
					}
					return hits;
				},
			};
			const restrictedTable: TableIR = {
				name: 'restricted',
				columns: [{ name: 'id', type: 'number', nullable: false }],
				foreignKeys: [],
				indexes: [],
			};
			const model = makeModel(new Map([['restricted', restrictedTable]]));
			const caps = noDDLCaps();

			// Act — inject only the custom checker (replaces DEFAULT_FEATURE_CHECKERS)
			const result = negotiateFeatures(model, caps, 'warning', [customChecker]);

			// Assert
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]!.element).toBe('restricted table');
		});

		it('should produce zero warnings if custom checker finds no usages', () => {
			// Arrange: same custom checker, but table name does not match
			const customChecker: FeatureChecker = {
				capability: 'supportsSchemas',
				feature: 'extension',
				detectUsage(model): readonly FeatureUsage[] {
					if (!model.tables) return [];
					const hits: FeatureUsage[] = [];
					for (const [tableName] of model.tables) {
						if (tableName === 'restricted') {
							hits.push({ table: tableName, detail: 'restricted table' });
						}
					}
					return hits;
				},
			};
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]));
			const caps = noDDLCaps();

			// Act
			const result = negotiateFeatures(model, caps, 'warning', [customChecker]);

			// Assert
			expect(result.warnings).toHaveLength(0);
		});

		it('should skip custom checker when capability is supported', () => {
			// Arrange: caps says supportsSchemas = true => checker is skipped entirely
			const called: boolean[] = [];
			const customChecker: FeatureChecker = {
				capability: 'supportsSchemas',
				feature: 'extension',
				detectUsage(_model): readonly FeatureUsage[] {
					called.push(true);
					return [{ detail: 'always-triggers' }];
				},
			};
			const model = makeModel(new Map([['users', MINIMAL_TABLE]]));
			const caps: DialectCapabilities = {
				...noDDLCaps(),
				supportsSchemas: true,
			};

			// Act
			const result = negotiateFeatures(model, caps, 'warning', [customChecker]);

			// Assert: checker.detectUsage was never called
			expect(called).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);
		});

		it('DEFAULT_FEATURE_CHECKERS should have exactly 17 entries (one per model-detectable DDLFeature)', () => {
			expect(DEFAULT_FEATURE_CHECKERS).toHaveLength(17);
		});

		it('every DEFAULT_FEATURE_CHECKER entry should have unique capability + feature pair', () => {
			const capabilitySet = new Set(
				DEFAULT_FEATURE_CHECKERS.map((c) => c.capability),
			);
			const featureSet = new Set(
				DEFAULT_FEATURE_CHECKERS.map((c) => c.feature),
			);
			expect(capabilitySet.size).toBe(17);
			expect(featureSet.size).toBe(17);
		});
	});
});
