import { POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type { DialectCapabilities, IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	type EngineCanonicalExpression,
	isEngineCanonicalIndex,
	markEngineCanonicalCheck,
	markEngineCanonicalIndex,
} from '../expression-provenance.js';
import { identityNaming } from '../naming-plugin.js';
import { derivePostgresqlCapabilitiesForVersion } from '../postgresql-capabilities.js';
import { generateCreateIndex } from './ddl-generator.js';
import { generateCreateIndexSQL } from './index-operations.js';
import {
	IndexFeatureUnsupportedError,
	renderCreateIndex,
} from './index-render.js';
import { generateDownSQL, generateMigrationSQL } from './migration-sql.js';
import type { SchemaDiff } from './schema-diff.js';

const maximalIndex: IndexIR = {
	name: 'idx_orders_email_cover',
	columns: ['email', 'tenant_id'],
	expressions: ['lower(email)'],
	unique: true,
	method: 'gin',
	opclass: {
		email: 'gin_trgm_ops',
		tenant_id: 'int4_ops',
	},
	include: ['id', 'created_at'],
	nullsNotDistinct: true,
	with: {
		fillfactor: '80',
		fastupdate: 'off',
	},
	where: "deleted_at IS NULL AND note = 'active'",
};

const maximalPublicOptions = {
	name: 'idx_orders_email_cover',
	columns: [
		{ expression: 'lower(email)', opclass: 'text_pattern_ops' },
		'tenant_id',
	],
	unique: true,
	concurrently: true,
	ifNotExists: true,
	method: 'gin' as const,
	opclass: {
		tenant_id: 'int4_ops',
	},
	include: ['id', 'created_at'],
	nullsNotDistinct: true,
	with: {
		fillfactor: '80',
		fastupdate: 'off',
	},
	where: "deleted_at IS NULL AND note = 'active'",
};

const pg15Caps = POSTGRESQL_CAPABILITIES;
const pg14Caps: DialectCapabilities = {
	...POSTGRESQL_CAPABILITIES,
	supportsDDLIndexNullsNotDistinct: false,
};
const pg10Caps: DialectCapabilities = {
	...pg14Caps,
	supportsDDLIndexInclude: false,
};

describe('partial-index predicate literal validation', () => {
	it('rejects SQL injection hidden by apostrophes in double-quoted identifiers', () => {
		expect(() =>
			renderCreateIndex({
				name: 'idx_notes_flag',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
				where: '"flag\'"; DROP TABLE victims; SELECT 1 AS "bar\'"',
			}),
		).toThrow(/contains forbidden token ";" outside string literal/);
	});

	it('accepts a legitimate double-quoted identifier containing an apostrophe', () => {
		expect(
			renderCreateIndex({
				name: 'idx_notes_its',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
				where: '"it\'s" = true',
			}),
		).toContain('WHERE "it\'s" = true');
	});

	it('omits WHERE only when the predicate is undefined', () => {
		expect(
			renderCreateIndex({
				name: 'idx_notes_empty_predicate',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
			}),
		).not.toContain(' WHERE ');
	});

	it('passes a present blank predicate through to PostgreSQL', () => {
		expect(
			renderCreateIndex({
				name: 'idx_notes_whitespace_predicate',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
				where: '   ',
			}),
		).toContain('WHERE    ');
	});

	it('rejects a backslash in an ordinary quoted predicate literal', () => {
		const predicate = String.raw`note = '\n'`;
		expect(() =>
			renderCreateIndex({
				name: 'idx_notes_newline',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
				where: predicate,
			}),
		).toThrow(
			`Unsafe SQL expression in index WHERE predicate: contains a backslash in an ordinary single-quoted string literal, whose meaning depends on PostgreSQL standard_conforming_strings; use E'...' for a setting-independent string literal. Value: "${predicate}"`,
		);
	});

	it('renders an authored escape-string predicate literal', () => {
		const predicate = String.raw`note = E'\\n'`;
		expect(
			renderCreateIndex({
				name: 'idx_notes_newline',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
				where: predicate,
			}),
		).toContain(`WHERE ${predicate}`);
	});

	it('refuses an authored Unicode-escape predicate literal', () => {
		expect(() =>
			renderCreateIndex({
				name: 'idx_notes_unicode_escape',
				table: 'notes',
				keys: [{ column: 'id' }],
				unique: false,
				where: String.raw`note = U&'\0441'`,
			}),
		).toThrow(/contains a Unicode-escape string literal/);
	});

	it('refuses a Proxy forged as a canonical predicate', () => {
		const forged = new Proxy(
			{
				name: 'idx_notes_forged',
				columns: ['id'],
				where: "note = U&'\\0441'",
			},
			{
				get(target, property, receiver) {
					return typeof property === 'symbol'
						? property
						: Reflect.get(target, property, receiver);
				},
			},
		);

		expect(isEngineCanonicalIndex(forged)).toBe(false);
		expect(() =>
			renderCreateIndex({
				name: 'idx_notes_forged',
				table: 'notes',
				unique: false,
				keys: [{ column: 'id' }],
				where: forged.where,
				whereSource: forged,
			}),
		).toThrow(/contains a Unicode-escape string literal/);
	});
});

function createIndexDiff(index: IndexIR = maximalIndex): SchemaDiff {
	return {
		changes: [
			{
				kind: 'create_index',
				table: 'orders',
				destructive: false,
				details: 'create maximal index',
				meta: { index },
			},
		],
		hasDestructive: false,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 1, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function createTableWithFkDiff(table: TableIR): SchemaDiff {
	return {
		changes: [
			{
				kind: 'create_table',
				table: table.name,
				destructive: false,
				details: 'create table',
				meta: { table },
			},
		],
		hasDestructive: false,
		summary: {
			tables: { added: 1, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 1, dropped: 0, altered: 0 },
		},
	};
}

function replaceIndexDiff(oldIndex: IndexIR, newIndex: IndexIR): SchemaDiff {
	return {
		changes: [
			{
				kind: 'drop_index',
				table: 'users',
				destructive: true,
				details: 'drop old index',
				meta: { index: oldIndex },
			},
			{
				kind: 'create_index',
				table: 'users',
				destructive: true,
				details: 'create replacement index',
				meta: { index: newIndex },
			},
		],
		hasDestructive: true,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 1, dropped: 1 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function dropIndexDiff(index: IndexIR): SchemaDiff {
	return {
		changes: [
			{
				kind: 'drop_index',
				table: 'users',
				destructive: true,
				details: 'drop index',
				meta: { index },
			},
		],
		hasDestructive: true,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 1 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

describe('CREATE INDEX pre-refactor goldens', () => {
	it('captures ddl-generator maximal index SQL byte-for-byte', () => {
		expect(
			generateCreateIndex('orders', maximalIndex, 'app', identityNaming),
		).toEqual(
			'CREATE UNIQUE INDEX "idx_orders_email_cover" ON "app"."orders" USING gin (lower(email), "email" gin_trgm_ops, "tenant_id" int4_ops) INCLUDE ("id", "created_at") NULLS NOT DISTINCT WITH (fillfactor = 80, fastupdate = off) WHERE deleted_at IS NULL AND note = \'active\';',
		);
	});

	it('captures migration create_index maximal index SQL byte-for-byte', () => {
		expect(
			generateMigrationSQL(createIndexDiff(), { schemaName: 'app' }),
		).toEqual([
			'CREATE UNIQUE INDEX IF NOT EXISTS "idx_orders_email_cover" ON "app"."orders" USING gin (lower(email), "email" gin_trgm_ops, "tenant_id" int4_ops) INCLUDE ("id", "created_at") NULLS NOT DISTINCT WITH (fillfactor = 80, fastupdate = off) WHERE deleted_at IS NULL AND note = \'active\';',
		]);
	});

	it('makes canonical predicates with backslashes setting-independent', () => {
		const canonicalPredicate = String.raw`note ~ '\d+'::text`;
		const canonicalIndex = markEngineCanonicalIndex({
			name: 'idx_orders_note_pattern',
			columns: ['id'],
			where: canonicalPredicate as EngineCanonicalExpression,
		});
		const diff = createIndexDiff(canonicalIndex);

		expect(generateMigrationSQL(diff, { schemaName: 'app' })).toEqual([
			'CREATE INDEX IF NOT EXISTS "idx_orders_note_pattern" ON "app"."orders" ("id") WHERE note ~ E\'\\\\d+\'::text;',
		]);
		expect(
			generateDownSQL(dropIndexDiff(canonicalIndex), { schemaName: 'app' }),
		).toEqual([
			'CREATE INDEX IF NOT EXISTS "idx_orders_note_pattern" ON "app"."users" ("id") WHERE note ~ E\'\\\\d+\'::text;',
		]);
	});

	it('makes canonical CHECK SQL without an index setting-independent', () => {
		const canonicalCheck = markEngineCanonicalCheck({
			name: 'orders_note_format',
			expression: String.raw`CHECK (note ~ '\d+')`,
		});
		const diff: SchemaDiff = {
			changes: [
				{
					kind: 'drop_check_constraint',
					table: 'orders',
					destructive: true,
					details: 'Drop previous note format check',
					meta: { check: canonicalCheck },
				},
				{
					kind: 'add_check_constraint',
					table: 'orders',
					destructive: false,
					details: 'Add note format check',
					meta: { check: canonicalCheck },
				},
			],
			hasDestructive: true,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 1, dropped: 1, altered: 0 },
			},
		};

		expect(generateMigrationSQL(diff)).toEqual([
			'ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_note_format";',
			expect.stringContaining("CHECK (note ~ E'\\\\d+')"),
		]);
		expect(generateDownSQL(diff)).toEqual([
			'ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_note_format";',
			expect.stringContaining("CHECK (note ~ E'\\\\d+')"),
		]);
	});

	it('captures public create-index maximal SQL byte-for-byte', () => {
		expect(
			generateCreateIndexSQL('orders', 'app', maximalPublicOptions),
		).toEqual(
			'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_email_cover" ON "app"."orders" USING gin (lower(email) text_pattern_ops, "tenant_id" int4_ops) INCLUDE ("id", "created_at") NULLS NOT DISTINCT WITH (fillfactor = 80, fastupdate = off) WHERE deleted_at IS NULL AND note = \'active\'',
		);
	});

	it('captures migration FK auto-index SQL byte-for-byte', () => {
		const table: TableIR = {
			name: 'posts',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'user_id', type: 'integer', nullable: false },
			],
			primaryKey: ['id'],
			foreignKeys: [
				{
					columns: ['user_id'],
					references: {
						table: 'users',
						columns: ['id'],
					},
				},
			],
			indexes: [],
		};

		expect(
			generateMigrationSQL(createTableWithFkDiff(table), { schemaName: 'app' }),
		).toContain(
			'CREATE INDEX IF NOT EXISTS "idx_posts_user_id" ON "app"."posts" ("user_id");',
		);
	});
});

describe('CREATE INDEX capability assertions', () => {
	it('rejects NULLS NOT DISTINCT when capabilities are below PostgreSQL 15', () => {
		expect(() =>
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'uk_users_email_nulls',
					columns: ['email'],
					unique: true,
					nullsNotDistinct: true,
				},
				{ caps: pg14Caps, targetVersion: '14' },
			),
		).toThrow(IndexFeatureUnsupportedError);
		expect(() =>
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'uk_users_email_nulls',
					columns: ['email'],
					unique: true,
					nullsNotDistinct: true,
				},
				{ caps: pg14Caps, targetVersion: '14' },
			),
		).toThrow(
			'index `uk_users_email_nulls`: NULLS NOT DISTINCT requires PostgreSQL >= 15 (target 14)',
		);
	});

	it('rejects INCLUDE when capabilities are below PostgreSQL 11', () => {
		expect(() =>
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'idx_users_email_cover',
					columns: ['email'],
					include: ['id'],
				},
				{ caps: pg10Caps, targetVersion: '10' },
			),
		).toThrow(
			'index `idx_users_email_cover`: INCLUDE requires PostgreSQL >= 11 (target 10)',
		);
	});

	it('renders CONCURRENTLY for PG10/PG11 derived capabilities', () => {
		for (const version of ['10', '11']) {
			const caps = derivePostgresqlCapabilitiesForVersion(version);
			expect(
				generateCreateIndexSQL(
					'users',
					'public',
					{
						name: 'uk_users_email_concurrent',
						columns: ['email'],
						unique: true,
						concurrently: true,
					},
					{
						caps,
						targetVersion: version,
					},
				),
			).toEqual(
				'CREATE UNIQUE INDEX CONCURRENTLY "uk_users_email_concurrent" ON "public"."users" ("email")',
			);
		}
	});

	it('emits supported NULLS NOT DISTINCT with PostgreSQL 15 capabilities', () => {
		expect(
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'uk_users_email_nulls',
					columns: ['email'],
					unique: true,
					nullsNotDistinct: true,
				},
				{ caps: pg15Caps, targetVersion: '15' },
			),
		).toEqual(
			'CREATE UNIQUE INDEX "uk_users_email_nulls" ON "public"."users" ("email") NULLS NOT DISTINCT',
		);
	});

	it('rejects NULLS NOT DISTINCT on a non-unique index as an input error', () => {
		expect(() =>
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'idx_users_email_nulls',
					columns: ['email'],
					nullsNotDistinct: true,
				},
				{ caps: pg15Caps, targetVersion: '15' },
			),
		).toThrow(
			'index `idx_users_email_nulls`: NULLS NOT DISTINCT is only valid for UNIQUE indexes',
		);
	});

	it('keeps the public API permissive without a context and gated with one', () => {
		expect(
			generateCreateIndexSQL('users', 'public', {
				name: 'uk_users_email_nulls',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
			}),
		).toEqual(
			'CREATE UNIQUE INDEX "uk_users_email_nulls" ON "public"."users" ("email") NULLS NOT DISTINCT',
		);

		expect(() =>
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'uk_users_email_nulls',
					columns: ['email'],
					unique: true,
					nullsNotDistinct: true,
				},
				{ caps: pg14Caps, targetVersion: '14' },
			),
		).toThrow(IndexFeatureUnsupportedError);
	});

	it('aggregates multiple unsupported features in declaration order', () => {
		let error: unknown;
		try {
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'uk_users_email_cover_nulls',
					columns: ['email'],
					unique: true,
					include: ['id'],
					nullsNotDistinct: true,
				},
				{ caps: pg10Caps, targetVersion: '10' },
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(IndexFeatureUnsupportedError);
		expect((error as IndexFeatureUnsupportedError).unsupportedFeatures).toEqual(
			['INCLUDE', 'NULLS NOT DISTINCT'],
		);
		expect((error as Error).message).toEqual(
			'index `uk_users_email_cover_nulls`: INCLUDE requires PostgreSQL >= 11 (target 10); index `uk_users_email_cover_nulls`: NULLS NOT DISTINCT requires PostgreSQL >= 15 (target 10)',
		);
	});

	it('reports input errors before version aggregate errors', () => {
		let error: unknown;
		try {
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'idx_users_email_cover_nulls',
					columns: ['email'],
					include: ['id'],
					nullsNotDistinct: true,
				},
				{ caps: pg10Caps, targetVersion: '10' },
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).not.toBeInstanceOf(IndexFeatureUnsupportedError);
		expect((error as Error).message).toEqual(
			'index `idx_users_email_cover_nulls`: NULLS NOT DISTINCT is only valid for UNIQUE indexes',
		);
	});

	it('gates expression indexes even though migration diff treats them as unmanaged', () => {
		const noExpressionCaps: DialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLExpressionIndexes: false,
		};

		expect(() =>
			generateCreateIndexSQL(
				'users',
				'public',
				{
					name: 'idx_users_lower_email',
					columns: [{ expression: 'lower(email)' }],
				},
				{ caps: noExpressionCaps },
			),
		).toThrow(
			'index `idx_users_lower_email`: EXPRESSION INDEX is not enabled in the supplied dialect capabilities',
		);
	});

	it('rejects unsafe identifier vectors before SQL emission', () => {
		for (const name of [
			'idx"quote',
			'idx;semi',
			'idx--comment',
			'idx*/comment',
		]) {
			expect(() =>
				generateCreateIndexSQL('users', 'public', {
					name,
					columns: ['email'],
				}),
			).toThrow('Invalid alias identifier');
		}
	});

	it('throws on empty keys and omits empty WITH clauses', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_empty',
				columns: [],
			}),
		).toThrow('index `idx_empty`: CREATE INDEX requires at least one key');
		expect(() =>
			renderCreateIndex({
				name: 'idx_empty_expression',
				table: 'users',
				unique: false,
				keys: [{ expression: '' }],
			}),
		).toThrow(
			'index `idx_empty_expression`: CREATE INDEX key #1 must declare a non-empty column or expression',
		);
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_blank_expression',
				columns: [{ expression: '   ' }],
			}),
		).toThrow(
			'index `idx_blank_expression`: CREATE INDEX key #1 must declare a non-empty column or expression',
		);
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_empty_column',
				columns: [''],
			}),
		).toThrow(
			'index `idx_empty_column`: CREATE INDEX key #1 must declare a non-empty column or expression',
		);
		expect(() =>
			renderCreateIndex({
				name: 'idx_ambiguous_key',
				table: 'users',
				unique: false,
				keys: [{ column: 'email', expression: 'lower(email)' }],
			}),
		).toThrow(
			'index `idx_ambiguous_key`: CREATE INDEX key #1 must not declare both column and expression',
		);

		expect(
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_no_with',
				columns: ['email'],
				with: {},
			}),
		).toEqual('CREATE INDEX "idx_no_with" ON "public"."users" ("email")');
	});

	it('renders a partial-index predicate with a literal semicolon', () => {
		expect(
			renderCreateIndex({
				name: 'idx_notes_tag',
				table: 'notes',
				unique: false,
				keys: [{ column: 'id' }],
				where: "tag = 'a;b'",
			}),
		).toContain("WHERE tag = 'a;b'");
	});

	it('routes equivalent site inputs through the same renderer output', () => {
		const ddlSql = generateCreateIndex(
			'orders',
			{ ...maximalIndex, name: 'idx_orders_email_cover' },
			'app',
			identityNaming,
		).replace(/;$/, '');
		const publicSql = generateCreateIndexSQL('orders', 'app', {
			...maximalPublicOptions,
			concurrently: false,
			ifNotExists: false,
			columns: [{ expression: 'lower(email)' }, 'email', 'tenant_id'],
			opclass: {
				email: 'gin_trgm_ops',
				tenant_id: 'int4_ops',
			},
		});
		const migrationSql = generateMigrationSQL(createIndexDiff(), {
			schemaName: 'app',
		})[0]!
			.replace(' IF NOT EXISTS', '')
			.replace(/;$/, '');

		expect(ddlSql).toEqual(publicSql);
		expect(migrationSql).toEqual(publicSql);
	});
});

