/**
 * Pure-TypeScript SQL expression parser.
 *
 * Parses a raw SQL fragment (not a full statement) into a `@pgsql/types`
 * compatible `Node` object that can be placed into an AST tree and serialised
 * by `deparseSync` from `pgsql-deparser`.
 *
 * The node shapes produced here are identical to those produced by
 * `pgsql-parser`'s `parseSync` for the same fragment — verified by the
 * comparison tests in `raw-expression-parser.test.ts`.
 *
 * Supported constructs:
 *  - Integer literals:          `1`, `42`
 *  - String literals:           `'text'`
 *  - Identifiers / column refs: `count`, `excluded.count`
 *  - Function calls:            `now()`, `gen_random_uuid()`, `COALESCE(a, b)`
 *  - Arithmetic (+ - * /):      `excluded.count + 1`, `a + b * c`
 *  - Type casts:                `a::integer`, `val::text`
 *  - Parenthesised expressions: `(a + b) * c`
 *
 * @module
 */

import type { Node } from '@pgsql/types';
import { stringConstNode } from './ast-helpers.js';

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenKind =
	| 'INT'
	| 'FLOAT'
	| 'STRING'
	| 'IDENT'
	| 'OP'
	| 'LPAREN'
	| 'RPAREN'
	| 'COMMA'
	| 'DOT'
	| 'CAST'
	| 'EOF';

interface Token {
	kind: TokenKind;
	value: string;
}

/**
 * Note: Scientific notation (e.g., 3.14e5, 2.5E-3) is not supported.
 * The parser handles simple decimal floats only (e.g., 3.14, 0.5).
 * Scientific notation is rare in SQL expression fragments (sql() escape hatch).
 */
