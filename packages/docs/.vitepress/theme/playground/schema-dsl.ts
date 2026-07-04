/**
 * Schema DSL parser + generators for the docs Playground.
 *
 * Architecture: a quote-aware character tokenizer (tokenize()) feeds a
 * small recursive-descent parser (the Parser class). Quote-awareness lives
 * ENTIRELY in the tokenizer: while scanning a string literal, `->`, `}`,
 * `unique`, `//`, whitespace, etc. are consumed as literal string content
 * and never re-examined as syntax. That single property makes the parser
 * correct-by-construction against the whole "quoted default leaks DSL
 * syntax" class of bugs that kept resurfacing in the old regex/`split`
 * implementation (see https://github.com/oorabona/db-semantic-planner/issues/116).
 *
 * Grammar (whitespace/newlines are insignificant — layout is free-form;
 * `table` blocks may appear anywhere, in any order, forward references
 * included):
 *
 *   table <name> {
 *     <col>: <type>['?'] [pk] [unique] [default(<value>)]
 *     <col>: [<type>['?']] -> <target>['.' <column>]['?'] <fkModifier>*
 *   }
 *
 *   <fkModifier> := cascade | onDelete:<action> | onUpdate:<action> | unique | pk
 *   <onDelete action> := cascade | restrict | setnull | setdefault | noaction
 *   <onUpdate action> := cascade | restrict | setnull | noaction
 *     (no setdefault — @dbsp/core's RefOptions.onUpdate doesn't support it)
 *
 * default(<value>) typing: a value that tokenizes to EXACTLY one literal
 * token (a number, a quoted string, or the bare word true/false/null,
 * case-insensitive) becomes that real JS type — `default('hello')` is the
 * STRING `hello` (the DSL's quotes are its own quoting syntax, stripped
 * before storage), NOT the string `'hello'` with quotes baked in. Anything
 * else — a bare SQL keyword (`CURRENT_TIMESTAMP`), or a call expression
 * (`NOW()`, `timezone('UTC', now())`, nested parens included) — is a SQL
 * expression, compiled to `{ sql: '<verbatim source text>' }`.
 *
 * Column types: the canonical `@dbsp/core` `ColumnType` union is
 * authoritative. A small documented alias table covers common SQL
 * synonyms (`int`/`smallint` → `integer`, `varchar`/`char` → `string`,
 * `numeric` → `decimal`, `float`/`real`/`double` → `number`, `bool` →
 * `boolean`, `timestamptz` → `timestamp`), plus `serial`/`bigserial` DSL
 * sugar (→ `integer`/`bigint` + `autoIncrement`). Anything else is a hard
 * parse error (`SchemaDslError`) — core does NOT validate types at
 * runtime, an invalid type silently becomes `TEXT` in DDL, so this parser
 * is the only validation boundary.
 *
 * FK columns: the built schema uses the real `ref(target[, { references }])`
 * — the FK column's type is never hardcoded to `uuid`. The DISPLAY
 * (Mermaid) type resolves the same way: the target's explicit `pk` column
 * declared type, else a column named `id`'s declared type, else the
 * `uuid` placeholder only when unresolvable — serial/bigserial targets
 * display as integer/bigint, matching the built schema. `-> target.col`
 * references a non-id column explicitly and resolves the type from THAT
 * column. `pk`/`default` on a ref column have no home in `RefOptions` —
 * they surface a parse WARNING (`ParsedSchema.warnings`) instead of being
 * silently dropped or faked as applied.
 *
 * Generated TypeScript (generateTypeScript()) escapes every interpolated
 * value: identifiers as safe object keys (tsKey), strings via
 * JSON.stringify (tsString) — the output is always valid, injection-safe
 * TypeScript regardless of what characters appear in identifiers or
 * default values.
 */

import type {
	ColumnDef,
	ColumnType,
	RefOptions,
	SchemaDefinition,
	TableDef,
} from '@dbsp/core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Thrown for a fatal parse failure (unknown column type, unterminated string literal). */
export class SchemaDslError extends Error {}

/** A non-fatal parse issue — collected, never silently dropped, never crashes the parse. */
export interface ParseWarning {
	message: string;
	table?: string;
	column?: string;
}

/**
 * Identifiers that would corrupt an object's prototype chain if assigned
 * via `obj[name] = ...` (`constructor`/`prototype`), or trigger the
 * object-literal `__proto__` special case (sets the prototype instead of
 * creating an own property — see tsKey() below) — never allowed as a
 * table name, column name, FK target table name, or FK reference column
 * name.
 */
const FORBIDDEN_IDENTIFIERS = new Set([
	'__proto__',
	'constructor',
	'prototype',
]);

/** Throws `SchemaDslError` if `name` is a prototype-pollution-prone identifier. */
function assertSafeIdentifier(
	name: string,
	kind: string,
	tableName: string | undefined,
): void {
	if (FORBIDDEN_IDENTIFIERS.has(name)) {
		const where = tableName ? ` on table '${tableName}'` : '';
		throw new SchemaDslError(
			`'${name}' is not allowed as a ${kind}${where} — reserved to prevent prototype pollution ` +
				`(forbidden: ${[...FORBIDDEN_IDENTIFIERS].join(', ')}).`,
		);
	}
}

/** `RefOptions.onDelete` narrowed to a required (non-optional) union. */
export type OnDeleteFkAction = NonNullable<RefOptions['onDelete']>;
/** `RefOptions.onUpdate` narrowed to a required (non-optional) union — excludes `SET DEFAULT` (core doesn't support it for onUpdate). */
export type OnUpdateFkAction = NonNullable<RefOptions['onUpdate']>;

/** A parsed `default(...)` value, already resolved to its real kind. */
export type ParsedDefault =
	| { kind: 'literal'; value: string | number | boolean | null }
	| { kind: 'sql'; value: string };

export interface ParsedColumn {
	name: string;
	/** Canonical @dbsp/core type for a value column; resolved display type for a ref column (never a raw DSL alias). */
	type: string;
	nullable?: boolean;
	pk?: boolean;
	unique?: boolean;
	autoIncrement?: boolean;
	default?: ParsedDefault;
	/** Target table name — set only for ref (FK) columns. */
	ref?: string;
	/** Explicit non-id referenced column, from `-> target.col`. */
	refColumn?: string;
	refNullable?: boolean;
	refUnique?: boolean;
	onDelete?: OnDeleteFkAction;
	onUpdate?: OnUpdateFkAction;
}

export interface ParsedTable {
	name: string;
	columns: ParsedColumn[];
}

export interface ParsedRelation {
	from: string;
	fromCol: string;
	to: string;
}

export interface ParsedSchema {
	tables: ParsedTable[];
	relations: ParsedRelation[];
	warnings: ParseWarning[];
}

// ---------------------------------------------------------------------------
// Column type validation + alias normalization (requirement #8)
// ---------------------------------------------------------------------------

/** The canonical `@dbsp/core` `ColumnType` union — the only types core actually understands. */
const CANONICAL_TYPES = new Set<ColumnType>([
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
]);

