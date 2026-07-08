/**
 * Unit tests for DDL generation phases.
 *
 * Each phase is tested in isolation with a minimal ModelIR fixture.
 * Correctness of the combined output is validated by the existing ddl.test.ts
 * golden tests — these tests verify that each phase produces the expected
 * fragment for its domain.
 */

import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateCommentsPhase } from '../ddl/phases/comments.js';
import { generateConstraintsPhase } from '../ddl/phases/constraints.js';
import { generateDropStatementsPhase } from '../ddl/phases/drop-statements.js';
import { generateEnumTypesPhase } from '../ddl/phases/enum-types.js';
import { generateExtensionsPhase } from '../ddl/phases/extensions.js';
import { generateIndexesPhase } from '../ddl/phases/indexes.js';
import { generateRlsPhase } from '../ddl/phases/rls.js';
import { generateSequencesPhase } from '../ddl/phases/sequences.js';
import { generateTablesPhase } from '../ddl/phases/tables.js';
import type { PhaseContext } from '../ddl/phases/types.js';
import { identityNaming } from '../naming-plugin.js';

// ---------------------------------------------------------------------------
// Minimal ModelIR factory
// ---------------------------------------------------------------------------

function makeTable(name: string, overrides: Partial<TableIR> = {}): TableIR {
	return {
		name,
		columns: [],
		foreignKeys: [],
		indexes: [],
		policies: [],
		rlsEnabled: false,
		checkConstraints: [],
		...overrides,
	} as unknown as TableIR;
}

