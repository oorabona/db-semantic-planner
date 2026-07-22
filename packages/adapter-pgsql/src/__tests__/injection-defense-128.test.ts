/**
 * Injection Defense-in-Depth Tests — Issue #128
 *
 * Regression-locks the 7 defense-in-depth fixes for trusted/escape-hatch surfaces.
 * Each item gets: a malicious/invalid input that throws + a valid input that passes.
 *
 * Items:
 *  1. stream() chunkSize — already tested in pgsql-adapter-mock.test.ts (FIX-4a), not duplicated here
 *  2. literal() — rejects non-primitive values
 *  3. columnRef / rangeVar — validateIdentifier after naming transformation
 *  4. ALTER COLUMN USING — validateSqlExpression on options.using
 *  5. partition strategy + RLS command — allowlist validation
 *  6. customOp operator / cast typeName / namedArg name — injection guards
 *  7. batch/unnest cast type — validateDbTypeName in mapToPgBaseType default path
 */

import { createOrm, literal, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { columnRef, rangeVar } from '../ast-helpers.js';
import { inferPgArrayType } from '../compiler-utils.js';
import { generateCreatePolicy } from '../ddl/ddl-generator.js';
import { generateAlterColumnSQL } from '../ddl/table-operations.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { InvalidIdentifierError } from '../validate.js';

// Minimal schema for ORM integration tests
const minimalSchema = schema({
	items: { id: { type: 'integer', primaryKey: true } },
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter();
	return createOrm({ schema: minimalSchema, adapter });
}

// ============================================================================
// ITEM 2: literal() — reject non-primitive types
// ============================================================================

describe('ITEM-2: literal() rejects non-primitive values (injection defense)', () => {
	it('rejects object value — prevents [object Object] SQL emission', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'literal',
				value: {} as unknown as string,
			}),
		).toThrow(/unsupported value type/);
	});

	it('rejects array value', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'literal',
				value: [1, 2, 3] as unknown as string,
			}),
		).toThrow(/unsupported value type/);
	});

	it('rejects NaN — not finite', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'literal',
				value: Number.NaN,
			}),
		).toThrow(/must be finite/);
	});

	it('rejects Infinity — not finite', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'literal',
				value: Infinity,
			}),
		).toThrow(/must be finite/);
	});

	it("allows literal string with single-quote — produces 'o''brien' safely", () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const { sql } = adapter.compileSelectExpression(literal("o'brien").intent);
		// The deparser single-quote-escapes: 'o''brien'
		expect(sql).toContain("'o''brien'");
	});

	it('allows literal null', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const { sql } = adapter.compileSelectExpression(
			literal(null as unknown as string).intent,
		);
		expect(sql).toContain('NULL');
	});

	it('allows literal boolean', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const { sql } = adapter.compileSelectExpression(literal(true).intent);
		expect(sql).toContain('true');
	});

	it('allows literal number', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const { sql } = adapter.compileSelectExpression(literal(42).intent);
		expect(sql).toContain('42');
	});
});

// ============================================================================
// ITEM 3: columnRef / rangeVar — validateIdentifier after naming
// ============================================================================

describe('ITEM-3: columnRef rejects unsafe identifiers', () => {
	it('rejects column name with semicolon', () => {
		expect(() =>
			columnRef('users; DROP TABLE foo', undefined, undefined, identityNaming),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects column name with embedded double-quote', () => {
		expect(() =>
			columnRef('col"name', undefined, undefined, identityNaming),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects column starting with a digit', () => {
		expect(() =>
			columnRef('1col', undefined, undefined, identityNaming),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects schema with injection payload', () => {
		expect(() =>
			columnRef(
				'id',
				'users',
				'public; DROP SCHEMA pg_catalog',
				identityNaming,
			),
		).toThrow(InvalidIdentifierError);
	});

	it('allows valid identifier: user_id', () => {
		expect(() =>
			columnRef('user_id', undefined, undefined, identityNaming),
		).not.toThrow();
	});

	it('allows valid qualified identifier: schema.table.column', () => {
		expect(() =>
			columnRef('email', 'users', 'tenant_123', identityNaming),
		).not.toThrow();
	});
});

describe('ITEM-3: rangeVar rejects unsafe identifiers', () => {
	it('rejects table name with semicolon', () => {
		expect(() =>
			rangeVar('users; DROP TABLE foo', undefined, undefined, identityNaming),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects alias with embedded quote', () => {
		expect(() =>
			rangeVar('users', 'u"alias', undefined, identityNaming),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects schema with injection payload', () => {
		expect(() =>
			rangeVar('users', undefined, 'public; DROP TABLE t', identityNaming),
		).toThrow(InvalidIdentifierError);
	});

	it('allows valid table + alias + schema', () => {
		expect(() =>
			rangeVar('posts', 'p', 'tenant_42', identityNaming),
		).not.toThrow();
	});
});

// ============================================================================
// ITEM 4: ALTER COLUMN USING — validateSqlExpression
// ============================================================================

describe('ITEM-4: generateAlterColumnSQL USING injection defense', () => {
	it('rejects USING with semicolon injection', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'status', {
				type: 'text',
				using: 'old_status::text; DROP TABLE users --',
			}),
		).toThrow(/Unsafe SQL/);
	});

	it('rejects USING with line-comment injection', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'score', {
				type: 'integer',
				using: 'old_score::integer -- bypass',
			}),
		).toThrow(/Unsafe SQL/);
	});

	it('rejects USING with block-comment injection', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'val', {
				type: 'bigint',
				using: 'val::bigint /* injected */',
			}),
		).toThrow(/Unsafe SQL/);
	});

	it('allows valid USING expression: old_column::text', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'status', {
				type: 'text',
				using: 'old_status::text',
			}),
		).not.toThrow();
	});

	it('allows valid USING with type cast: CAST(old_col AS varchar)', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'name', {
				type: 'varchar',
				using: 'old_name::varchar',
			}),
		).not.toThrow();
	});
});