/**
 * Documented alias table for common SQL type synonyms → canonical type.
 * A `Map` (not a plain object) — plain-object bracket lookup on a
 * `__proto__` key silently returns `Object.prototype` (truthy!) instead of
 * `undefined`, which would let a type named `__proto__`/`constructor`
 * bypass the "unknown type" error below. `Map.get` has no such prototype-
 * chain ambiguity.
 */
const TYPE_ALIASES = new Map<string, ColumnType>([
	['int', 'integer'],
	['smallint', 'integer'],
	['varchar', 'string'],
	['char', 'string'],
	['numeric', 'decimal'],
	['float', 'number'],
	['real', 'number'],
	['double', 'number'],
	['bool', 'boolean'],
	['timestamptz', 'timestamp'],
]);

/** `serial`/`bigserial` DSL sugar → real column type + autoIncrement. `Map`, see TYPE_ALIASES. */
const SERIAL_TYPES = new Map<string, Extract<ColumnType, 'integer' | 'bigint'>>(
	[
		['serial', 'integer'],
		['bigserial', 'bigint'],
	],
);

/**
 * Resolves a raw DSL type token to a canonical `@dbsp/core` type (case
 * insensitive), applying the alias table and serial/bigserial sugar.
 * Throws `SchemaDslError` for anything that isn't canonical, an alias, or
 * serial/bigserial — core doesn't validate types at runtime (an invalid
 * type silently becomes TEXT in DDL), so this is the only place that does.
 */
function resolveColumnType(
	rawType: string,
	tableName: string,
	colName: string,
): { type: ColumnType; autoIncrement: boolean } {
	const lower = rawType.toLowerCase();
	const serial = SERIAL_TYPES.get(lower);
	if (serial) return { type: serial, autoIncrement: true };
	if (CANONICAL_TYPES.has(lower as ColumnType)) {
		return { type: lower as ColumnType, autoIncrement: false };
	}
	const alias = TYPE_ALIASES.get(lower);
	if (alias) return { type: alias, autoIncrement: false };
	throw new SchemaDslError(
		`Unknown type '${rawType}' on ${tableName}.${colName}. Supported: ${[...CANONICAL_TYPES].join(', ')} ` +
			`(aliases: ${[...TYPE_ALIASES.keys()].join(', ')}; also serial, bigserial).`,
	);
}

// ---------------------------------------------------------------------------
// FK action keyword maps (requirements #6, #7) — per-direction, typed
// against core's own RefOptions so a stray entry is a compile error.
// `Map`, see TYPE_ALIASES above for why (not a plain-object Record).
// ---------------------------------------------------------------------------

const ON_DELETE_ACTIONS = new Map<string, OnDeleteFkAction>([
	['cascade', 'CASCADE'],
	['restrict', 'RESTRICT'],
	['setnull', 'SET NULL'],
	['setdefault', 'SET DEFAULT'],
	['noaction', 'NO ACTION'],
]);

const ON_UPDATE_ACTIONS = new Map<string, OnUpdateFkAction>([
	['cascade', 'CASCADE'],
	['restrict', 'RESTRICT'],
	['setnull', 'SET NULL'],
	['noaction', 'NO ACTION'],
]);

/**
 * The union of every keyword either map recognizes as an FK action — used
 * to decide "does this ident LOOK LIKE an intended onDelete/onUpdate action"
 * independent of which of the two directions is semantically valid for it
 * (e.g. `setdefault` is onDelete-only, but must still be recognized as an
 * action ATTEMPT when written after a malformed `onUpdate`, not mistaken
 * for an ordinary column name).
 */
const FK_ACTION_KEYWORDS = new Set<string>([
	...ON_DELETE_ACTIONS.keys(),
	...ON_UPDATE_ACTIONS.keys(),
]);

// ---------------------------------------------------------------------------
// Tokenizer — quote-aware character scanner
// ---------------------------------------------------------------------------

type TokenKind =
	| 'ident'
	| 'number'
	| 'string'
	| ':'
	| '{'
	| '}'
	| '('
	| ')'
	| '.'
	| '?'
	| '->'
	| 'eof';

interface Token {
	kind: TokenKind;
	/**
	 * For 'ident'/'number': the raw matched text. For 'string': the
	 * UNESCAPED content (quotes stripped, doubled quote-of-the-same-kind
	 * resolved to one literal quote character). For structural tokens:
	 * the token's own text.
	 */
	value: string;
	/** Source char offset of the token's first character. */
	start: number;
	/** Source char offset one past the token's last character. */
	end: number;
}

const STRUCTURAL_CHARS = new Set([':', '{', '}', '(', ')', '.', '?']);

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}
function isDigit(ch: string): boolean {
	return ch >= '0' && ch <= '9';
}

/**
 * Produces ONE token per `next()` call from the current character cursor,
 * advancing it — a LAZY tokenizer, not an eager whole-source pass. This
 * matters for `default(...)` spans: `parseDefaultClause`/`skipParenSpan`
 * bypass the lexer entirely for their content (see scanBalancedParenSpan
 * below) and reposition its cursor past the matched close, so arbitrary
 * SQL-expression punctuation ($1, $$...$$ dollar-quoting, commas, etc.)
 * never reaches the lexer's own character rules at all — it's never
 * "tokenized and possibly mangled," just raw-captured.
 *
 * QUOTE-AWARE: string-literal scanning consumes everything up to the
 * matching closing quote as content, so `->`, `}`, `unique`, `//`, and
 * whitespace inside a quoted value are never mistaken for syntax.
 *
 * Throws `SchemaDslError` for an unterminated string literal OR any
 * character that isn't part of a recognized token (outside whitespace/
 * comments/strings) — e.g. a stray `-` in `author-id` (not part of `->`
 * or a negative number), or a `$` outside a default(...) span. This
 * closes the whole "silently skip and corrupt" class the same way
 * quote-awareness closed the quote class: previously such characters were
 * dropped silently, splitting `author-id` into two idents (`author`,
 * `id`) or truncating `users-archive` to `users`.
 */
class Lexer {
	private readonly src: string;
	pos = 0;

	constructor(src: string) {
		this.src = src;
	}

	next(): Token {
		const src = this.src;
		const n = src.length;
		let i = this.pos;

		while (i < n) {
			const ch = src[i];

			if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
				i++;
				continue;
			}

			// Line comment — only recognized HERE, i.e. never inside a string;
			// string scanning below consumes '//' as literal content instead.
			if (ch === '/' && src[i + 1] === '/') {
				while (i < n && src[i] !== '\n') i++;
				continue;
			}

			// String literal — quote-aware. A doubled quote of the SAME kind
			// (`''` inside a single-quoted string, `""` inside a double-quoted
			// one) is an escaped literal quote character, not the closing quote.
			if (ch === "'" || ch === '"') {
				const quote = ch;
				const start = i;
				i++;
				let value = '';
				let closed = false;
				while (i < n) {
					const c = src[i];
					if (c === quote) {
						if (src[i + 1] === quote) {
							value += quote;
							i += 2;
							continue;
						}
						i++;
						closed = true;
						break;
					}
					value += c;
					i++;
				}
				if (!closed) {
					this.pos = i;
					throw new SchemaDslError(
						`Unterminated string literal starting at position ${start}`,
					);
				}
				this.pos = i;
				return { kind: 'string', value, start, end: i };
			}

			// Arrow operator
			if (ch === '-' && src[i + 1] === '>') {
				this.pos = i + 2;
				return { kind: '->', value: '->', start: i, end: i + 2 };
			}

			// Number — optional leading '-', optional decimal part
			if (isDigit(ch) || (ch === '-' && isDigit(src[i + 1] ?? ''))) {
				const start = i;
				if (ch === '-') i++;
				while (i < n && isDigit(src[i])) i++;
				if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
					i++;
					while (i < n && isDigit(src[i])) i++;
				}
				this.pos = i;
				return { kind: 'number', value: src.slice(start, i), start, end: i };
			}

