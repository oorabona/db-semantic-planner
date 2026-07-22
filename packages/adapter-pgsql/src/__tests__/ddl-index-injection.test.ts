/**
 * SQL Injection checks for index DDL emission paths.
 *
 * Covers S-1 (index WHERE, expressions, opclass, WITH keys) and S-2 (COLLATE)
 * across all three DDL emission paths:
 *   1. migration-sql.ts  → generateMigrationSQL (upCreateIndex)
 *   2. ddl-generator.ts  → generateCreateIndex
 *   3. index-operations.ts → generateCreateIndexSQL
 *
 * Also covers S-2 COLLATE injection via migration-sql (upAlterColumnCollation).
 */

import type { IndexIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateCreateIndex } from '../ddl/ddl-generator.js';
import { generateCreateIndexSQL } from '../ddl/index-operations.js';
import { generateMigrationSQL } from '../ddl/migration-sql.js';
import type { SchemaChange, SchemaDiff } from '../ddl/schema-diff.js';
import { identityNaming } from '../naming-plugin.js';

const unsafeWithValue = '70); DROP TABLE x; --';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(changes: SchemaChange[]): SchemaDiff {
	return {
		changes,
		hasDestructive: false,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function makeCreateIndexChange(idx: Partial<IndexIR>): SchemaChange {
	return {
		kind: 'create_index',
		table: 'users',
		destructive: false,
		details: '',
		meta: {
			index: {
				name: 'idx_test',
				columns: ['id'],
				...idx,
			} satisfies IndexIR,
		},
	};
}

function makeAlterColumnCollationChange(collation: string): SchemaChange {
	return {
		kind: 'alter_column_collation',
		table: 'users',
		column: 'name',
		destructive: false,
		details: '',
		meta: {
			column: {
				name: 'name',
				type: 'text',
				nullable: true,
				collation,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// S-1: migration-sql.ts (upCreateIndex) — index WHERE injection
// ---------------------------------------------------------------------------

describe('S-1 migration-sql upCreateIndex — index WHERE injection', () => {
	it('throws on semicolon injection in index WHERE', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({ where: 'active = true; DROP TABLE users' }),
				]),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on line-comment injection in index WHERE', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({ where: 'active = true -- injected' }),
				]),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on block-comment injection in index WHERE', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({ where: '/* comment */ active = true' }),
				]),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows a safe WHERE predicate', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeCreateIndexChange({ where: 'active = true' })]),
			),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// S-1: migration-sql.ts (upCreateIndex) — expression injection
// ---------------------------------------------------------------------------

describe('S-1 migration-sql upCreateIndex — expression injection', () => {
	it('throws on semicolon injection in index expression', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({
						columns: [],
						expressions: ['lower(email); DROP TABLE users'],
					}),
				]),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on line-comment injection in index expression', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({
						columns: [],
						expressions: ['lower(email) -- injected'],
					}),
				]),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows a safe expression', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({ columns: [], expressions: ['lower(email)'] }),
				]),
			),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// S-1: migration-sql.ts (upCreateIndex) — opclass injection
// ---------------------------------------------------------------------------

describe('S-1 migration-sql upCreateIndex — opclass injection', () => {
	it('throws on injection via opclass identifier', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({
						opclass: { id: 'vector_cosine_ops; DROP TABLE users' },
					}),
				]),
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('allows a valid opclass identifier', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({ opclass: { id: 'vector_cosine_ops' } }),
				]),
			),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// S-1: migration-sql.ts (upCreateIndex) — WITH key injection
// ---------------------------------------------------------------------------

