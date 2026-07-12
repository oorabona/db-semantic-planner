import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@dbsp/types public surface', () => {
	it('does not export the removed ScalarSubqueryIntent alias', async () => {
		const files = ['index.ts', 'intent-ast.ts', 'intent/where-intent.ts'];

		for (const file of files) {
			const source = await readFile(resolve(__dirname, file), 'utf8');
			expect(source).not.toContain('ScalarSubqueryIntent');
		}
	});
});
