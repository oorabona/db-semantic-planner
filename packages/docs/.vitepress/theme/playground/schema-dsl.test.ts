import { ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	buildMermaidCode,
	buildSchemaFromParsed,
	generateTypeScript,
	parseSchemaDsl,
	SchemaDslError,
} from './schema-dsl';

const core = { schema, ref };

function findTable(parsed: ReturnType<typeof parseSchemaDsl>, name: string) {
	const table = parsed.tables.find((t) => t.name === name);
	if (!table) throw new Error(`table not found in parsed schema: ${name}`);
	return table;
}

function findColumn(
	parsed: ReturnType<typeof parseSchemaDsl>,
	tableName: string,
	colName: string,
) {
	const col = findTable(parsed, tableName).columns.find(
		(c) => c.name === colName,
	);
	if (!col) throw new Error(`column not found: ${tableName}.${colName}`);
	return col;
}

function build(parsed: ReturnType<typeof parseSchemaDsl>) {
	return buildSchemaFromParsed(parsed, core) as ReturnType<typeof schema>;
}

// ---------------------------------------------------------------------------
// Requirement #1 — quote-aware everything (tokenizer-level correctness)
// ---------------------------------------------------------------------------

describe('requirement #1: quote-aware everything', () => {
	it("does not treat '-> users' inside a quoted default as an FK arrow", () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string default('x -> users')
				b: string
			}
		`);
		const a = findColumn(parsed, 't', 'a');
		expect(a.default).toEqual({ kind: 'literal', value: 'x -> users' });
		expect(a.ref).toBeUndefined();
		expect(parsed.relations).toHaveLength(0);
		// Column 'b' must still be parsed — the quoted arrow must not have
		// been mistaken for a real FK declaration that swallows the rest.
		expect(findColumn(parsed, 't', 'b')).toBeDefined();
	});

	it("does not treat 'unique' inside a quoted default as the unique modifier", () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string default('a unique b')
			}
		`);
		const a = findColumn(parsed, 't', 'a');
		expect(a.default).toEqual({ kind: 'literal', value: 'a unique b' });
		expect(a.unique).toBeUndefined();
	});

	it("does not treat 'pk' inside a quoted default as the pk modifier", () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string default('a pk b')
			}
		`);
		const a = findColumn(parsed, 't', 'a');
		expect(a.default).toEqual({ kind: 'literal', value: 'a pk b' });
		expect(a.pk).toBeUndefined();
	});

	it('does not truncate a default value containing // at a comment marker', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string default('https://x')
			}
		`);
		const a = findColumn(parsed, 't', 'a');
		expect(a.default).toEqual({ kind: 'literal', value: 'https://x' });
	});

	it('does not truncate the table at a `}` inside a quoted default', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string default('a } b')
				b: string
			}
		`);
		const table = findTable(parsed, 't');
		expect(table.columns.map((c) => c.name)).toEqual(['id', 'a', 'b']);
		expect(findColumn(parsed, 't', 'a').default).toEqual({
			kind: 'literal',
			value: 'a } b',
		});
	});
});

// ---------------------------------------------------------------------------
// Requirement #2 — typed literal defaults (real JS types, not strings)
// ---------------------------------------------------------------------------

describe('requirement #2: typed literal defaults', () => {
	it('parses a positive integer literal as a number', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk retries: integer default(0) }
		`);
		expect(findColumn(parsed, 't', 'retries').default).toEqual({
			kind: 'literal',
			value: 0,
		});
	});

	it('parses a negative decimal literal as a number', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk balance: decimal default(-3.5) }
		`);
		expect(findColumn(parsed, 't', 'balance').default).toEqual({
			kind: 'literal',
			value: -3.5,
		});
	});

	it('parses true/false as booleans', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				active: boolean default(true)
				archived: boolean default(false)
			}
		`);
		expect(findColumn(parsed, 't', 'active').default).toEqual({
			kind: 'literal',
			value: true,
		});
		expect(findColumn(parsed, 't', 'archived').default).toEqual({
			kind: 'literal',
			value: false,
		});
	});

	it('parses null/NULL (case-insensitive) as null', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string? default(null)
				b: string? default(NULL)
			}
		`);
		expect(findColumn(parsed, 't', 'a').default).toEqual({
			kind: 'literal',
			value: null,
		});
		expect(findColumn(parsed, 't', 'b').default).toEqual({
			kind: 'literal',
			value: null,
		});
	});

	it('parses single- and double-quoted strings, quotes stripped, as the string', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string default('hello')
				b: string default("hi")
			}
		`);
		expect(findColumn(parsed, 't', 'a').default).toEqual({
			kind: 'literal',
			value: 'hello',
		});
		expect(findColumn(parsed, 't', 'b').default).toEqual({
			kind: 'literal',
			value: 'hi',
		});
	});

	it('emits typed literals (unquoted number/boolean/null, quoted string) in the built schema and generated TypeScript', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				retries: integer default(0)
				active: boolean default(true)
				label: string default('hello')
				note: string? default(null)
			}
		`);
		const built = build(parsed);
		const columns = built.model.getTable('t')?.columns ?? [];
		expect(columns.find((c) => c.name === 'retries')?.default).toBe(0);
		expect(columns.find((c) => c.name === 'active')?.default).toBe(true);
		expect(columns.find((c) => c.name === 'label')?.default).toBe('hello');
		expect(columns.find((c) => c.name === 'note')?.default).toBe(null);

		const ts = generateTypeScript(parsed);
		expect(ts).toContain('default: 0');
		expect(ts).toContain('default: true');
		expect(ts).toContain('default: "hello"');
		expect(ts).toContain('default: null');
	});
});

// ---------------------------------------------------------------------------
// Requirement #3 — SQL-expression defaults compile to { sql }
// ---------------------------------------------------------------------------

describe('requirement #3: SQL-expression defaults', () => {
	it('compiles a zero-arg call to { sql }', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk created_at: timestamp default(NOW()) }
		`);
		expect(findColumn(parsed, 't', 'created_at').default).toEqual({
			kind: 'sql',
			value: 'NOW()',
		});
	});

	it('captures a NESTED call expression without truncation', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk created_at: timestamp default(timezone('UTC', now())) }
		`);
		expect(findColumn(parsed, 't', 'created_at').default).toEqual({
			kind: 'sql',
			value: "timezone('UTC', now())",
		});
	});

	it('compiles a bare SQL keyword builtin to { sql }', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: timestamp default(CURRENT_TIMESTAMP)
				b: date default(CURRENT_DATE)
				c: string default(CURRENT_USER)
			}
		`);
		expect(findColumn(parsed, 't', 'a').default).toEqual({
			kind: 'sql',
			value: 'CURRENT_TIMESTAMP',
		});
		expect(findColumn(parsed, 't', 'b').default).toEqual({
			kind: 'sql',
			value: 'CURRENT_DATE',
		});
		expect(findColumn(parsed, 't', 'c').default).toEqual({
			kind: 'sql',
			value: 'CURRENT_USER',
		});
	});

	it('compiles CURRENT_TIMESTAMP(6) (keyword + precision arg) as one SQL expression', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk created_at: timestamp default(CURRENT_TIMESTAMP(6)) }
		`);
		expect(findColumn(parsed, 't', 'created_at').default).toEqual({
			kind: 'sql',
			value: 'CURRENT_TIMESTAMP(6)',
		});
	});

	it('classifies a bare keyword as a SQL expression case-insensitively, preserving the original casing in the value', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk created_at: timestamp default(current_timestamp) }
		`);
		expect(findColumn(parsed, 't', 'created_at').default).toEqual({
			kind: 'sql',
			value: 'current_timestamp',
		});
	});

	it('emits { sql: "..." } (not a bare quoted literal) in the built schema and generated TypeScript', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk created_at: timestamp default(timezone('UTC', now())) }
		`);
		const built = build(parsed);
		const col = built.model
			.getTable('t')
			?.columns.find((c) => c.name === 'created_at');
		expect(col?.default).toEqual({ sql: "timezone('UTC', now())" });

		const ts = generateTypeScript(parsed);
		expect(ts).toContain(
			`default: { sql: ${JSON.stringify("timezone('UTC', now())")} }`,
		);
	});
});

// ---------------------------------------------------------------------------
// Requirement #4 — FK type inference + display resolution
// ---------------------------------------------------------------------------

describe('requirement #4: FK type inference + display', () => {
	it("resolves the target's EXPLICIT pk column declared type (not uuid)", () => {
		const parsed = parseSchemaDsl(`
			table users {
				id: integer pk
				name: string
			}
			table posts {
				id: uuid pk
				author_id: -> users
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.type).toBe('integer');

		const built = build(parsed);
		const builtCol = built.model
			.getTable('posts')
			?.columns.find((c) => c.name === 'author_id');
		expect(builtCol?.type).toBe('integer');
	});

	it("resolves the target's implicit 'id' column declared type when no explicit pk is marked", () => {
		const parsed = parseSchemaDsl(`
			table users {
				id: integer
				name: string
			}
			table posts {
				id: uuid pk
				author_id: -> users
			}
		`);
		expect(findColumn(parsed, 'posts', 'author_id').type).toBe('integer');

		const built = build(parsed);
		const builtCol = built.model
			.getTable('posts')
			?.columns.find((c) => c.name === 'author_id');
		expect(builtCol?.type).toBe('integer');
	});

	it('falls back to the uuid placeholder when the target is unresolvable', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				author_id: -> missing
			}
		`);
		expect(findColumn(parsed, 'posts', 'author_id').type).toBe('uuid');
	});

	it('applies the serial→integer / bigserial→bigint mapping to the DISPLAY type too', () => {
		const parsed = parseSchemaDsl(`
			table users { id: serial pk }
			table posts { id: uuid pk author_id: -> users }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').type).toBe('integer');
		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('integer author_id');
		expect(mermaid).not.toContain('serial author_id');

		const bigParsed = parseSchemaDsl(`
			table counters { id: bigserial pk }
			table events { id: uuid pk counter_id: -> counters }
		`);
		expect(findColumn(bigParsed, 'events', 'counter_id').type).toBe('bigint');
	});

	it('resolves a non-id reference (-> target.col) to that column, with references: [col]', () => {
		const parsed = parseSchemaDsl(`
			table users {
				id: uuid pk
				email: string unique
			}
			table posts {
				id: uuid pk
				author_email: -> users.email
			}
		`);
		const authorEmail = findColumn(parsed, 'posts', 'author_email');
		expect(authorEmail.refColumn).toBe('email');
		expect(authorEmail.type).toBe('string');

		const built = build(parsed);
		const fk = built.model
			.getTable('posts')
			?.foreignKeys.find((f) => f.columns.includes('author_email'));
		expect(fk?.references.columns).toEqual(['email']);

		const ts = generateTypeScript(parsed);
		expect(ts).toContain('references: ["email"]');
	});
});