			// Single-char structural tokens
			if (STRUCTURAL_CHARS.has(ch)) {
				this.pos = i + 1;
				return { kind: ch as TokenKind, value: ch, start: i, end: i + 1 };
			}

			// Identifier
			if (isIdentStart(ch)) {
				const start = i;
				i++;
				while (i < n && isIdentPart(src[i])) i++;
				this.pos = i;
				return { kind: 'ident', value: src.slice(start, i), start, end: i };
			}

			// Unrecognized character outside a default(...) span (which never
			// reaches here — see scanBalancedParenSpan) — hard error, not a
			// silent skip.
			throw new SchemaDslError(
				`Unrecognized character '${ch}' at position ${i}`,
			);
		}

		this.pos = n;
		return { kind: 'eof', value: '', start: n, end: n };
	}
}

/**
 * Scans a balanced `( ... )` span directly from the RAW SOURCE, starting
 * right after the opening `(` (already consumed by the caller). This is
 * NOT token-based — it never asks the Lexer to make sense of the content,
 * so arbitrary SQL-expression punctuation ($1 positional params, `$$...$$`
 * dollar-quoted bodies, commas, operators, anything) passes through
 * UNINTERPRETED instead of being tokenized (and silently mangled — e.g.
 * `default($1)` losing the `$` and becoming the literal number `1`) by
 * the general lexer, which only understands the schema DSL's own small
 * grammar. Quote-aware (single/double, with doubled-quote escaping) and
 * dollar-quote-aware (bare `$$...$$`) so quotes/parens INSIDE either
 * never affect paren depth or get mistaken for the span's own boundary.
 *
 * Bounded on an unescaped `}` or EOF — an unbalanced span must not run
 * past the enclosing table and swallow the rest of the file (the
 * `default(NOW() } table u { ... }` runaway-consumption class).
 *
 * Returns the raw text between the parens and the char offset right after
 * the matching `)` on success; on an unbalanced span, returns `raw: null`
 * plus the offset where the scan gave up (`}`/EOF) so the caller can
 * reposition the lexer there WITHOUT re-tokenizing the abandoned span.
 *
 * KNOWN LIMITATIONS (deferred — this is a docs-playground teaching subset,
 * not a full PostgreSQL parser): only BARE `$$...$$` dollar-quoting is
 * supported, not PostgreSQL's TAGGED form (`$tag$...$tag$`, e.g.
 * `$func$...$func$`) — a tagged delimiter is treated as plain characters,
 * so its embedded parens/quotes still affect paren-depth tracking like
 * ordinary text. C-style block comments inside a default value are NOT
 * recognized as comments either (only line comments starting with two
 * slashes are, and only outside default(...) spans — see the Lexer). And a
 * span that hits `}` always aborts as unbalanced — there's no way for this
 * scanner to distinguish a stray, unquoted `}` genuinely meant as SQL
 * content from "the enclosing table ends here". None of these are
 * expected to matter for realistic playground schemas.
 */
/**
 * The safe resume point once a quote or `$$...$$` dollar-quoted span inside
 * a `default(...)` is discovered to never close before EOF: the nearest
 * unquoted `}` at or after `startPos`, or true EOF (`n`) if the source has
 * none at all. Reusing the SAME recovery point as the plain "hit an unquoted
 * `}`" case keeps both malformed-span classes bounded identically instead
 * of the unterminated-quote case alone silently consuming every table after
 * it as "still inside the string".
 */
function nearestBraceOrEnd(src: string, startPos: number, n: number): number {
	const idx = src.indexOf('}', startPos);
	return idx === -1 ? n : idx;
}