function tokenise(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const src = input.trim();

	while (i < src.length) {
		// src[i] is safe here because i < src.length is the loop condition
		const ch = src[i]!;

		// Whitespace
		if (/\s/.test(ch)) {
			i++;
			continue;
		}

		// Integer or float literal
		if (/[0-9]/.test(ch)) {
			let num = '';
			while (i < src.length && /[0-9]/.test(src[i]!)) {
				num += src[i++]!;
			}
			// Check for decimal fraction → float
			if (src[i] === '.' && i + 1 < src.length && /[0-9]/.test(src[i + 1]!)) {
				num += src[i++]!; // consume '.'
				while (i < src.length && /[0-9]/.test(src[i]!)) {
					num += src[i++]!;
				}
				tokens.push({ kind: 'FLOAT', value: num });
			} else {
				tokens.push({ kind: 'INT', value: num });
			}
			continue;
		}

		// String literal (single-quoted)
		if (ch === "'") {
			let str = '';
			i++; // skip opening quote
			while (i < src.length) {
				if (src[i]! === "'" && src[i + 1] === "'") {
					// Escaped single quote
					str += "'";
					i += 2;
				} else if (src[i]! === "'") {
					i++; // skip closing quote
					break;
				} else {
					str += src[i++]!;
				}
			}
			tokens.push({ kind: 'STRING', value: str });
			continue;
		}

		// Identifier or keyword
		if (/[a-zA-Z_]/.test(ch)) {
			let ident = '';
			while (i < src.length && /[a-zA-Z0-9_]/.test(src[i]!)) {
				ident += src[i++]!;
			}
			tokens.push({ kind: 'IDENT', value: ident });
			continue;
		}

		// Double-colon cast operator (must come before single colon if ever added)
		if (ch === ':' && src[i + 1] === ':') {
			tokens.push({ kind: 'CAST', value: '::' });
			i += 2;
			continue;
		}

		// Arithmetic operators
		if (['+', '-', '*', '/'].includes(ch)) {
			tokens.push({ kind: 'OP', value: ch });
			i++;
			continue;
		}

		if (ch === '(') {
			tokens.push({ kind: 'LPAREN', value: '(' });
			i++;
			continue;
		}

		if (ch === ')') {
			tokens.push({ kind: 'RPAREN', value: ')' });
			i++;
			continue;
		}

		if (ch === ',') {
			tokens.push({ kind: 'COMMA', value: ',' });
			i++;
			continue;
		}

		if (ch === '.') {
			tokens.push({ kind: 'DOT', value: '.' });
			i++;
			continue;
		}

		throw new Error(
			`parseExpression: unexpected character '${ch}' at position ${i} in: ${input}`,
		);
	}

	tokens.push({ kind: 'EOF', value: '' });
	return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
	private pos = 0;

	constructor(private readonly tokens: Token[]) {}

	private peek(): Token {
		// pos is always in bounds: tokenise() guarantees a trailing EOF token
		return this.tokens[this.pos]!;
	}

	private consume(): Token {
		// pos is always in bounds: tokenise() guarantees a trailing EOF token
		const tok = this.tokens[this.pos]!;
		this.pos++;
		return tok;
	}

	private expect(kind: TokenKind): Token {
		const tok = this.peek();
		if (tok.kind !== kind) {
			throw new Error(
				`parseExpression: expected ${kind}, got ${tok.kind} ('${tok.value}')`,
			);
		}
		return this.consume();
	}

	// expr → additive (:: type)*
	parseExpr(): Node {
		let node = this.parseAdditive();

		while (this.peek().kind === 'CAST') {
			this.consume(); // ::
			const typeName = this.parseTypeName();
			node = {
				TypeCast: {
					arg: node,
					typeName,
				},
			} as unknown as Node;
		}

		return node;
	}

	// additive → multiplicative (('+' | '-') multiplicative)*
	private parseAdditive(): Node {
		let left = this.parseMultiplicative();

		while (
			this.peek().kind === 'OP' &&
			(this.peek().value === '+' || this.peek().value === '-')
		) {
			const op = this.consume().value;
			const right = this.parseMultiplicative();
			left = buildAExpr(op, left, right);
		}

		return left;
	}

	// multiplicative → unary (('*' | '/') unary)*
	private parseMultiplicative(): Node {
		let left = this.parseUnary();

		while (
			this.peek().kind === 'OP' &&
			(this.peek().value === '*' || this.peek().value === '/')
		) {
			const op = this.consume().value;
			const right = this.parseUnary();
			left = buildAExpr(op, left, right);
		}

		return left;
	}

	// unary → ('-')? primary
	private parseUnary(): Node {
		if (this.peek().kind === 'OP' && this.peek().value === '-') {
			this.consume();
			const operand = this.parsePrimary();
			// Unary minus: represented as A_Expr with no lexpr
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: '-' } }],
					rexpr: operand,
				},
			} as unknown as Node;
		}
		return this.parsePrimary();
	}

	// primary → INT | STRING | IDENT(...) | IDENT.IDENT | (expr) | COALESCE(...)
	private parsePrimary(): Node {
		const tok = this.peek();

		if (tok.kind === 'INT') {
			this.consume();
			return {
				A_Const: {
					ival: { ival: parseInt(tok.value, 10) },
				},
			} as unknown as Node;
		}

		if (tok.kind === 'FLOAT') {
			this.consume();
			return {
				A_Const: {
					fval: { fval: tok.value },
				},
			} as unknown as Node;
		}

		if (tok.kind === 'STRING') {
			this.consume();
			return stringConstNode(tok.value);
		}

		if (tok.kind === 'LPAREN') {
			this.consume();
			const inner = this.parseExpr();
			this.expect('RPAREN');
			return inner;
		}

		if (tok.kind === 'IDENT') {
			return this.parseIdentOrCall();
		}

		throw new Error(
			`parseExpression: unexpected token ${tok.kind} ('${tok.value}')`,
		);
	}

	/**
	 * Parse an identifier, possibly followed by:
	 *  - `.ident` (qualified column ref)
	 *  - `(args)` (function call)
	 *
	 * COALESCE is a special case — PostgreSQL parses it as CoalesceExpr, not FuncCall.
	 */
	private parseIdentOrCall(): Node {
		const ident = this.consume(); // first IDENT

		// Function call: IDENT(...)
		if (this.peek().kind === 'LPAREN') {
			this.consume(); // (
			const args = this.parseArgList();
			this.expect('RPAREN');

			// Special built-in functions that PostgreSQL parses differently
			const upper = ident.value.toUpperCase();

			if (upper === 'COALESCE') {
				return {
					CoalesceExpr: {
						args,
					},
				} as unknown as Node;
			}

			if (upper === 'NULLIF') {
				// NullIfExpr takes exactly 2 args
				return {
					NullIfExpr: {
						args,
					},
				} as unknown as Node;
			}

			// Regular function call
			return {
				FuncCall: {
					funcname: [{ String: { sval: ident.value.toLowerCase() } }],
					args: args.length > 0 ? args : undefined,
					funcformat: 'COERCE_EXPLICIT_CALL',
				},
			} as unknown as Node;
		}

		// Qualified: IDENT.IDENT
		if (this.peek().kind === 'DOT') {
			this.consume(); // .
			const field = this.expect('IDENT');
			return {
				ColumnRef: {
					fields: [
						{ String: { sval: ident.value } },
						{ String: { sval: field.value } },
					],
				},
			} as unknown as Node;
		}

		// Plain identifier → ColumnRef with single field
		return {
			ColumnRef: {
				fields: [{ String: { sval: ident.value } }],
			},
		} as unknown as Node;
	}

	private parseArgList(): Node[] {
		const args: Node[] = [];
		if (this.peek().kind === 'RPAREN') {
			return args;
		}
		args.push(this.parseExpr());
		while (this.peek().kind === 'COMMA') {
			this.consume();
			args.push(this.parseExpr());
		}
		return args;
	}

	/**
	 * Parse a type name after `::`.
	 * Handles simple names like `integer`, `text`, `uuid`, `bigint`, etc.
	 * Maps to PostgreSQL's pg_catalog qualified names to match parseSync output.
	 */
	private parseTypeName(): {
		names: Array<{ String: { sval: string } }>;
		typemod: number;
	} {
		const ident = this.expect('IDENT');
		const lower = ident.value.toLowerCase();

		// Map SQL type aliases to pg_catalog qualified names (matches parseSync output)
		const pgCatalogTypes: Record<string, string> = {
			int: 'int4',
			integer: 'int4',
			int4: 'int4',
			int2: 'int2',
			smallint: 'int2',
			int8: 'int8',
			bigint: 'int8',
			float4: 'float4',
			real: 'float4',
			float8: 'float8',
			'double precision': 'float8',
			bool: 'bool',
			boolean: 'bool',
			text: 'text',
			varchar: 'varchar',
			bpchar: 'bpchar',
			char: 'bpchar',
			bytea: 'bytea',
			date: 'date',
			time: 'time',
			timetz: 'timetz',
			timestamp: 'timestamp',
			timestamptz: 'timestamptz',
			interval: 'interval',
			numeric: 'numeric',
			decimal: 'numeric',
			uuid: 'uuid',
			json: 'json',
			jsonb: 'jsonb',
			oid: 'oid',
			name: 'name',
		};

		const pgName = pgCatalogTypes[lower];
		if (pgName) {
			return {
				names: [
					{ String: { sval: 'pg_catalog' } },
					{ String: { sval: pgName } },
				],
				typemod: -1,
			};
		}

		// Unknown type: pass through as-is (not pg_catalog qualified)
		return {
			names: [{ String: { sval: lower } }],
			typemod: -1,
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAExpr(op: string, left: Node, right: Node): Node {
	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: op } }],
			lexpr: left,
			rexpr: right,
		},
	} as unknown as Node;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw SQL expression fragment into a `@pgsql/types` `Node`.
 *
 * The returned node is structurally identical to what `pgsql-parser`'s
 * `parseSync` would produce for the same fragment wrapped in `SELECT <fragment>`.
 * It can be embedded in a larger AST tree and serialised by `pgsql-deparser`.
 *
 * @param sqlFragment - A SQL expression fragment, e.g. `now()`, `excluded.count + 1`
 * @returns A pg AST `Node` ready for deparsing
 * @throws Error if the fragment cannot be parsed
 *
 * @example
 * ```ts
 * parseExpression('now()')
 * // → { FuncCall: { funcname: [{ String: { sval: 'now' } }], funcformat: 'COERCE_EXPLICIT_CALL' } }
 *
 * parseExpression('excluded.count + 1')
 * // → { A_Expr: { kind: 'AEXPR_OP', name: [{ String: { sval: '+' } }], lexpr: ColumnRef, rexpr: A_Const } }
 * ```
 */
export function parseExpression(sqlFragment: string): Node {
	const trimmed = sqlFragment.trim();
	if (!trimmed) {
		throw new Error('parseExpression: empty SQL fragment');
	}

	const tokens = tokenise(trimmed);
	const parser = new Parser(tokens);
	const node = parser.parseExpr();

	// biome-ignore lint/complexity/useLiteralKeys: accessing private members via bracket notation intentionally
	if (parser['peek']().kind !== 'EOF') {
		const remaining = tokens
			// biome-ignore lint/complexity/useLiteralKeys: accessing private members via bracket notation intentionally
			.slice(parser['pos'])
			.map((t) => t.value)
			.join(' ');
		throw new Error(
			`parseExpression: unexpected trailing tokens '${remaining}' in: ${sqlFragment}`,
		);
	}

	return node;
}