describe('S-1 migration-sql upCreateIndex — WITH key injection', () => {
	it('throws on injection in WITH storage parameter key', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({
						with: { 'fillfactor = 10; DROP TABLE users; --': '70' },
					}),
				]),
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('allows a safe WITH parameter key', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeCreateIndexChange({ with: { fillfactor: '70' } })]),
			),
		).not.toThrow();
	});

	it('quotes unsafe WITH storage parameter values instead of raw-splicing them', () => {
		const sql = generateMigrationSQL(
			makeDiff([
				makeCreateIndexChange({
					with: { fillfactor: unsafeWithValue },
				}),
			]),
		);

		expect(sql[0]).toContain(`WITH (fillfactor = '${unsafeWithValue}')`);
		expect(sql[0]).not.toContain(`WITH (fillfactor = ${unsafeWithValue})`);
	});

	it('emits safe numeric and boolean WITH values unchanged', () => {
		const sql = generateMigrationSQL(
			makeDiff([
				makeCreateIndexChange({
					with: {
						fillfactor: 70 as unknown as string,
						fastupdate: 'on',
					},
				}),
			]),
		);

		expect(sql[0]).toContain('WITH (fillfactor = 70, fastupdate = on)');
	});
});

// ---------------------------------------------------------------------------
// S-1: ddl-generator.ts (generateCreateIndex) — all fields
// ---------------------------------------------------------------------------

const naming = identityNaming;

describe('S-1 ddl-generator generateCreateIndex — index WHERE injection', () => {
	it('throws on semicolon injection in index WHERE', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{
					name: 'idx_test',
					columns: ['id'],
					where: 'active = true; DROP TABLE users',
				},
				undefined,
				naming,
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on line-comment injection in index WHERE', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{
					name: 'idx_test',
					columns: ['id'],
					where: 'active = true -- injected',
				},
				undefined,
				naming,
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows a safe WHERE predicate', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{ name: 'idx_test', columns: ['id'], where: 'active = true' },
				undefined,
				naming,
			),
		).not.toThrow();
	});
});

describe('S-1 ddl-generator generateCreateIndex — expression injection', () => {
	it('throws on semicolon injection in expression', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{
					name: 'idx_test',
					columns: [],
					expressions: ['lower(email); DROP TABLE users'],
				},
				undefined,
				naming,
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows a safe expression', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{ name: 'idx_test', columns: [], expressions: ['lower(email)'] },
				undefined,
				naming,
			),
		).not.toThrow();
	});
});

describe('S-1 ddl-generator generateCreateIndex — opclass injection', () => {
	it('throws on injection via opclass', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{
					name: 'idx_test',
					columns: ['vec'],
					opclass: { vec: 'ops; DROP TABLE users' },
				},
				undefined,
				naming,
			),
		).toThrow(/Invalid.*identifier/i);
	});
});

describe('S-1 ddl-generator generateCreateIndex — WITH key injection', () => {
	it('throws on injection in WITH storage parameter key', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{
					name: 'idx_test',
					columns: ['id'],
					with: { 'fillfactor = 10; DROP TABLE users --': '1' },
				},
				undefined,
				naming,
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('quotes unsafe WITH storage parameter values instead of raw-splicing them', () => {
		const sql = generateCreateIndex(
			'users',
			{
				name: 'idx_test',
				columns: ['id'],
				with: { fillfactor: unsafeWithValue },
			},
			undefined,
			naming,
		);

		expect(sql).toContain(`WITH (fillfactor = '${unsafeWithValue}')`);
		expect(sql).not.toContain(`WITH (fillfactor = ${unsafeWithValue})`);
	});

	it('emits safe numeric and boolean WITH values unchanged', () => {
		const sql = generateCreateIndex(
			'users',
			{
				name: 'idx_test',
				columns: ['id'],
				with: {
					fillfactor: 70 as unknown as string,
					fastupdate: 'off',
				},
			},
			undefined,
			naming,
		);

		expect(sql).toContain('WITH (fillfactor = 70, fastupdate = off)');
	});
});

// ---------------------------------------------------------------------------
// S-1: index-operations.ts (generateCreateIndexSQL) — WHERE and expression
// ---------------------------------------------------------------------------

describe('S-1 index-operations generateCreateIndexSQL — WHERE injection', () => {
	it('throws on semicolon injection in WHERE', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				where: 'active = true; DROP TABLE users',
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on line-comment injection in WHERE', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				where: 'active = true -- injected',
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows a safe WHERE predicate', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				where: 'active = true',
			}),
		).not.toThrow();
	});
});

