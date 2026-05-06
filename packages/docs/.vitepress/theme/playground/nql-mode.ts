/**
 * NQL syntax highlighting for CodeMirror 6.
 * Uses StreamLanguage.define to create a lightweight tokenizer for NQL keywords.
 */

import { StreamLanguage, type StringStream } from '@codemirror/language';

// All NQL keywords (case-insensitive) from packages/nql/src/lexer/tokens.ts
const NQL_KEYWORDS = new Set([
	'select',
	'from',
	'where',
	'and',
	'or',
	'not',
	'in',
	'is',
	'null',
	'true',
	'false',
	'asc',
	'desc',
	'order',
	'by',
	'limit',
	'offset',
	'group',
	'having',
	'join',
	'on',
	'with',
	'as',
	'exists',
	'between',
	'like',
	'ilike',
	'insert',
	'into',
	'set',
	'values',
	'update',
	'delete',
	'upsert',
	'distinct',
	'all',
	// Additional NQL-specific keywords from lexer
	'any',
	'case',
	'when',
	'then',
	'else',
	'end',
	'union',
	'intersect',
	'except',
	'count',
	'sum',
	'avg',
	'min',
	'max',
	'for',
	'no',
	'key',
	'share',
	'skip',
	'locked',
	'row_number',
	'dense_rank',
	'partition',
	'over',
	'overlaps',
	'contains',
	'contained_by',
]);

interface NqlState {
	inString: string | null; // the quote char (' or ") or null
}

const nqlLanguage = StreamLanguage.define<NqlState>({
	startState(): NqlState {
		return { inString: null };
	},

	token(stream: StringStream, state: NqlState): string | null {
		// Continue string literals
		if (state.inString !== null) {
			if (stream.skipTo(state.inString)) {
				stream.next(); // consume closing quote
				state.inString = null;
			} else {
				stream.skipToEnd();
			}
			return 'string';
		}

		// Skip whitespace
		if (stream.eatSpace()) return null;

		// Line comments (--)
		if (stream.match('--')) {
			stream.skipToEnd();
			return 'comment';
		}

		// String literals
		const ch = stream.peek();
		if (ch === "'" || ch === '"') {
			stream.next();
			if (!stream.skipTo(ch)) {
				stream.skipToEnd();
				state.inString = ch;
			} else {
				stream.next();
			}
			return 'string';
		}

		// Numbers
		if (stream.match(/^-?\d+(\.\d+)?/)) {
			return 'number';
		}

		// Named params (:paramName)
		if (stream.match(/^:[a-zA-Z_]\w*/)) {
			return 'variableName';
		}

		// Operators
		if (stream.match(/^(<=|>=|<>|!=|[<>=!@])/)) {
			return 'operator';
		}

		// Identifiers and keywords
		if (stream.match(/^[a-zA-Z_]\w*/)) {
			const word = stream.current().toLowerCase();
			if (NQL_KEYWORDS.has(word)) {
				return 'keyword';
			}
			return 'variableName';
		}

		// Punctuation — consume one char
		stream.next();
		return 'punctuation';
	},

	languageData: {
		commentTokens: { line: '--' },
	},
});

/** CodeMirror 6 language extension for NQL syntax highlighting. */
export function nql() {
	return nqlLanguage;
}
