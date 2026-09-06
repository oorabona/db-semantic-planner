/**
 * Cleans module syntax from an extracted documentation block without
 * reprinting the rest of its source.
 */
import * as ts from 'typescript';

/**
 * Removes imports and top-level export modifiers from a documentation block.
 *
 * Parser failures retain the markdown filename and point at the original
 * documentation line, rather than at generated test source.
 */
export function cleanBlockSource(
	code: string,
	file: string,
	codeStartLine: number,
): string {
	const sourceFile = ts.createSourceFile(
		file,
		code,
		ts.ScriptTarget.ESNext,
		false,
		ts.ScriptKind.TS,
	);
	const diagnostic = sourceFile.parseDiagnostics[0];
	if (diagnostic !== undefined) {
		const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
		throw new Error(
			`${file}:${codeStartLine + position.line}:${position.character + 1} — ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
		);
	}

	const ranges: Array<readonly [start: number, end: number]> = [];
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) ||
			ts.isImportEqualsDeclaration(statement)
		) {
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
	return output.join('');
}
