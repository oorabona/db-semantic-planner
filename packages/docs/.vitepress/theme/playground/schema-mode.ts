/**
 * Schema DSL syntax highlighting for CodeMirror 6.
 *
 * Companion to nql-mode.ts but for the database schema DSL used in the
 * Playground (DEFAULT_SCHEMA_DSL constant in PlaygroundView.vue, tokenizer
 * + recursive-descent parser in playground/schema-dsl.ts).
 *
 * DSL grammar (derived from schema-dsl.ts's tokenize()/Parser — whitespace
 * and newlines are insignificant, layout is free-form):
 *
 *   table <name> {
 *     <col>: <type>[?] [pk] [unique] [default(<val>)]
 *     <col>: [<type>[?]] -> <target>['.' <column>][?] <fkModifier>*
 *   }
 *
 *   <fkModifier> := cascade | onDelete:<action> | onUpdate:<action> | unique | pk
 *   <onDelete action> := cascade | restrict | setnull | setdefault | noaction
 *   <onUpdate action> := cascade | restrict | setnull | noaction  (no setdefault)
 *
 * `default(<val>)`: a value that is exactly one literal token (a number, a
 * quoted string, or true/false/null) becomes that real JS type. Anything
 * else — a bare SQL keyword (`CURRENT_TIMESTAMP`) or a call expression
 * (`NOW()`, `timezone('UTC', now())`) — is a SQL expression (`{ sql }`).
 *
 * Column types: the canonical @dbsp/core ColumnType union, a documented
 * alias table for common SQL synonyms, and serial/bigserial DSL sugar —
 * see schema-dsl.ts's CANONICAL_TYPES/TYPE_ALIASES/SERIAL_TYPES (this
 * file's SCHEMA_TYPES below must stay exactly canonical ∪ aliases ∪
 * serial/bigserial, so highlighting never implies a type the parser
 * would actually reject).
 *
 * Comment delimiter: `//` (see tokenize() in schema-dsl.ts — quote-aware,
 * so a `//` inside a quoted default value is never mistaken for a comment).
 */

import { StreamLanguage, type StringStream } from '@codemirror/language';

// ---------------------------------------------------------------------------
// Keyword sets — source of truth: playground/schema-dsl.ts's tokenizer/
// parser + PlaygroundView.vue's DEFAULT_SCHEMA_DSL constant.
//
// Structural keywords: token 'keyword' → VitePress brand-blue
//   table  (table block declaration)
//
// Column modifiers: token 'keyword' → VitePress brand-blue
//   pk        (primary key marker)
//   unique    (unique constraint)
//   default   (default value modifier, as in default(<val>))
//   nullable  KNOWN LIMITATION (deferred, not a bug to fix): highlighted
//             here as a keyword, but schema-dsl.ts's parser does NOT treat
//             'nullable' as a modifier at all — nullability is expressed
//             ONLY via the `?` suffix (`col: type?`, `-> target?`). Typing
//             the bare word `nullable` in the editor colors it like a
//             keyword but has zero parsing effect; it's silently absorbed
//             as an "unrecognized modifier" warning. Kept for now since
//             removing the highlight is cosmetic-only and low value versus
//             the risk of user confusion either way.
//
// FK action modifiers: token 'keyword' → VitePress brand-blue
//   ondelete / onupdate      (the onDelete:/onUpdate: prefix, lowercased)
//   cascade / restrict / setnull / noaction   (action values valid for BOTH directions)
//
//   NOTE: 'setdefault' is intentionally NOT highlighted as a keyword — it's
//   onDelete-only (core's RefOptions.onUpdate has no SET DEFAULT) and this
//   stream tokenizer has no onDelete/onUpdate direction context to
//   conditionally highlight it. 'setnull' has no such asymmetry (valid for
//   BOTH onDelete and onUpdate — see schema-dsl.ts's ON_DELETE_ACTIONS /
//   ON_UPDATE_ACTIONS), so it's highlighted normally; only 'setdefault' is
//   left as plain text (variableName) to avoid implying it's valid
//   everywhere. Both still parse correctly regardless of coloring.
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
	'default',
	'nullable',
	// FK action modifiers (direction prefixes + actions valid for both directions)
	'ondelete',
	'onupdate',
	'cascade',
	'restrict',
	'setnull',
	'noaction',
]);

// Exactly canonical ∪ aliases ∪ serial/bigserial — see schema-dsl.ts's
// CANONICAL_TYPES / TYPE_ALIASES / SERIAL_TYPES. Do NOT add a type here
// that the parser doesn't actually accept (e.g. vector, bytea, binary,
// blob were removed — those are hard parse errors now, not silent TEXT).
const SCHEMA_TYPES = new Set([
	// Canonical @dbsp/core ColumnType union
	'string',
	'text',
	'number',
	'integer',
	'bigint',
	'decimal',
	'boolean',
	'date',
	'time',
	'datetime',
	'timestamp',
	'json',
	'jsonb',
	'uuid',
	'daterange',
	'tsrange',
	'tstzrange',
	'int4range',
	'int8range',
	'numrange',
	// Aliases → canonical (int/smallint→integer, varchar/char→string,
	// numeric→decimal, float/real/double→number, bool→boolean,
	// timestamptz→timestamp)
	'int',
	'smallint',
	'varchar',
	'char',
	'numeric',
	'float',
	'real',
	'double',
	'bool',
	'timestamptz',
	// serial/bigserial DSL sugar → integer/bigint + autoIncrement
	'serial',
	'bigserial',
]);

interface SchemaState {
	inString: string | null;
}

const schemaLanguage = StreamLanguage.define<SchemaState>({
	startState(): SchemaState {
		return { inString: null };
	},

	token(stream: StringStream, state: SchemaState): string | null {
		// Continue multi-line string — DSL default values can be quoted.
		// Quote-aware to match the parser's tokenizer: a DOUBLED quote of
		// the same kind (`''`/`""`) is an escaped literal quote, not the
		// closing delimiter.
		if (state.inString !== null) {
			const quoteChar = state.inString;
			while (!stream.eol()) {
				const ch = stream.next();
				if (ch === quoteChar) {
					if (stream.peek() === quoteChar) {
						stream.next(); // consume the second quote of the '' / "" escape
						continue;
					}
					state.inString = null;
					break;
				}
			}
			return 'string';
		}

		// Skip whitespace
		if (stream.eatSpace()) return null;

		// Line comments — schema DSL uses '//' (see stripLineComments() in schema-dsl.ts)
		if (stream.match('//')) {
			stream.skipToEnd();
			return 'comment';
		}

		// String literals (single-quoted, used in default values). Quote-aware
		// doubled-quote escape, matching the parser's tokenizer — see above.
		const ch = stream.peek();
		if (ch === "'") {
			stream.next(); // consume opening quote
			while (!stream.eol()) {
				const c = stream.next();
				if (c === "'") {
					if (stream.peek() === "'") {
						stream.next();
						continue;
					}
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
					if (stream.peek() === '"') {
						stream.next();
						continue;
					}
					return 'string';
				}
			}
			state.inString = '"';
			return 'string';
		}

		// Numbers (used in default values, e.g. default(0), default(-3.5))
		if (stream.match(/^-?\d+(\.\d+)?/)) {
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
		// Schema DSL line comment delimiter is '//' (see stripLineComments() in schema-dsl.ts)
		commentTokens: { line: '//' },
	},
});

/** CodeMirror 6 language extension for the Playground schema DSL. */
export function schemaDsl() {
	return schemaLanguage;
}
