import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const transitionDirectory = dirname(fileURLToPath(import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
				? [path]
				: [];
		}),
	);
	return nested.flat();
}

async function producerFiles(pattern: RegExp): Promise<string[]> {
	const files = await sourceFiles(transitionDirectory);
	const matching = await Promise.all(
		files.map(async (file) =>
			(await readFile(file, 'utf8')).match(pattern) ? file : undefined,
		),
	);
	return matching
		.filter((file): file is string => file !== undefined)
		.map((file) => relative(transitionDirectory, file));
}

describe('SC-30 lifecycle producer inventory', () => {
	it('has exactly one lifecycle-state producer and extends the same scan to later producers', async () => {
		await expect(
			producerFiles(/export function projectLedgerChain\b/),
		).resolves.toEqual(['lifecycle-interpreter.ts']);

		// Unit 7 supplies the token producer. Its module may consume the grammar,
		// but no second layer may mint an execution capability.
		await expect(
			producerFiles(/export function mintClaimToken\b/),
		).resolves.toEqual(['outcome-protocol.ts']);

		// Unit 11 adds this producer later; retain its conditional inventory until
		// that layer exists without pretending it exists today.
		const destructive = await producerFiles(
			/export function (?:create|decide)DestructiveDecision\b/,
		);
		if (destructive.length > 0) expect(destructive).toHaveLength(1);
	});
});
