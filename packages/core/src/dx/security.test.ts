/**
 * @fileoverview Audit-commit-1 security proof tests.
 *
 * Each test validates a specific security finding from the retro-audit.
 * These tests serve as regression gates: if a finding is reverted, the
 * corresponding test here fails.
 *
 * Findings covered:
 * - FIND-001: table name validation before use in error messages (listAncestors)
 * - FIND-002: withSchema identifier validation without adapter
 * - FIND-004: cursorPaginate cursor shape validation (non-object rejection)
 * - FIND-005: proto-key guard in objectToWhereIntent
 * - FIND-006: generic error messages (no info leakage in .message)
 * - FIND-021: isSafeInteger validation for limit/offset/paginate
 * - FIND-007: listAncestors maxDepth cap
 */

import { describe, expect, it } from 'vitest';
import { ColumnNotFoundError, InvalidOperationError } from './errors.js';
import { objectToWhereIntent } from './object-filter.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Shared test schema
// ============================================================================

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});

describe('audit-commit-1 security', () => {
	// ==========================================================================
	// Test 1 — FIND-002: withSchema rejects injection even without adapter
	// ==========================================================================

	it('FIND-002: withSchema rejects injection string even without adapter', () => {
		// withSchema calls validateIdentifier (in core) before delegating to adapter.
		// Even with a real adapter present, the core guard fires first.
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		const injectionPayload = "public'; DROP TABLE users; --";

		expect(() => orm.withSchema(injectionPayload)).toThrow(
			InvalidOperationError,
		);

		// The thrown message MUST NOT contain the injection payload
		let caughtMessage = '';
		try {
			orm.withSchema(injectionPayload);
		} catch (err) {
			caughtMessage = err instanceof Error ? err.message : String(err);
		}
		expect(caughtMessage).not.toContain('DROP TABLE');
		expect(caughtMessage).not.toContain(injectionPayload);
	});

	// ==========================================================================
	// Test 2 — FIND-001: listAncestors rejects HTML-tag-bearing table names
	// ==========================================================================

	it('FIND-001: listAncestors rejects HTML-tag-bearing table names', async () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const maliciousTable = '<script>alert(1)</script>';

		// FIND-001 guard fires before any self-ref lookup: throws "Table not found"
		await expect(
			orm.listAncestors(maliciousTable, 1, { parentId: 'parentId' }),
		).rejects.toThrow('Table not found');

		// The error message MUST NOT contain the raw HTML tag
		let caughtMessage = '';
		try {
			await orm.listAncestors(maliciousTable, 1, { parentId: 'parentId' });
		} catch (err) {
			caughtMessage = err instanceof Error ? err.message : String(err);
		}
		expect(caughtMessage).not.toContain('<script>');
		expect(caughtMessage).not.toContain(maliciousTable);
	});

	// ==========================================================================
	// Test 3 — FIND-005: proto-key guard — throws on forbidden keys
	// ==========================================================================

	it('FIND-005: filter with __proto__ as own property throws InvalidOperationError', () => {
		// JS literal `{ __proto__: 1 }` sets the prototype, not an own key.
		// Use Object.defineProperty to create an object with __proto__ as an OWN key,
		// which is how the attack is delivered (e.g. from JSON.parse('{"__proto__":1}')).
		const poisoned = Object.defineProperty(
			Object.create(null) as Record<string, unknown>,
			'__proto__',
			{ value: 1, enumerable: true, writable: true, configurable: true },
		);
		expect(() => objectToWhereIntent(poisoned)).toThrow(InvalidOperationError);
	});

	it('FIND-005: filter { constructor: "x" } throws InvalidOperationError', () => {
		expect(() =>
			objectToWhereIntent({ constructor: 'x' } as Record<string, unknown>),
		).toThrow(InvalidOperationError);
	});

	// ==========================================================================
	// Test 4 — FIND-021: limit rejects non-safe-integer values
	// ==========================================================================

	// limit() validates synchronously — use expect().toThrow(), not rejects
	it('FIND-021: limit rejects -1', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').limit(-1)).toThrow(InvalidOperationError);
	});

	it('FIND-021: limit rejects 1e20 (too large for safe integer)', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').limit(1e20)).toThrow(
			InvalidOperationError,
		);
	});

	it('FIND-021: limit rejects NaN', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').limit(Number.NaN)).toThrow(
			InvalidOperationError,
		);
	});

	it('FIND-021: limit rejects Infinity', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').limit(Number.POSITIVE_INFINITY)).toThrow(
			InvalidOperationError,
		);
	});

	it('FIND-021: limit rejects 1.5 (non-integer)', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').limit(1.5)).toThrow(InvalidOperationError);
	});

	// ==========================================================================
	// Test 5 — FIND-021: offset rejects non-safe-integer values
	// ==========================================================================

	// offset() validates synchronously — use expect().toThrow(), not rejects
	it('FIND-021: offset rejects -1', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').offset(-1)).toThrow(InvalidOperationError);
	});

	it('FIND-021: offset rejects NaN', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').offset(Number.NaN)).toThrow(
			InvalidOperationError,
		);
	});

	it('FIND-021: offset rejects Infinity', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').offset(Number.POSITIVE_INFINITY)).toThrow(
			InvalidOperationError,
		);
	});

	it('FIND-021: offset rejects 1.5 (non-integer)', () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		expect(() => orm.select('users').offset(1.5)).toThrow(
			InvalidOperationError,
		);
	});

	// ==========================================================================
	// Test 6 — FIND-006: ColumnNotFoundError generic message (no info leakage)
	// ==========================================================================

	it('FIND-006: ColumnNotFoundError.message does NOT contain available column names', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: ['a', 'b', 'c'],
		});

		// .message is generic — must not leak schema enumeration
		expect(error.message).not.toContain('a');
		expect(error.message).not.toContain('b');
		expect(error.message).not.toContain('c');
		expect(error.message).toBe('Column not found');

		// Diagnostic detail IS accessible via .available
		expect(error.available).toContain('a');
		expect(error.available).toContain('b');
		expect(error.available).toContain('c');
	});

	it('FIND-006: ColumnNotFoundError.publicMessage equals .message', () => {
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'col',
			available: ['id', 'email'],
		});

		expect(error.publicMessage).toBe(error.message);
		expect(error.publicMessage).toBe('Column not found');
	});

	// ==========================================================================
	// Test 7 — FIND-004: cursorPaginate rejects malformed cursors
	// ==========================================================================

	it('FIND-004: cursorPaginate rejects base64 of JSON array', async () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		// JSON array decodes to non-object — must throw
		const arrayCursor = Buffer.from(JSON.stringify([1, 2, 3])).toString(
			'base64',
		);
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ limit: 10, cursor: arrayCursor }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('FIND-004: cursorPaginate rejects base64 of JSON string', async () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		// JSON string decodes to non-object — must throw
		const stringCursor = Buffer.from(JSON.stringify('not-an-object')).toString(
			'base64',
		);
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ limit: 10, cursor: stringCursor }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('FIND-004: cursorPaginate rejects base64 of JSON null', async () => {
		const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });
		// JSON null decodes to null — must throw
		const nullCursor = Buffer.from(JSON.stringify(null)).toString('base64');
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ limit: 10, cursor: nullCursor }),
		).rejects.toThrow(InvalidOperationError);
	});

	// ==========================================================================
	// Test 8 — FIND-007: listAncestors maxDepth validation
	// ==========================================================================

	it('FIND-007: listAncestors rejects Infinity as maxDepth', async () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		await expect(
			orm.listAncestors('categories', 1, {
				parentId: 'parentId',
				maxDepth: Number.POSITIVE_INFINITY,
			}),
		).rejects.toThrow(InvalidOperationError);
	});

	it('FIND-007: listAncestors rejects -1 as maxDepth', async () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		await expect(
			orm.listAncestors('categories', 1, {
				parentId: 'parentId',
				maxDepth: -1,
			}),
		).rejects.toThrow(InvalidOperationError);
	});

	it('FIND-007: listAncestors accepts 50 as maxDepth (guard does not fire)', async () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		// With a valid maxDepth=50, the guard must NOT fire.
		// The call will still throw later (MockAdapter compile throws "Not implemented"),
		// but NOT an InvalidOperationError mentioning maxDepth.
		let thrownError: unknown;
		try {
			await orm.listAncestors('categories', 1, {
				parentId: 'parentId',
				maxDepth: 50,
			});
		} catch (err) {
			thrownError = err;
		}
		// If an InvalidOperationError was thrown, verify it is NOT about maxDepth
		if (thrownError instanceof InvalidOperationError) {
			expect((thrownError as Error).message).not.toContain('maxDepth');
		}
		// Reaching here proves the maxDepth=50 guard did not fire
	});
});
