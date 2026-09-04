/**
 * Documentation execution examples use a compile-only adapter, then replace
 * its executor with a deterministic result. That replacement is an explicit
 * execution capability declaration, not an exception to the core guard.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const executionHarnesses = [
	{
		file: new URL('../../../docs/guide/observability.md', import.meta.url),
		adapter: '__nqlHookAdapter',
	},
	{
		file: new URL('../../../docs/nql/index.md', import.meta.url),
		adapter: 'adapterWithExecute',
	},
] as const;

describe('documentation execution harnesses', () => {
	it.each(executionHarnesses)(
		'$adapter declares execution availability after replacing executeWithMeta',
		({ file, adapter }) => {
			const source = readFileSync(file, 'utf8');
			const escapedAdapter = adapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const declaration = new RegExp(
				`Object\\.defineProperty\\(${escapedAdapter}, ['"]connectionAvailability['"], \\{\\s*value: \\{ status: ['"]available['"] \\},\\s*configurable: true,?\\s*\\}\\);`,
				's',
			);

			expect(source).toMatch(declaration);
		},
	);
});
