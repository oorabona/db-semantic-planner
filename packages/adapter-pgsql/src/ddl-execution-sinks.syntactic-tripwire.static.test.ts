import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const adapterSource = dirname(fileURLToPath(import.meta.url));
const repository = join(adapterSource, '..', '..', '..');

/**
 * This is a deliberately narrow syntactic tripwire, not a complete DDL-sink
 * inventory. It recognizes only the following grammar:
 *
 * - a literal, no-substitution template, template head, left-hand string
 *   concatenation, or parenthesized version thereof beginning (after
 *   whitespace) with ALTER, CREATE, DROP, GRANT, REVOKE, or TRUNCATE;
 * - that expression, or a known binding for it, passed as the first argument
 *   to a direct `.query(...)` call or to a direct one-argument forwarder that
 *   calls `.query(...)`; and
 * - a direct `.query(statement.sql)` planned-statement sender, plus the few
 *   named executor entry points below.
 *
 * It structurally cannot see dynamic SQL, leading comments, other SQL command
 * forms, aliased or destructured query calls, configuration-object calls, or
 * wrappers beyond the direct forwarder shape above. Those are non-goals of the
 * tripwire and need a different analysis if they ever become in scope.
 */
const DDL_TRIPWIRE_ALLOWLIST: Readonly<Record<string, string>> = {
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
	'transition/outcome-protocol.ts': 'token-gated managed DDL',
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

const DDL_SQL = /^\s*(?:alter|create|drop|grant|revoke|truncate)\b/iu;

function isDdlSqlExpression(node: ts.Expression): boolean {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		return DDL_SQL.test(node.text);
	if (ts.isTemplateExpression(node)) return DDL_SQL.test(node.head.text);
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.PlusToken
	)
		return isDdlSqlExpression(node.left);
	if (ts.isParenthesizedExpression(node))
		return isDdlSqlExpression(node.expression);
	return false;
}

/** Dynamic planned SQL is just as much a DDL sink as a literal. */
function isPlannedSqlExpression(node: ts.Expression): boolean {
	return ts.isPropertyAccessExpression(node) && node.name.text === 'sql';
}

function hasDdlSink(source: string, file: string): boolean {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	let found = false;
	const ddlBindings = new Set<string>();
	const ddlForwarders = new Set<string>();
	const collectBindings = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			isDdlSqlExpression(node.initializer)
		)
			ddlBindings.add(node.name.text);
		ts.forEachChild(node, collectBindings);
	};
	collectBindings(tree);
	const collectForwarders = (node: ts.Node): void => {
		if (
			(ts.isFunctionDeclaration(node) && node.name !== undefined) ||
			(ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer !== undefined &&
				(ts.isArrowFunction(node.initializer) ||
					ts.isFunctionExpression(node.initializer)))
		) {
			const name = ts.isFunctionDeclaration(node)
				? node.name!.text
				: (node.name as ts.Identifier).text;
			const fn = ts.isFunctionDeclaration(node)
				? node
				: (node.initializer! as ts.ArrowFunction | ts.FunctionExpression);
			const params = new Set(
				fn.parameters
					.filter((parameter) => ts.isIdentifier(parameter.name))
					.map((parameter) => (parameter.name as ts.Identifier).text),
			);
			let forwards = false;
			const inspect = (child: ts.Node): void => {
				const firstArgument = ts.isCallExpression(child)
					? child.arguments[0]
					: undefined;
				if (
					ts.isCallExpression(child) &&
					ts.isPropertyAccessExpression(child.expression) &&
					child.expression.name.text === 'query' &&
					firstArgument !== undefined &&
					ts.isIdentifier(firstArgument) &&
					params.has(firstArgument.text)
				)
					forwards = true;
				ts.forEachChild(child, inspect);
			};
			if (fn.body !== undefined) inspect(fn.body);
			if (forwards) ddlForwarders.add(name);
		}
		ts.forEachChild(node, collectForwarders);
	};
	collectForwarders(tree);
	const visit = (node: ts.Node): void => {
		if (
			ts.isMethodDeclaration(node) &&
			(node.name.getText(tree) === 'executeOperation' ||
				node.name.getText(tree) === 'executeDDL' ||
				node.name.getText(tree) === 'executeDdl')
		)
			found = true;
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			ddlForwarders.has(node.expression.text) &&
			node.arguments.some(
				(argument) =>
					isDdlSqlExpression(argument) ||
					(ts.isIdentifier(argument) && ddlBindings.has(argument.text)),
			)
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
			(isDdlSqlExpression(node.arguments[0]) ||
				isPlannedSqlExpression(node.arguments[0]) ||
				(ts.isIdentifier(node.arguments[0]) &&
					ddlBindings.has(node.arguments[0].text)))
		)
			found = true;
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return found;
}

describe('SC-65 DDL execution syntactic tripwire', () => {
	it('rejects a DDL binding forwarded through executor.query', () => {
		expect(
			hasDdlSink(
				"const statement = 'DROP TABLE tenant.accounts'; await executor.query(statement);",
				'indirection.ts',
			),
		).toBe(true);
	});

	it('rejects a new dynamic statement.sql sender', () => {
		expect(
			hasDdlSink(
				'async function send(executor: { query(sql: string): unknown }, statement: { sql: string }) { await executor.query(statement.sql); }',
				'dynamic-indirection.ts',
			),
		).toBe(true);
	});

	it('requires labels for every syntactically recognized DDL shape', async () => {
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

		expect(discovered).toEqual(Object.keys(DDL_TRIPWIRE_ALLOWLIST).sort());
		for (const sink of discovered)
			expect(DDL_TRIPWIRE_ALLOWLIST[sink]).toMatch(
				/token-gated managed DDL|explicitly unmanaged(?: API| test fixture API)|ledger bootstrap and explicitly managed storage API|separately privileged ledger cutover/u,
			);
	}, 20_000);
});