// ============================================================================
// ITEM 5a: Partition strategy — allowlist
// ============================================================================

describe('ITEM-5a: partition strategy allowlist (ddl-generator)', () => {
	it('rejects unknown strategy: NONE', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map([
				[
					'events',
					{
						name: 'events',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: ['id'],
						foreignKeys: [],
						indexes: [],
						policies: [],
						rlsEnabled: false,
						partition: { strategy: 'NONE', columns: ['id'] },
					},
				],
			]),
			enums: new Map(),
			extensions: [],
			sequences: new Map(),
		} as unknown as Parameters<typeof generateDDL>[0];
		const caps = {
			supportsDDLTableOperations: true,
			supportsInsert: true,
			supportsUpdate: true,
			supportsDelete: true,
			supportsDDLIndexOperations: true,
			supportsDDLForeignKeys: true,
			supportsDDLEnumTypes: true,
			supportsDDLSequences: true,
			supportsDDLExtensions: true,
			supportsDDLComments: true,
			supportsDDLRowLevelSecurity: true,
			supportsDDLCheckConstraints: true,
			supportsDDLCollations: false,
			supportsDDLGeneratedColumns: false,
			supportsCursorStreaming: true,
			supportsSchemaIntrospection: true,
			supportsAdvancedTypes: true,
		};
		expect(() => generateDDL(model, { dialectCapabilities: caps })).toThrow(
			/Invalid partition strategy/,
		);
	});

	it('rejects injection payload as partition strategy', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map([
				[
					'events',
					{
						name: 'events',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: ['id'],
						foreignKeys: [],
						indexes: [],
						policies: [],
						rlsEnabled: false,
						partition: {
							strategy: 'RANGE; DROP TABLE events --',
							columns: ['id'],
						},
					},
				],
			]),
			enums: new Map(),
			extensions: [],
			sequences: new Map(),
		} as unknown as Parameters<typeof generateDDL>[0];
		const caps = {
			supportsDDLTableOperations: true,
			supportsInsert: true,
			supportsUpdate: true,
			supportsDelete: true,
			supportsDDLIndexOperations: true,
			supportsDDLForeignKeys: true,
			supportsDDLEnumTypes: true,
			supportsDDLSequences: true,
			supportsDDLExtensions: true,
			supportsDDLComments: true,
			supportsDDLRowLevelSecurity: true,
			supportsDDLCheckConstraints: true,
			supportsDDLCollations: false,
			supportsDDLGeneratedColumns: false,
			supportsCursorStreaming: true,
			supportsSchemaIntrospection: true,
			supportsAdvancedTypes: true,
		};
		expect(() => generateDDL(model, { dialectCapabilities: caps })).toThrow(
			/Invalid partition strategy/,
		);
	});

	it('accepts RANGE, LIST, HASH (case-insensitive)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const caps = {
			supportsDDLTableOperations: true,
			supportsInsert: true,
			supportsUpdate: true,
			supportsDelete: true,
			supportsDDLIndexOperations: true,
			supportsDDLForeignKeys: true,
			supportsDDLEnumTypes: true,
			supportsDDLSequences: true,
			supportsDDLExtensions: true,
			supportsDDLComments: true,
			supportsDDLRowLevelSecurity: true,
			supportsDDLCheckConstraints: true,
			supportsDDLCollations: false,
			supportsDDLGeneratedColumns: false,
			supportsCursorStreaming: true,
			supportsSchemaIntrospection: true,
			supportsAdvancedTypes: true,
		};
		for (const strategy of ['RANGE', 'LIST', 'HASH', 'range', 'list', 'hash']) {
			const model: any = {
				tables: new Map([
					[
						'events',
						{
							name: 'events',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
								},
							],
							primaryKey: ['id'],
							foreignKeys: [],
							indexes: [],
							policies: [],
							rlsEnabled: false,
							partition: { strategy, columns: ['id'] },
						},
					],
				]),
				enums: new Map(),
				extensions: [],
				sequences: new Map(),
				getTable: (n: string) => model.tables.get(n),
				getRelation: () => undefined,
			} as unknown as Parameters<typeof generateDDL>[0];
			expect(
				() => generateDDL(model, { dialectCapabilities: caps }),
				`strategy "${strategy}" should compile without error`,
			).not.toThrow();
		}
	});
});