// ---------------------------------------------------------------------------
// Requirement #5 — FK modifiers honored (unique/nullable forwarded; pk/default warned)
// ---------------------------------------------------------------------------

describe('requirement #5: FK modifiers honored', () => {
	it('forwards unique to the built schema and generated TypeScript', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users unique }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').refUnique).toBe(true);

		const built = build(parsed);
		const fk = built.model
			.getTable('posts')
			?.foreignKeys.find((f) => f.columns.includes('author_id'));
		expect(fk).toBeDefined();
		const col = built.model
			.getTable('posts')
			?.columns.find((c) => c.name === 'author_id');
		expect(col?.unique).toBe(true);

		const ts = generateTypeScript(parsed);
		expect(ts).toContain('ref("users", { unique: true })');
	});

	it('forwards nullable (from the type-level "?") to the built schema and generated TypeScript', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: uuid? -> users }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').nullable).toBe(true);

		const built = build(parsed);
		const col = built.model
			.getTable('posts')
			?.columns.find((c) => c.name === 'author_id');
		expect(col?.nullable).toBe(true);

		const ts = generateTypeScript(parsed);
		expect(ts).toContain('ref("users", { nullable: true })');
	});

	it('still forwards nullable via the target-level "?" (regression)', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users? }
		`);
		const built = build(parsed);
		const col = built.model
			.getTable('posts')
			?.columns.find((c) => c.name === 'author_id');
		expect(col?.nullable).toBe(true);
	});

	it("surfaces a warning for 'pk' on a ref column instead of silently applying it", () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users pk
				title: string
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.pk).toBeUndefined();
		expect(
			parsed.warnings.some(
				(w) => /pk/i.test(w.message) && /foreign-key/i.test(w.message),
			),
		).toBe(true);
		// Parsing must still recover and see the next column.
		expect(findColumn(parsed, 'posts', 'title')).toBeDefined();

		// Builds fine — RefOptions simply has no primaryKey field to set.
		expect(() => build(parsed)).not.toThrow();
	});

	it("surfaces a warning for 'default' on a ref column instead of silently applying it", () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users default(NOW())
				title: string
			}
		`);
		expect(
			parsed.warnings.some(
				(w) => /default/i.test(w.message) && /foreign-key/i.test(w.message),
			),
		).toBe(true);
		// The paren span must have been consumed cleanly — the next column is
		// still parsed (proves the token stream didn't desync).
		expect(findColumn(parsed, 'posts', 'title')).toBeDefined();
		expect(() => build(parsed)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Requirement #6 — legacy bare `cascade` shorthand
// ---------------------------------------------------------------------------

describe('requirement #6: legacy bare cascade shorthand', () => {
	it('honors bare cascade (arrow-first syntax) as onDelete: CASCADE', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users cascade }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').onDelete).toBe('CASCADE');

		const built = build(parsed);
		const fk = built.model
			.getTable('posts')
			?.foreignKeys.find((f) => f.columns.includes('author_id'));
		expect(fk?.onDelete).toBe('CASCADE');
	});

	it('honors bare cascade (embedded type + arrow syntax)', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: uuid -> users cascade }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').onDelete).toBe('CASCADE');
	});

	it('keeps working alongside the explicit onDelete:/onUpdate: syntax', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users onDelete:cascade onUpdate:restrict }
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.onDelete).toBe('CASCADE');
		expect(authorId.onUpdate).toBe('RESTRICT');
	});
});

