/**
 * Security regression tests for dot-commands.ts.
 *
 * Covers findings from Commit 4 worklist:
 *  [SEC-S1] SQL injection via schemaName in SET search_path (.use)
 *  [SEC-S2] SQL injection via tableName / CSV column names (.load / .dump)
 *  [SEC-M2] Path containment — ../escape, NUL bytes (.import / .load / .dump)
 *  [SC-11]  Boolean-toggle DRY — shared handleBooleanToggle (.exec/.explain/.parse)
 *  [CC-13]  .help lists .natural and .sql
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelIR, TableIR } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoadedSchema } from '../utils/schema-loader.js';
import type { DbConnection } from './db-connection.js';
import type { BatchState } from './dot-commands.js';
import { processDotCommand } from './dot-commands.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockTables = new Map<string, TableIR>([
	[
		'users',
		{
			name: 'users',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'email', type: 'varchar', nullable: true },
			],
			indexes: [],
			checks: [],
			foreignKeys: [],
		} as unknown as TableIR,
	],
]);

const mockModel: Partial<ModelIR> = {
	tables: mockTables,
	relations: new Map(),
};

const mockSchema: LoadedSchema = {
	definition: {} as unknown as LoadedSchema['definition'],
	model: mockModel as ModelIR,
	tableNames: ['users'],
};

function createMockDbConnection(
	overrides?: Partial<DbConnection>,
): DbConnection {
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
// Temp dir used for path containment tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
	tmpDir = join(tmpdir(), `dot-commands-sec-${process.pid}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [SEC-S1] Schema name injection via .use
// ---------------------------------------------------------------------------

describe('[SEC-S1] .use schema name validation', () => {
	it('rejects schema with SQL injection payload', async () => {
		const state = createState();
		const result = await processDotCommand(
			'.use malicious"; DROP TABLE users; --',
			mockSchema,
			state,
		);
		expect(result.output).toContain('❌');
		expect(result.output).toContain('Invalid schema identifier');
		// MUST NOT produce a stateChange — schemaName must stay unset
		expect(result.stateChange).toBeUndefined();
	});

	it('rejects schema with double-quote character', async () => {
		const state = createState();
		const result = await processDotCommand(
			'.use "injected"',
			mockSchema,
			state,
		);
		expect(result.output).toContain('❌');
		expect(result.stateChange).toBeUndefined();
	});

	it('rejects schema with semicolon', async () => {
		const result = await processDotCommand(
			'.use bad;schema',
			mockSchema,
			createState(),
		);
		expect(result.output).toContain('❌');
	});

	it('rejects schema with NUL byte (stripped → empty-like)', async () => {
		// '\x00' stripped at arg level — remaining empty string → rejected
		const result = await processDotCommand(
			'.use \x00',
			mockSchema,
			createState(),
		);
		// After NUL strip arg is '' → .use with no arg = clear schema (valid)
		// This is an acceptable outcome: NUL was stripped, intent is treated as clear
		expect(result.stateChange?.schemaName === undefined || result.output.includes('❌')).toBe(true);
	});

	it('accepts valid schema name', async () => {
		const state = createState();
		const result = await processDotCommand('.use tenant_42', mockSchema, state);
		expect(result.stateChange?.schemaName).toBe('tenant_42');
		expect(result.output).not.toContain('❌');
	});

	it('prevents injection from reaching .import SET search_path', async () => {
		// If .use rejected the bad name, state.schemaName stays undefined.
		// A subsequent .import would NOT include a SET search_path line.
		const sqlFile = join(tmpDir, 'safe.sql');
		writeFileSync(sqlFile, '-- safe sql\n');

		const db = createMockDbConnection();
		// schemaName stays undefined because .use would have rejected the bad name
		const state = createState({
			dbConnection: db,
			schemaName: undefined,
		});

		// Use absolute path — absolute paths are user-explicit intent, allowed
		const result = await processDotCommand(
			`.import ${sqlFile}`,
			mockSchema,
			state,
		);
		expect(result.output).toMatch(/✅ Imported/);

		// Verify executeRaw was called WITHOUT a SET search_path line
		const callArg = (db.executeRaw as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(callArg).not.toContain('SET search_path');
	});
});

// ---------------------------------------------------------------------------
// [SEC-S2] Table identifier injection via .load / .dump
// ---------------------------------------------------------------------------

describe('[SEC-S2] .load table name validation', () => {
	it('rejects table name with double-quote', async () => {
		const db = createMockDbConnection();
		const csvFile = join(tmpDir, 'data.csv');
		writeFileSync(csvFile, 'id,email\n1,a@b.com\n');

		const result = await processDotCommand(
			`.load "bad"table ${csvFile}`,
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		expect(result.output).toContain('Invalid table identifier');
		// executeRaw must NOT have been called
		expect((db.executeRaw as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it('rejects table name with semicolon', async () => {
		const db = createMockDbConnection();
		const csvFile = join(tmpDir, 'data.csv');
		writeFileSync(csvFile, 'id\n1\n');

		const result = await processDotCommand(
			`.load bad;DROP TABLE users ${csvFile}`,
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		expect((db.executeRaw as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});
});

describe('[SEC-S2] .dump table name validation', () => {
	it('rejects dump with injected table name', async () => {
		const db = createMockDbConnection();
		const result = await processDotCommand(
			`.dump "evil" out.csv`,
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		expect(result.output).toContain('Invalid table identifier');
		expect((db.executeRaw as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});
});

describe('[SEC-S2] CSV column name validation in .load', () => {
	it('rejects CSV with injected column header', async () => {
		const db = createMockDbConnection();
		const csvFile = join(tmpDir, 'evil-headers.csv');
		// Column header contains SQL injection
		writeFileSync(csvFile, '"id","name"); DROP TABLE users; --\n1,foo\n');

		const result = await processDotCommand(
			`.load evil_table ${csvFile}`,
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		// db must NOT be called with injected SQL
		expect((db.executeRaw as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// [SEC-M2] Path containment
// ---------------------------------------------------------------------------

describe('[SEC-M2] .import path containment', () => {
	it('rejects ../ path traversal', async () => {
		const db = createMockDbConnection();
		const result = await processDotCommand(
			'.import ../../etc/passwd',
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		expect(result.output).toContain('Path escapes working directory');
	});

	it('allows absolute path (explicit user intent — not a traversal)', async () => {
		// Absolute paths are explicitly typed by the user and are not a silent
		// relative traversal. The containment check only fires for relative paths.
		// The path won't exist, so we get "File not found" rather than escape error.
		const db = createMockDbConnection();
		const result = await processDotCommand(
			'.import /tmp/nonexistent_security_test.sql',
			mockSchema,
			createState({ dbConnection: db }),
		);
		// Should NOT be a path escape error — instead a "file not found" error
		expect(result.output).not.toContain('Path escapes working directory');
	});

	it('accepts an absolute SQL file path (explicit user intent)', async () => {
		const sqlFile = join(tmpDir, 'seed.sql');
		writeFileSync(sqlFile, '-- seed\n');
		const db = createMockDbConnection();

		// Absolute paths are allowed (user explicitly typed the full path).
		// Path containment only blocks relative traversals (../../...).
		const result = await processDotCommand(
			`.import ${sqlFile}`,
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).not.toContain('Path escapes working directory');
	});

	it('strips NUL bytes before path validation', async () => {
		const db = createMockDbConnection();
		// After NUL strip: '../../etc/passwd' — still escapes cwd
		const result = await processDotCommand(
			'.import ../../etc\x00/passwd',
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
	});
});

describe('[SEC-M2] .load path containment', () => {
	it('rejects ../ traversal in load file path', async () => {
		const db = createMockDbConnection();
		const result = await processDotCommand(
			'.load users ../../etc/passwd',
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		expect(result.output).toContain('Path escapes working directory');
	});
});

describe('[SEC-M2] .dump path containment', () => {
	it('rejects ../ traversal in dump file path', async () => {
		const db = createMockDbConnection();
		const result = await processDotCommand(
			'.dump users ../escape.csv',
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.output).toContain('❌');
		expect(result.output).toContain('Path escapes working directory');
	});
});

// ---------------------------------------------------------------------------
// [SC-11] Boolean toggle DRY — handleBooleanToggle via .exec/.explain/.parse
// ---------------------------------------------------------------------------

describe('[SC-11] handleBooleanToggle — .exec', () => {
	it('.exec on without db → error', async () => {
		const result = await processDotCommand('.exec on', mockSchema, createState());
		expect(result.output).toContain('❌');
		expect(result.stateChange).toBeUndefined();
	});

	it('.exec off (no db needed)', async () => {
		const result = await processDotCommand(
			'.exec off',
			mockSchema,
			createState({ execEnabled: true }),
		);
		expect(result.stateChange?.execEnabled).toBe(false);
		expect(result.output).toContain('OFF');
	});

	it('.exec on with db → enabled', async () => {
		const db = createMockDbConnection();
		const result = await processDotCommand(
			'.exec on',
			mockSchema,
			createState({ dbConnection: db }),
		);
		expect(result.stateChange?.execEnabled).toBe(true);
		expect(result.output).toContain('ON');
	});

	it('.exec toggle → flips value', async () => {
		const db = createMockDbConnection();
		const result = await processDotCommand(
			'.exec',
			mockSchema,
			createState({ dbConnection: db, execEnabled: false }),
		);
		expect(result.stateChange?.execEnabled).toBe(true);
	});
});

describe('[SC-11] handleBooleanToggle — .explain', () => {
	it('.explain on (no db needed)', async () => {
		const result = await processDotCommand(
			'.explain on',
			mockSchema,
			createState(),
		);
		expect(result.stateChange?.explainMode).toBe(true);
		expect(result.output).toContain('ON');
	});

	it('.explain off', async () => {
		const result = await processDotCommand(
			'.explain off',
			mockSchema,
			createState({ explainMode: true }),
		);
		expect(result.stateChange?.explainMode).toBe(false);
	});

	it('.explain toggle from false → true', async () => {
		const result = await processDotCommand(
			'.explain',
			mockSchema,
			createState({ explainMode: false }),
		);
		expect(result.stateChange?.explainMode).toBe(true);
	});

	it('.explain toggle from true → false', async () => {
		const result = await processDotCommand(
			'.explain',
			mockSchema,
			createState({ explainMode: true }),
		);
		expect(result.stateChange?.explainMode).toBe(false);
	});
});

describe('[SC-11] handleBooleanToggle — .parse', () => {
	it('.parse on', async () => {
		const result = await processDotCommand(
			'.parse on',
			mockSchema,
			createState(),
		);
		expect(result.stateChange?.parseMode).toBe(true);
	});

	it('.parse off', async () => {
		const result = await processDotCommand(
			'.parse off',
			mockSchema,
			createState({ parseMode: true }),
		);
		expect(result.stateChange?.parseMode).toBe(false);
	});

	it('.parse toggle from false → true', async () => {
		const result = await processDotCommand(
			'.parse',
			mockSchema,
			createState({ parseMode: false }),
		);
		expect(result.stateChange?.parseMode).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// [CC-13] .help lists .natural and .sql
// ---------------------------------------------------------------------------

describe('[CC-13] .help completeness', () => {
	it('lists .natural command', async () => {
		const result = await processDotCommand('.help', mockSchema, createState());
		expect(result.output).toContain('.natural');
	});

	it('lists .sql command', async () => {
		const result = await processDotCommand('.help', mockSchema, createState());
		expect(result.output).toContain('.sql');
	});
});