function makeModel(overrides: Partial<ModelIR> = {}): ModelIR {
	return {
		tables: new Map(),
		extensions: [],
		sequences: new Map(),
		enums: new Map(),
		...overrides,
	} as unknown as ModelIR;
}

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
	return {
		schema: makeModel(),
		tables: [],
		schemaName: undefined,
		naming: identityNaming,
		caps: undefined,
		fkAutoIndex: true,
		includeDropStatements: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Extensions phase
// ---------------------------------------------------------------------------

describe('generateExtensionsPhase', () => {
	it('returns empty when no extensions', () => {
		const ctx = makeCtx({ schema: makeModel({ extensions: [] }) });
		expect(generateExtensionsPhase(ctx)).toEqual([]);
	});

	it('generates CREATE EXTENSION for each extension', () => {
		const ctx = makeCtx({
			schema: makeModel({ extensions: ['pgvector', 'pg_trgm'] }),
		});
		const stmts = generateExtensionsPhase(ctx);
		expect(stmts).toHaveLength(2);
		expect(stmts[0]).toBe('CREATE EXTENSION IF NOT EXISTS "pgvector";');
		expect(stmts[1]).toBe('CREATE EXTENSION IF NOT EXISTS "pg_trgm";');
	});

	it('returns empty when supportsDDLExtensions=false', () => {
		const ctx = makeCtx({
			schema: makeModel({ extensions: ['pgvector'] }),
			caps: { supportsDDLExtensions: false } as never,
		});
		expect(generateExtensionsPhase(ctx)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Sequences phase
// ---------------------------------------------------------------------------

describe('generateSequencesPhase', () => {
	it('returns empty when no sequences', () => {
		const ctx = makeCtx({ schema: makeModel({ sequences: new Map() }) });
		expect(generateSequencesPhase(ctx)).toEqual([]);
	});

	it('generates CREATE SEQUENCE statement', () => {
		const seq = { name: 'user_id_seq', start: 1, increment: 1, minValue: 1 };
		const seqs = new Map([['user_id_seq', seq]]);
		const ctx = makeCtx({ schema: makeModel({ sequences: seqs as never }) });
		const stmts = generateSequencesPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('CREATE SEQUENCE');
		expect(stmts[0]).toContain('"user_id_seq"');
	});

	it('qualifies sequence name when schemaName provided', () => {
		const seq = { name: 'my_seq', start: 1, increment: 1, minValue: 1 };
		const seqs = new Map([['my_seq', seq]]);
		const ctx = makeCtx({
			schema: makeModel({ sequences: seqs as never }),
			schemaName: 'myschema',
		});
		const stmts = generateSequencesPhase(ctx);
		expect(stmts[0]).toContain('"myschema"."my_seq"');
	});
});

// ---------------------------------------------------------------------------
// Enum types phase
// ---------------------------------------------------------------------------

describe('generateEnumTypesPhase', () => {
	it('returns empty when no enums', () => {
		const ctx = makeCtx({ schema: makeModel({ enums: new Map() }) });
		expect(generateEnumTypesPhase(ctx)).toEqual([]);
	});

	it('generates CREATE TYPE AS ENUM for each enum', () => {
		const enumDef = {
			name: 'status_enum',
			values: ['active', 'inactive', "it's special"],
		};
		const enums = new Map([['status_enum', enumDef]]);
		const ctx = makeCtx({ schema: makeModel({ enums: enums as never }) });
		const stmts = generateEnumTypesPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toBe(
			`CREATE TYPE "status_enum" AS ENUM ('active', 'inactive', 'it''s special');`,
		);
	});

	it('returns empty when supportsDDLEnumTypes=false', () => {
		const enumDef = { name: 'status_enum', values: ['active'] };
		const enums = new Map([['status_enum', enumDef]]);
		const ctx = makeCtx({
			schema: makeModel({ enums: enums as never }),
			caps: { supportsDDLEnumTypes: false } as never,
		});
		expect(generateEnumTypesPhase(ctx)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Drop statements phase
// ---------------------------------------------------------------------------

describe('generateDropStatementsPhase', () => {
	it('returns empty when includeDropStatements=false', () => {
		const table = makeTable('users');
		const ctx = makeCtx({ tables: [table], includeDropStatements: false });
		expect(generateDropStatementsPhase(ctx)).toEqual([]);
	});

	it('generates DROP TABLE for each table in reverse order', () => {
		const users = makeTable('users');
		const posts = makeTable('posts');
		const ctx = makeCtx({
			tables: [users, posts],
			includeDropStatements: true,
		});
		const stmts = generateDropStatementsPhase(ctx);
		// Should have DROP posts, DROP users (reverse), plus empty separator
		expect(stmts.length).toBeGreaterThanOrEqual(2);
		expect(stmts[0]).toContain('"posts"');
		expect(stmts[1]).toContain('"users"');
	});
});

// ---------------------------------------------------------------------------
// Tables phase
// ---------------------------------------------------------------------------

describe('generateTablesPhase', () => {
	it('returns empty when no tables', () => {
		const ctx = makeCtx({ tables: [] });
		expect(generateTablesPhase(ctx)).toEqual([]);
	});

	it('generates one CREATE TABLE per table', () => {
		const users = makeTable('users', {
			columns: [{ name: 'id', type: 'integer', required: true } as never],
		});
		const ctx = makeCtx({ tables: [users] });
		const stmts = generateTablesPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('CREATE TABLE');
		expect(stmts[0]).toContain('"users"');
	});
});

// ---------------------------------------------------------------------------
// Constraints phase
// ---------------------------------------------------------------------------

describe('generateConstraintsPhase', () => {
	it('returns empty when no FKs and no check constraints', () => {
		const table = makeTable('users');
		const ctx = makeCtx({ tables: [table] });
		expect(generateConstraintsPhase(ctx)).toEqual([]);
	});

	it('generates ALTER TABLE ADD CONSTRAINT for each FK', () => {
		const posts = makeTable('posts', {
			foreignKeys: [
				{
					columns: ['user_id'],
					references: { table: 'users', columns: ['id'] },
					onDelete: 'CASCADE',
				} as never,
			],
		});
		const ctx = makeCtx({ tables: [posts] });
		const stmts = generateConstraintsPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('ALTER TABLE');
		expect(stmts[0]).toContain('ADD CONSTRAINT');
	});

	it('generates check constraints when supportsDDLCheckConstraints=true', () => {
		const users = makeTable('users', {
			checkConstraints: [
				{ name: 'users_age_check', expression: 'CHECK (age > 0)' },
			] as never,
		});
		const ctx = makeCtx({
			tables: [users],
			caps: { supportsDDLCheckConstraints: true } as never,
		});
		const stmts = generateConstraintsPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('ADD CONSTRAINT "users_age_check"');
	});

	it('generates check constraints with escaped semicolon and comment literals', () => {
		const users = makeTable('users', {
			checkConstraints: [
				{
					name: 'users_status_check',
					expression: "CHECK (status IN ('a;b', 'c--d'))",
				},
			] as never,
		});
		const ctx = makeCtx({
			tables: [users],
			caps: { supportsDDLCheckConstraints: true } as never,
		});
		const stmts = generateConstraintsPhase(ctx);
		expect(stmts).toEqual([
			`ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK (status IN ('a;b', 'c--d'));`,
		]);
	});
});

// ---------------------------------------------------------------------------
// Indexes phase
// ---------------------------------------------------------------------------

describe('generateIndexesPhase', () => {
	it('returns empty when no indexes and no FKs', () => {
		const table = makeTable('users');
		const ctx = makeCtx({ tables: [table] });
		expect(generateIndexesPhase(ctx)).toEqual([]);
	});

	it('generates CREATE INDEX for explicit indexes', () => {
		const users = makeTable('users', {
			indexes: [
				{ name: 'idx_users_email', columns: ['email'], unique: true } as never,
			],
		});
		const ctx = makeCtx({ tables: [users] });
		const stmts = generateIndexesPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('CREATE UNIQUE INDEX');
		expect(stmts[0]).toContain('"idx_users_email"');
	});

	it('auto-generates FK index when fkAutoIndex=true', () => {
		const posts = makeTable('posts', {
			indexes: [],
			foreignKeys: [
				{
					columns: ['user_id'],
					references: { table: 'users', columns: ['id'] },
					onDelete: 'CASCADE',
				} as never,
			],
		});
		const ctx = makeCtx({ tables: [posts], fkAutoIndex: true });
		const stmts = generateIndexesPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('idx_posts_user_id');
	});

	it('does not auto-generate FK index when explicit FK index uses nullsNotDistinct', () => {
		const posts = makeTable('posts', {
			indexes: [
				{
					name: 'uk_posts_user_id_nulls',
					columns: ['user_id'],
					unique: true,
					nullsNotDistinct: true,
				} as never,
			],
			foreignKeys: [
				{
					columns: ['user_id'],
					references: { table: 'users', columns: ['id'] },
				} as never,
			],
		});
		const ctx = makeCtx({
			tables: [posts],
			fkAutoIndex: true,
		});

		const stmts = generateIndexesPhase(ctx);

		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toContain('uk_posts_user_id_nulls');
		expect(stmts[0]).toContain('NULLS NOT DISTINCT');
	});

	it('skips FK auto-index when fkAutoIndex=false', () => {
		const posts = makeTable('posts', {
			indexes: [],
			foreignKeys: [
				{
					columns: ['user_id'],
					references: { table: 'users', columns: ['id'] },
					onDelete: 'CASCADE',
				} as never,
			],
		});
		const ctx = makeCtx({ tables: [posts], fkAutoIndex: false });
		expect(generateIndexesPhase(ctx)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RLS phase
// ---------------------------------------------------------------------------

describe('generateRlsPhase', () => {
	it('returns empty when supportsDDLRowLevelSecurity=false', () => {
		const table = makeTable('users', { rlsEnabled: true });
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLRowLevelSecurity: false } as never,
		});
		expect(generateRlsPhase(ctx)).toEqual([]);
	});

	it('generates ENABLE ROW LEVEL SECURITY when rlsEnabled=true', () => {
		const table = makeTable('users', { rlsEnabled: true });
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLRowLevelSecurity: true } as never,
		});
		const stmts = generateRlsPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toBe('ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;');
	});

	it('returns empty when no RLS and no policies', () => {
		const table = makeTable('users', { rlsEnabled: false, policies: [] });
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLRowLevelSecurity: true } as never,
		});
		expect(generateRlsPhase(ctx)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Comments phase
// ---------------------------------------------------------------------------

describe('generateCommentsPhase', () => {
	it('returns empty when supportsDDLComments=false', () => {
		const table = makeTable('users', { comment: 'User accounts' } as never);
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLComments: false } as never,
		});
		expect(generateCommentsPhase(ctx)).toEqual([]);
	});

	it('generates COMMENT ON TABLE when table has a comment', () => {
		const table = makeTable('users', { comment: 'User accounts' } as never);
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLComments: true } as never,
		});
		const stmts = generateCommentsPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toBe(`COMMENT ON TABLE "users" IS 'User accounts';`);
	});

	it('generates COMMENT ON COLUMN for each column with a comment', () => {
		const table = makeTable('users', {
			columns: [
				{
					name: 'id',
					type: 'integer',
					required: true,
					comment: 'Primary key',
				} as never,
				{ name: 'email', type: 'text', required: true } as never,
			],
		} as never);
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLComments: true } as never,
		});
		const stmts = generateCommentsPhase(ctx);
		expect(stmts).toHaveLength(1);
		expect(stmts[0]).toBe(`COMMENT ON COLUMN "users"."id" IS 'Primary key';`);
	});

	it('escapes single quotes in comments', () => {
		const table = makeTable('users', { comment: "User's data" } as never);
		const ctx = makeCtx({
			tables: [table],
			caps: { supportsDDLComments: true } as never,
		});
		const stmts = generateCommentsPhase(ctx);
		expect(stmts[0]).toContain("'User''s data'");
	});
});
