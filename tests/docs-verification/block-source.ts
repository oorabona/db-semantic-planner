/**
 * Cleans module syntax from an extracted documentation block without
 * reprinting the rest of its source.
 */
import * as ts from 'typescript';

export type BlockImport = {
	text: string;
	module: string;
	runtimeLocalNames: readonly string[];
};

export type CleanBlockSource = {
	body: string;
	imports: readonly BlockImport[];
};

function locationFor(
	sourceFile: ts.SourceFile,
	position: number,
	file: string,
	codeStartLine: number,
	sourceColumnReliable: boolean,
): string {
	const location = sourceFile.getLineAndCharacterOfPosition(position);
	return sourceColumnReliable
		? `${file}:${codeStartLine + location.line}:${location.character + 1}`
		: `${file}:${codeStartLine + location.line}`;
}

function unsupportedImport(
	sourceFile: ts.SourceFile,
	statement: ts.Statement,
	file: string,
	codeStartLine: number,
	sourceColumnReliable: boolean,
	message: string,
): never {
	throw new Error(
		`${locationFor(sourceFile, statement.getStart(sourceFile), file, codeStartLine, sourceColumnReliable)} — ${message}`,
	);
}

function runtimeLocalNames(clause: ts.ImportClause): string[] {
	if (clause.isTypeOnly) return [];
	const names: string[] = [];
	if (clause.name !== undefined) names.push(clause.name.text);
	if (clause.namedBindings === undefined) return names;
	if (ts.isNamespaceImport(clause.namedBindings)) {
		names.push(clause.namedBindings.name.text);
		return names;
	}
	for (const specifier of clause.namedBindings.elements) {
		if (!specifier.isTypeOnly) names.push(specifier.name.text);
	}
	return names;
}

/**
 * Returns a body with top-level export modifiers removed plus the static
 * `@dbsp/*` and `pg` imports to hoist; refuses `import 'x'`, import-equals
 * declarations, imports from any other module, and runtime local names with
 * the doctest harness's reserved `__` prefix.
 *
 * Parser failures retain the markdown filename and point at the original
 * documentation line, rather than at generated test source.
 */
export function cleanBlockSource(
	code: string,
	file: string,
	codeStartLine: number,
	sourceColumnReliable: boolean,
): CleanBlockSource {
	const sourceFile = ts.createSourceFile(
		file,
		code,
		ts.ScriptTarget.ESNext,
		false,
		ts.ScriptKind.TS,
	);
	const diagnostic = sourceFile.parseDiagnostics[0];
	if (diagnostic !== undefined) {
		const location = locationFor(
			sourceFile,
			diagnostic.start,
			file,
			codeStartLine,
			sourceColumnReliable,
		);
		throw new Error(
			`${location} — ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
		);
	}

	const ranges: Array<readonly [start: number, end: number]> = [];
	const imports: BlockImport[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportEqualsDeclaration(statement)) {
			const module = ts.isExternalModuleReference(statement.moduleReference)
				? (statement.moduleReference.expression?.getText(sourceFile) ??
					'unknown module')
				: statement.moduleReference.getText(sourceFile);
			unsupportedImport(
				sourceFile,
				statement,
				file,
				codeStartLine,
				sourceColumnReliable,
				`unsupported import-equals declaration from ${module}`,
			);
		}

		if (ts.isImportDeclaration(statement)) {
			const module = ts.isStringLiteral(statement.moduleSpecifier)
				? statement.moduleSpecifier.text
				: statement.moduleSpecifier.getText(sourceFile);
			if (statement.importClause === undefined) {
				unsupportedImport(
					sourceFile,
					statement,
					file,
					codeStartLine,
					sourceColumnReliable,
					`unsupported side-effect import from ${JSON.stringify(module)}`,
				);
			}
			if (!module.startsWith('@dbsp/') && module !== 'pg') {
				unsupportedImport(
					sourceFile,
					statement,
					file,
					codeStartLine,
					sourceColumnReliable,
					`unsupported import from ${JSON.stringify(module)}`,
				);
			}
			const localNames = runtimeLocalNames(statement.importClause);
			const reservedLocalName = localNames.find((name) =>
				name.startsWith('__'),
			);
			if (reservedLocalName !== undefined) {
				unsupportedImport(
					sourceFile,
					statement,
					file,
					codeStartLine,
					sourceColumnReliable,
					`unsupported import local name ${JSON.stringify(reservedLocalName)}: the __ prefix is reserved for the doctest harness`,
				);
			}
			imports.push({
				text: code.slice(statement.getStart(sourceFile), statement.end),
				module,
				runtimeLocalNames: localNames,
			});
			ranges.push([statement.getStart(sourceFile), statement.end]);
			continue;
		}

		const modifiers = ts.getModifiers(statement);
		if (
			!modifiers?.some(
				(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
			)
		)
			continue;
		for (const modifier of modifiers) {
			if (
				modifier.kind === ts.SyntaxKind.ExportKeyword ||
				modifier.kind === ts.SyntaxKind.DefaultKeyword ||
				modifier.kind === ts.SyntaxKind.DeclareKeyword
			)
				ranges.push([modifier.getStart(sourceFile), modifier.end]);
		}
	}

	const output: string[] = [];
	let cursor = 0;
	for (const [start, end] of ranges.sort(([left], [right]) => left - right)) {
		output.push(code.slice(cursor, start));
		output.push(code.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, ''));
		cursor = end;
	}
	output.push(code.slice(cursor));
	return { body: output.join(''), imports };
}