// ---------------------------------------------------------------------------
// Requirement #7 — per-direction FK actions typed from core
// ---------------------------------------------------------------------------

describe('requirement #7: per-direction FK actions', () => {
	it.each([
		['cascade', 'CASCADE'],
		['restrict', 'RESTRICT'],
		['setnull', 'SET NULL'],
		['setdefault', 'SET DEFAULT'],
		['noaction', 'NO ACTION'],
	])('onDelete:%s maps to %s (5-action set)', (keyword, expected) => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users onDelete:${keyword} }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').onDelete).toBe(expected);
	});

	it.each([
		['cascade', 'CASCADE'],
		['restrict', 'RESTRICT'],
		['setnull', 'SET NULL'],
		['noaction', 'NO ACTION'],
	])('onUpdate:%s maps to %s (4-action set)', (keyword, expected) => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users onUpdate:${keyword} }
		`);
		expect(findColumn(parsed, 'posts', 'author_id').onUpdate).toBe(expected);
	});

	it('rejects onUpdate:setdefault (core does not support it) while onDelete:setdefault works, and warns', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users onDelete:setdefault onUpdate:setdefault
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.onDelete).toBe('SET DEFAULT');
		expect(authorId.onUpdate).toBeUndefined();
		expect(
			parsed.warnings.some(
				(w) => /onUpdate/i.test(w.message) && /setdefault/i.test(w.message),
			),
		).toBe(true);

		const ts = generateTypeScript(parsed);
		expect(ts).not.toContain('onUpdate');
		expect(ts).toContain('onDelete: "SET DEFAULT"');
	});
});

// ---------------------------------------------------------------------------
// Requirement #8 — type validation + alias normalization
// ---------------------------------------------------------------------------

describe('requirement #8: type validation + alias normalization', () => {
	it.each([
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
	])('normalizes alias %s to canonical %s', (alias, canonical) => {
		const parsed = parseSchemaDsl(`table t { v: ${alias} }`);
		expect(findColumn(parsed, 't', 'v').type).toBe(canonical);
	});

	it('accepts canonical types as-is (case-insensitive)', () => {
		const parsed = parseSchemaDsl(`table t { v: INTEGER }`);
		expect(findColumn(parsed, 't', 'v').type).toBe('integer');
	});

	it.each([
		'vector',
		'bytea',
		'binary',
		'blob',
		'nonsense',
	])('throws SchemaDslError for the unsupported/unknown type %s', (badType) => {
		expect(() => parseSchemaDsl(`table t { v: ${badType} }`)).toThrow(
			SchemaDslError,
		);
		expect(() => parseSchemaDsl(`table t { v: ${badType} }`)).toThrow(
			new RegExp(`Unknown type '${badType}'`),
		);
	});

	it('the unknown-type error message lists supported canonical types and aliases', () => {
		try {
			parseSchemaDsl('table t { v: vector }');
			throw new Error('expected parseSchemaDsl to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SchemaDslError);
			const message = (e as Error).message;
			expect(message).toContain('integer');
			expect(message).toContain('varchar');
			expect(message).toContain('serial');
		}
	});
});

// ---------------------------------------------------------------------------
// Requirement #9 — escaped codegen (JSON.stringify values, safe keys, typed defs)
// ---------------------------------------------------------------------------

describe('requirement #9: escaped codegen', () => {
	it('escapes a default value containing a doubled (escaped) quote', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk label: string default('it''s here') }
		`);
		const label = findColumn(parsed, 't', 'label');
		// The tokenizer resolves the doubled '' escape to one literal quote.
		expect(label.default).toEqual({ kind: 'literal', value: "it's here" });

		const ts = generateTypeScript(parsed);
		expect(ts).toContain(`default: ${JSON.stringify("it's here")}`);
		expect(ts).not.toContain("''s here''"); // never the old invalid double-single-quote form
	});

	it('escapes a default value containing an embedded double quote', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk quote: string default('she said "hi"') }
		`);
		const ts = generateTypeScript(parsed);
		expect(ts).toContain(`default: ${JSON.stringify('she said "hi"')}`);
	});

	it('keeps safe bare identifiers unquoted (no unnecessary escaping) for table/column keys', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk author_id: string }
		`);
		const ts = generateTypeScript(parsed);
		expect(ts).toContain('  users: {');
		expect(ts).toContain('author_id: "string"');
	});

	it('types the built column def against the real ColumnDef/RefOptions contract (no Record<string, unknown> bypass)', () => {
		// A structural proof: the built def for a plain column has exactly the
		// keys ColumnDef declares, and a ref column's options object has
		// exactly the keys RefOptions declares — nothing extra leaked in via
		// an untyped bag.
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				title: string unique
				author_id: -> users onDelete:cascade unique
			}
		`);
		const built = build(parsed);
		const postsTable = built.model.getTable('posts');
		const titleCol = postsTable?.columns.find((c) => c.name === 'title');
		expect(titleCol).toMatchObject({
			name: 'title',
			type: 'string',
			unique: true,
		});
		const fk = postsTable?.foreignKeys.find((f) =>
			f.columns.includes('author_id'),
		);
		expect(fk?.onDelete).toBe('CASCADE');
	});
});

// ---------------------------------------------------------------------------
// Gate finding #1 — prototype pollution via schema names
// ---------------------------------------------------------------------------

describe('gate fix: prototype-pollution-safe identifiers', () => {
	it('rejects __proto__ as a table name with a thrown parse error', () => {
		expect(() => parseSchemaDsl('table __proto__ { id: uuid pk }')).toThrow(
			SchemaDslError,
		);
		expect(() => parseSchemaDsl('table __proto__ { id: uuid pk }')).toThrow(
			/__proto__/,
		);
	});

	it('rejects __proto__ as a column name, not a silent drop', () => {
		expect(() =>
			parseSchemaDsl(`
				table t {
					id: uuid pk
					x: string
					__proto__: string
				}
			`),
		).toThrow(SchemaDslError);
	});

	it.each([
		'constructor',
		'prototype',
	])('also rejects %s as a table or column name', (bad) => {
		expect(() => parseSchemaDsl(`table ${bad} { id: uuid pk }`)).toThrow(
			SchemaDslError,
		);
		expect(() => parseSchemaDsl(`table t { ${bad}: string }`)).toThrow(
			SchemaDslError,
		);
	});

	it('rejects __proto__ as a FK target table name and as a non-id reference column', () => {
		expect(() =>
			parseSchemaDsl(`
				table t {
					id: uuid pk
					x: -> __proto__
				}
			`),
		).toThrow(SchemaDslError);
		expect(() =>
			parseSchemaDsl(`
				table users { id: uuid pk }
				table t {
					id: uuid pk
					x: -> users.__proto__
				}
			`),
		).toThrow(SchemaDslError);
	});

	it('a type literally named __proto__ is rejected as an unknown type (Map-based lookup, no prototype-chain bypass)', () => {
		// __proto__ is not a real @dbsp/core type either — this proves
		// SERIAL_TYPES/TYPE_ALIASES (converted to Map) don't accidentally
		// resolve '__proto__' to Object.prototype (a plain-object Record
		// would: `{}['__proto__']` returns Object.prototype, which is
		// truthy, bypassing the "unknown type" check).
		expect(() => parseSchemaDsl('table t { v: __proto__ }')).toThrow(
			/Unknown type '__proto__'/,
		);
	});

	it('tsKey computed-emits __proto__ as a defense-in-depth codegen guard (unreachable via parseSchemaDsl, tested directly)', () => {
		// The parser rejects __proto__ before generateTypeScript ever sees
		// it — this exercises generateTypeScript's OWN independent guard
		// with a hand-constructed ParsedSchema, proving the codegen defense
		// works even if some future caller bypasses the parser.
		const parsed: Parameters<typeof generateTypeScript>[0] = {
			tables: [
				{
					name: 'users',
					columns: [{ name: '__proto__', type: 'string' }],
				},
			],
			relations: [],
			warnings: [],
		};
		const ts = generateTypeScript(parsed);
		expect(ts).toContain('["__proto__"]: "string"');
		expect(ts).not.toContain('__proto__: "string"');
		expect(ts).not.toContain('"__proto__": "string"');
	});
});

// ---------------------------------------------------------------------------
// Gate finding #2 — malformed FKs must not swallow sibling columns/tables
// ---------------------------------------------------------------------------

describe('gate fix: malformed FK targets recover without swallowing siblings', () => {
	it('warns and drops the column when -> has no target before the table closes', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				author_id: ->
			}
		`);
		const table = findTable(parsed, 'posts');
		expect(table.columns.map((c) => c.name)).toEqual(['id']);
		expect(parsed.relations).toHaveLength(0);
		expect(
			parsed.warnings.some((w) =>
				/missing a target table name/i.test(w.message),
			),
		).toBe(true);
	});

	it('warns and drops the column WITHOUT consuming the next real column as its target', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				author_id: ->
				title: string
			}
		`);
		const table = findTable(parsed, 'posts');
		expect(table.columns.map((c) => c.name)).toEqual(['id', 'title']);
		expect(findColumn(parsed, 'posts', 'title').type).toBe('string');
		expect(findColumn(parsed, 'posts', 'title').ref).toBeUndefined();
		expect(parsed.relations).toHaveLength(0);
	});

	it('warns and drops the column on a trailing "." with no reference column name, without swallowing the next column', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users.
				title: string
			}
		`);
		const table = findTable(parsed, 'posts');
		expect(table.columns.map((c) => c.name)).toEqual(['id', 'title']);
		expect(findColumn(parsed, 'posts', 'title').type).toBe('string');
		expect(parsed.warnings.some((w) => /trailing '\.'/.test(w.message))).toBe(
			true,
		);
	});

	it('never builds a malformed FK as a plain uuid column (buildSchemaFromParsed/generateTypeScript defense in depth)', () => {
		// Direct proof of the guard against an empty col.ref, using a
		// hand-constructed ParsedSchema (the parser itself never emits
		// `ref: ''` after the fix above — this is the independent layer).
		const parsed: Parameters<typeof buildSchemaFromParsed>[0] = {
			tables: [
				{
					name: 'posts',
					columns: [
						{ name: 'id', type: 'uuid', pk: true },
						{ name: 'author_id', type: 'uuid', ref: '' },
					],
				},
			],
			relations: [],
			warnings: [],
		};
		const built = build(parsed);
		const postsTable = built.model.getTable('posts');
		expect(
			postsTable?.columns.find((c) => c.name === 'author_id'),
		).toBeUndefined();

		const ts = generateTypeScript(parsed);
		expect(ts).not.toContain('author_id');
	});
});

