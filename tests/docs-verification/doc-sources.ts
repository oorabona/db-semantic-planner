/**
 * The markdown population processed by the doctest generator.
 *
 * Keep this list here rather than reconstructing it in a checker: the ledger
 * and generator must make statements about the same files.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function collectDir(root: string, rel: string): string[] {
	const abs = join(root, rel);
	try {
		return readdirSync(abs)
			.filter((file) => file.endsWith('.md'))
			.filter((file) => statSync(join(abs, file)).isFile())
			.map((file) => join(rel, file));
	} catch {
		return [];
	}
}

/** The buckets emitted as generated doctest suites. */
export function doctestSources(root: string): Record<string, string[]> {
	return {
		readme: ['README.md'],
		'package-readmes': [
			'packages/types/README.md',
			'packages/nql/README.md',
			'packages/core/README.md',
			'packages/adapter-pgsql/README.md',
			'packages/cli/README.md',
			'packages/mcp-server/README.md',
		],
		'site-index': [
			'packages/docs/index.md',
			'packages/docs/patterns.md',
			'packages/docs/comparison.md',
			'packages/docs/roadmap.md',
		],
		'site-guides': collectDir(root, 'packages/docs/guide'),
		'site-api': collectDir(root, 'packages/docs/api'),
		'site-nql': collectDir(root, 'packages/docs/nql'),
	};
}

/** A flattened view for checks that need every source rather than its bucket. */
export function doctestSourceFiles(root: string): string[] {
	return Object.values(doctestSources(root)).flat();
}

/** Matches the generator's heuristic for blocks which cannot stand alone. */
export function looksLikeFragment(code: string): boolean {
	const trimmed = code.trim();
	if (!trimmed) return true;
	if (/^\.\w/.test(trimmed)) return true;
	if (/^(\||&&|\|\||\?|,)/.test(trimmed)) return true;
	return /^(\.{3}|\{\s*\.{3})/.test(trimmed);
}