describe('S-1 index-operations generateCreateIndexSQL — expression injection', () => {
	it('throws on semicolon in expression column', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: [{ expression: 'lower(email); DROP TABLE users' }],
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows a safe expression column', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: [{ expression: 'lower(email)' }],
			}),
		).not.toThrow();
	});
});

describe('S-1 index-operations generateCreateIndexSQL — WITH key injection', () => {
	it('throws on injection in WITH storage parameter key', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				with: { 'fillfactor = 10; DROP TABLE users --': '1' },
			}),
		).toThrow(/Invalid.*identifier/i);
	});

	it('quotes unsafe WITH storage parameter values instead of raw-splicing them', () => {
		const sql = generateCreateIndexSQL('users', 'public', {
			name: 'idx_test',
			columns: ['id'],
			with: { fillfactor: unsafeWithValue },
		});

		expect(sql).toContain(`WITH (fillfactor = '${unsafeWithValue}')`);
		expect(sql).not.toContain(`WITH (fillfactor = ${unsafeWithValue})`);
	});

	it('emits safe numeric and boolean WITH values unchanged', () => {
		const sql = generateCreateIndexSQL('users', 'public', {
			name: 'idx_test',
			columns: ['id'],
			with: { fillfactor: 70, fastupdate: 'on' },
		});

		expect(sql).toContain('WITH (fillfactor = 70, fastupdate = on)');
	});
});

// ---------------------------------------------------------------------------
// S-2: migration-sql upAlterColumnCollation — COLLATE injection
// ---------------------------------------------------------------------------

describe('S-2 migration-sql upAlterColumnCollation — COLLATE injection', () => {
	it('throws on injection in COLLATE clause', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('"C"; DROP TABLE users --')]),
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('allows a valid collation identifier', () => {
		expect(() =>
			generateMigrationSQL(makeDiff([makeAlterColumnCollationChange('C')])),
		).not.toThrow();
	});

	// Regression gate (M-1): real PG locale strings with dots/hyphens must be accepted
	it('allows en_US (basic locale — regression gate)', () => {
		expect(() =>
			generateMigrationSQL(makeDiff([makeAlterColumnCollationChange('en_US')])),
		).not.toThrow();
	});

	it('allows en_US.utf8 (locale with dot)', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('en_US.utf8')]),
			),
		).not.toThrow();
	});

	it('allows en-US-x-icu (ICU locale with hyphens)', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('en-US-x-icu')]),
			),
		).not.toThrow();
	});

	it('allows C.UTF-8 (POSIX locale with dot and hyphen)', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('C.UTF-8')]),
			),
		).not.toThrow();
	});

	it('throws on injection: embedded double-quote', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('en_US"; DROP TABLE x; --')]),
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('throws on NUL byte in collation name', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('en_US\x00')]),
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('throws on block-comment opener in collation name', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('en_US/*')]),
			),
		).toThrow(/Invalid.*identifier/i);
	});

	it('throws on block-comment closer in collation name', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeAlterColumnCollationChange('en_US*/')]),
			),
		).toThrow(/Invalid.*identifier/i);
	});
});

// ---------------------------------------------------------------------------
// S-1/S-2: idx.method injection — upCreateIndex (migration-sql) + generateCreateIndex (ddl-generator)
// ---------------------------------------------------------------------------

describe('S-1 migration-sql upCreateIndex — idx.method injection (allowlist)', () => {
	it('allows standard index methods: btree, hash, gin, gist, brin', () => {
		for (const method of ['btree', 'hash', 'gin', 'gist', 'brin'] as const) {
			expect(() =>
				generateMigrationSQL(makeDiff([makeCreateIndexChange({ method })])),
			).not.toThrow();
		}
	});

	it('allows spgist (M-4: SP-GiST core access method)', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeCreateIndexChange({ method: 'spgist' })]),
			),
		).not.toThrow();
	});

	it('allows hnsw and bm25 (extension methods)', () => {
		for (const method of ['hnsw', 'bm25'] as const) {
			expect(() =>
				generateMigrationSQL(makeDiff([makeCreateIndexChange({ method })])),
			).not.toThrow();
		}
	});

	it('rejects injection via idx.method: semicolon', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					makeCreateIndexChange({ method: 'btree); DROP TABLE users --' }),
				]),
			),
		).toThrow(/Invalid index method/);
	});

	it('rejects injection via idx.method: NUL byte', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeCreateIndexChange({ method: 'btree\x00' })]),
			),
		).toThrow(/Invalid index method/);
	});

	it('rejects unknown method string', () => {
		expect(() =>
			generateMigrationSQL(
				makeDiff([makeCreateIndexChange({ method: 'spgist_unknown' })]),
			),
		).toThrow(/Invalid index method/);
	});
});