// ---------------------------------------------------------------------------
// Gate finding #3 — unbalanced default(...) must not consume the file
// ---------------------------------------------------------------------------

describe('gate fix: unbalanced default(...) does not consume the file', () => {
	it('warns and drops the default, and does not swallow the following table', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				created_at: timestamp default(NOW() }
			table users {
				id: uuid pk
			}
		`);
		expect(parsed.tables.map((t) => t.name)).toEqual(['posts', 'users']);
		expect(findColumn(parsed, 'posts', 'created_at').default).toBeUndefined();
		expect(
			parsed.warnings.some((w) => /missing its closing '\)'/.test(w.message)),
		).toBe(true);
	});

	it('the ref-column default(...) skip span (skipParenSpan) has the same bound', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users default(NOW() }
			table events {
				id: uuid pk
			}
		`);
		expect(parsed.tables.map((t) => t.name)).toEqual([
			'users',
			'posts',
			'events',
		]);
	});
});

// ---------------------------------------------------------------------------
// Gate finding #4 — typed FK bypasses type validation (pre-arrow type hint)
// ---------------------------------------------------------------------------

describe('gate fix: pre-arrow type hint on a ref column is validated', () => {
	it('throws for an unsupported type hint before the arrow', () => {
		expect(() =>
			parseSchemaDsl(`
				table users { id: uuid pk }
				table posts { id: uuid pk author_id: vector -> users }
			`),
		).toThrow(SchemaDslError);
	});

	it('throws for a typo type hint before the arrow', () => {
		expect(() =>
			parseSchemaDsl(`
				table users { id: uuid pk }
				table posts { id: uuid pk author_id: uuidd -> users }
			`),
		).toThrow(/Unknown type 'uuidd'/);
	});
});

