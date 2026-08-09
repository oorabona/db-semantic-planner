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
	'../../cli/src/commands/generator-execution.ts': 'token-gated managed DDL',
	'../../cli/src/ddl-executor.ts': 'explicitly unmanaged test fixture API',
	'pgsql-adapter.ts': 'explicitly unmanaged API',
	'transition/ledger.ts': 'ledger bootstrap and explicitly managed storage API',
	'transition/observation-issuer.ts': 'token-gated managed DDL',
	'transition/reinitialize-preflight.ts':
		'separately privileged ledger cutover',
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

const DDL_KEYWORD = /\b(?:alter|create|drop|grant|revoke|truncate)\b/iu;

function hasDdlSink(source: string, file: string): boolean {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	let found = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isMethodDeclaration(node) &&
			(node.name.getText(tree) === 'executeOperation' ||
				node.name.getText(tree) === 'executeDDL' ||
				node.name.getText(tree) === 'executeDdl')
		)
			found = true;
		if (
			ts.isFunctionDeclaration(node) &&
			(node.name?.text === 'executeGeneratorPlan' ||
				node.name?.text === 'executeDDL' ||
				node.name?.text === 'executeDdl')
		)
			found = true;
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'query' &&
			node.arguments[0] !== undefined &&
			DDL_KEYWORD.test(node.arguments[0].getText(tree))
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
		const cliSource = join(repository, 'packages/cli/src');
		const cliFiles = await sourceFiles(cliSource);
		const candidates = [...adapterFiles, ...cliFiles];
		const discovered = (
			await Promise.all(
				candidates.map(async (file) =>
					hasDdlSink(await readFile(file, 'utf8'), file) ? file : undefined,
				),
			)
		)
			.filter((file): file is string => file !== undefined)
			.map((file) => relative(adapterSource, file))
			.sort();

		expect(discovered).toEqual(Object.keys(DDL_SINK_ALLOWLIST).sort());
		for (const sink of discovered)
			expect(DDL_SINK_ALLOWLIST[sink]).toMatch(
				/token-gated managed DDL|explicitly unmanaged(?: API| test fixture API)|ledger bootstrap and explicitly managed storage API|separately privileged ledger cutover/u,
			);
	});
});