// ============================================================================
// ITEM 5b: RLS policy command — allowlist (ddl-generator + migration-sql)
// ============================================================================

describe('ITEM-5b: RLS policy command allowlist (generateCreatePolicy)', () => {
	const naming = identityNaming;

	it('rejects injection payload as policy command', () => {
		expect(() =>
			generateCreatePolicy(
				'users',
				{
					name: 'test_policy',
					command: 'SELECT; DROP TABLE users --',
					permissive: true,
				} as Parameters<typeof generateCreatePolicy>[1],
				undefined,
				naming,
			),
		).toThrow(/Invalid RLS policy command/);
	});

	it('rejects unknown command EXECUTE', () => {
		expect(() =>
			generateCreatePolicy(
				'users',
				{
					name: 'test_policy',
					command: 'EXECUTE',
					permissive: true,
				} as Parameters<typeof generateCreatePolicy>[1],
				undefined,
				naming,
			),
		).toThrow(/Invalid RLS policy command/);
	});

	it('accepts all valid commands: ALL SELECT INSERT UPDATE DELETE', () => {
		for (const command of [
			'ALL',
			'SELECT',
			'INSERT',
			'UPDATE',
			'DELETE',
			// Case-insensitive
			'select',
			'insert',
		]) {
			expect(
				() =>
					generateCreatePolicy(
						'users',
						{
							name: 'policy',
							command,
							permissive: true,
						} as Parameters<typeof generateCreatePolicy>[1],
						undefined,
						naming,
					),
				`command "${command}" should compile without error`,
			).not.toThrow();
		}
	});

	it('emits FOR SELECT (not the injection payload) in valid SQL', () => {
		const sql = generateCreatePolicy(
			'users',
			{
				name: 'read_policy',
				command: 'SELECT',
				permissive: true,
			} as Parameters<typeof generateCreatePolicy>[1],
			undefined,
			naming,
		);
		expect(sql).toContain('FOR SELECT');
		// Injection payload must not appear mid-statement (trailing ; is the valid terminator)
		expect(sql).not.toMatch(/SELECT.*--/);
		expect(sql).not.toMatch(/SELECT.*DROP/i);
	});
});

/** Minimal valid SchemaDiff for a single create_policy change */
function makePolicyDiff(policy: {
	name: string;
	command?: string;
	permissive: boolean;
}) {
	return {
		changes: [
			{
				kind: 'create_policy' as const,
				table: 'users',
				destructive: false,
				details: '',
				meta: { policy },
			},
		],
		hasDestructive: false,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

describe('ITEM-5b: RLS policy command allowlist (buildPolicySQL / migration-sql)', () => {
	it('rejects injection payload as policy command in migration path', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePolicyDiff({
			name: 'bad_policy',
			command: 'SELECT; DROP TABLE users --',
			permissive: true,
		});
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).toThrow(/Invalid RLS policy command/);
	});

	it('accepts SELECT in migration path', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePolicyDiff({
			name: 'read_only',
			command: 'SELECT',
			permissive: true,
		});
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).not.toThrow();
	});
});

// ============================================================================
// ITEM 6: customOp operator / cast typeName / namedArg name
// ============================================================================

describe('ITEM-6: customOp operator injection guard', () => {
	it('rejects operator with semicolon injection', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<=>; DROP TABLE users --',
				left: { kind: 'ref', column: 'vec' },
				right: { kind: 'param', value: [0.1, 0.2] },
			}),
		).toThrow(/Invalid operator/);
	});

	it('rejects operator with block-comment injection', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '/* injected',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/Invalid operator/);
	});

	it('allows pgvector cosine distance operator: <=>', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<=>',
				left: { kind: 'ref', column: 'embedding' },
				right: { kind: 'param', value: [0.1, 0.2] },
			}),
		).not.toThrow();
	});

	it('allows pgvector L2 distance operator: <->', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<->',
				left: { kind: 'ref', column: 'v' },
				right: { kind: 'param', value: [0.1] },
			}),
		).not.toThrow();
	});
});