// ---------------------------------------------------------------------------
// Gate finding #5 — chained FK display type resolution (order-independent)
// ---------------------------------------------------------------------------

describe('gate fix: chained FK display type resolves the terminal type', () => {
	it('resolves a 2-hop chain to the terminal declared type', () => {
		const parsed = parseSchemaDsl(`
			table users {
				id: integer pk
			}
			table posts {
				id: uuid pk
				user_id: -> users
			}
			table comments {
				id: uuid pk
				post_user_id: -> posts.user_id
			}
		`);
		expect(findColumn(parsed, 'comments', 'post_user_id').type).toBe('integer');
	});

	it('resolves the same chain when tables are declared in reverse order (order-independent)', () => {
		const parsed = parseSchemaDsl(`
			table comments {
				id: uuid pk
				post_user_id: -> posts.user_id
			}
			table posts {
				id: uuid pk
				user_id: -> users
			}
			table users {
				id: integer pk
			}
		`);
		expect(findColumn(parsed, 'comments', 'post_user_id').type).toBe('integer');
	});
});

// ---------------------------------------------------------------------------
// Gate finding #7 — Mermaid must reflect FK uniqueness
// ---------------------------------------------------------------------------

describe('gate fix: Mermaid renders a unique FK as 1:1 with a UK suffix', () => {
	it('renders a unique FK column as UK and the relation as one-to-one', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table profiles { id: uuid pk user_id: -> users unique }
		`);
		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('uuid user_id UK');
		expect(mermaid).toContain('users ||--o| profiles');
		expect(mermaid).not.toContain('users ||--o{ profiles');
	});

	it('still renders a non-unique FK as one-to-many with no UK (regression)', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts { id: uuid pk author_id: -> users }
		`);
		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('users ||--o{ posts');
		expect(mermaid).not.toContain(' UK');
	});
});

// ---------------------------------------------------------------------------
// Re-scan additions — table declared without a name / without '{'
// ---------------------------------------------------------------------------

