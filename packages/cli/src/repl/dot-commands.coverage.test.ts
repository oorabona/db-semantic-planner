// @ts-nocheck — coverage test: runtime assertions
/**
 * Coverage tests for dot-commands.ts — targets uncovered branches
 * not in batch.test.ts (which already tests .import, .use, .help,
 * .explain, .parse, .output, .begin/.commit/.rollback).
 *
 * Focus: .tables, .schema, .relations, .exec, .natural, .sql,
 * .load, .dump, .exit/.quit, unknown commands, error paths for
 * .commit/.rollback failures, .import with schema scoping,
 * .import with result.error (non-thrown), .load edge cases,
 * .dump edge cases.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelIR, RelationIR, TableIR } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoadedSchema } from '../utils/schema-loader.js';
import type { BatchState } from './dot-commands.js';
import { processDotCommand } from './dot-commands.js';
import type { DbConnection } from './db-connection.js';

// ---------------------------------------------------------------------------
// Mock schema with tables and relations
// ---------------------------------------------------------------------------

const mockTables = new Map<string, TableIR>([
	[
		'users',
		{
			name: 'users',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'name', type: 'text', nullable: true },
				{ name: 'email', type: 'text', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		},
	],
	[
		'posts',
		{
			name: 'posts',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'title', type: 'text', nullable: false },
				{ name: 'authorId', type: 'integer', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		},
	],
]);

const mockRelations = new Map<string, RelationIR>([
	[
		'users.posts',
		{
			name: 'posts',
			type: 'hasMany',
			source: 'users',
			target: 'posts',
			foreignKey: 'authorId',
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
	[
		'posts.author',
		{
			name: 'author',
			type: 'belongsTo',
			source: 'posts',
			target: 'users',
			foreignKey: 'authorId',
			cardinality: 'one',
			optionality: 'optional',
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
]);

const mockModel: ModelIR = {
	tables: mockTables,
	relations: mockRelations,
	getTable: (name: string) => mockTables.get(name),
	getRelation: (name: string) => mockRelations.get(name),
	getRelationsFrom: () => [],
	getRelationsTo: () => [],
	isAmbiguous: () => ({ ambiguous: false, options: [] }),
};

const mockSchema: LoadedSchema = {
	definition: {
		users: { id: { type: 'integer' }, name: { type: 'text' }, email: { type: 'text' } },
		posts: { id: { type: 'integer' }, title: { type: 'text' }, authorId: { type: 'integer' } },
	},
	model: mockModel,
	tableNames: ['users', 'posts'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDbConnection(overrides?: Partial<DbConnection>): DbConnection {
	return {
		executeRaw: vi.fn().mockResolvedValue({
			rows: [],
			columns: [],
			rowCount: 0,
			executionTimeMs: 1,
		}),
		ping: vi.fn().mockResolvedValue(true),
		close: vi.fn().mockResolvedValue(undefined),
		getPool: vi.fn() as unknown as DbConnection['getPool'],
		beginTransaction: vi.fn().mockResolvedValue(undefined),
		commitTransaction: vi.fn().mockResolvedValue(undefined),
		rollbackTransaction: vi.fn().mockResolvedValue(undefined),
		inTransaction: false,
		...overrides,
	};
}

function createState(overrides?: Partial<BatchState>): BatchState {
	return {
		mode: 'natural',
		execEnabled: false,
		schemaName: undefined,
		dbConnection: undefined,
		explainMode: false,
		parseMode: false,
		model: undefined,
		outputMode: 'json',
		inTransaction: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processDotCommand — coverage', () => {
	// -----------------------------------------------------------------------
	// .tables
	// -----------------------------------------------------------------------
	describe('.tables', () => {
		it('lists all tables with count', async () => {
			const result = await processDotCommand('.tables', mockSchema, createState());
			expect(result.output).toContain('Tables (2)');
			expect(result.output).toContain('users');
			expect(result.output).toContain('posts');
		});
	});

	// -----------------------------------------------------------------------
	// .schema (with and without argument)
	// -----------------------------------------------------------------------
	describe('.schema', () => {
		it('shows schema summary without argument', async () => {
			const result = await processDotCommand('.schema', mockSchema, createState());
			expect(result.output).toContain('Schema Summary');
			expect(result.output).toContain('Tables: 2');
			expect(result.output).toContain('Relations: 2');
		});

		it('shows table schema with argument', async () => {
			const result = await processDotCommand('.schema users', mockSchema, createState());
			expect(result.output).toContain('Table: users');
			expect(result.output).toContain('id: integer');
			expect(result.output).toContain('name: text');
		});

		it('shows NOT NULL annotation for non-nullable columns', async () => {
			const result = await processDotCommand('.schema users', mockSchema, createState());
			// id is not nullable → should have (NOT NULL)
			expect(result.output).toContain('id: integer (NOT NULL)');
			// name is nullable → no (NOT NULL)
			expect(result.output).toMatch(/name: text(?! \(NOT NULL\))/);
		});

		it('returns error for unknown table', async () => {
			const result = await processDotCommand('.schema unknown_table', mockSchema, createState());
			expect(result.output).toContain('Table not found: unknown_table');
		});
	});

	// -----------------------------------------------------------------------
	// .relations
	// -----------------------------------------------------------------------
	describe('.relations', () => {
		it('lists all relations without argument', async () => {
			const result = await processDotCommand('.relations', mockSchema, createState());
			expect(result.output).toContain('Relations (2)');
			expect(result.output).toContain('users.posts');
			expect(result.output).toContain('hasMany');
		});

		it('filters relations for specific table (as target)', async () => {
			const result = await processDotCommand('.relations posts', mockSchema, createState());
			expect(result.output).toContain('Relations for posts');
			expect(result.output).toContain('users.posts');
			expect(result.output).toContain('posts.author');
		});

		it('filters relations for specific table (as source)', async () => {
			const result = await processDotCommand('.relations users', mockSchema, createState());
			expect(result.output).toContain('Relations for users');
			expect(result.output).toContain('users.posts');
		});

		it('returns message when no relations found for table', async () => {
			// Create schema with no relations involving "orphan"
			const orphanTables = new Map<string, TableIR>([
				['orphan', { name: 'orphan', columns: [{ name: 'id', type: 'integer', nullable: false }], primaryKey: 'id', foreignKeys: [], indexes: [] }],
			]);
			const noRelModel: ModelIR = {
				tables: orphanTables,
				relations: new Map(),
				getTable: (n) => orphanTables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};
			const noRelSchema: LoadedSchema = {
				definition: {},
				model: noRelModel,
				tableNames: ['orphan'],
			};

			const result = await processDotCommand('.relations orphan', noRelSchema, createState());
			expect(result.output).toContain('No relations found for table: orphan');
		});
	});

	// -----------------------------------------------------------------------
	// .exec
	// -----------------------------------------------------------------------
	describe('.exec', () => {
		it('.exec on enables when DB connected', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.exec on', mockSchema, state);
			expect(result.output).toContain('Execution mode: ON');
			expect(result.stateChange?.execEnabled).toBe(true);
		});

		it('.exec on returns error when no DB', async () => {
			const state = createState();
			const result = await processDotCommand('.exec on', mockSchema, state);
			expect(result.output).toContain('No database connection');
		});

		it('.exec off disables execution', async () => {
			const state = createState({ execEnabled: true });
			const result = await processDotCommand('.exec off', mockSchema, state);
			expect(result.output).toContain('Execution mode: OFF');
			expect(result.stateChange?.execEnabled).toBe(false);
		});

		it('.exec toggles on (was off) when DB connected', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db, execEnabled: false });
			const result = await processDotCommand('.exec', mockSchema, state);
			expect(result.output).toContain('Execution mode: ON');
			expect(result.stateChange?.execEnabled).toBe(true);
		});

		it('.exec toggles off (was on) when DB connected', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db, execEnabled: true });
			const result = await processDotCommand('.exec', mockSchema, state);
			expect(result.output).toContain('Execution mode: OFF');
			expect(result.stateChange?.execEnabled).toBe(false);
		});

		it('.exec toggle returns error when no DB', async () => {
			const state = createState({ execEnabled: false });
			const result = await processDotCommand('.exec', mockSchema, state);
			expect(result.output).toContain('No database connection');
		});
	});

	// -----------------------------------------------------------------------
	// .natural / .sql
	// -----------------------------------------------------------------------
	describe('.natural / .sql mode switching', () => {
		it('.natural switches to natural mode', async () => {
			const result = await processDotCommand('.natural', mockSchema, createState({ mode: 'sql' }));
			expect(result.output).toContain('natural query mode');
			expect(result.stateChange?.mode).toBe('natural');
		});

		it('.sql switches to SQL mode', async () => {
			const result = await processDotCommand('.sql', mockSchema, createState({ mode: 'natural' }));
			expect(result.output).toContain('SQL mode');
			expect(result.stateChange?.mode).toBe('sql');
		});
	});

	// -----------------------------------------------------------------------
	// .exit / .quit
	// -----------------------------------------------------------------------
	describe('.exit / .quit', () => {
		it('.exit returns Exiting message', async () => {
			const result = await processDotCommand('.exit', mockSchema, createState());
			expect(result.output).toBe('Exiting...');
		});

		it('.quit returns Exiting message', async () => {
			const result = await processDotCommand('.quit', mockSchema, createState());
			expect(result.output).toBe('Exiting...');
		});
	});

	// -----------------------------------------------------------------------
	// Unknown command
	// -----------------------------------------------------------------------
	describe('unknown command', () => {
		it('returns error for unknown dot command', async () => {
			const result = await processDotCommand('.foobar', mockSchema, createState());
			expect(result.output).toContain('Unknown command: .foobar');
		});
	});

	// -----------------------------------------------------------------------
	// .import with schema scoping
	// -----------------------------------------------------------------------
	describe('.import with schema scoping', () => {
		let testDir: string;
		let testSqlFile: string;

		beforeAll(() => {
			testDir = join(tmpdir(), `dot-cmd-cov-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			testSqlFile = join(testDir, 'schema-test.sql');
			writeFileSync(testSqlFile, 'INSERT INTO users (id) VALUES (1);');
		});

		afterAll(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('prefixes SQL with SET search_path when schemaName is set', async () => {
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 1,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db, schemaName: 'tenant_42' });

			const result = await processDotCommand(`.import ${testSqlFile}`, mockSchema, state);

			expect(result.output).toContain('Imported');
			expect(result.output).toContain('schema: tenant_42');
			const sqlArg = mockExecuteRaw.mock.calls[0][0];
			expect(sqlArg).toContain('SET search_path TO "tenant_42"');
		});

		it('returns error when executeRaw returns result.error (non-thrown)', async () => {
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 0,
				executionTimeMs: 0,
				error: 'relation does not exist',
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.import ${testSqlFile}`, mockSchema, state);

			expect(result.output).toContain('Import failed: relation does not exist');
			expect(result.success).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// .commit / .rollback failure paths
	// -----------------------------------------------------------------------
	describe('.commit failure', () => {
		it('returns error when commitTransaction throws', async () => {
			const db = createMockDbConnection({
				inTransaction: true,
				commitTransaction: vi.fn().mockRejectedValue(new Error('disk full')),
			});
			const state = createState({ dbConnection: db, inTransaction: true });
			const result = await processDotCommand('.commit', mockSchema, state);
			expect(result.output).toContain('Commit failed');
			expect(result.output).toContain('disk full');
		});
	});

	describe('.rollback failure', () => {
		it('returns error when rollbackTransaction throws', async () => {
			const db = createMockDbConnection({
				inTransaction: true,
				rollbackTransaction: vi.fn().mockRejectedValue(new Error('connection lost')),
			});
			const state = createState({ dbConnection: db, inTransaction: true });
			const result = await processDotCommand('.rollback', mockSchema, state);
			expect(result.output).toContain('Rollback failed');
			expect(result.output).toContain('connection lost');
		});
	});

	// -----------------------------------------------------------------------
	// .load edge cases
	// -----------------------------------------------------------------------
	describe('.load', () => {
		let testDir: string;

		beforeAll(() => {
			testDir = join(tmpdir(), `dot-cmd-load-cov-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterAll(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('returns error when no arguments', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.load', mockSchema, state);
			expect(result.output).toContain('Usage: .load <table> <file.csv>');
		});

		it('returns error when only table name (no file)', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.load users', mockSchema, state);
			expect(result.output).toContain('Usage: .load <table> <file.csv>');
		});

		it('returns error when no DB connection', async () => {
			const state = createState();
			const result = await processDotCommand('.load users data.csv', mockSchema, state);
			expect(result.output).toContain('.load requires database connection');
		});

		it('returns error when file not found', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.load users /nonexistent/file.csv', mockSchema, state);
			expect(result.output).toContain('File not found');
		});

		it('returns error when CSV is empty', async () => {
			const emptyFile = join(testDir, 'empty.csv');
			writeFileSync(emptyFile, '');
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand(`.load users ${emptyFile}`, mockSchema, state);
			expect(result.output).toContain('empty');
		});

		it('loads CSV rows successfully', async () => {
			const csvFile = join(testDir, 'users.csv');
			writeFileSync(csvFile, 'id,name,email\n1,Alice,alice@test.com\n2,Bob,bob@test.com\n');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 2,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.load users ${csvFile}`, mockSchema, state);

			expect(result.output).toContain('Loaded 2 rows into users');
			expect(result.success).toBe(true);
		});

		it('returns error when insert fails', async () => {
			const csvFile = join(testDir, 'bad.csv');
			writeFileSync(csvFile, 'id,name,email\n1,Alice,a@b.com\n');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 0,
				executionTimeMs: 0,
				error: 'violates unique constraint',
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.load users ${csvFile}`, mockSchema, state);

			expect(result.output).toContain('Insert failed');
			expect(result.success).toBe(false);
		});

		it('uses schema prefix when schemaName is set', async () => {
			const csvFile = join(testDir, 'scoped.csv');
			writeFileSync(csvFile, 'id,name,email\n1,Test,t@t.com\n');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 1,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db, schemaName: 'my_tenant' });

			await processDotCommand(`.load users ${csvFile}`, mockSchema, state);

			const sql = mockExecuteRaw.mock.calls[0][0];
			expect(sql).toContain('"my_tenant".');
		});

		it('handles parseCsvFile exception', async () => {
			// A binary file should cause parsing to fail or produce unexpected results
			const binFile = join(testDir, 'binary.csv');
			writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.load users ${binFile}`, mockSchema, state);

			// Should either fail or indicate empty/no matching columns
			expect(result.output).toMatch(/empty|No matching columns|Load failed/i);
		});
	});

	// -----------------------------------------------------------------------
	// .dump edge cases
	// -----------------------------------------------------------------------
	describe('.dump', () => {
		let testDir: string;

		beforeAll(() => {
			testDir = join(tmpdir(), `dot-cmd-dump-cov-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterAll(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('returns error when no arguments', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.dump', mockSchema, state);
			expect(result.output).toContain('Usage: .dump <table> <file.csv>');
		});

		it('returns error when only table name (no file)', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.dump users', mockSchema, state);
			expect(result.output).toContain('Usage: .dump <table> <file.csv>');
		});

		it('returns error when no DB connection', async () => {
			const state = createState();
			const result = await processDotCommand('.dump users out.csv', mockSchema, state);
			expect(result.output).toContain('.dump requires database connection');
		});

		it('returns error for unknown table', async () => {
			const db = createMockDbConnection();
			const state = createState({ dbConnection: db });
			const result = await processDotCommand('.dump unknown_table out.csv', mockSchema, state);
			expect(result.output).toContain('Table not found: unknown_table');
		});

		it('dumps table rows to CSV file', async () => {
			const outFile = join(testDir, 'dump-output.csv');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }],
				columns: ['id', 'name', 'email'],
				rowCount: 1,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.dump users ${outFile}`, mockSchema, state);

			expect(result.output).toContain('Dumped 1 rows from users');
			expect(result.success).toBe(true);
			expect(existsSync(outFile)).toBe(true);
		});

		it('returns error when query fails with result.error', async () => {
			const outFile = join(testDir, 'dump-error.csv');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 0,
				executionTimeMs: 0,
				error: 'relation does not exist',
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.dump users ${outFile}`, mockSchema, state);

			expect(result.output).toContain('Query failed');
			expect(result.success).toBe(false);
		});

		it('uses schema prefix when schemaName is set', async () => {
			const outFile = join(testDir, 'dump-schema.csv');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: ['id'],
				rowCount: 0,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db, schemaName: 'tenant_x' });

			await processDotCommand(`.dump users ${outFile}`, mockSchema, state);

			const sql = mockExecuteRaw.mock.calls[0][0];
			expect(sql).toContain('"tenant_x".');
		});

		it('uses table columns when result.columns is empty', async () => {
			const outFile = join(testDir, 'dump-nocols.csv');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }],
				columns: [],
				rowCount: 1,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.dump users ${outFile}`, mockSchema, state);

			expect(result.output).toContain('Dumped 1 rows');
			expect(result.success).toBe(true);
		});

		it('returns error when executeRaw throws', async () => {
			const outFile = join(testDir, 'dump-throw.csv');
			const mockExecuteRaw = vi.fn().mockRejectedValue(new Error('connection timeout'));
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.dump users ${outFile}`, mockSchema, state);

			expect(result.output).toContain('Dump failed');
			expect(result.output).toContain('connection timeout');
		});
	});

	// -----------------------------------------------------------------------
	// Case insensitivity
	// -----------------------------------------------------------------------
	describe('case insensitivity', () => {
		it('.HELP (uppercase) is recognized', async () => {
			const result = await processDotCommand('.HELP', mockSchema, createState());
			expect(result.output).toContain('Available commands');
		});

		it('.Tables (mixed case) is recognized', async () => {
			const result = await processDotCommand('.Tables', mockSchema, createState());
			expect(result.output).toContain('Tables (2)');
		});
	});

	// -----------------------------------------------------------------------
	// .load with table not in schema (columns from CSV only)
	// -----------------------------------------------------------------------
	describe('.load with unknown table (not in schema)', () => {
		let testDir: string;

		beforeAll(() => {
			testDir = join(tmpdir(), `dot-cmd-load-noschema-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterAll(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('uses CSV headers as columns when table not in schema', async () => {
			const csvFile = join(testDir, 'custom.csv');
			writeFileSync(csvFile, 'foo,bar\n1,hello\n');
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 1,
				executionTimeMs: 1,
			});
			const db = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createState({ dbConnection: db });

			const result = await processDotCommand(`.load unknown_table ${csvFile}`, mockSchema, state);

			expect(result.output).toContain('Loaded 1 rows into unknown_table');
			const sql = mockExecuteRaw.mock.calls[0][0];
			expect(sql).toContain('"unknown_table"');
		});
	});
});
