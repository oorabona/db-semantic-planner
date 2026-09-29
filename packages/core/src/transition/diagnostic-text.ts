/**
 * Preserve hostile diagnostic text as one printable line without losing which
 * control character was supplied. This is for diagnostics only, never SQL.
 */
export function escapeDiagnosticText(value: string): string {
	return value.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		switch (character) {
			case '\\':
				return '\\\\';
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\t':
				return '\\t';
			default:
				return `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0')}`;
		}
	});
}