describe('ITEM-6: cast typeName injection guard', () => {
	it('rejects type name with injection payload', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'vector; DROP TABLE users',
				expr: { kind: 'param', value: [0.1, 0.2] },
			}),
		).toThrow(/batchValues: invalid type name/);
	});

	it('rejects type name with closing paren injection', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'text) NOT NULL --',
				expr: { kind: 'param', value: 'hello' },
			}),
		).toThrow(/batchValues: invalid type name/);
	});

	it('allows vector type', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'vector',
				expr: { kind: 'param', value: [0.1, 0.2] },
			}),
		).not.toThrow();
	});

	it('allows tsvector type', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'tsvector',
				expr: { kind: 'param', value: 'hello world' },
			}),
		).not.toThrow();
	});

	it('allows numeric(10,2) type', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'numeric(10,2)',
				expr: { kind: 'param', value: 3.14 },
			}),
		).not.toThrow();
	});

	// FIX 1: validateTypeName (from @dbsp/core) replaced validateDbTypeName so that
	// schema-qualified types and multi-word base types are accepted by cast().

	it('allows schema-qualified type: audit.status_enum', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'audit.status_enum',
				expr: { kind: 'param', value: 'active' },
			}),
		).not.toThrow();
	});

	it('allows multi-word base type: timestamp without time zone', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'timestamp without time zone',
				expr: { kind: 'param', value: '2024-01-01T00:00:00' },
			}),
		).not.toThrow();
	});

	it('still rejects injection payload: x; DROP TABLE users', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 'x; DROP TABLE users',
				expr: { kind: 'param', value: 'hello' },
			}),
		).toThrow(/batchValues: invalid type name/);
	});
});

describe('ITEM-6: namedArg name injection guard', () => {
	it('rejects named arg with semicolon in name', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'namedArg',
				name: 'field; DROP TABLE --',
				value: { kind: 'param', value: 'hello' },
			}),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects named arg with embedded quote', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'namedArg',
				name: 'field"name',
				value: { kind: 'param', value: 'hello' },
			}),
		).toThrow(InvalidIdentifierError);
	});

	it('allows valid namedArg: query_string', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'namedArg',
				name: 'query_string',
				value: { kind: 'param', value: 'hello' },
			}),
		).not.toThrow();
	});

	it('allows valid namedArg: field_name', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'namedArg',
				name: 'field',
				value: { kind: 'param', value: 'name_searchable' },
			}),
		).not.toThrow();
	});
});

// ============================================================================
// ITEM 7: batch/unnest cast type via mapToPgBaseType custom path
// ============================================================================

describe('ITEM-7: inferPgArrayType custom-type path validates via adapter validateDbType', () => {
	it('rejects injection in custom type via columnTypes map', () => {
		// The custom-type default path in mapToPgBaseType calls the adapter's
		// PostgreSQL-aware validateDbType. "vector; DROP TABLE x" is not safe.
		expect(() =>
			inferPgArrayType('embedding', {
				embedding: 'vector; DROP TABLE x',
			}),
		).toThrow(/batchValues: invalid type name/);
	});

	it('rejects closing-paren injection in custom type', () => {
		expect(() =>
			inferPgArrayType('col', {
				col: 'text) NOT NULL --',
			}),
		).toThrow(/batchValues: invalid type name/);
	});

	it('allows valid custom type: vector', () => {
		expect(() =>
			inferPgArrayType('embedding', { embedding: 'vector' }),
		).not.toThrow();
		const result = inferPgArrayType('embedding', { embedding: 'vector' });
		expect(result).toBe('vector[]');
	});

	it('allows numeric type with precision: numeric(10,2)', () => {
		// numeric(10,2) normalizes through the NUMERIC case to numeric
		// so this exercises the switch-case path, not the custom default
		const result = inferPgArrayType('price', { price: 'NUMERIC(10,2)' });
		expect(result).toBe('numeric[]');
	});

	it('allows custom extension type: tsvector', () => {
		const result = inferPgArrayType('tsv', { tsv: 'tsvector' });
		expect(result).toBe('tsvector[]');
	});
});

// ============================================================================
// GAP 1: Partition strategy allowlist — MIGRATION path (migration-sql.ts)
// The allowlist was added to ddl-generator.ts but the migration create_table
// path called generateCreateTableSQL() in migration-sql.ts directly.
// Both paths now share assertPartitionStrategy() exported from ddl-generator.ts.
// ============================================================================

/** Minimal valid SchemaDiff for a single create_table change with partition */
function makePartitionTableDiff(strategy: string) {
	return {
		changes: [
			{
				kind: 'create_table' as const,
				table: 'events',
				destructive: false,
				details: '',
				meta: {
					table: {
						name: 'events',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: ['id'],
						foreignKeys: [],
						indexes: [],
						partition: { strategy, columns: ['id'] },
					},
				},
			},
		],
		hasDestructive: false,
		summary: {
			tables: { added: 1, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

describe('GAP-1: partition strategy allowlist — migration-sql.ts path', () => {
	it('rejects injection payload as strategy via generateMigrationSQL', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePartitionTableDiff('RANGE; DROP TABLE users --');
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).toThrow(/Invalid partition strategy/);
	});

	it('rejects unknown strategy NONE via generateMigrationSQL', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePartitionTableDiff('NONE');
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).toThrow(/Invalid partition strategy/);
	});

	it('accepts RANGE via generateMigrationSQL', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePartitionTableDiff('RANGE');
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).not.toThrow();
	});

	it('accepts LIST via generateMigrationSQL', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePartitionTableDiff('LIST');
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).not.toThrow();
	});

	it('accepts HASH via generateMigrationSQL (case-insensitive)', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		const diff = makePartitionTableDiff('hash');
		expect(() =>
			generateMigrationSQL(diff as Parameters<typeof generateMigrationSQL>[0]),
		).not.toThrow();
	});
});

