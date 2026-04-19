import { describe, expect, it } from 'vitest';
import { generateCreateIndexSQL } from '../ddl/index-operations.js';
import { generateAlterColumnSQL } from '../ddl/table-operations.js';

describe('SQL Injection Checks (DDL-TABLE-001)', () => {
	it('throws when creating index with unsafe WITH options', () => {
		expect(() =>
			generateCreateIndexSQL('users', {
				name: 'idx',
				columns: ['id'],
				with: { 'fillfactor = 10; DROP TABLE users; --': 1 },
			}),
		).toThrow(/Invalid storage parameter identifier/);
	});
});

// ── typeof guard (symmetry with migration-sql M-1 fix, dcd7b15) ──────────────

describe('table-operations formatDefault({ sql }) — typeof runtime guard (DDL-TABLE-003)', () => {
	it('throws with clear message when { sql } value is not a string (number)', () => {
		// Passing { sql: 42 } must fail the typeof check BEFORE validateSqlExpression.
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: 42 as unknown as string },
			}),
		).toThrow(/expected string, got number/);
	});

	it('throws when { sql } value is null', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: null as unknown as string },
			}),
		).toThrow(/expected string, got object/);
	});

	it('throws when { sql } value is an object', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: {} as unknown as string },
			}),
		).toThrow(/expected string, got object/);
	});

	it('accepts valid string { sql } without throwing', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: 'gen_random_uuid()' },
			}),
		).not.toThrow();
	});
});

describe('SQL Injection Checks — setDefault { sql } escape hatch (DDL-TABLE-002)', () => {
	it('throws on semicolon injection in setDefault sql escape hatch', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: 'NOW(); DROP TABLE users --' },
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on line-comment injection (--) in setDefault sql escape hatch', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: 'NOW() -- injected' },
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on block-comment injection (/*) in setDefault sql escape hatch', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'status', {
				setDefault: { sql: "/* comment */ 'active'" },
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on dollar-quote injection in setDefault sql escape hatch', () => {
		// validateSqlExpression forbids adjacent dollar-signs (dollar-quoted strings).
		// Use fromCharCode to construct $ without literal dollar signs in the source
		// (the test transport layer strips $-signs from string literals).
		const dollar = String.fromCharCode(36);
		const dollarQuote = dollar + dollar;
		expect(() =>
			generateAlterColumnSQL('users', 'label', {
				setDefault: { sql: `${dollarQuote}injected${dollarQuote}` },
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects backslash in { sql }', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'col', {
				setDefault: { sql: 'NOW() \\foo' },
			}),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows safe expressions in setDefault sql escape hatch', () => {
		expect(() =>
			generateAlterColumnSQL('users', 'created_at', {
				setDefault: { sql: 'NOW()' },
			}),
		).not.toThrow();

		expect(() =>
			generateAlterColumnSQL('users', 'id', {
				setDefault: { sql: 'gen_random_uuid()' },
			}),
		).not.toThrow();

		expect(() =>
			generateAlterColumnSQL('users', 'status', {
				setDefault: { sql: "'active'" },
			}),
		).not.toThrow();
	});
});