describe('PostgreSQL version-derived index capabilities', () => {
	it('validates version strings accepted by the projection bridge', () => {
		expect(() => derivePostgresqlCapabilitiesForVersion('14')).not.toThrow();
		expect(() => derivePostgresqlCapabilitiesForVersion('14.2')).not.toThrow();
		expect(() => derivePostgresqlCapabilitiesForVersion('garbage')).toThrow(
			'Invalid PostgreSQL version "garbage"',
		);
		for (const version of ['14junk', '14.evil', '', 'v14', '14.0.5.6']) {
			expect(() => derivePostgresqlCapabilitiesForVersion(version)).toThrow(
				`Invalid PostgreSQL version "${version}"`,
			);
		}
		expect(() => derivePostgresqlCapabilitiesForVersion('9')).toThrow(
			'Unsupported PostgreSQL version "9"; minimum supported major version is 10',
		);
		expect(() => derivePostgresqlCapabilitiesForVersion('140005')).toThrow(
			'PostgreSQL version "140005" must be a dotted or major version string, not server_version_num form',
		);
		// A minor/patch segment >= 100 overflows serverVersionNum's packed math
		// ("14.100" -> 150000 = PG15) and would falsely enable a gated feature.
		for (const version of ['10.100', '14.100', '14.0.100']) {
			expect(() => derivePostgresqlCapabilitiesForVersion(version)).toThrow(
				'minor/patch segments must be below 100',
			);
		}
		expect(() => derivePostgresqlCapabilitiesForVersion('14.99')).not.toThrow();
	});

	it('a below-min minor cannot falsely enable a version-gated feature (F8)', () => {
		// "14.100" once computed to PG15 and enabled NULLS NOT DISTINCT; it must now be rejected.
		expect(() => derivePostgresqlCapabilitiesForVersion('14.100')).toThrow();
		// A genuine PG14 target keeps NND / INCLUDE gated off.
		const pg14 = derivePostgresqlCapabilitiesForVersion('14');
		expect(pg14.supportsDDLIndexNullsNotDistinct).toBe(false);
		expect(pg14.supportsDDLIndexInclude).toBe(true);
	});

	it('preflights migration CREATE INDEX output all-or-nothing before replacement drops', () => {
		const diff = replaceIndexDiff(
			{ name: 'idx_users_email', columns: ['email'] },
			{
				name: 'uk_users_email_nulls',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
			},
		);

		expect(() =>
			generateMigrationSQL(diff, {
				dialectCapabilities: derivePostgresqlCapabilitiesForVersion('14'),
			}),
		).toThrow(IndexFeatureUnsupportedError);
		expect(() =>
			generateMigrationSQL(diff, {
				dialectCapabilities: derivePostgresqlCapabilitiesForVersion('14'),
			}),
		).toThrow('NULLS NOT DISTINCT requires PostgreSQL >= 15');
	});

	it('does not gate DOWN for a forward create_index because rollback is a pure drop', () => {
		const diff = createIndexDiff({
			name: 'uk_users_email_nulls',
			columns: ['email'],
			unique: true,
			nullsNotDistinct: true,
		});

		expect(
			generateDownSQL(diff, {
				dialectCapabilities: derivePostgresqlCapabilitiesForVersion('14'),
			}),
		).toEqual(['DROP INDEX IF EXISTS "uk_users_email_nulls";']);
	});

	it('gates DOWN recreation for a forward drop_index', () => {
		const diff = dropIndexDiff({
			name: 'uk_users_email_nulls',
			columns: ['email'],
			unique: true,
			nullsNotDistinct: true,
		});

		expect(() =>
			generateDownSQL(diff, {
				dialectCapabilities: derivePostgresqlCapabilitiesForVersion('14'),
			}),
		).toThrow(IndexFeatureUnsupportedError);
	});
});