// ============================================================================
// GAP 2: customOp operator — strict symbolic-only allowlist
// validateSqlExpression was too permissive: 'OR true OR' passes it.
// The deparser emits operator tokens verbatim between operands, so
// 'OR true OR' would produce: <left> OR true OR <right> (SQL injection).
// Fix: operator MUST match ^[-+*/<>=~!@#%^&|?]+$ (symbolic chars only).
// ============================================================================

describe('GAP-2: customOp operator strict symbolic allowlist', () => {
	it('rejects word operator: OR true OR', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: 'OR true OR',
				left: { kind: 'ref', column: 'active' },
				right: { kind: 'param', value: true },
			}),
		).toThrow(/Invalid operator/);
	});

	it('rejects bare word operator: OR', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: 'OR',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/Invalid operator/);
	});

	it('rejects operator with semicolon: ; DROP TABLE x --', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '; DROP TABLE x --',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/Invalid operator/);
	});

	it('rejects operator with space: <=> ANY(SELECT', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<=> ANY(SELECT',
				left: { kind: 'ref', column: 'v' },
				right: { kind: 'param', value: [0.1] },
			}),
		).toThrow(/Invalid operator/);
	});

	it('allows pgvector cosine distance: <=>', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<=>',
				left: { kind: 'ref', column: 'embedding' },
				right: { kind: 'param', value: [0.1, 0.2] },
			}),
		).not.toThrow();
	});

	it('allows pgvector L2 distance: <->', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<->',
				left: { kind: 'ref', column: 'v' },
				right: { kind: 'param', value: [0.1] },
			}),
		).not.toThrow();
	});

	it('allows ParadeDB full-text operator: @@', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '@@',
				left: { kind: 'ref', column: 'body' },
				right: { kind: 'param', value: 'search term' },
			}),
		).not.toThrow();
	});

	it('allows range containment operator: @>', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '@>',
				left: { kind: 'ref', column: 'period' },
				right: { kind: 'param', value: '[2024-01-01,2024-12-31]' },
			}),
		).not.toThrow();
	});

	it('allows regex match operator: ~', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '~',
				left: { kind: 'ref', column: 'path' },
				right: { kind: 'param', value: '^/api/' },
			}),
		).not.toThrow();
	});
});

// ============================================================================
// GAP 2b: customOp operator — SQL comment-sequence rejection
// The symbolic-charset check (^[-+*/<>=~!@#%^&|?]+$) passes '--', '/*', '*/'
// because '-', '/', '*' are individually valid chars. PostgreSQL forbids those
// sequences inside operator names (they start comments). The deparser emits
// the operator verbatim between operands, so '--' renders 'a -- $1' which
// comments out the right operand and any following WHERE predicates on the
// same generated SQL line (could neutralize auth/tenant filters).
// ============================================================================

describe('GAP-2b: customOp operator rejects SQL comment sequences', () => {
	// --- REJECT: comment sequences that pass the symbolic-charset regex ---

	it('rejects bare line-comment operator: --', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '--',
				left: { kind: 'ref', column: 'active' },
				right: { kind: 'param', value: true },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	it('rejects operator containing -- prefix: <--', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<--',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	it('rejects operator containing -- suffix: -->', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '-->',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	it('rejects block-comment open: /*', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '/*',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	it('rejects block-comment close: */', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '*/',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	it('rejects empty block comment: /**/', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '/**/',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	// --- ACCEPT: single-char and real multi-char operators that happen to use
	//   '-', '/', or '*' but do NOT form a comment sequence ---

	it('allows bare minus: -', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '-',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).not.toThrow();
	});

	it('allows bare multiply: *', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '*',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 2 },
			}),
		).not.toThrow();
	});

	it('allows bare divide: /', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '/',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 2 },
			}),
		).not.toThrow();
	});

	it('allows bare add: +', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '+',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).not.toThrow();
	});

	it('allows pgvector cosine distance (confirmed legit): <=>', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<=>',
				left: { kind: 'ref', column: 'embedding' },
				right: { kind: 'param', value: [0.1, 0.2] },
			}),
		).not.toThrow();
	});

	it('allows pgvector inner product: <#>', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<#>',
				left: { kind: 'ref', column: 'embedding' },
				right: { kind: 'param', value: [0.1, 0.2] },
			}),
		).not.toThrow();
	});

	it('allows equality: =', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '=',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).not.toThrow();
	});

	it('allows not-equal: <>', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '<>',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).not.toThrow();
	});

	it('allows not-equal: !=', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: '!=',
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).not.toThrow();
	});
});

