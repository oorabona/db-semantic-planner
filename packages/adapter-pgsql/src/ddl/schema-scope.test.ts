import { POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type { ColumnIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateDDL } from './ddl-generator.js';
import { generateDownSQL, generateMigrationSQL } from './migration-sql.js';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';

function makeColumn(overrides: Partial<ColumnIR> & { name: string }): ColumnIR {
	return {
		type: 'string',
		nullable: false,
		...overrides,
	};
}

function targetScopedColumn(name = 'status', schema = 'tenant_1'): ColumnIR {
	return makeColumn({
		name,
		type: 'string',
		originalDbType: 'status',
		originalDbTypeSchema: schema,
		originalDbTypeSchemaScope: 'target',
	});
}

function makeTable(columns: readonly ColumnIR[]): TableIR {
	return {
		name: 'accounts',
		columns,
		foreignKeys: [],
		indexes: [],
	};
}

function makeModel(
	tables: readonly TableIR[] = [],
	enums: readonly EnumIR[] = [],
): ModelIR {
	return {
		tables: new Map(tables.map((table) => [table.name, table])),
		relations: new Map(),
		enums: new Map(enums.map((enumDef) => [enumDef.name, enumDef])),
	} as unknown as ModelIR;
}

function makeDiff(changes: readonly SchemaChange[]): SchemaDiff {
	return {
		changes,
		hasDestructive: changes.some((change) => change.destructive),
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function expectedModelMessage(schemas: readonly string[]): string {
	return (
		'generateDDL requires an explicit schemaName: this model is schema-scoped — ' +
		`its custom types/enums live in ${schemas.map((schema) => JSON.stringify(schema)).join(', ')}. ` +
		'Pass options.schemaName with the schema this DDL targets ' +
		'(the source schema to re-emit it as-is, or another schema to retarget it).'
	);
}

function expectedDiffMessage(schemas: readonly string[]): string {
	return (
		'Migration SQL generation requires an explicit schemaName: this diff is schema-scoped — ' +
		`its custom types/enums live in ${schemas.map((schema) => JSON.stringify(schema)).join(', ')}. ` +
		'Pass options.schemaName with the schema this migration targets ' +
		'(the source schema to re-emit it as-is, or another schema to retarget it).'
	);
}

const NO_ENUM_CAPS = {
	...POSTGRESQL_CAPABILITIES,
	supportsDDLEnumTypes: false,
};

describe('schema-scoped DDL guard', () => {
	it('throws when a target-scoped column lives in a non-default schema and schemaName is absent', () => {
		const model = makeModel([makeTable([targetScopedColumn()])]);

		expect(() => generateDDL(model)).toThrowError(
			expectedModelMessage(['tenant_1']),
		);
	});

	it('allows retargeting a target-scoped column when schemaName is explicit', () => {
		const model = makeModel([makeTable([targetScopedColumn()])]);

		expect(generateDDL(model, { schemaName: 'tenant_2' })).toEqual([
			`CREATE TABLE "tenant_2"."accounts" (
  "status" "tenant_2".status NOT NULL
);`,
		]);
	});

	it('does not treat absolute public or shared types as model scope', () => {
		const model = makeModel([
			makeTable([
				makeColumn({
					name: 'public_status',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'public',
					originalDbTypeSchemaScope: 'absolute',
				}),
				makeColumn({
					name: 'shared_status',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'shared_types',
					originalDbTypeSchemaScope: 'absolute',
				}),
			]),
		]);

		expect(generateDDL(model)).toEqual([
			`CREATE TABLE "accounts" (
  "public_status" "public".status NOT NULL,
  "shared_status" "shared_types".status NOT NULL
);`,
		]);
	});

	it('does not throw for built-ins or legacy originalDbType spellings', () => {
		const model = makeModel([
			makeTable([
				makeColumn({ name: 'id', type: 'integer' }),
				makeColumn({
					name: 'legacy_bare',
					type: 'string',
					originalDbType: 'status',
				}),
				makeColumn({
					name: 'legacy_qualified',
					type: 'string',
					originalDbType: '"tenant_1".status',
				}),
			]),
		]);

		expect(generateDDL(model)).toEqual([
			`CREATE TABLE "accounts" (
  "id" INTEGER NOT NULL,
  "legacy_bare" status NOT NULL,
  "legacy_qualified" "tenant_1".status NOT NULL
);`,
		]);
	});

	it('does not throw for managed enums in a non-default schema when no table SQL is emitted', () => {
		const model = makeModel(
			[],
			[{ name: 'status', schema: 'tenant_1', values: ['active'] }],
		);

		expect(generateDDL(model)).toEqual([
			`CREATE TYPE "tenant_1"."status" AS ENUM ('active');`,
		]);
	});

	it('does not throw for public managed enums', () => {
		const model = makeModel(
			[],
			[{ name: 'status', schema: 'public', values: ['active'] }],
		);

		expect(generateDDL(model)).toEqual([
			`CREATE TYPE "status" AS ENUM ('active');`,
		]);
	});

	it('does not count scoped enum DDL when enum types are capability-filtered', () => {
		const scopedEnum = {
			name: 'status',
			schema: 'tenant_1',
			values: ['active'],
		};

		expect(
			generateDDL(makeModel([], [scopedEnum]), {
				dialectCapabilities: NO_ENUM_CAPS,
			}),
		).toEqual([]);
		expect(() =>
			generateDDL(
				makeModel([makeTable([targetScopedColumn()])], [scopedEnum]),
				{
					dialectCapabilities: NO_ENUM_CAPS,
				},
			),
		).toThrowError(expectedModelMessage(['tenant_1']));
	});

	it('detects scoped columns on create_table meta.table', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'accounts',
				destructive: false,
				details: 'Create accounts',
				meta: { table: makeTable([targetScopedColumn()]) },
			},
		]);

		expect(() => generateMigrationSQL(diff)).toThrowError(
			expectedDiffMessage(['tenant_1']),
		);
	});

	it('does not throw for a scoped create_enum migration when no table SQL is emitted', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create status enum',
				meta: {
					enum: { name: 'status', schema: 'tenant_1', values: ['active'] },
				},
			},
		]);

		expect(generateMigrationSQL(diff)).toEqual([
			`CREATE TYPE "tenant_1"."status" AS ENUM ('active');`,
		]);
	});

	it('does not throw for a scoped alter_enum_add_value migration when no table SQL is emitted', () => {
		const diff = makeDiff([
			{
				kind: 'alter_enum_add_value',
				table: '',
				destructive: false,
				details: 'Add suspended status',
				meta: {
					enum: {
						name: 'status',
						schema: 'tenant_1',
						values: ['active', 'suspended'],
					},
					value: 'suspended',
					after: 'active',
				},
			},
		]);

		expect(generateMigrationSQL(diff)).toEqual([
			`ALTER TYPE "tenant_1"."status" ADD VALUE IF NOT EXISTS 'suspended' AFTER 'active';`,
		]);
	});

	it('throws when a scoped enum and table SQL are emitted in the same migration', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create status enum',
				meta: {
					enum: { name: 'status', schema: 'tenant_1', values: ['active'] },
				},
			},
			{
				kind: 'create_table',
				table: 'accounts',
				destructive: false,
				details: 'Create accounts',
				meta: {
					table: makeTable([makeColumn({ name: 'id', type: 'integer' })]),
				},
			},
		]);

		expect(() => generateMigrationSQL(diff)).toThrowError(
			expectedDiffMessage(['tenant_1']),
		);
	});

	it('keeps UP and DOWN in step when a scoped enum is filtered out by the dialect', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create status enum',
				meta: {
					enum: { name: 'status', schema: 'tenant_1', values: ['active'] },
				},
			},
			{
				kind: 'create_table',
				table: 'accounts',
				destructive: false,
				details: 'Create accounts',
				meta: {
					table: makeTable([makeColumn({ name: 'id', type: 'integer' })]),
				},
			},
		]);
		const options = { dialectCapabilities: NO_ENUM_CAPS };

		// A dialect without enum DDL emits neither the CREATE TYPE nor its rollback,
		// so no schema-scoped SQL is generated and neither direction may refuse.
		expect(generateMigrationSQL(diff, options)).toEqual([
			`CREATE TABLE "accounts" (
  "id" INTEGER NOT NULL
);`,
		]);
		expect(generateDownSQL(diff, options)).toEqual([
			'DROP TABLE IF EXISTS "accounts" CASCADE;',
		]);
	});

	it('detects scoped columns on alter_column_type meta.fromColumn', () => {
		const diff = makeDiff([
			{
				kind: 'alter_column_type',
				table: 'accounts',
				column: 'status',
				destructive: true,
				details: 'Alter accounts.status',
				meta: { fromColumn: targetScopedColumn(), toType: 'text' },
			},
		]);

		expect(() => generateMigrationSQL(diff)).toThrowError(
			expectedDiffMessage(['tenant_1']),
		);
	});

	it('returns the safe UP subset when the only schema-scoped change is destructively filtered', () => {
		const diff = makeDiff([
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop status',
				meta: {
					enum: { name: 'status', schema: 'tenant_1', values: ['active'] },
				},
			},
			{
				kind: 'add_column',
				table: 'accounts',
				column: 'nickname',
				destructive: false,
				details: 'Add accounts.nickname',
				meta: {
					column: makeColumn({
						name: 'nickname',
						type: 'text',
						nullable: true,
					}),
				},
			},
		]);

		expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual([
			`ALTER TABLE "accounts" ADD COLUMN "nickname" TEXT;`,
		]);
	});

	it('throws when a schema-scoped UP change survives destructive filtering', () => {
		const diff = makeDiff([
			{
				kind: 'add_column',
				table: 'accounts',
				column: 'status',
				destructive: false,
				details: 'Add accounts.status',
				meta: { column: targetScopedColumn() },
			},
		]);

		expect(() =>
			generateMigrationSQL(diff, { includeDestructive: false }),
		).toThrowError(expectedDiffMessage(['tenant_1']));
	});

	it('returns the safe DOWN subset when the only schema-scoped change is destructively filtered', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'accounts',
				destructive: false,
				details: 'Create accounts',
				meta: { table: makeTable([targetScopedColumn()]) },
			},
			{
				kind: 'drop_primary_key',
				table: 'accounts',
				destructive: true,
				details: 'Drop accounts primary key',
				meta: { columns: ['id'] },
			},
		]);

		expect(generateDownSQL(diff, { includeDestructive: false })).toEqual([
			`ALTER TABLE "accounts" ADD CONSTRAINT "pk_accounts" PRIMARY KEY ("id");`,
		]);
	});

	it('makes UP and DOWN agree on requiring schemaName with default destructive filtering', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'accounts',
				destructive: false,
				details: 'Create accounts',
				meta: { table: makeTable([targetScopedColumn()]) },
			},
		]);

		expect(() => generateMigrationSQL(diff)).toThrowError(
			expectedDiffMessage(['tenant_1']),
		);
		expect(() => generateDownSQL(diff)).toThrowError(
			expectedDiffMessage(['tenant_1']),
		);
	});

	it('escapes discovered schema names in error messages', () => {
		const schema = 'tenant_"quoted\nline';
		const model = makeModel([
			makeTable([targetScopedColumn('status', schema)]),
		]);

		expect(() => generateDDL(model)).toThrowError(
			expectedModelMessage([schema]),
		);
	});

	it('lists discovered schemas sorted and deduped', () => {
		const model = makeModel(
			[
				makeTable([
					targetScopedColumn('status_b', 'tenant_b'),
					targetScopedColumn('status_a', 'tenant_a'),
				]),
			],
			[{ name: 'status_b', schema: 'tenant_b', values: ['active'] }],
		);

		expect(() => generateDDL(model)).toThrowError(
			expectedModelMessage(['tenant_a', 'tenant_b']),
		);
	});
});
