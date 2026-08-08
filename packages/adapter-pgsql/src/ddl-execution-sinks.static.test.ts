import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const adapterSource = dirname(fileURLToPath(import.meta.url));
const repository = join(adapterSource, '..', '..', '..');

const DDL_SINK_ALLOWLIST: Readonly<Record<string, string>> = {
	'transition/operations/alter-column-set-not-null.ts':
		'token-gated managed DDL',
	'transition/operations/alter-table-add-check.ts': 'token-gated managed DDL',
	'transition/operations/alter-type-add-value.ts': 'token-gated managed DDL',
	'transition/operations/attach-logical-identity.ts': 'token-gated managed DDL',
	'transition/operations/create-unique-index-concurrently.ts':
		'token-gated managed DDL',
	'transition/operations/manual-sql.ts': 'token-gated managed DDL',
	'../cli/src/commands/generator-execution.ts': 'token-gated managed DDL',
	'pgsql-adapter.ts': 'explicitly unmanaged API',
};

async function sourceFiles(directory: string): Promise<readonly string[]> {
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

function hasDdlSink(source: string, file: string): boolean {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	let found = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isMethodDeclaration(node) &&
			(node.name.getText(tree) === 'executeOperation' ||
				node.name.getText(tree) === 'executeDDL')
		)
			found = true;
		if (
			ts.isFunctionDeclaration(node) &&
			(node.name?.text === 'executeGeneratorPlan' ||
				node.name?.text === 'executeDDL')
		)
			found = true;
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return found;
}

describe('SC-65 DDL execution sink inventory', () => {
	it('AST-discovers only labelled managed or explicitly unmanaged DDL sinks', async () => {
		const adapterFiles = await sourceFiles(adapterSource);
		const generator = join(
			repository,
			'packages/cli/src/commands/generator-execution.ts',
		);
		const candidates = [...adapterFiles, generator];
		const discovered = (
			await Promise.all(
				candidates.map(async (file) =>
					hasDdlSink(await readFile(file, 'utf8'), file) ? file : undefined,
				),
			)
		)
			.filter((file): file is string => file !== undefined)
			.map((file) =>
				file === generator
					? '../cli/src/commands/generator-execution.ts'
					: relative(adapterSource, file),
			)
			.sort();

		expect(discovered).toEqual(Object.keys(DDL_SINK_ALLOWLIST).sort());
		for (const sink of discovered)
			expect(DDL_SINK_ALLOWLIST[sink]).toMatch(
				/token-gated managed DDL|explicitly unmanaged API/u,
			);
	});
});