// ============================================================================
// FINDING 1: unary operator — assertSafeOperator (allowWords: ['NOT'])
// Regression-locks that forged unary operators are rejected and that all
// legitimate unary operators (NOT, -, ~, +) continue to pass.
// ============================================================================

describe('FINDING-1: unary operator injection guard (assertSafeOperator)', () => {
	// --- REJECT: word injection payloads ---

	it('rejects multi-word injection: NOT true OR', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: 'NOT true OR',
				operand: { kind: 'ref', column: 'active' },
			}),
		).toThrow(/Invalid operator/);
	});

	it('rejects injection with semicolon: NOT true; DROP', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: 'NOT true; DROP',
				operand: { kind: 'ref', column: 'active' },
			}),
		).toThrow(/Invalid operator/);
	});

	it('rejects bare unknown word: NOOP', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: 'NOOP',
				operand: { kind: 'ref', column: 'x' },
			}),
		).toThrow(/Invalid operator/);
	});

	// --- REJECT: comment sequences ---

	it('rejects line-comment operator: --', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: '--',
				operand: { kind: 'ref', column: 'x' },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	it('rejects block-comment open: /*', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: '/*',
				operand: { kind: 'ref', column: 'x' },
			}),
		).toThrow(/must not contain SQL comment sequences/);
	});

	// --- ACCEPT: legitimate unary operators ---

	it('allows NOT (keyword unary)', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: 'NOT',
				operand: { kind: 'ref', column: 'active' },
			}),
		).not.toThrow();
	});

	it('allows NOT case-insensitive: not', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: 'not',
				operand: { kind: 'ref', column: 'active' },
			}),
		).not.toThrow();
	});

	it('allows unary minus: -', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: '-',
				operand: { kind: 'ref', column: 'score' },
			}),
		).not.toThrow();
	});

	it('allows unary plus: +', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: '+',
				operand: { kind: 'ref', column: 'score' },
			}),
		).not.toThrow();
	});

	it('allows bitwise NOT: ~', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: '~',
				operand: { kind: 'ref', column: 'flags' },
			}),
		).not.toThrow();
	});
});

// ============================================================================
// FINDING 2: batch/unnest cast types — assertBatchTypeName allows ident.ident
// Regression-locks that schema-qualified types pass and that injection payloads
// are still rejected.
// ============================================================================

describe('FINDING-2: assertBatchTypeName — schema-qualified type regression fix', () => {
	// --- ACCEPT: previously-broken schema-qualified forms ---

	it('allows schema-qualified type: audit.status_enum', () => {
		expect(() =>
			inferPgArrayType('status', { status: 'audit.status_enum' }),
		).not.toThrow();
		expect(inferPgArrayType('status', { status: 'audit.status_enum' })).toBe(
			'audit.status_enum[]',
		);
	});

	it('allows schema-qualified type with array suffix: audit.status_enum[]', () => {
		// inferPgArrayType strips [] before calling mapToPgBaseType; the validator
		// sees 'audit.status_enum' (no suffix). Output re-appends [].
		expect(() =>
			inferPgArrayType('status', { status: 'audit.status_enum[]' }),
		).not.toThrow();
	});

	it('allows simple custom type: vector', () => {
		expect(() =>
			inferPgArrayType('embedding', { embedding: 'vector' }),
		).not.toThrow();
		expect(inferPgArrayType('embedding', { embedding: 'vector' })).toBe(
			'vector[]',
		);
	});

	it('allows numeric with precision: numeric(10,2)', () => {
		// numeric(10,2) hits the NUMERIC case branch, not the default custom path
		const result = inferPgArrayType('price', { price: 'numeric(10,2)' });
		expect(result).toBe('numeric[]');
	});

	it('allows tsvector custom extension type', () => {
		expect(inferPgArrayType('tsv', { tsv: 'tsvector' })).toBe('tsvector[]');
	});

	// --- REJECT: injection payloads ---

	it('rejects injection with semicolon: x; DROP TABLE t', () => {
		expect(() => inferPgArrayType('col', { col: 'x; DROP TABLE t' })).toThrow(
			/batchValues: invalid type name/,
		);
	});

	it("rejects injection with single-quote: x'--", () => {
		expect(() => inferPgArrayType('col', { col: "x'--" })).toThrow(
			/batchValues: invalid type name/,
		);
	});

	it('rejects triple-dot schema path: a.b.c', () => {
		expect(() => inferPgArrayType('col', { col: 'a.b.c' })).toThrow(
			/batchValues: invalid type name/,
		);
	});

	it('rejects double array suffix: text[][]', () => {
		expect(() => inferPgArrayType('col', { col: 'text[][]' })).toThrow(
			/batchValues: invalid type name/,
		);
	});
});

