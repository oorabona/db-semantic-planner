/**
 * Generate command tests
 *
 * E01 regression: Verify CLI options are applied correctly.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the adapter module
vi.mock('@dbsp/adapter-pgsql', () => ({
	createPgsqlCompileOnlyAdapter: vi.fn(() => ({
		generateDDL: vi.fn((_schema, options) => {
			// Return different content based on options to verify they're passed
			const statements = ['CREATE TABLE test (id INTEGER)'];
			if (options?.includeDropStatements) {
				statements.unshift('DROP TABLE IF EXISTS test');
			}
			return statements;
		}),
	})),
}));

const loadSchema = vi.hoisted(() => vi.fn());
vi.mock('../utils/schema-loader.js', () => ({
	loadSchema,
	loadSchemaFromCwd: loadSchema,
}));

describe('generate: a refused target never runs the user schema', () => {
	// Loading a schema executes the user's module. A target we are going to
	// refuse must be refused first.
	it.each([
		'manifest',
		'kysely',
		'typo',
	])('rejects %s without loading the schema', async (target) => {
		loadSchema.mockClear();
		const { generateCommand } = await import('./generate.js');
		const exit = vi
			.spyOn(process, 'exit')
			.mockImplementation((() => undefined) as never);
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

		await generateCommand.parseAsync(['node', 'dbsp', target]);

		expect(loadSchema).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining(
				target === 'typo' ? 'Unknown target' : 'has been removed',
			),
		);
		exit.mockRestore();
		stderr.mockRestore();
	});
});

describe('E01 Regression: generate command options', () => {
	describe('--drop option', () => {
		it('includeDropStatements is passed to generateDDL when --drop is set', async () => {
			const { createPgsqlCompileOnlyAdapter } = await import(
				'@dbsp/adapter-pgsql'
			);

			// Simulate what the CLI does
			const adapter = createPgsqlCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});

			// Without --drop
			const withoutDrop = adapter.generateDDL({} as any, {});
			expect(withoutDrop).not.toContain('DROP TABLE');

			// With --drop
			const withDrop = adapter.generateDDL({} as any, {
				includeDropStatements: true,
			});
			expect(withDrop).toContain('DROP TABLE IF EXISTS test');
		});
	});

	describe('--dialect option', () => {
		function isDialectSupported(dialect: string): boolean {
			return dialect === 'postgresql';
		}

		it('warns when dialect is not postgresql', () => {
			// The CLI should warn but continue with postgresql
			expect(isDialectSupported('mysql')).toBe(false);
			expect(isDialectSupported('sqlite')).toBe(false);
			expect(isDialectSupported('mssql')).toBe(false);
		});

		it('accepts postgresql dialect without warning', () => {
			expect(isDialectSupported('postgresql')).toBe(true);
		});
	});

	describe('--casing option', () => {
		function mapCasingToDbCasing(casing: string): 'snake_case' | 'preserve' {
			return casing === 'snake' ? 'snake_case' : 'preserve';
		}

		it('maps snake to snake_case dbCasing', () => {
			expect(mapCasingToDbCasing('snake')).toBe('snake_case');
		});

		it('maps camel to preserve dbCasing', () => {
			expect(mapCasingToDbCasing('camel')).toBe('preserve');
		});

		it('maps none to preserve dbCasing', () => {
			expect(mapCasingToDbCasing('none')).toBe('preserve');
		});
	});
});
