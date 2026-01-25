/**
 * Unit tests for batch mode functionality
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelIR, RelationIR, TableIR } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type BatchState, processDotCommand } from './batch.js';
import type { DbConnection, ExecutionResult } from './db-connection.js';
import type { LoadedSchema } from '../utils/schema-loader.js';

// ARCH-005: Minimal mock schema matching LoadedSchema interface
const mockTables = new Map<string, TableIR>([
	[
		'users',
		{
			name: 'users',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'name', type: 'text', nullable: true },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		},
	],
]);

const mockRelations = new Map<string, RelationIR>();

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
	definition: { users: { id: { type: 'integer' }, name: { type: 'text' } } },
	model: mockModel,
	tableNames: ['users'],
};

// Mock database connection factory
function createMockDbConnection(
	overrides?: Partial<{
		executeRaw: (
			query: string,
			params?: readonly unknown[],
		) => Promise<ExecutionResult>;
	}>,
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
		getKysely: vi.fn() as unknown as DbConnection['getKysely'],
		...overrides,
	};
}

// Create default batch state
function createBatchState(overrides?: Partial<BatchState>): BatchState {
	return {
		mode: 'natural',
		execEnabled: false,
		schemaName: undefined,
		dbConnection: undefined,
		explainMode: false,
		parseMode: false,
		model: undefined,
		outputMode: 'json',
		...overrides,
	};
}

describe('processDotCommand', () => {
	describe('.import command', () => {
		let testDir: string;
		let testSqlFile: string;

		beforeAll(() => {
			// Create temp directory for test files
			testDir = join(tmpdir(), `batch-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });

			// Create a test SQL file
			testSqlFile = join(testDir, 'test.sql');
			writeFileSync(testSqlFile, 'CREATE TABLE test (id INT);');
		});

		afterAll(() => {
			// Cleanup temp directory
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('should return error when no file argument provided', async () => {
			const state = createBatchState({
				dbConnection: createMockDbConnection(),
			});
			const result = await processDotCommand('.import', mockSchema, state);

			expect(result.output).toBe('❌ Usage: .import <file.sql>');
		});

		it('should return error when no database connection', async () => {
			const state = createBatchState({ dbConnection: undefined });
			const result = await processDotCommand(
				'.import test.sql',
				mockSchema,
				state,
			);

			expect(result.output).toBe(
				'❌ .import requires database connection (--db)',
			);
		});

		it('should return error when file not found', async () => {
			const state = createBatchState({
				dbConnection: createMockDbConnection(),
			});
			const result = await processDotCommand(
				'.import nonexistent.sql',
				mockSchema,
				state,
			);

			expect(result.output).toMatch(/❌ File not found:/);
		});

		it('should execute SQL file successfully', async () => {
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: 5,
				executionTimeMs: 10,
			});
			const mockDb = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createBatchState({ dbConnection: mockDb });

			const result = await processDotCommand(
				`.import ${testSqlFile}`,
				mockSchema,
				state,
			);

			expect(result.output).toMatch(/✅ Imported:.*\(5 rows affected\)/);
			expect(mockExecuteRaw).toHaveBeenCalledWith(
				'CREATE TABLE test (id INT);',
				[],
			);
		});

		it('should handle SQL execution error', async () => {
			const mockExecuteRaw = vi
				.fn()
				.mockRejectedValue(new Error('syntax error'));
			const mockDb = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createBatchState({ dbConnection: mockDb });

			const result = await processDotCommand(
				`.import ${testSqlFile}`,
				mockSchema,
				state,
			);

			expect(result.output).toBe('❌ Import failed: syntax error');
		});

		it('should handle row count undefined', async () => {
			const mockExecuteRaw = vi.fn().mockResolvedValue({
				rows: [],
				columns: [],
				rowCount: undefined,
				executionTimeMs: 10,
			});
			const mockDb = createMockDbConnection({ executeRaw: mockExecuteRaw });
			const state = createBatchState({ dbConnection: mockDb });

			const result = await processDotCommand(
				`.import ${testSqlFile}`,
				mockSchema,
				state,
			);

			expect(result.output).toMatch(/✅ Imported:/);
			expect(result.output).not.toMatch(/rows affected/);
		});
	});

	describe('.use command', () => {
		it('should set schema name', async () => {
			const state = createBatchState();
			const result = await processDotCommand(
				'.use tenant_123',
				mockSchema,
				state,
			);

			expect(result.output).toBe('Using schema: tenant_123');
			expect(result.stateChange).toEqual({ schemaName: 'tenant_123' });
		});

		it('should clear schema name when no argument', async () => {
			const state = createBatchState({ schemaName: 'old_schema' });
			const result = await processDotCommand('.use', mockSchema, state);

			expect(result.output).toBe(
				'Cleared schema scope. Queries now use default schema.',
			);
			expect(result.stateChange).toEqual({ schemaName: undefined });
		});
	});

	describe('.help command', () => {
		it('should include .import in help text', async () => {
			const state = createBatchState();
			const result = await processDotCommand('.help', mockSchema, state);

			expect(result.output).toContain('.import <file>');
			expect(result.output).toContain('Execute SQL file');
		});

		it('should include .explain in help text', async () => {
			const state = createBatchState();
			const result = await processDotCommand('.help', mockSchema, state);

			expect(result.output).toContain('.explain');
			expect(result.output).toContain('EXPLAIN');
		});
	});

	/**
	 * SC-15 to SC-17: .explain command tests
	 */
	describe('.explain command', () => {
		it('SC-15: should toggle explain mode on', async () => {
			// Arrange
			const state = createBatchState({ explainMode: false });

			// Act
			const result = await processDotCommand('.explain', mockSchema, state);

			// Assert
			expect(result.output).toContain('EXPLAIN mode: ON');
			expect(result.stateChange?.explainMode).toBe(true);
		});

		it('SC-15: should toggle explain mode off', async () => {
			// Arrange
			const state = createBatchState({ explainMode: true });

			// Act
			const result = await processDotCommand('.explain', mockSchema, state);

			// Assert
			expect(result.output).toContain('EXPLAIN mode: OFF');
			expect(result.stateChange?.explainMode).toBe(false);
		});

		it('should enable with explicit "on" argument', async () => {
			// Arrange
			const state = createBatchState({ explainMode: false });

			// Act
			const result = await processDotCommand('.explain on', mockSchema, state);

			// Assert
			expect(result.output).toContain('EXPLAIN mode: ON');
			expect(result.stateChange?.explainMode).toBe(true);
		});

		it('should disable with explicit "off" argument', async () => {
			// Arrange
			const state = createBatchState({ explainMode: true });

			// Act
			const result = await processDotCommand('.explain off', mockSchema, state);

			// Assert
			expect(result.output).toContain('EXPLAIN mode: OFF');
			expect(result.stateChange?.explainMode).toBe(false);
		});
	});

	/**
	 * SC-21 to SC-23: .parse command tests
	 */
	describe('.parse command', () => {
		it('should toggle parse mode on when currently off (SC-21)', async () => {
			// Arrange
			const state = createBatchState({ parseMode: false });

			// Act
			const result = await processDotCommand('.parse', mockSchema, state);

			// Assert
			expect(result.output).toContain('Parse mode: ON');
			expect(result.stateChange?.parseMode).toBe(true);
		});

		it('should toggle parse mode off when currently on (SC-23)', async () => {
			// Arrange
			const state = createBatchState({ parseMode: true });

			// Act
			const result = await processDotCommand('.parse', mockSchema, state);

			// Assert
			expect(result.output).toContain('Parse mode: OFF');
			expect(result.stateChange?.parseMode).toBe(false);
		});

		it('should explicitly enable parse mode with ".parse on" (SC-21)', async () => {
			// Arrange
			const state = createBatchState({ parseMode: false });

			// Act
			const result = await processDotCommand('.parse on', mockSchema, state);

			// Assert
			expect(result.output).toContain('Parse mode: ON');
			expect(result.stateChange?.parseMode).toBe(true);
		});

		it('should explicitly disable parse mode with ".parse off" (SC-23)', async () => {
			// Arrange
			const state = createBatchState({ parseMode: true });

			// Act
			const result = await processDotCommand('.parse off', mockSchema, state);

			// Assert
			expect(result.output).toContain('Parse mode: OFF');
			expect(result.stateChange?.parseMode).toBe(false);
		});

		it('should include .parse in help text (SC-22)', async () => {
			// Arrange
			const state = createBatchState();

			// Act
			const result = await processDotCommand('.help', mockSchema, state);

			// Assert
			expect(result.output).toContain('.parse');
		});
	});

	/**
	 * NQL v2.1: .output command tests
	 */
	describe('.output command', () => {
		it('should show current mode when called without argument', async () => {
			// Arrange
			const state = createBatchState({ outputMode: 'json' });

			// Act
			const result = await processDotCommand('.output', mockSchema, state);

			// Assert
			expect(result.output).toContain('Current output mode: json');
			expect(result.stateChange).toBeUndefined();
		});

		it('should set output mode to json', async () => {
			// Arrange
			const state = createBatchState({ outputMode: 'table' });

			// Act
			const result = await processDotCommand('.output json', mockSchema, state);

			// Assert
			expect(result.output).toContain('Output mode: json');
			expect(result.stateChange?.outputMode).toBe('json');
		});

		it('should set output mode to table', async () => {
			// Arrange
			const state = createBatchState({ outputMode: 'json' });

			// Act
			const result = await processDotCommand(
				'.output table',
				mockSchema,
				state,
			);

			// Assert
			expect(result.output).toContain('Output mode: table');
			expect(result.stateChange?.outputMode).toBe('table');
		});

		it('should set output mode to csv', async () => {
			// Arrange
			const state = createBatchState({ outputMode: 'json' });

			// Act
			const result = await processDotCommand('.output csv', mockSchema, state);

			// Assert
			expect(result.output).toContain('Output mode: csv');
			expect(result.stateChange?.outputMode).toBe('csv');
		});

		it('should reject invalid output mode', async () => {
			// Arrange
			const state = createBatchState();

			// Act
			const result = await processDotCommand('.output xml', mockSchema, state);

			// Assert
			expect(result.output).toContain('Invalid output mode: xml');
			expect(result.output).toContain('json, table, csv');
			expect(result.stateChange).toBeUndefined();
		});

		it('should include .output in help text', async () => {
			// Arrange
			const state = createBatchState();

			// Act
			const result = await processDotCommand('.help', mockSchema, state);

			// Assert
			expect(result.output).toContain('.output');
			expect(result.output).toContain('json|table|csv');
		});
	});
});
