/**
 * Schema DSL syntax highlighting for CodeMirror 6.
 *
 * Companion to nql-mode.ts but for the database schema DSL used in
 * Playground.vue (DEFAULT_SCHEMA_DSL constant and parseSchemaDsl()).
 *
 * DSL grammar (derived from parseSchemaDsl() in Playground.vue):
 *
 *   table <name> {
 *     <col>: <type>[?] [pk] [unique] [cascade] [default(<val>)]
 *     <col>: -> <target>[?] [cascade] [unique]
 *   }
 *
 * Comment delimiter: `//` (see stripLineComments() in Playground.vue, line 235).
 */

import { StreamLanguage, type StringStream } from '@codemirror/language';

// ---------------------------------------------------------------------------
// Keyword sets — source of truth: Playground.vue parseSchemaDsl() +
// DEFAULT_SCHEMA_DSL constant.
//
// Structural keywords: token 'keyword' → VitePress brand-blue
//   table  (table block declaration)
//
// Column modifiers: token 'keyword' → VitePress brand-blue
//   pk        (primary key marker)
//   unique    (unique constraint)
//   cascade   (onDelete CASCADE for FK columns)
//   default   (default value modifier, as in default(<val>))
//   nullable  (explicit nullable — not used by parser but valid DSL intent)
//
// Built-in column types: token 'typeName' → VitePress tip-blue
//   (different color from keywords to visually separate structure from data types)
// ---------------------------------------------------------------------------

const SCHEMA_KEYWORDS = new Set([
	// Structural
	'table',
	// Column modifiers
	'pk',
	'unique',
	'cascade',
	'default',
	'nullable',
]);

const SCHEMA_TYPES = new Set([
	// String types
	'string',
	'text',
	'varchar',
	'char',
	// Integer / numeric types
	'integer',
	'int',
	'bigint',
	'smallint',
	'float',
	'real',
	'double',
	'decimal',
	'numeric',
	// Boolean
	'boolean',
	'bool',
	// UUID
	'uuid',
	// Date / time
	'timestamp',
	'timestamptz',
	'date',
	'time',
	// JSON
	'json',
	'jsonb',
	// Binary
	'bytea',
	'binary',
	'blob',
	// Vector (pgvector)
	'vector',
]);

interface SchemaState {
	inString: string | null;
}

const schemaLanguage = StreamLanguage.define<SchemaState>({
	startState(): SchemaState {
		return { inString: null };
	},

	token(stream: StringStream, state: SchemaState): string | null {
		// Continue multi-line string — DSL default values can be quoted
		if (state.inString !== null) {
			const quoteChar = state.inString;
			while (!stream.eol()) {
				const ch = stream.next();
				if (ch === quoteChar) {
					// No doubled-quote escape in schema DSL — just close
					state.inString = null;
					break;
				}
			}
			return 'string';
		}

		// Skip whitespace
		if (stream.eatSpace()) return null;

		// Line comments — schema DSL uses '//' (see stripLineComments() in Playground.vue)
		if (stream.match('//')) {
			stream.skipToEnd();
			return 'comment';
		}

		// String literals (single-quoted, used in default values)
		const ch = stream.peek();
		if (ch === "'") {
			stream.next(); // consume opening quote
			while (!stream.eol()) {
				const c = stream.next();
				if (c === "'") {
					return 'string';
				}
			}
			// EOL hit before closing quote — multi-line
			state.inString = "'";
			return 'string';
		}

		// Double-quoted strings
		if (ch === '"') {
			stream.next();
			while (!stream.eol()) {
				const c = stream.next();
				if (c === '"') {
					return 'string';
				}
			}
			state.inString = '"';
			return 'string';
		}

		// Numbers (used in default values, e.g. default(0))
		if (stream.match(/^\d+(\.\d+)?/)) {
			return 'number';
		}

		// Arrow operator: -> (FK reference syntax)
		if (stream.match('->')) {
			return 'operator';
		}

		// Identifiers, keywords, types
		if (stream.match(/^[a-zA-Z_]\w*/)) {
			const word = stream.current().toLowerCase();
			if (SCHEMA_KEYWORDS.has(word)) return 'keyword';
			if (SCHEMA_TYPES.has(word)) return 'typeName';
			return 'variableName';
		}

		// Punctuation — braces, colon, comma, question mark (nullable suffix)
		stream.next();
		return 'punctuation';
	},

	languageData: {
		// Schema DSL line comment delimiter is '//' (see stripLineComments() in Playground.vue)
		commentTokens: { line: '//' },
	},
});

/** CodeMirror 6 language extension for the Playground schema DSL. */
export function schemaDsl() {
	return schemaLanguage;
}