// ---------------------------------------------------------------------------
// S-3: index-operations.ts (generateCreateIndexSQL) — idx.method injection
// ---------------------------------------------------------------------------

describe('S-3 index-operations generateCreateIndexSQL — idx.method injection (allowlist)', () => {
	it('allows standard index methods: btree, hash, gin, gist, brin', () => {
		for (const method of ['btree', 'hash', 'gin', 'gist', 'brin'] as const) {
			expect(() =>
				generateCreateIndexSQL('users', 'public', {
					name: 'idx_test',
					columns: ['id'],
					method,
				}),
			).not.toThrow();
		}
	});

	it('allows spgist (M-4: SP-GiST core access method)', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				method: 'spgist',
			}),
		).not.toThrow();
	});

	it('allows hnsw and bm25 (extension methods)', () => {
		for (const method of ['hnsw', 'bm25'] as const) {
			expect(() =>
				generateCreateIndexSQL('users', 'public', {
					name: 'idx_test',
					columns: ['id'],
					method,
				}),
			).not.toThrow();
		}
	});

	it('rejects injection via idx.method: semicolon + DROP', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				method: 'btree); DROP TABLE users --',
			}),
		).toThrow(/Invalid index method/);
	});

	it('rejects injection via idx.method: NUL byte', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				method: 'btree\x00',
			}),
		).toThrow(/Invalid index method/);
	});

	it('rejects unknown method string', () => {
		expect(() =>
			generateCreateIndexSQL('users', 'public', {
				name: 'idx_test',
				columns: ['id'],
				method: 'spgist_unknown',
			}),
		).toThrow(/Invalid index method/);
	});
});

describe('S-2 ddl-generator generateCreateIndex — idx.method injection (allowlist)', () => {
	it('allows standard index methods: btree, hash, gin, gist, brin', () => {
		for (const method of ['btree', 'hash', 'gin', 'gist', 'brin'] as const) {
			expect(() =>
				generateCreateIndex(
					'users',
					{ name: 'idx_test', columns: ['id'], method },
					undefined,
					identityNaming,
				),
			).not.toThrow();
		}
	});

	it('allows spgist (M-4: SP-GiST core access method)', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{ name: 'idx_test', columns: ['id'], method: 'spgist' },
				undefined,
				identityNaming,
			),
		).not.toThrow();
	});

	it('allows hnsw and bm25 (extension methods)', () => {
		for (const method of ['hnsw', 'bm25'] as const) {
			expect(() =>
				generateCreateIndex(
					'users',
					{ name: 'idx_test', columns: ['id'], method },
					undefined,
					identityNaming,
				),
			).not.toThrow();
		}
	});

	it('rejects injection via idx.method: semicolon + DROP', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{
					name: 'idx_test',
					columns: ['id'],
					method: 'btree); DROP TABLE users --',
				},
				undefined,
				identityNaming,
			),
		).toThrow(/Invalid index method/);
	});

	it('rejects injection via idx.method: NUL byte', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{ name: 'idx_test', columns: ['id'], method: 'btree\x00' },
				undefined,
				identityNaming,
			),
		).toThrow(/Invalid index method/);
	});

	it('rejects unknown method string', () => {
		expect(() =>
			generateCreateIndex(
				'users',
				{ name: 'idx_test', columns: ['id'], method: 'spgist_unknown' },
				undefined,
				identityNaming,
			),
		).toThrow(/Invalid index method/);
	});
});