function scanBalancedParenSpan(
	src: string,
	startPos: number,
): { raw: string; endPos: number } | { raw: null; stoppedAt: number } {
	const n = src.length;
	let i = startPos;
	let depth = 1;

	while (i < n) {
		const ch = src[i];

		if (ch === '}') return { raw: null, stoppedAt: i };

		if (ch === "'" || ch === '"') {
			const quote = ch;
			i++;
			let closed = false;
			while (i < n) {
				if (src[i] === quote) {
					if (src[i + 1] === quote) {
						i += 2;
						continue;
					}
					i++;
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) {
				// The quote never closes before EOF — deliberately do NOT
				// report `stoppedAt: n` (true end of file): while we were
				// scanning what we thought was quoted content, `}` was
				// legitimately ignored, but once the quote itself turns out
				// to be unterminated, that assumption no longer holds and
				// letting `stoppedAt` land at true EOF would silently
				// swallow every subsequent table as "part of the string".
				// Recover exactly like the already-handled "hits an unquoted
				// '}'" case above: resume at the nearest '}' from the START
				// of this span (or true EOF if none exists at all).
				return { raw: null, stoppedAt: nearestBraceOrEnd(src, startPos, n) };
			}
			continue;
		}

		if (ch === '$' && src[i + 1] === '$') {
			// Bare dollar-quoted span: $$ ... $$ — scan verbatim to the closing $$.
			const closeIdx = src.indexOf('$$', i + 2);
			if (closeIdx === -1) {
				return { raw: null, stoppedAt: nearestBraceOrEnd(src, startPos, n) };
			}
			i = closeIdx + 2;
			continue;
		}

		if (ch === '(') {
			depth++;
			i++;
			continue;
		}
		if (ch === ')') {
			depth--;
			i++;
			if (depth === 0) {
				return { raw: src.slice(startPos, i - 1), endPos: i };
			}
			continue;
		}

		i++;
	}

	return { raw: null, stoppedAt: n };
}

/**
 * Matches `s` (already trimmed) as a WHOLE single- or double-quoted string
 * literal — the closing quote must be the true final character, not just
 * the first unescaped occurrence (so `'a' + 'b'` correctly does NOT match:
 * it's a SQL expression, not one string literal). Doubled-quote escaping
 * matches the lexer's string rule. Returns the unescaped content, or
 * `null` if `s` isn't a single, whole, cleanly-quoted string.
 */
function matchWholeQuotedString(s: string): string | null {
	if (s.length < 2) return null;
	const quote = s[0];
	if (quote !== "'" && quote !== '"') return null;
	if (s[s.length - 1] !== quote) return null;
	let value = '';
	let i = 1;
	while (i < s.length - 1) {
		const c = s[i];
		if (c === quote) {
			if (s[i + 1] === quote) {
				value += quote;
				i += 2;
				continue;
			}
			// An unescaped quote before the assumed final character — this
			// isn't one clean string literal (e.g. `'a' + 'b'`).
			return null;
		}
		value += c;
		i++;
	}
	return value;
}

/**
 * Classifies a `default(...)` span's raw (already trimmed) text: exactly
 * one literal — a number, a whole quoted string (quotes stripped), or the
 * bare word true/false/null (case-insensitive) — becomes that real JS
 * type. Anything else (a bare SQL keyword, a call expression, dollar-
 * quoted SQL, nested parens/commas, `$1` positional params, ...) is a SQL
 * expression, preserved VERBATIM.
 */
function classifyDefaultSpan(trimmed: string): ParsedDefault {
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return { kind: 'literal', value: Number(trimmed) };
	}
	const str = matchWholeQuotedString(trimmed);
	if (str !== null) return { kind: 'literal', value: str };
	const lower = trimmed.toLowerCase();
	if (lower === 'true') return { kind: 'literal', value: true };
	if (lower === 'false') return { kind: 'literal', value: false };
	if (lower === 'null') return { kind: 'literal', value: null };
	return { kind: 'sql', value: trimmed };
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

class Parser {
	private readonly src: string;
	private readonly lexer: Lexer;
	/** Small lookahead buffer of already-produced-but-not-yet-consumed tokens (the Lexer is pulled lazily, one token at a time, via pull()). */
	private readonly queue: Token[] = [];
	/** Cached eof token — once produced, returned again forever rather than re-invoking the Lexer (which would just re-return it, but this makes the "sticky eof" contract explicit). */
	private eofToken: Token | null = null;
	readonly warnings: ParseWarning[] = [];

	constructor(src: string) {
		this.src = src;
		this.lexer = new Lexer(src);
	}

	private pull(): Token {
		if (this.eofToken) return this.eofToken;
		const t = this.lexer.next();
		if (t.kind === 'eof') this.eofToken = t;
		return t;
	}
	private ensure(count: number): void {
		while (this.queue.length <= count) this.queue.push(this.pull());
	}
	private peek(offset = 0): Token {
		this.ensure(offset);
		// biome-ignore lint/style/noNonNullAssertion: ensure(offset) guarantees index `offset` exists
		return this.queue[offset]!;
	}
	private next(): Token {
		this.ensure(0);
		// biome-ignore lint/style/noNonNullAssertion: ensure(0) guarantees at least one element
		const t = this.queue.shift()!;
		// eof is "sticky" — never actually consumed, so callers past the end
		// of input keep seeing it instead of running off the buffer.
		if (t.kind === 'eof') this.queue.unshift(t);
		return t;
	}
	private check(kind: TokenKind): boolean {
		return this.peek().kind === kind;
	}
	private match(kind: TokenKind): Token | null {
		return this.check(kind) ? this.next() : null;
	}
	private warn(message: string, table?: string, column?: string): void {
		this.warnings.push({ message, table, column });
	}

	/**
	 * Discards any buffered lookahead and repositions the lexer's raw
	 * character cursor — used after a raw-captured `default(...)` span
	 * (scanBalancedParenSpan) to resume normal tokenization from right
	 * after the matched (or abandoned, on an unbalanced span) boundary,
	 * without ever asking the lexer to re-tokenize the bypassed content.
	 */
	private syncLexerTo(pos: number): void {
		this.queue.length = 0;
		this.eofToken = null;
		this.lexer.pos = pos;
	}

	/**
	 * `true` when the upcoming tokens start a NEW column declaration
	 * (`ident ':'`) rather than continuing the current one's modifiers.
	 * `ident ':'` is unambiguous EXCEPT inside a ref column's FK-modifier
	 * scan, where `onDelete:`/`onUpdate:` use the exact same shape —
	 * `inFkModifiers` excludes those two specific idents there so a fresh
	 * column can still start on the very same source line (e.g.
	 * `table t { id: uuid pk name: string }`), no newline required.
	 *
	 * Also `true` on the `table` keyword itself, regardless of `inFkModifiers`
	 * — 'table' is never a legitimate modifier/type-hint/action token in
	 * EITHER modifier-scanning loop (parseValueColumn's or parseRefColumn's),
	 * so this stops BOTH loops the same way `parseTable`'s own body loop
	 * stops, when a table body is missing its closing '}' and the next
	 * `table` declaration follows directly: without this, the modifier scan
	 * (bounded only by '}'/eof otherwise) keeps running and swallows
	 * `table <name> {` as a string of "unrecognized modifier" warnings
	 * instead of leaving it untouched for parseSchema()'s own loop.
	 */
	private isColumnStart(inFkModifiers: boolean): boolean {
		if (this.isTableKeyword()) return true;
		const tok = this.peek();
		if (tok.kind !== 'ident' || this.peek(1).kind !== ':') return false;
		if (inFkModifiers) {
			const lower = tok.value.toLowerCase();
			if (lower === 'ondelete' || lower === 'onupdate') {
				// `onDelete:`/`onUpdate:` is only an FK MODIFIER when it's
				// actually followed by a recognized action keyword — a real
				// column literally NAMED onDelete/onUpdate (`onDelete: string`)
				// must NOT be swallowed as a malformed FK action just because
				// its name collides. When the token after ':' isn't a known
				// action keyword, still treat it as part of the (malformed)
				// modifier — not a new column — if THAT token is itself
				// followed by ':' (it's unambiguously the start of a
				// DIFFERENT, later column, e.g. `onDelete: title: string`),
				// leaving the existing "missing an action name" recovery
				// in the modifier loop body to handle it exactly as before.
				const actionTok = this.peek(2);
				const actionKeyword =
					actionTok.kind === 'ident' ? actionTok.value.toLowerCase() : '';
				if (FK_ACTION_KEYWORDS.has(actionKeyword)) return false;
				if (this.peek(3).kind === ':') return false;
				return true;
			}
		}
		return true;
	}

	parseSchema(): ParsedSchema {
		const tables: ParsedTable[] = [];
		const seenTables = new Set<string>();

		while (!this.check('eof')) {
			if (this.isTableKeyword()) {
				this.next();
				const table = this.parseTable();
				if (!table) continue;
				if (seenTables.has(table.name)) {
					// Keep the first occurrence — a plain `tableDefs[name] = ...`
					// build step would otherwise silently let the LATER
					// duplicate overwrite the first with no signal at all.
					this.warn(
						`duplicate table '${table.name}' — keeping the first occurrence`,
						table.name,
					);
					continue;
				}
				seenTables.add(table.name);
				tables.push(table);
			} else {
				this.next();
			}
		}

		// Relations are DERIVED from the final, deduplicated `tables` array —
		// not accumulated incrementally while parsing (a duplicate table/
		// column is only known to be a duplicate AFTER it's fully parsed, so
		// pushing relations during parsing would leak a phantom relation for
		// a column/table that ends up discarded — a stale FK on a KEPT,
		// non-FK column could then get silently mutated by
		// resolveRefColumnTypes, and Mermaid would render a relationship line
		// for a FK that doesn't actually exist in the final schema). Deriving
		// AFTER deduplication makes this impossible by construction: only
		// columns that survive into `tables` can ever produce a relation.
		const relations = deriveRelations(tables);
		resolveRefColumnTypes(tables, relations);
		return { tables, relations, warnings: this.warnings };
	}

	private parseTable(): ParsedTable | null {
		const nameTok = this.match('ident');
		if (!nameTok) {
			this.warn("'table' is missing a name");
			return null;
		}
		const tableName = nameTok.value;
		assertSafeIdentifier(tableName, 'table name', undefined);
		if (!this.match('{')) {
			this.warn(`table '${tableName}' is missing '{'`, tableName);
			return null;
		}

		const columns: ParsedColumn[] = [];
		const seenColumns = new Set<string>();
		while (!this.check('}') && !this.check('eof') && !this.isTableKeyword()) {
			const col = this.parseColumn(tableName);
			if (!col) continue;
			if (seenColumns.has(col.name)) {
				// Keep the first occurrence (e.g. the PK marker on the first
				// `id`) instead of a later duplicate silently overwriting it
				// when columns are built into a name-keyed map.
				this.warn(
					`duplicate column '${col.name}' on table '${tableName}' — keeping the first occurrence`,
					tableName,
					col.name,
				);
				continue;
			}
			seenColumns.add(col.name);
			columns.push(col);
		}
		if (!this.match('}')) {
			// EOF or a new 'table' keyword was reached before the closing
			// '}' — without this check, either one is silently accepted:
			// EOF just ends the loop with no signal at all, and a following
			// `table` keyword gets consumed here as a bogus attempted
			// column (its own name/body then vanish into THIS table's
			// columns instead of starting a fresh table). Warn and recover
			// WITHOUT consuming a 'table' token — parseSchema()'s own loop
			// must see it fresh to parse the next table independently.
			this.warn(
				`unterminated table '${tableName}' — missing closing '}'`,
				tableName,
			);
		}
		return { name: tableName, columns };
	}

	/** `true` when the current token is the (case-insensitive) `table` keyword — a new table declaration starting without the current one's closing '}'. */
	private isTableKeyword(): boolean {
		return this.check('ident') && this.peek().value.toLowerCase() === 'table';
	}

	private parseColumn(tableName: string): ParsedColumn | null {
		const nameTok = this.match('ident');
		if (!nameTok) {
			this.next(); // stray token — skip to guarantee forward progress
			return null;
		}
		const colName = nameTok.value;
		assertSafeIdentifier(colName, 'column name', tableName);
		if (!this.match(':')) {
			this.warn(`column '${colName}' has no ':' — skipped`, tableName, colName);
			return null;
		}

		let typeTok: Token | null = null;
		let typeNullable = false;
		if (!this.check('->')) {
			// Re-scan fix (same class as finding #2): an ident immediately
			// followed by ':' can never be a legitimate type hint — it's the
			// START of the NEXT column. Without this guard, `author_id:
			// title: string` (author_id missing its own type) would greedily
			// consume 'title' as author_id's "type", then either throw an
			// unrelated "Unknown type 'title'" error or (if 'title' happened
			// to be valid) silently drop the real title column entirely.
			if (this.canConsumeBareIdent()) {
				typeTok = this.next();
				if (this.match('?')) typeNullable = true;
			}
		}

		if (this.match('->')) {
			if (typeTok) {
				// Validate the pre-arrow type hint too, even though it's
				// immediately discarded/overridden by the resolved referenced-
				// column type in parseRefColumn below — a typo here (uuidd,
				// vector) must error the same way it would on a value column,
				// not silently pass through unchecked.
				resolveColumnType(typeTok.value, tableName, colName);
			}
			return this.parseRefColumn(tableName, colName, typeNullable);
		}

		if (!typeTok) {
			this.warn(`column '${colName}' has no type`, tableName, colName);
			return null;
		}

		return this.parseValueColumn(
			tableName,
			colName,
			typeTok.value,
			typeNullable,
		);
	}

	private parseValueColumn(
		tableName: string,
		colName: string,
		rawType: string,
		nullable: boolean,
	): ParsedColumn {
		const resolved = resolveColumnType(rawType, tableName, colName);
		const col: ParsedColumn = { name: colName, type: resolved.type };
		if (resolved.autoIncrement) col.autoIncrement = true;
		if (nullable) col.nullable = true;

		while (
			!this.check('}') &&
			!this.check('eof') &&
			!this.isColumnStart(false)
		) {
			const tok = this.peek();
			const lower = tok.kind === 'ident' ? tok.value.toLowerCase() : '';
			if (lower === 'pk') {
				this.next();
				col.pk = true;
				continue;
			}
			if (lower === 'unique') {
				this.next();
				col.unique = true;
				continue;
			}
			if (lower === 'default') {
				this.next();
				this.parseDefaultClause(col, tableName, colName);
				continue;
			}
			this.warn(
				`unrecognized modifier '${tok.value || tok.kind}' on column '${colName}'`,
				tableName,
				colName,
			);
			this.next();
		}
		return col;
	}

	/**
	 * `true` when the CURRENT token is an ident that is safe to consume as a
	 * BARE VALUE — a pre-arrow type hint, a FK target/reference-column
	 * name, or an onDelete:/onUpdate: action — i.e. it is NOT immediately
	 * followed by `:`. No production in this grammar ever has a bare value
	 * directly followed by `:` (type hints, targets, ref columns, and
	 * actions are never themselves colon-suffixed), so an ident-then-colon
	 * here can only be the START of the NEXT column (e.g. `author_id: ->`
	 * or `author_id: -> users onDelete:` immediately followed by
	 * `title: string` — the real `title` column must never be consumed as
	 * if it were this column's missing type/target/action).
	 */
	private canConsumeBareIdent(): boolean {
		return this.check('ident') && this.peek(1).kind !== ':';
	}

	private parseRefColumn(
		tableName: string,
		colName: string,
		typeNullable: boolean,
	): ParsedColumn | null {
		if (!this.canConsumeBareIdent()) {
			this.warn(
				`FK column '${colName}' is missing a target table name after '->' — column dropped`,
				tableName,
				colName,
			);
			return null;
		}
		const target = this.next().value;
		assertSafeIdentifier(target, 'FK target table name', tableName);

		let refColumn: string | undefined;
		if (this.match('.')) {
			if (!this.canConsumeBareIdent()) {
				this.warn(
					`FK column '${colName}' has a trailing '.' with no reference column name after '-> ${target}.' — column dropped`,
					tableName,
					colName,
				);
				return null;
			}
			refColumn = this.next().value;
			assertSafeIdentifier(refColumn, 'FK reference column name', tableName);
		}

		let targetNullable = false;
		if (this.match('?')) targetNullable = true;

		const col: ParsedColumn = {
			name: colName,
			type: 'uuid', // placeholder; resolved from the referenced column below
			ref: target,
		};
		if (refColumn) col.refColumn = refColumn;
		if (typeNullable || targetNullable) col.nullable = true;
		if (targetNullable) col.refNullable = true;

		while (
			!this.check('}') &&
			!this.check('eof') &&
			!this.isColumnStart(true)
		) {
			const tok = this.peek();
			const lower = tok.kind === 'ident' ? tok.value.toLowerCase() : '';

			if (lower === 'cascade') {
				this.next();
				col.onDelete = 'CASCADE';
				continue;
			}
			if (lower === 'unique') {
				this.next();
				col.refUnique = true;
				continue;
			}
			if (lower === 'pk') {
				this.next();
				this.warn(
					`'pk' is not supported on foreign-key column '${colName}' (RefOptions has no primaryKey field) — ignored`,
					tableName,
					colName,
				);
				continue;
			}
			if (lower === 'default') {
				this.next();
				this.warn(
					`'default' is not supported on foreign-key column '${colName}' (RefOptions has no default field) — ignored`,
					tableName,
					colName,
				);
				this.skipParenSpan(tableName, colName);
				continue;
			}
			if (lower === 'ondelete' || lower === 'onupdate') {
				this.next();
				if (this.match(':')) {
					// Same guard as canConsumeRefIdent: an ident immediately
					// followed by ':' is never a legitimate action name (no
					// production has "action:") — it's the START of the NEXT
					// column (e.g. `onDelete: title: string` must not consume
					// `title` as a bogus action, dropping the real column).
					if (!this.canConsumeBareIdent()) {
						this.warn(
							`'${tok.value}:' is missing an action name on column '${colName}'`,
							tableName,
							colName,
						);
						continue;
					}
					const actionTok = this.next();
					const actionKeyword = actionTok.value.toLowerCase();
					if (lower === 'ondelete') {
						const action = ON_DELETE_ACTIONS.get(actionKeyword);
						if (action) col.onDelete = action;
						else
							this.warn(
								`unknown onDelete action '${actionKeyword}' on column '${colName}'`,
								tableName,
								colName,
							);
					} else {
						const action = ON_UPDATE_ACTIONS.get(actionKeyword);
						if (action) col.onUpdate = action;
						else
							this.warn(
								`unsupported onUpdate action '${actionKeyword}' on column '${colName}' (core's RefOptions.onUpdate doesn't support it)`,
								tableName,
								colName,
							);
					}
				} else {
					this.warn(
						`'${tok.value}' missing ':<action>' on column '${colName}'`,
						tableName,
						colName,
					);
					// Consume the immediately-following action-like token (if
					// any) so a typo'd bare `onDelete cascade` / `onUpdate
					// cascade` (missing the colon) is NOT left dangling for
					// the legacy bare-`cascade` shorthand above to pick up on
					// the NEXT loop iteration — a typo must not silently flip
					// onDelete to CASCADE. Guarded the same way as the
					// `:`-action case: an ident immediately followed by ':' is
					// the START of the next column, never an action name here.
					if (
						this.check('ident') &&
						this.peek(1).kind !== ':' &&
						FK_ACTION_KEYWORDS.has(this.peek().value.toLowerCase())
					) {
						this.next();
					}
				}
				continue;
			}

			this.warn(
				`unrecognized FK modifier '${tok.value || tok.kind}' on column '${colName}'`,
				tableName,
				colName,
			);
			this.next();
		}

		// No relations.push here — relations are DERIVED from the final
		// `tables` array in parseSchema(), after this column is confirmed
		// kept (not a discarded duplicate). See deriveRelations().
		return col;
	}

	/**
	 * Consumes a balanced `( ... )` span WITHOUT interpreting it (used to
	 * keep the parser in sync after a warned-away `default(...)` on a ref
	 * column) via the raw-source scanner — never re-tokenizes the content,
	 * so arbitrary SQL punctuation inside it can't throw or desync.
	 */
	private skipParenSpan(tableName: string, colName: string): void {
		const openParen = this.match('(');
		if (!openParen) return;
		const scan = scanBalancedParenSpan(this.src, openParen.end);
		if (scan.raw === null) {
			this.warn(
				`'default(...)' on foreign-key column '${colName}' is missing its closing ')'`,
				tableName,
				colName,
			);
			this.syncLexerTo(scan.stoppedAt);
			return;
		}
		this.syncLexerTo(scan.endPos);
	}

	/**
	 * Parses `'(' <defaultValue> ')'` (the `default` keyword itself already
	 * consumed) and records a typed `ParsedDefault` on `col`. The content is
	 * RAW-CAPTURED via scanBalancedParenSpan (never re-tokenized) — this is
	 * what lets `$1`, `$$...$$` dollar-quoting, commas, and any other SQL
	 * punctuation round-trip verbatim into `{ sql }` instead of being
	 * silently mangled by the general lexer, which only understands the
	 * schema DSL's own small grammar.
	 */
	private parseDefaultClause(
		col: ParsedColumn,
		tableName: string,
		colName: string,
	): void {
		const openParen = this.match('(');
		if (!openParen) {
			this.warn(
				`'default' on column '${colName}' is missing '('`,
				tableName,
				colName,
			);
			return;
		}

		const scan = scanBalancedParenSpan(this.src, openParen.end);
		if (scan.raw === null) {
			// Unbalanced — do NOT consume '}'/eof and do NOT keep reading;
			// that would swallow the rest of the file's tables (the exact
			// "default(NOW() } table u { ... }" runaway-consumption bug).
			this.warn(
				`'default(...)' on column '${colName}' is missing its closing ')' — default ignored`,
				tableName,
				colName,
			);
			this.syncLexerTo(scan.stoppedAt);
			return;
		}
		this.syncLexerTo(scan.endPos);

		const trimmed = scan.raw.trim();
		if (trimmed.length === 0) return; // default() — nothing to record
		col.default = classifyDefaultSpan(trimmed);
	}
}

export function parseSchemaDsl(text: string): ParsedSchema {
	const parser = new Parser(text);
	return parser.parseSchema();
}

// ---------------------------------------------------------------------------
// FK display-type resolution (requirement #4)
// ---------------------------------------------------------------------------

/**
 * Derives `ParsedRelation`s from the FINAL `tables` array — i.e. AFTER
 * table/column deduplication has already happened (see parseSchema/
 * parseTable) — instead of accumulating them incrementally while parsing.
 * A relation only ever exists for a column that's actually present in
 * `tables`, so a discarded duplicate table/column can never leak a
 * phantom relation into the built schema or Mermaid: there is no
 * "relations from a rejected parse" state to accidentally keep.
 */
function deriveRelations(tables: readonly ParsedTable[]): ParsedRelation[] {
	const relations: ParsedRelation[] = [];
	for (const table of tables) {
		for (const col of table.columns) {
			if (col.ref) {
				relations.push({ from: table.name, fromCol: col.name, to: col.ref });
			}
		}
	}
	return relations;
}

/**
 * Finds the column a FK column's display/inferred type should be resolved
 * from — an explicit non-id reference (`-> target.col`) when given,
 * otherwise the target's explicit `pk` column, otherwise a column named
 * `id` (mirroring `@dbsp/core`'s implicit-PK convention). Returns
 * `undefined` when nothing resolves, in which case the caller keeps the
 * FK column's `uuid` placeholder — the real `schema()`/`ref()` call raises
 * the authoritative validation error for a genuinely missing target.
 */
function findReferencedColumn(
	table: ParsedTable | undefined,
	explicitColumn: string | undefined,
): ParsedColumn | undefined {
	if (!table) return undefined;
	if (explicitColumn) {
		return table.columns.find((c) => c.name === explicitColumn);
	}
	return (
		table.columns.find((c) => c.pk) ??
		table.columns.find((c) => c.name === 'id')
	);
}

/**
 * Resolves a column's TERMINAL declared type by CHASING chained FK
 * references (mirroring `@dbsp/core`'s own `getReferencedColumnType`
 * recursion) — if the referenced column is ITSELF a ref column, follow it
 * to whatever it ultimately points at, instead of stopping at its
 * not-yet-resolved placeholder. This makes resolution independent of the
 * order relations happen to be processed in (a forward chain like
 * `comments.x -> posts.y` where `posts.y -> users` must resolve to
 * `users`' terminal type regardless of which relation is visited first).
 * `visiting` guards against a cyclic reference chain — a genuine cycle is
 * a schema-design error, not something to recurse over forever.
 */
function resolveTerminalType(
	tableByName: ReadonlyMap<string, ParsedTable>,
	col: ParsedColumn,
	visiting: Set<ParsedColumn> = new Set(),
): string {
	if (!col.ref) return col.type;
	if (visiting.has(col)) return col.type;
	visiting.add(col);
	const referencedCol = findReferencedColumn(
		tableByName.get(col.ref),
		col.refColumn,
	);
	if (!referencedCol) return col.type;
	return resolveTerminalType(tableByName, referencedCol, visiting);
}

/**
 * Resolves each FK column's DISPLAY type from its referenced column, now
 * that all tables in the DSL have been parsed (forward references
 * included). The referenced column's `.type` is already canonical (serial/
 * bigserial already normalized to integer/bigint at parse time); if the
 * referenced column is itself a FK, resolveTerminalType chases the chain.
 */
function resolveRefColumnTypes(
	tables: readonly ParsedTable[],
	relations: readonly ParsedRelation[],
): void {
	const tableByName = new Map(tables.map((t) => [t.name, t]));
	for (const rel of relations) {
		const fromTable = tableByName.get(rel.from);
		const fromCol = fromTable?.columns.find((c) => c.name === rel.fromCol);
		// Verify the found column IS ACTUALLY the FK this relation describes
		// before mutating its display type. `relations` is derived solely
		// from columns that have `.ref` set (see deriveRelations), so this
		// should always hold — but defense in depth matters here
		// specifically: a lookup by NAME ALONE (ignoring whether the column
		// is even a ref column) is exactly what let a stale/phantom relation
		// silently overwrite an unrelated, non-FK column's type in the past.
		if (!fromCol || fromCol.ref !== rel.to) continue;
		const referencedCol = findReferencedColumn(
			tableByName.get(rel.to),
			fromCol.refColumn,
		);
		if (referencedCol) {
			fromCol.type = resolveTerminalType(tableByName, referencedCol);
			// A bare `ref(target)` (no explicit `references`) lets
			// `@dbsp/core` default to `target.id` — correct ONLY when the
			// target's ACTUAL resolved primary key (same explicit-pk -> id
			// fallback order findReferencedColumn always uses) IS a column
			// named `id`. When it resolved to some OTHER column (e.g. the
			// target's pk is `uid`), the emitted ref must say so explicitly
			// or core points at a missing/wrong `id` column — build failure
			// or a silently wrong target. Reuses the SAME `references`
			// emission both buildSchemaFromParsed and generateTypeScript
			// already have for an EXPLICIT `-> target.col`; only auto-fills
			// it here when the DSL author didn't write one themselves.
			if (!fromCol.refColumn && referencedCol.name !== 'id') {
				fromCol.refColumn = referencedCol.name;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Generated TypeScript escaping helpers (requirement #9)
// ---------------------------------------------------------------------------

/** A safe bare JS/TS identifier — usable as an unquoted object-literal key. */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Emits a valid, safely-escaped JS string literal for `value`. */
function tsString(value: string): string {
	return JSON.stringify(value);
}

/**
 * Emits a safe object-literal KEY for `name`.
 *
 * `__proto__` is special-cased in BOTH bare (`__proto__: x`) AND quoted
 * string (`"__proto__": x`) object-literal key positions — either form
 * sets the object's PROTOTYPE instead of creating an own property (see the
 * ECMAScript spec's `__proto__` PropertyDefinition production). Only the
 * COMPUTED form (`["__proto__"]: x`) creates a genuine own property, so
 * that's always emitted for this one name — regardless of it otherwise
 * "looking like" a safe bare identifier. (The parser rejects `__proto__`/
 * `constructor`/`prototype` as a DSL identifier entirely, so this is
 * defense-in-depth for a hand-constructed ParsedSchema calling
 * generateTypeScript directly, not something reachable via parseSchemaDsl.)
 */
function tsKey(name: string): string {
	if (name === '__proto__') return `[${JSON.stringify(name)}]`;
	return SAFE_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Emits a `ParsedDefault` as a valid TypeScript expression (typed: number/boolean/null unquoted, string quoted, SQL wrapped as `{ sql }`). */
function tsDefaultLiteral(d: ParsedDefault): string {
	if (d.kind === 'sql') return `{ sql: ${tsString(d.value)} }`;
	if (d.value === null) return 'null';
	if (typeof d.value === 'number' || typeof d.value === 'boolean')
		return String(d.value);
	return tsString(d.value);
}

// ---------------------------------------------------------------------------
// Schema-derived generators
// ---------------------------------------------------------------------------

/** The object-literal form of `@dbsp/core`'s `ColumnDef` (excludes the bare-string-type shorthand). */
type ColumnDefObject = Extract<ColumnDef, object>;

/** Maps a `ParsedDefault` to the wrapper's expected `default` shape. */
function toWrapperDefault(d: ParsedDefault): unknown {
	return d.kind === 'sql' ? { sql: d.value } : d.value;
}

export function buildSchemaFromParsed(
	parsed: ParsedSchema,
	core: Pick<typeof import('@dbsp/core'), 'schema' | 'ref'>,
): unknown {
	const { schema, ref: dbRef } = core;
	// Object.create(null) — defense in depth against prototype pollution:
	// `tableDefs[table.name] = ...` with a user-controlled name would, on a
	// plain `{}`, special-case `__proto__` (mutates the object's own
	// prototype instead of creating an own property) and silently vanish
	// from Object.keys(). A null-prototype object has no such special case
	// (still fully compatible with schema()'s Record<string, TableDef>
	// shape — Object.keys/entries only ever look at own properties
	// anyway). parseSchemaDsl already REJECTS __proto__/constructor/
	// prototype identifiers with a thrown error, so this is a second,
	// independent layer, not the primary defense.
	const tableDefs: SchemaDefinition = Object.create(null);

	for (const table of parsed.tables) {
		const colDefs: TableDef = Object.create(null);
		for (const col of table.columns) {
			// Defense in depth: `col.ref === ''` is falsy in JS, so a plain
			// `if (col.ref)` check below would silently fall through to the
			// VALUE-COLUMN branch and build this as a working-looking plain
			// uuid column — exactly the "malformed FK builds as a plain
			// uuid column" bug. The parser never emits an empty ref target
			// (a missing '-> target' is a warning + dropped column, not
			// `ref: ''`), but this guard must run BEFORE the truthy check,
			// not inside it, to actually catch a hand-constructed
			// ParsedSchema with a broken ref.
			if (col.ref === '') continue;
			if (col.ref) {
				// Typed against the real RefOptions contract (not
				// Record<string, unknown>) so an invalid/misspelled option, or
				// an onUpdate action core doesn't support, is a compile-time
				// error instead of a silent runtime mismatch.
				const refOpts: RefOptions = {};
				if (col.refNullable || col.nullable) refOpts.nullable = true;
				if (col.refUnique) refOpts.unique = true;
				if (col.onDelete) refOpts.onDelete = col.onDelete;
				if (col.onUpdate) refOpts.onUpdate = col.onUpdate;
				if (col.refColumn) refOpts.references = [col.refColumn];
				colDefs[col.name] =
					Object.keys(refOpts).length > 0
						? dbRef(col.ref, refOpts)
						: dbRef(col.ref);
			} else {
				const def: ColumnDefObject = { type: col.type as ColumnType };
				if (col.autoIncrement) def.autoIncrement = true;
				if (col.pk) def.primaryKey = true;
				if (col.nullable) def.nullable = true;
				if (col.unique) def.unique = true;
				if (col.default) def.default = toWrapperDefault(col.default);
				colDefs[col.name] = Object.keys(def).length === 1 ? def.type : def;
			}
		}
		tableDefs[table.name] = colDefs;
	}

	return schema(tableDefs);
}

export function generateTypeScript(parsed: ParsedSchema): string {
	const lines: string[] = [];
	lines.push('// NOTE: this code is auto-generated from the playground DSL.');
	lines.push('// The playground DSL is a teaching subset — it does NOT cover');
	lines.push(
		'// indexes, enums, composite keys, CHECK constraints, RLS policies,',
	);
	lines.push(
		'// computed columns, schema scoping, and more. Tracking the gaps:',
	);
	lines.push('// https://github.com/oorabona/db-semantic-planner/issues/116');
	lines.push('//');
	lines.push(
		'// The real @dbsp/core schema() API supports all of those — see the',
	);
	lines.push('// schema guide in the docs for the full surface.');
	lines.push('');
	lines.push("import { schema, ref } from '@dbsp/core';");
	lines.push('');
	lines.push('const db = schema({');

	for (const table of parsed.tables) {
		lines.push(`  ${tsKey(table.name)}: {`);
		for (const col of table.columns) {
			// Defense in depth — see the matching guard in
			// buildSchemaFromParsed: never emit a broken FK as a plain column.
			if (col.ref === '') continue;
			if (col.ref) {
				const opts: string[] = [];
				if (col.refNullable || col.nullable) opts.push('nullable: true');
				if (col.refUnique) opts.push('unique: true');
				if (col.onDelete) opts.push(`onDelete: ${tsString(col.onDelete)}`);
				if (col.onUpdate) opts.push(`onUpdate: ${tsString(col.onUpdate)}`);
				if (col.refColumn)
					opts.push(`references: [${tsString(col.refColumn)}]`);
				const refCall =
					opts.length > 0
						? `ref(${tsString(col.ref)}, { ${opts.join(', ')} })`
						: `ref(${tsString(col.ref)})`;
				lines.push(`    ${tsKey(col.name)}: ${refCall},`);
			} else {
				const extras: string[] = [];
				if (col.autoIncrement) extras.push('autoIncrement: true');
				if (col.pk) extras.push('primaryKey: true');
				if (col.nullable) extras.push('nullable: true');
				if (col.unique) extras.push('unique: true');
				if (col.default)
					extras.push(`default: ${tsDefaultLiteral(col.default)}`);
				if (extras.length > 0) {
					lines.push(
						`    ${tsKey(col.name)}: { type: ${tsString(col.type)}, ${extras.join(', ')} },`,
					);
				} else {
					lines.push(`    ${tsKey(col.name)}: ${tsString(col.type)},`);
				}
			}
		}
		lines.push('  },');
	}

	lines.push('});');
	return lines.join('\n');
}

/** A safe bare Mermaid ER identifier: alphanumeric/underscore only. */
const SAFE_MERMAID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Mermaid ER-diagram keywords that break parsing if used bare as an entity
 * or attribute name (case-insensitive), plus the `PK`/`FK`/`UK` key-type
 * modifiers, which are ambiguous with an attribute NAME that happens to be
 * literally "PK"/"FK"/"UK". Not meant to be an exhaustive list of every
 * Mermaid reserved word across versions — quoting (below) is what actually
 * guarantees correctness; this set just avoids unnecessary quoting noise
 * for the overwhelmingly common case of an ordinary identifier.
 */
const MERMAID_RESERVED = new Set([
	'erdiagram',
	'class',
	'classdef',
	'style',
	'end',
	'subgraph',
	'pk',
	'fk',
	'uk',
]);

/**
 * Quotes `name` for use as a Mermaid ER entity/attribute name when it isn't
 * a safe bare identifier or collides with a Mermaid-reserved word — a
 * table named `class`/`style`/`erDiagram`, or a column named `PK`/`FK`/`UK`,
 * otherwise breaks Mermaid's parser and renders a blank diagram. Mermaid ER
 * supports `"quoted"` entity/attribute names for exactly this case.
 */
function mermaidName(name: string): string {
	if (
		SAFE_MERMAID_IDENTIFIER.test(name) &&
		!MERMAID_RESERVED.has(name.toLowerCase())
	) {
		return name;
	}
	return `"${name.replace(/"/g, "'")}"`;
}

export function buildMermaidCode(parsed: ParsedSchema): string {
	const lines: string[] = ['erDiagram'];

	for (const table of parsed.tables) {
		lines.push(`    ${mermaidName(table.name)} {`);
		for (const col of table.columns) {
			const type = col.type.replace(/[^a-zA-Z0-9_]/g, '_');
			// A unique FK (col.refUnique) is a unique constraint on the
			// column just like col.unique — both render as UK.
			const suffix = col.pk ? ' PK' : col.unique || col.refUnique ? ' UK' : '';
			lines.push(`        ${type} ${mermaidName(col.name)}${suffix}`);
		}
		lines.push('    }');
	}

	const tableByName = new Map(parsed.tables.map((t) => [t.name, t]));
	for (const rel of parsed.relations) {
		const fromCol = tableByName
			.get(rel.from)
			?.columns.find((c) => c.name === rel.fromCol);
		// A unique FK is a 1:1 relationship (one optional-one on the "from"
		// side, `||--o|`); a non-unique FK is the usual 1:N (`||--o{`).
		const cardinality = fromCol?.refUnique ? '||--o|' : '||--o{';
		lines.push(
			`    ${mermaidName(rel.to)} ${cardinality} ${mermaidName(rel.from)} : ""`,
		);
	}

	return lines.join('\n');
}