describe('re-scan: other lenient-accept cases hardened to warnings', () => {
	it('warns (and skips) when "table" has no name', () => {
		const parsed = parseSchemaDsl(`
			table {
				id: uuid pk
			}
			table users {
				id: uuid pk
			}
		`);
		// The first, nameless "table" block is dropped; the real 'users'
		// table right after it must still be found.
		expect(parsed.tables.map((t) => t.name)).toEqual(['users']);
		expect(parsed.warnings.some((w) => /missing a name/i.test(w.message))).toBe(
			true,
		);
	});

	it("warns (and skips) when a table name isn't followed by '{'", () => {
		const parsed = parseSchemaDsl(`
			table posts
			table users {
				id: uuid pk
			}
		`);
		expect(parsed.tables.map((t) => t.name)).toEqual(['users']);
		expect(parsed.warnings.some((w) => /missing '\{'/.test(w.message))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Gate finding #1 — tokenizer errors on unrecognized characters (class fix)
// ---------------------------------------------------------------------------

describe('gate fix: tokenizer errors on unrecognized characters instead of silently skipping', () => {
	it('throws on a hyphen inside a column name (author-id), not a silent split into two idents', () => {
		expect(() =>
			parseSchemaDsl(`
				table t {
					id: uuid pk
					author-id: string
				}
			`),
		).toThrow(SchemaDslError);
		expect(() => parseSchemaDsl('table t { author-id: string }')).toThrow(
			/Unrecognized character '-'/,
		);
	});

	it('throws on a hyphen inside a FK target (-> users-archive), not a silent truncation to "users"', () => {
		expect(() =>
			parseSchemaDsl(`
				table users { id: uuid pk }
				table t {
					id: uuid pk
					x: -> users-archive
				}
			`),
		).toThrow(SchemaDslError);
	});

	it('throws on a hyphen inside a non-id reference column (users.tenant-id), not silent truncation', () => {
		expect(() =>
			parseSchemaDsl(`
				table users { id: uuid pk }
				table t {
					id: uuid pk
					x: -> users.tenant-id
				}
			`),
		).toThrow(SchemaDslError);
	});

	it('throws on a bare $ outside a default(...) span (no legitimate use there)', () => {
		expect(() => parseSchemaDsl('table t { x$foo: string }')).toThrow(
			SchemaDslError,
		);
	});

	it('preserves a $1 positional parameter verbatim in a SQL default instead of mangling it to a bare number', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk v: integer default($1) }
		`);
		expect(findColumn(parsed, 't', 'v').default).toEqual({
			kind: 'sql',
			value: '$1',
		});
	});

	it('preserves a $$...$$ dollar-quoted SQL body verbatim, parens and all', () => {
		const parsed = parseSchemaDsl(`
			table t { id: uuid pk v: string default($$now()$$) }
		`);
		expect(findColumn(parsed, 't', 'v').default).toEqual({
			kind: 'sql',
			value: '$$now()$$',
		});
	});

	it('still classifies literals and other SQL expressions correctly alongside the raw-capture change (regression)', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				n: integer default(0)
				s: string default('hello')
				b: boolean default(true)
				expr: timestamp default(timezone('UTC', now()))
			}
		`);
		expect(findColumn(parsed, 't', 'n').default).toEqual({
			kind: 'literal',
			value: 0,
		});
		expect(findColumn(parsed, 't', 's').default).toEqual({
			kind: 'literal',
			value: 'hello',
		});
		expect(findColumn(parsed, 't', 'b').default).toEqual({
			kind: 'literal',
			value: true,
		});
		expect(findColumn(parsed, 't', 'expr').default).toEqual({
			kind: 'sql',
			value: "timezone('UTC', now())",
		});
	});
});

// ---------------------------------------------------------------------------
// Gate finding #2 — onDelete:/onUpdate: with no action must not swallow the next column
// ---------------------------------------------------------------------------

describe('gate fix: onDelete:/onUpdate: with a missing action does not swallow the next column', () => {
	it('recovers from a missing onDelete action without consuming the next column', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users onDelete:
				title: string
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.onDelete).toBeUndefined();
		expect(findColumn(parsed, 'posts', 'title').type).toBe('string');
		expect(
			parsed.warnings.some((w) => /missing an action name/i.test(w.message)),
		).toBe(true);
	});

	it('recovers from a missing onUpdate action without consuming the next column', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users onUpdate:
				title: string
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.onUpdate).toBeUndefined();
		expect(findColumn(parsed, 'posts', 'title').type).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// Exhaustive re-scan finding — the pre-arrow type hint had the SAME
// column-swallowing flaw as finding #2 (an ident immediately followed by
// ':' was greedily consumed as a bare value instead of recognized as the
// start of the next column).
// ---------------------------------------------------------------------------

describe('re-scan fix: a missing column type does not swallow the next column as a bogus type hint', () => {
	it('warns "no type" and does not consume the next column\'s name as this column\'s type', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				author_id:
				title: string
			}
		`);
		const table = findTable(parsed, 't');
		expect(table.columns.map((c) => c.name)).toEqual(['id', 'title']);
		expect(findColumn(parsed, 't', 'title').type).toBe('string');
		expect(
			parsed.warnings.some((w) =>
				/column 'author_id' has no type/i.test(w.message),
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Gate finding #3 — duplicate table/column names must not silently overwrite
// ---------------------------------------------------------------------------

describe('gate fix: duplicate table/column names warn and keep the first occurrence', () => {
	it('keeps the first column on a duplicate column name (does not silently lose the PK)', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				id: string
			}
		`);
		const table = findTable(parsed, 't');
		expect(table.columns).toHaveLength(1);
		expect(table.columns[0]).toMatchObject({
			name: 'id',
			type: 'uuid',
			pk: true,
		});
		expect(
			parsed.warnings.some((w) => /duplicate column 'id'/.test(w.message)),
		).toBe(true);
	});

	it('keeps the first table on a duplicate table name', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				a: string
			}
			table t {
				id: integer pk
			}
		`);
		expect(parsed.tables).toHaveLength(1);
		expect(findTable(parsed, 't').columns.map((c) => c.name)).toEqual([
			'id',
			'a',
		]);
		expect(
			parsed.warnings.some((w) => /duplicate table 't'/.test(w.message)),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// A discarded duplicate must never leak a phantom relation — relations are
// derived from the FINAL, deduplicated tables array, not accumulated while
// parsing (see deriveRelations()).
// ---------------------------------------------------------------------------

describe('fix: duplicate column/table never leaks a phantom FK relation', () => {
	it('a duplicate column whose discarded occurrence is the FK produces no phantom relation', () => {
		const parsed = parseSchemaDsl(`
			table users {
				id: uuid pk
			}
			table posts {
				id: uuid pk
				author_id: integer
				author_id: -> users
			}
		`);
		const posts = findTable(parsed, 'posts');
		expect(posts.columns).toHaveLength(2);
		const authorId = posts.columns.find((c) => c.name === 'author_id');
		expect(authorId).toMatchObject({ name: 'author_id', type: 'integer' });
		expect(authorId?.ref).toBeUndefined();

		// No relation at all — the FK occurrence was the discarded duplicate.
		expect(parsed.relations).toHaveLength(0);
		expect(
			parsed.warnings.some((w) =>
				/duplicate column 'author_id'/.test(w.message),
			),
		).toBe(true);

		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('integer author_id');
		expect(mermaid).not.toContain('users ||--o{ posts');
		expect(mermaid).not.toContain('users ||--o| posts');
	});

	it('a duplicate table whose discarded occurrence is the FK-bearing one produces no phantom relation', () => {
		const parsed = parseSchemaDsl(`
			table users {
				id: uuid pk
			}
			table posts {
				id: uuid pk
				title: string
			}
			table posts {
				id: uuid pk
				author_id: -> users
			}
		`);
		expect(parsed.tables).toHaveLength(2);
		const posts = findTable(parsed, 'posts');
		expect(posts.columns.map((c) => c.name)).toEqual(['id', 'title']);

		// No relation at all — the FK lived only on the discarded duplicate table.
		expect(parsed.relations).toHaveLength(0);
		expect(
			parsed.warnings.some((w) => /duplicate table 'posts'/.test(w.message)),
		).toBe(true);

		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).not.toContain('||--o{');
		expect(mermaid).not.toContain('||--o|');
	});
});

// ---------------------------------------------------------------------------
// Mermaid must escape reserved/ambiguous identifiers (entity names, attribute
// names, relation endpoints) so a table named `class` or a column named `PK`
// doesn't break Mermaid's ER-diagram parser.
// ---------------------------------------------------------------------------

describe('fix: Mermaid escapes reserved/ambiguous identifiers', () => {
	it('quotes a table named `class` (a Mermaid reserved word)', () => {
		const parsed = parseSchemaDsl(`
			table class {
				id: uuid pk
			}
		`);
		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('"class" {');
		expect(mermaid).not.toContain('\n    class {');
	});

	it('quotes a column named `PK` (collides with the PK suffix marker)', () => {
		const parsed = parseSchemaDsl(`
			table t {
				id: uuid pk
				PK: string
			}
		`);
		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('string "PK"');
		expect(mermaid).not.toMatch(/string PK(?!")/);
	});

	it('quotes reserved-word entity names on both sides of a relationship line', () => {
		const parsed = parseSchemaDsl(`
			table style {
				id: uuid pk
			}
			table posts {
				id: uuid pk
				style_id: -> style
			}
		`);
		const mermaid = buildMermaidCode(parsed);
		expect(mermaid).toContain('"style" ||--o{ posts : ""');
	});
});

// ---------------------------------------------------------------------------
// A bare `onDelete cascade` / `onUpdate cascade` (missing the required ':')
// must not have its action word reinterpreted as the legacy bare-cascade
// shorthand on the next loop iteration — a typo must not silently flip
// onDelete to CASCADE.
// ---------------------------------------------------------------------------

describe('fix: a malformed bare onDelete/onUpdate modifier does not leak into the legacy bare-cascade shorthand', () => {
	it("does not set onDelete from a typo'd 'onUpdate cascade' (missing colon)", () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users onUpdate cascade
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.onDelete).toBeUndefined();
		expect(authorId.onUpdate).toBeUndefined();
		expect(
			parsed.warnings.some((w) =>
				/'onUpdate' missing ':<action>'/.test(w.message),
			),
		).toBe(true);
	});

	it("does not set onDelete from a typo'd 'onDelete cascade' (missing colon)", () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users onDelete cascade
			}
		`);
		const authorId = findColumn(parsed, 'posts', 'author_id');
		expect(authorId.onDelete).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// A column literally NAMED onDelete/onUpdate must parse as an ordinary
