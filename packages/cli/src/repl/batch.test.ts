/**
 * Unit tests for batch mode functionality
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedSchema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type BatchState, processDotCommand } from './batch.js';
import type { DbConnection, ExecutionResult } from './db-connection.js';

// Minimal mock schema for testing
const mockSchema: ResolvedSchema = {
	tables: {
		users: {
			columns: { id: { type: 'integer' }, name: { type: 'text' } },
			primary: ['id'],
		},
	},
	relations: [],
	config: {},
} as unknown as ResolvedSchema;

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
	});
});
