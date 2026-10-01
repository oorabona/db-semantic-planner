import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { plan, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const queryAndHydrationModules = [
	'../ast-helpers.ts',
	'../adapter-compiler-includes.ts',
	'../adapter-compiler-recursive.ts',
	'../adapter-compiler-select.ts',
	'../column-metadata.ts',
	'../projection-envelope.ts',
	'../relation-target-projection.ts',
	'../pgsql-adapter.ts',
	'../mutations/mutation-compiler.ts',
	'../mutations/upsert.ts',
	'../recursive/cte-compiler.ts',
	'../handlers/expression/pseudo.ts',
	'../handlers/include/json-agg.ts',
	'../handlers/where/exists.ts',
] as const;

describe('query naming boundary', () => {
	it('refuses undeclared addressed mutation and select references', () => {
		const model = schema({
			userProfiles: { id: 'integer', displayName: 'string' },
		}).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		expect(() =>
			adapter.compileInsert(
				{
					type: 'insert',
					table: 'userProfiles',
					values: [{ missingColumn: 'x' }],
				} as never,
				{ model },
			),
		).toThrow("Declared column 'userProfiles.missingColumn'");
		expect(() =>
			adapter.compileInsert(
				{ type: 'insert', table: 'missingTable', values: [{ id: 1 }] } as never,
				{ model },
			),
		).toThrow("Declared table 'missingTable'");
		expect(() =>
			adapter.compileUpsert(
				{
					type: 'upsert',
					table: 'userProfiles',
					values: [{ id: 1 }],
					onConflict: { columns: ['missingColumn'] },
					action: { type: 'doNothing' },
				} as never,
				{ model },
			),
		).toThrow("Declared column 'userProfiles.missingColumn'");
		expect(() =>
			adapter.compile(
				plan(
					{
						type: 'select',
						from: 'userProfiles',
						select: { type: 'fields', fields: ['missingColumn'] },
					},
					model,
				),
				{ model },
			),
		).toThrow("Declared column 'userProfiles.missingColumn'");
	});

	it('does not retain an addressless declared-name resolver bridge', () => {
		const source = readFileSync(
			fileURLToPath(new URL('../declared-name-resolver.ts', import.meta.url)),
			'utf8',
		);
		expect(source).not.toMatch(/\bresolve\s*\(\s*name\s*:\s*string/);
		expect(source).not.toMatch(/\.(?:toDatabase|toModel)\s*\(/);
	});

	it('resolves declared conflict constraints and preserves catalog constraints', () => {
		const model = schema({
			userProfiles: {
				id: { type: 'integer', primaryKey: true },
				email: 'string',
			},
		}).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		const base = {
			type: 'upsert' as const,
			table: 'userProfiles',
			values: [{ id: 1, email: 'a@example.test' }],
			action: { type: 'doNothing' as const },
		};

		expect(
			adapter.compileUpsert(
				{ ...base, onConflict: { constraint: 'pk_userProfiles' } },
				{ model },
			).sql,
		).toContain('ON CONFLICT ON CONSTRAINT pk_user_profiles');
		expect(
			adapter.compileUpsert(
				{
					...base,
					onConflict: { constraint: 'runtime_user_profiles_email_uq' },
				},
				{ model },
			).sql,
		).toContain('ON CONFLICT ON CONSTRAINT runtime_user_profiles_email_uq');
	});

	it('does not call naming-plugin conversion methods from query, hydration, or helper modules', () => {
		for (const module of queryAndHydrationModules) {
			const source = readFileSync(
				fileURLToPath(new URL(module, import.meta.url)),
				'utf8',
			);
			expect(source, module).not.toMatch(/\.(?:toDatabase|toModel)\s*\(/);
		}
	});
});