// ============================================================================
// FINDING 2 (continued): multi-word PostgreSQL base types now pass
// The custom type path uses the adapter validator so faithful PostgreSQL type
// spellings shared with WHERE/NQL/DDL must no longer throw.
// ============================================================================

describe('FINDING-2: multi-word PostgreSQL base types pass via validateDbType', () => {
	it('allows timestamp without time zone', () => {
		expect(() =>
			inferPgArrayType('col', { col: 'timestamp without time zone' }),
		).not.toThrow();
		expect(
			inferPgArrayType('col', { col: 'timestamp without time zone' }),
		).toBe('timestamp without time zone[]');
	});

	it('allows timestamp with time zone', () => {
		expect(() =>
			inferPgArrayType('col', { col: 'timestamp with time zone' }),
		).not.toThrow();
	});

	it('allows time with time zone', () => {
		expect(() =>
			inferPgArrayType('col', { col: 'time with time zone' }),
		).not.toThrow();
	});

	it('allows time without time zone', () => {
		expect(() =>
			inferPgArrayType('col', { col: 'time without time zone' }),
		).not.toThrow();
	});

	it('allows double precision', () => {
		expect(() =>
			inferPgArrayType('col', { col: 'double precision' }),
		).not.toThrow();
	});

	it('allows character varying', () => {
		expect(() =>
			inferPgArrayType('col', { col: 'character varying' }),
		).not.toThrow();
	});

	it('allows bit varying', () => {
		expect(() => inferPgArrayType('col', { col: 'bit varying' })).not.toThrow();
	});
});

// ============================================================================
// FINDING 1: typeof guards — non-string inputs at validate+render sites
// Regression-locks that forged non-string values are rejected before
// validation+rendering, preventing validate-coerce / render-original confusion.
// ============================================================================

describe('FINDING-1: non-string operator throws (assertSafeOperator typeof guard)', () => {
	it('rejects number as customOp operator', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: 42 as unknown as string,
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/expected a string/);
	});

	it('rejects object as customOp operator', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'customOp',
				operator: { toString: () => '<=>' } as unknown as string,
				left: { kind: 'ref', column: 'a' },
				right: { kind: 'param', value: 1 },
			}),
		).toThrow(/expected a string/);
	});

	it('rejects number as unary operator', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'unary',
				operator: 0 as unknown as string,
				operand: { kind: 'ref', column: 'x' },
			}),
		).toThrow(/expected a string/);
	});
});

describe('FINDING-1: non-string cast typeName throws (typeof guard)', () => {
	it('rejects number as cast typeName', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: 42 as unknown as string,
				expr: { kind: 'param', value: 1 },
			}),
		).toThrow(/typeName must be a plain string/);
	});

	it('rejects object as cast typeName', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'cast',
				typeName: { toString: () => 'text' } as unknown as string,
				expr: { kind: 'param', value: 'hello' },
			}),
		).toThrow(/typeName must be a plain string/);
	});
});

describe('FINDING-1: non-string namedArg name throws (typeof guard)', () => {
	it('rejects number as namedArg name', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileSelectExpression({
				kind: 'namedArg',
				name: 99 as unknown as string,
				value: { kind: 'param', value: 'hello' },
			}),
		).toThrow(/name must be a plain string/);
	});
});

describe('FINDING-1: non-string ALTER COLUMN USING throws (typeof guard)', () => {
	it('rejects number as USING expression', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'status', {
				type: 'text',
				using: 42 as unknown as string,
			}),
		).toThrow(/must be a plain string/);
	});

	it('rejects object as USING expression', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'public', 'status', {
				type: 'text',
				using: { toString: () => 'old_status::text' } as unknown as string,
			}),
		).toThrow(/must be a plain string/);
	});
});

// ============================================================================
// TOCTOU getter-probe tests — snapshot-once regression locks
//
// These construct forged objects whose getter returns a SAFE value on the first
// access (validation) and a MALICIOUS value on every subsequent access (render).
// Before snapshot-once: the malicious value is rendered → SQL injection.
// After snapshot-once: only the first/validated value is ever used → safe.
//
// Pattern: build a getter that counts reads; return safe on call #1, malicious
// on call #2+. Assert that the emitted SQL contains ONLY the safe value and
// never the injection payload.
// ============================================================================

describe('TOCTOU getter-probe: customOp operator snapshot-once', () => {
	it('renders only the validated (safe) operator when getter switches after first read', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		let reads = 0;
		const intent = {
			kind: 'customOp' as const,
			get operator() {
				reads += 1;
				return reads === 1 ? '<=>' : '<=>; DROP TABLE users --';
			},
			left: { kind: 'ref' as const, column: 'embedding' },
			right: { kind: 'param' as const, value: [0.1, 0.2] },
		};
		const { sql } = adapter.compileSelectExpression(intent);
		// Only the safe operator appears; injection payload must not be present.
		expect(sql).toContain('<=>');
		expect(sql).not.toContain('DROP TABLE');
	});
});