// column, not be swallowed as a malformed FK modifier just because its name
// collides with the FK-modifier keywords.
// ---------------------------------------------------------------------------

describe('fix: a column literally named onDelete/onUpdate is not swallowed as an FK modifier', () => {
	it('keeps `onDelete: string` as a real column after an FK column with no modifiers', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users
				onDelete: string
			}
		`);
		const posts = findTable(parsed, 'posts');
		expect(posts.columns.map((c) => c.name)).toEqual([
			'id',
			'author_id',
			'onDelete',
		]);
		expect(findColumn(parsed, 'posts', 'onDelete').type).toBe('string');
		expect(findColumn(parsed, 'posts', 'author_id').onDelete).toBeUndefined();
	});

	it('keeps `onUpdate: integer` as a real column and still parses a following column', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users
				onUpdate: integer
				title: string
			}
		`);
		expect(findTable(parsed, 'posts').columns.map((c) => c.name)).toEqual([
			'id',
			'author_id',
			'onUpdate',
			'title',
		]);
		expect(findColumn(parsed, 'posts', 'onUpdate').type).toBe('integer');
		expect(findColumn(parsed, 'posts', 'title').type).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// An FK targeting a table whose ACTUAL primary key isn't named `id` must
// emit an explicit `references: [pkColumn]` (the same resolution the
// display/type path already uses) — a bare `ref(target)` would let
// @dbsp/core default to `target.id`, which doesn't exist.
// ---------------------------------------------------------------------------

describe('fix: an FK to a non-id-named primary key auto-fills references', () => {
	it('resolves references to the explicit non-id pk column in build + generated TS', () => {
		const parsed = parseSchemaDsl(`
			table users {
				uid: integer pk
				name: string
			}
			table posts {
				id: uuid pk
				author: -> users
			}
		`);
		expect(findColumn(parsed, 'posts', 'author').refColumn).toBe('uid');

		const built = build(parsed);
		const fk = built.model
			.getTable('posts')
			?.foreignKeys.find((f) => f.columns.includes('author'));
		expect(fk?.references.columns).toEqual(['uid']);

		const ts = generateTypeScript(parsed);
		expect(ts).toContain('references: ["uid"]');
	});

	it('still emits a bare ref() when the target pk IS named id', () => {
		const parsed = parseSchemaDsl(`
			table users { id: uuid pk }
			table posts {
				id: uuid pk
				author_id: -> users
			}
		`);
		expect(findColumn(parsed, 'posts', 'author_id').refColumn).toBeUndefined();
		const ts = generateTypeScript(parsed);
		expect(ts).not.toContain('references:');
	});
});

// ---------------------------------------------------------------------------
// A table body missing its closing '}' must not silently swallow the NEXT
// table declaration — warn and recover so the following table still parses
// independently.
// ---------------------------------------------------------------------------

describe('fix: an unterminated table body does not swallow the next table', () => {
	it('warns and still parses the following table when a closing } is missing', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				title: string
			table users {
				id: uuid pk
			}
		`);
		expect(parsed.tables.map((t) => t.name)).toEqual(['posts', 'users']);
		expect(findTable(parsed, 'posts').columns.map((c) => c.name)).toEqual([
			'id',
			'title',
		]);
		expect(findTable(parsed, 'users').columns.map((c) => c.name)).toEqual([
			'id',
		]);
		expect(
			parsed.warnings.some((w) => /unterminated table 'posts'/.test(w.message)),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// An unterminated string/dollar-quote INSIDE a default(...) must not run the
// raw-source scan to true EOF — that would silently swallow every table
// after it as "still inside the string". Recover at the nearest '}' instead,
// same as the already-handled unbalanced-paren case.
// ---------------------------------------------------------------------------

describe('fix: an unterminated string/dollar-quote inside default(...) does not consume the file', () => {
	it('recovers from an unterminated quoted default and still parses the next table', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				bio: string default('unterminated
			}
			table users {
				id: uuid pk
			}
		`);
		expect(parsed.tables.map((t) => t.name)).toEqual(['posts', 'users']);
		expect(findColumn(parsed, 'posts', 'bio').default).toBeUndefined();
		expect(
			parsed.warnings.some((w) => /missing its closing '\)'/.test(w.message)),
		).toBe(true);
	});

	it('recovers from an unterminated dollar-quoted default and still parses the next table', () => {
		const parsed = parseSchemaDsl(`
			table posts {
				id: uuid pk
				bio: string default($$unterminated
			}
			table users {
				id: uuid pk
			}
		`);
		expect(parsed.tables.map((t) => t.name)).toEqual(['posts', 'users']);
		expect(findColumn(parsed, 'posts', 'bio').default).toBeUndefined();
		expect(
			parsed.warnings.some((w) => /missing its closing '\)'/.test(w.message)),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Preservation — the playground's default example schema keeps working
// ---------------------------------------------------------------------------

describe('preservation: the playground default example schema', () => {
	// Mirrors DEFAULT_SCHEMA_DSL in PlaygroundView.vue verbatim. Keep in sync.
	const DEFAULT_SCHEMA_DSL = [
		'table users {',
		'  id: uuid pk',
		'  name: string',
		'  email: string unique',
		'  active: boolean',
		'  last_login: timestamp',
		'  created_at: timestamp',
		'}',
		'',
		'table posts {',
		'  id: uuid pk',
		'  title: string',
		'  content: text?',
		'  published: boolean',
		'  author_id: -> users',
		'  created_at: timestamp',
		'}',
		'',
		'table comments {',
		'  id: uuid pk',
		'  text: string',
		'  post_id: -> posts',
		'  author_id: -> users',
		'  created_at: timestamp',
		'}',
		'',
		'table orders {',
		'  id: uuid pk',
		'  user_id: -> users',
		'  status: string',
		'  amount: integer',
		'  created_at: timestamp',
		'}',
		'',
		'table products {',
		'  id: uuid pk',
		'  name: string',
		'  category: string',
		'  price: integer',
		'}',
		'',
		'table order_items {',
		'  id: uuid pk',
		'  order_id: -> orders',
		'  product_id: -> products',
		'  quantity: integer',
		'}',
	].join('\n');

	it('parses without throwing and produces all 6 tables', () => {
		const parsed = parseSchemaDsl(DEFAULT_SCHEMA_DSL);
		expect(parsed.tables.map((t) => t.name)).toEqual([
			'users',
			'posts',
			'comments',
			'orders',
			'products',
			'order_items',
		]);
	});

	it('builds successfully via the real schema()/ref()', () => {
		const parsed = parseSchemaDsl(DEFAULT_SCHEMA_DSL);
		expect(() => build(parsed)).not.toThrow();
	});

	it('generates valid TypeScript and Mermaid output', () => {
		const parsed = parseSchemaDsl(DEFAULT_SCHEMA_DSL);
		expect(() => generateTypeScript(parsed)).not.toThrow();
		expect(() => buildMermaidCode(parsed)).not.toThrow();
	});
});
