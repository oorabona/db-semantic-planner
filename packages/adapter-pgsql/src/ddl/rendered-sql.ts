/**
 * Re-spell ordinary quoted literals with backslashes as PostgreSQL escape
 * strings. Call this only for SQL PostgreSQL itself deparsed: authored
 * expressions retain their normal validation path.
 *
 * An ordinary literal's backslashes are literal when
 * `standard_conforming_strings` is on. In an `E'…'` literal they are escape
 * characters, so double each one while adding the `E` prefix. The resulting
 * literal has the same value independently of that session setting.
 */
export function escapeCanonicalSqlLiterals(sql: string): string {
	let i = 0;
	let rewritten = '';
	let copiedThrough = 0;

	while (i < sql.length) {
		if (sql.startsWith('--', i)) {
			const newline = sql.indexOf('\n', i + 2);
			i = newline === -1 ? sql.length : newline + 1;
			continue;
		}
		if (sql.startsWith('/*', i)) {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (sql[i] === '"') {
			i = skipQuotedIdentifier(sql, i);
			continue;
		}

		if (sql[i] === "'") {
			const ordinary =
				!isEscapeStringPrefix(sql, i) && !isUnicodeEscapeStringPrefix(sql, i);
			const literal = scanSingleQuotedLiteral(sql, i);
			if (ordinary && literal.hasBackslash) {
				rewritten +=
					sql.slice(copiedThrough, i) +
					"E'" +
					sql.slice(i + 1, literal.end - 1).replaceAll('\\', '\\\\') +
					"'";
				copiedThrough = literal.end;
			}
			i = literal.end;
			continue;
		}

		i++;
	}

	return rewritten === '' ? sql : rewritten + sql.slice(copiedThrough);
}

function skipQuotedIdentifier(sql: string, start: number): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === '"') {
			if (sql[i + 1] === '"') {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i++;
	}
	return i;
}

function isEscapeStringPrefix(sql: string, quote: number): boolean {
	const prefix = sql[quote - 1];
	if (prefix !== 'E' && prefix !== 'e') return false;
	const beforePrefix = sql[quote - 2];
	return beforePrefix === undefined || !/[A-Za-z0-9_$]/u.test(beforePrefix);
}

function isUnicodeEscapeStringPrefix(sql: string, quote: number): boolean {
	return (
		sql[quote - 1] === '&' &&
		(sql[quote - 2] === 'U' || sql[quote - 2] === 'u') &&
		(quote < 3 || !/[A-Za-z0-9_$]/u.test(sql[quote - 3]!))
	);
}

function scanSingleQuotedLiteral(
	sql: string,
	start: number,
): { readonly end: number; readonly hasBackslash: boolean } {
	let hasBackslash = false;
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === '\\') hasBackslash = true;
		if (sql[i] === "'") {
			if (sql[i + 1] === "'") {
				i += 2;
				continue;
			}
			return { end: i + 1, hasBackslash };
		}
		i++;
	}
	return { end: i, hasBackslash };
}
