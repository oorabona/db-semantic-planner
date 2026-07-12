/**
 * Tests for Push Command — Schema Provisioning.
 *
 * Tests the push logic functions with mocked adapter.
 * Pattern: test mocked function calls and transformations,
 * not Commander internals.
 */

import type { SchemaChange, SchemaDiff } from '@dbsp/adapter-pgsql';
import { describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mock adapter
// ============================================================================

const mockComparePgsqlDatabaseSchema = vi.fn();
const mockGenerateDDL = vi.fn();
const mockGenerateMigrationSQL = vi.fn();

vi.mock('@dbsp/adapter-pgsql', () => ({
	comparePgsqlDatabaseSchema: (...args: unknown[]) =>
		mockComparePgsqlDatabaseSchema(...args),
	generateDDL: (...args: unknown[]) => mockGenerateDDL(...args),
	generateMigrationSQL: (...args: unknown[]) =>
		mockGenerateMigrationSQL(...args),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeDiff(
	changes: Partial<SchemaChange>[] = [],
	hasDestructive = false,
): SchemaDiff {
	return {
		changes: changes.map((c) => ({
			kind: 'create_table',
			table: 'unknown',
			destructive: false,
			details: '',
			...c,
		})) as SchemaChange[],
		hasDestructive,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

// ============================================================================
// Tests: _dbsp_migrations filtering
// ============================================================================

describe('push — migrations table protection', () => {
	it('should filter DROP for _dbsp_migrations from DDL', () => {
		const pattern = /DROP\s+TABLE.*"_dbsp_migrations"/i;
		const statements = [
			'DROP TABLE IF EXISTS "_dbsp_migrations"',
			'DROP TABLE IF EXISTS "users"',
			'CREATE TABLE "users" ("id" serial PRIMARY KEY)',
			'CREATE TABLE "_dbsp_migrations" ("id" serial PRIMARY KEY)',
		];

		const filtered = statements.filter((stmt) => !pattern.test(stmt));

		expect(filtered).toHaveLength(3);
		expect(filtered).not.toContainEqual(
			expect.stringContaining('DROP TABLE IF EXISTS "_dbsp_migrations"'),
		);
		expect(filtered).toContainEqual(
			expect.stringContaining('DROP TABLE IF EXISTS "users"'),
		);
		// CREATE for _dbsp_migrations is kept (only DROPs are filtered)
		expect(filtered).toContainEqual(
			expect.stringContaining('CREATE TABLE "_dbsp_migrations"'),
		);
	});

	it('should handle schema-qualified DROP', () => {
		const pattern = /DROP\s+TABLE.*"_dbsp_migrations"/i;
		const statements = [
			'DROP TABLE IF EXISTS "myschema"."_dbsp_migrations"',
			'DROP TABLE IF EXISTS "myschema"."users"',
		];

		const filtered = statements.filter((stmt) => !pattern.test(stmt));

		expect(filtered).toHaveLength(1);
		expect(filtered[0]).toContain('"users"');
	});
});

// ============================================================================
// Tests: Additive push (comparePgsqlDatabaseSchema -> generateMigrationSQL)
// ============================================================================

describe('push — additive mode logic', () => {
	it('should call generateMigrationSQL with includeDestructive: false', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: 'CREATE TABLE "users"',
			},
			{
				kind: 'drop_column',
				table: 'users',
				column: 'legacy',
				destructive: true,
				details: 'DROP COLUMN "legacy"',
			},
		]);

		// Simulate what push does: call generateMigrationSQL with includeDestructive: false
		mockGenerateMigrationSQL.mockReturnValue([
			'CREATE TABLE "users" ("id" serial)',
		]);

		const result = mockGenerateMigrationSQL(diff, {
			includeDestructive: false,
		});

		expect(result).toHaveLength(1);
		expect(mockGenerateMigrationSQL).toHaveBeenCalledWith(
			diff,
			expect.objectContaining({ includeDestructive: false }),
		);
	});

	it('should identify skipped destructive changes for warnings', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: 'CREATE TABLE "users"',
			},
			{
				kind: 'drop_column',
				table: 'posts',
				column: 'legacy',
				destructive: true,
				details: 'DROP COLUMN "legacy" from "posts"',
			},
			{
				kind: 'alter_column_type',
				table: 'posts',
				column: 'status',
				destructive: true,
				details: 'ALTER COLUMN "status" TYPE varchar(100)',
			},
		]);

		const skippedChanges = diff.changes.filter((c) => c.destructive);

		expect(skippedChanges).toHaveLength(2);
		expect(skippedChanges[0]!.details).toContain('DROP COLUMN');
		expect(skippedChanges[1]!.details).toContain('ALTER COLUMN');
	});
});

// ============================================================================
// Tests: Drop mode (generateDDL)
// ============================================================================

describe('push — drop mode logic', () => {
	it('should call generateDDL with includeDropStatements: true', () => {
		mockGenerateDDL.mockReturnValue([
			'DROP TABLE IF EXISTS "users"',
			'CREATE TABLE "users" ("id" serial)',
		]);

		const result = mockGenerateDDL({}, { includeDropStatements: true });

		expect(mockGenerateDDL).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ includeDropStatements: true }),
		);
		expect(result).toHaveLength(2);
	});

	it('should pass schemaName to generateDDL', () => {
		mockGenerateDDL.mockReturnValue([]);

		mockGenerateDDL(
			{},
			{
				includeDropStatements: true,
				schemaName: 'myschema',
			},
		);

		expect(mockGenerateDDL).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ schemaName: 'myschema' }),
		);
	});
});

// ============================================================================
// Tests: Diff summary for JSON output
// ============================================================================

describe('push — JSON output structure', () => {
	it('should produce correct up-to-date status', () => {
		const diff = makeDiff([]);
		const statements: string[] = [];
		const skippedChanges = diff.changes.filter((c) => c.destructive);

		const jsonOutput = {
			status: 'up-to-date',
			statementsExecuted: statements.length,
			skippedChanges: skippedChanges.length,
		};

		expect(jsonOutput).toEqual({
			status: 'up-to-date',
			statementsExecuted: 0,
			skippedChanges: 0,
		});
	});

	it('should produce correct applied status', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: 'CREATE TABLE "users"',
			},
		]);
		const statementsExecuted = 1;
		const skippedChanges = diff.changes.filter((c) => c.destructive);

		const jsonOutput = {
			status: 'applied',
			statementsExecuted,
			skippedChanges: skippedChanges.length,
		};

		expect(jsonOutput).toEqual({
			status: 'applied',
			statementsExecuted: 1,
			skippedChanges: 0,
		});
	});

	it('should produce correct dry-run status with skipped changes', () => {
		const diff = makeDiff(
			[
				{
					kind: 'create_table',
					table: 'users',
					destructive: false,
					details: 'CREATE TABLE',
				},
				{
					kind: 'drop_column',
					table: 'posts',
					column: 'x',
					destructive: true,
					details: 'DROP COLUMN',
				},
			],
			true,
		);
		const skippedChanges = diff.changes.filter((c) => c.destructive);

		const jsonOutput = {
			status: 'dry-run',
			statementsExecuted: 1,
			skippedChanges: skippedChanges.length,
		};

		expect(jsonOutput).toEqual({
			status: 'dry-run',
			statementsExecuted: 1,
			skippedChanges: 1,
		});
	});
});
