/**
 * NQL syntax highlighting for CodeMirror 6.
 * Uses StreamLanguage.define to create a lightweight tokenizer for NQL keywords.
 */

import { StreamLanguage, type StringStream } from '@codemirror/language';

// ---------------------------------------------------------------------------
// Keyword set — source of truth: packages/nql/src/lexer/tokens.ts
//
// Single-word keywords extracted from createToken({ pattern: /word\b/i }) calls:
//   with, select, where, flat, via, bind, limit, offset, distinct, ascendant,
//   descendant, parent, child, asc, as, on, and, or, not, all, some, none,
//   nowait, every, intersect, insert, into, in, any, between, like, overlaps,
//   containedby, contains, is, exists, update, delete, from, set, upsert,
//   values, true, false, null, desc, over, row_number, rank, dense_rank, lag,
//   lead, case, when, then, else, end, union, except
//
// Multi-word tokens (group by, order by, partition by) matched word-by-word:
//   → add: group, by, order, partition
//
// NOT in lexer (removed): ilike, join, having, contained_by (underscore form)
// ---------------------------------------------------------------------------
const NQL_KEYWORDS = new Set([
	// Core query keywords
	'select',
	'from',
	'where',
	'with',
	'flat',
	'via',
	'bind',
	'distinct',
	'limit',
	'offset',
	// Multi-word components (group by / order by / partition by)
	'group',
	'order',
	'partition',
	'by',
	// Boolean operators
	'and',
	'or',
	'not',
	// Comparison & predicate keywords
	'in',
	'is',
	'between',
	'like',
	'exists',
	// Quantifiers
	'all',
	'any',
	'some',
	'none',
	'every',
	// Sort direction
	'asc',
	'desc',
	// Alias / join keyword
	'as',
	'on',
	// Range operators (PostgreSQL) — from ContainedBy, Contains, Overlaps tokens
	'overlaps',
	'contains',
	'containedby',
	// Literals
	'null',
	'true',
	'false',
	// Mutation keywords
	'insert',
	'into',
	'set',
	'values',
	'update',
	'delete',
	'upsert',
	// Window function keywords
	'over',
	'row_number',
	'rank',
	'dense_rank',
	'lag',
	'lead',
	// CASE expression keywords
	'case',
	'when',
	'then',
	'else',
	'end',
	// Set operations
	'union',
	'intersect',
	'except',
	// Lock clause (single-word)
	'nowait',
	// Pseudo-column traversal
	'parent',
	'child',
	'ascendant',
	'descendant',
]);

interface NqlState {
	inString: string | null; // the quote char (' or ") or null
}

const nqlLanguage = StreamLanguage.define<NqlState>({
	startState(): NqlState {
		return { inString: null };
	},

	token(stream: StringStream, state: NqlState): string | null {
		// Continue string literals — handle SQL doubled-quote escape ('' or "")
		if (state.inString !== null) {
			const quoteChar = state.inString;
			while (!stream.eol()) {
				const ch = stream.next();
				if (ch === quoteChar) {
					if (stream.peek() === quoteChar) {
						// SQL escape: '' inside 'string' — consume second quote, stay in string
						stream.next();
					} else {
						// Closing quote — end string state
						state.inString = null;
						break;
					}
				}
			}
			return 'string';
		}

		// Skip whitespace
		if (stream.eatSpace()) return null;

		// Line comments — NQL uses '#' (see packages/nql/src/lexer/tokens.ts:13-17)
		if (stream.eat('#')) {
			stream.skipToEnd();
			return 'comment';
		}

		// String literals (single-quoted, SQL '' escape)
		const ch = stream.peek();
		if (ch === "'") {
			stream.next(); // consume opening quote
			// Inline scan: handle '' escape, stop at unescaped ' or EOL
			while (!stream.eol()) {
				const c = stream.next();
				if (c === "'") {
					if (stream.peek() === "'") {
						stream.next(); // consume doubled quote, stay in string
					} else {
						// Closing quote
						return 'string';
					}
				}
			}
			// EOL hit before closing quote — enter multi-line continuation state
			state.inString = "'";
			return 'string';
		}

		// Double-quoted identifiers ("ident" with "" escape)
		if (ch === '"') {
			stream.next();
			while (!stream.eol()) {
				const c = stream.next();
				if (c === '"') {
					if (stream.peek() === '"') {
						stream.next();
					} else {
						return 'string';
					}
				}
			}
			state.inString = '"';
			return 'string';
		}

		// Numbers
		if (stream.match(/^\d+(\.\d+)?/)) {
			return 'number';
		}

		// Named params (:paramName)
		if (stream.match(/^:[a-zA-Z_]\w*/)) {
			return 'variableName';
		}

		// Operators (multi-char before single-char — longest match first)
		if (stream.match(/^(->>|->|@>|<@|<=|>=|<>|!=|[<>=!@?])/)) {
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
		// NQL line comment delimiter is '#' (see packages/nql/src/lexer/tokens.ts:13-17)
		commentTokens: { line: '#' },
	},
});

/** CodeMirror 6 language extension for NQL syntax highlighting. */
export function nql() {
	return nqlLanguage;
}
