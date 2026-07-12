import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@dbsp/core public surface', () => {
	it('does not re-export the removed ScalarSubqueryIntent alias', async () => {
		const source = await readFile(resolve(__dirname, 'index.ts'), 'utf8');
		expect(source).not.toContain('ScalarSubqueryIntent');
	});
});
