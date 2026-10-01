import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
