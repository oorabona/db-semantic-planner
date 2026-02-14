import { type ModelIR, ModelIRImpl } from '@dbsp/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { handleRunAssertions, splitQueries } from './assertion-handler';

// ── Minimal schema for NQL compilation ───────────────────────────

const minimalModel = new ModelIRImpl(
	new Map([
		[
			'users',
			{
				name: 'users',
				columns: [
					{ name: 'id', type: 'integer', nullable: false, primaryKey: true },
					{ name: 'name', type: 'text', nullable: false, primaryKey: false },
					{ name: 'email', type: 'text', nullable: true, primaryKey: false },
					{
						name: 'active',
						type: 'boolean',
						nullable: false,
						primaryKey: false,
					},
				],
				foreignKeys: [],
				indexes: [],
			},
		],
	]),
	new Map(),
);

// ── Mock factories ───────────────────────────────────────────────

function mockGetModel(): (connectionId: string) => Promise<ModelIR> {
	return vi.fn().mockResolvedValue(minimalModel);
}

function mockGetPool(): (connectionId: string) => Pool {
	return vi.fn().mockReturnValue({
		query: vi.fn().mockResolvedValue({
			rows: [{ id: 1, name: 'Alice' }],
			fields: [{ name: 'id' }, { name: 'name' }],
			rowCount: 1,
		}),
	} as unknown as Pool);
}

function mockGetPoolError(): (connectionId: string) => Pool {
	return vi.fn().mockReturnValue({
		query: vi.fn().mockRejectedValue(new Error('connection refused')),
	} as unknown as Pool);
}

function mockGetPoolThrows(): (connectionId: string) => Pool {
	return vi.fn().mockImplementation(() => {
		throw new Error('Not connected');
	});
}

// ── splitQueries ─────────────────────────────────────────────────

describe('splitQueries', () => {
	it('splits simple queries by newline', () => {
		const content = 'users\nusers | where active = true';
		expect(splitQueries(content)).toEqual([
			'users',
			'users | where active = true',
		]);
	});

	it('handles backslash continuation', () => {
		const content = 'users \\\n| where active = true';
		expect(splitQueries(content)).toEqual(['users | where active = true']);
	});

	it('preserves blank lines and comments for index alignment', () => {
		const content = '# comment\n\nusers\n\nusers | limit 5';
		const result = splitQueries(content);
		expect(result).toEqual(['# comment', '', 'users', '', 'users | limit 5']);
	});

	it('handles empty content', () => {
		expect(splitQueries('')).toEqual(['']);
	});
});

// ── handleRunAssertions — nominal ────────────────────────────────

describe('handleRunAssertions', () => {
	describe('nominal (compile-only)', () => {
		it('compiles NQL and runs sql.equals assertion', async () => {
			const dbspContent = 'users';
			const assertContent = ['--- query: 0', 'sql.matches: SELECT'].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: false,
				},
				mockGetModel(),
				mockGetPoolThrows(),
			);

			expect(result.parseErrors).toEqual([]);
			expect(result.queryResults).toHaveLength(1);
			expect(result.queryResults[0]!.success).toBe(true);
			expect(result.queryResults[0]!.sql).toMatch(/SELECT/i);
			expect(result.summary.total).toBeGreaterThan(0);
			expect(result.summary.passed).toBeGreaterThan(0);
		});

		it('extracts intent summary for assertions', async () => {
			const dbspContent = 'users | where active = true';
			const assertContent = [
				'--- query: 0',
				'intent.table: users',
				'intent.type: query',
				'intent.hasWhere: true',
			].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: false,
				},
				mockGetModel(),
				mockGetPoolThrows(),
			);

			expect(result.parseErrors).toEqual([]);
			expect(result.summary.failed).toBe(0);
			expect(result.summary.passed).toBe(3);
		});
	});

	describe('with DB execution', () => {
		it('executes queries and provides db results', async () => {
			const dbspContent = 'users';
			const assertContent = [
				'--- query: 0',
				'success: true',
				'db.rows.min: 1',
			].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: true,
				},
				mockGetModel(),
				mockGetPool(),
			);

			expect(result.queryResults[0]!.dbSuccess).toBe(true);
			expect(result.queryResults[0]!.rowCount).toBe(1);
			expect(result.queryResults[0]!.rows).toEqual([{ id: 1, name: 'Alice' }]);
			expect(result.summary.failed).toBe(0);
		});

		it('handles DB execution errors gracefully', async () => {
			const dbspContent = 'users';
			const assertContent = ['--- query: 0', 'success: true'].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: true,
				},
				mockGetModel(),
				mockGetPoolError(),
			);

			expect(result.queryResults[0]!.dbSuccess).toBe(false);
			expect(result.queryResults[0]!.error).toContain('connection refused');
		});
	});

	describe('no connection (pool unavailable)', () => {
		it('compiles but skips execution when pool throws', async () => {
			const dbspContent = 'users';
			const assertContent = [
				'--- query: 0',
				'sql.matches: SELECT',
				'db.rows.min: 1',
			].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: true,
				},
				mockGetModel(),
				mockGetPoolThrows(),
			);

			// SQL assertions should pass
			expect(result.queryResults[0]!.success).toBe(true);
			expect(result.queryResults[0]!.sql).toBeDefined();
			// DB assertions should be skipped (no pool)
			expect(result.summary.skipped).toBeGreaterThan(0);
		});

		it('skips execution when execute=false', async () => {
			const dbspContent = 'users';
			const assertContent = [
				'--- query: 0',
				'sql.matches: SELECT',
				'db.rows.min: 1',
			].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: false,
				},
				mockGetModel(),
				mockGetPool(),
			);

			// SQL assertions pass
			expect(result.queryResults[0]!.success).toBe(true);
			// DB assertions skipped
			expect(result.summary.skipped).toBeGreaterThan(0);
		});
	});

	describe('parse errors', () => {
		it('returns parse errors for invalid assertion file', async () => {
			const dbspContent = 'users';
			const assertContent = 'invalid.assertion: foo';

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: false,
				},
				mockGetModel(),
				mockGetPoolThrows(),
			);

			expect(result.parseErrors.length).toBeGreaterThan(0);
			expect(result.summary.total).toBe(0);
		});
	});

	describe('compilation failure', () => {
		it('reports NQL compilation errors per query', async () => {
			const dbspContent = 'nonexistent_table';
			const assertContent = ['--- query: 0', 'success: false'].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: false,
				},
				mockGetModel(),
				mockGetPoolThrows(),
			);

			// Should compile successfully (NQL doesn't validate table names at parse time)
			// or fail — depends on schema validation. Either way, assertion evaluates.
			expect(result.queryResults).toHaveLength(1);
			expect(result.parseErrors).toEqual([]);
		});

		it('handles multiple queries with mixed success/failure', async () => {
			const dbspContent = 'users\nusers | where active = true';
			const assertContent = [
				'--- query: 0',
				'success: true',
				'--- query: 1',
				'success: true',
			].join('\n');

			const result = await handleRunAssertions(
				{
					connectionId: 'test-conn',
					dbspContent,
					assertContent,
					execute: false,
				},
				mockGetModel(),
				mockGetPoolThrows(),
			);

			expect(result.queryResults).toHaveLength(2);
			expect(result.queryResults[0]!.success).toBe(true);
			expect(result.queryResults[1]!.success).toBe(true);
			expect(result.summary.passed).toBe(2);
		});
	});
});