describe('TOCTOU getter-probe: unary operator snapshot-once', () => {
	it('renders only the validated (safe) operator when getter switches after first read', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		let reads = 0;
		const intent = {
			kind: 'unary' as const,
			get operator() {
				reads += 1;
				return reads === 1 ? 'NOT' : 'NOT true; DROP TABLE users --';
			},
			operand: { kind: 'ref' as const, column: 'active' },
		};
		const { sql } = adapter.compileSelectExpression(intent);
		expect(sql).not.toContain('DROP TABLE');
	});
});

describe('TOCTOU getter-probe: cast typeName snapshot-once', () => {
	it('renders only the validated (safe) typeName when getter switches after first read', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		let reads = 0;
		const intent = {
			kind: 'cast' as const,
			get typeName() {
				reads += 1;
				return reads === 1 ? 'vector' : 'vector; DROP TABLE users --';
			},
			expr: { kind: 'param' as const, value: [0.1, 0.2] },
		};
		const { sql } = adapter.compileSelectExpression(intent);
		expect(sql).toContain('vector');
		expect(sql).not.toContain('DROP TABLE');
	});
});

describe('TOCTOU getter-probe: namedArg name snapshot-once', () => {
	it('renders only the validated (safe) name when getter switches after first read', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		let reads = 0;
		const intent = {
			kind: 'namedArg' as const,
			get name() {
				reads += 1;
				return reads === 1 ? 'query_text' : 'query_text; DROP TABLE users --';
			},
			value: { kind: 'param' as const, value: 'hello' },
		};
		const { sql } = adapter.compileSelectExpression(intent);
		expect(sql).toContain('query_text');
		expect(sql).not.toContain('DROP TABLE');
	});
});

describe('TOCTOU getter-probe: ALTER COLUMN USING snapshot-once', () => {
	it('renders only the validated (safe) expression when getter switches after first read', () => {
		let reads = 0;
		const options = {
			type: 'text' as const,
			get using() {
				reads += 1;
				return reads === 1
					? 'old_status::text'
					: 'old_status::text; DROP TABLE users --';
			},
		};
		const sql = generateAlterColumnSQL('users', 'public', 'status', options);
		expect(sql).toContain('old_status::text');
		expect(sql).not.toContain('DROP TABLE');
	});
});

describe('TOCTOU getter-probe: RLS policy using/withCheck snapshot-once (ddl-generator)', () => {
	it('renders only the validated (safe) USING expression when getter switches', () => {
		let reads = 0;
		const policy = {
			name: 'tenant_policy',
			permissive: true as const,
			get using() {
				reads += 1;
				// Safe value uses no forbidden chars; malicious value has semicolon injection.
				return reads === 1
					? 'tenant_id = current_user_id()'
					: 'tenant_id = current_user_id()); DROP TABLE users --';
			},
		} as Parameters<typeof generateCreatePolicy>[1];
		const sql = generateCreatePolicy(
			'users',
			policy,
			undefined,
			identityNaming,
		);
		expect(sql).toContain('USING (');
		expect(sql).not.toContain('DROP TABLE');
	});

	it('renders only the validated (safe) WITH CHECK expression when getter switches', () => {
		let reads = 0;
		const policy = {
			name: 'tenant_write_policy',
			permissive: true as const,
			get withCheck() {
				reads += 1;
				return reads === 1
					? 'tenant_id = current_user_id()'
					: 'tenant_id = current_user_id()); DROP TABLE users --';
			},
		} as Parameters<typeof generateCreatePolicy>[1];
		const sql = generateCreatePolicy(
			'users',
			policy,
			undefined,
			identityNaming,
		);
		expect(sql).toContain('WITH CHECK (');
		expect(sql).not.toContain('DROP TABLE');
	});
});

describe('TOCTOU getter-probe: RLS policy using/withCheck snapshot-once (migration-sql)', () => {
	it('renders only the validated (safe) USING expression in migration path', async () => {
		const { generateMigrationSQL } = await import('../ddl/migration-sql.js');
		let reads = 0;
		const diff = {
			changes: [
				{
					kind: 'create_policy' as const,
					table: 'users',
					destructive: false,
					details: '',
					meta: {
						policy: {
							name: 'tenant_policy',
							permissive: true,
							get using() {
								reads += 1;
								return reads === 1
									? 'tenant_id = current_user_id()'
									: 'tenant_id = current_user_id()); DROP TABLE users --';
							},
						},
					},
				},
			],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		};
		// generateMigrationSQL returns string[] — join for substring assertions
		const statements = generateMigrationSQL(
			diff as Parameters<typeof generateMigrationSQL>[0],
		);
		const sql = statements.join('\n');
		expect(sql).toContain('USING (');
		expect(sql).not.toContain('DROP TABLE');
	});
});
