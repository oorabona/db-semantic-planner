/**
 * @fileoverview Error path tests for QueryBuilderImpl.
 *
 * Covers:
 * - firstOrThrow: no results → NotFoundError
 * - byIdOrThrow: no match → NotFoundError
 * - buildPkCondition: empty composite PK
 * - paginate: page < 1, perPage < 1
 * - cursorPaginate: limit < 1, missing orderBy, invalid cursor
 * - getConfiguredAdapter: no adapter → ExecutionError
 * - handleAmbiguity: strict mode → AmbiguousRelationError
 * - Hook error chains: beforeQuery throws → onError fires
 */

import { NotYetSupportedError } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../adapter.js';
import { caseWhen } from './case-when-builder.js';
import {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
} from './errors.js';
import { ref as exprRef, literal } from './expressions.js';
import { distinct, eq, sql } from './filters.js';
import { createHookManager } from './hooks.js';
import { createOrm } from './orm.js';
import { QueryBuilderImpl } from './query-builder.js';
import { ref, schema } from './schema.js';
import { outerRef, subquery } from './subquery-builder.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'text',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	order_lines: {
		order_id: 'integer',
		product_id: 'integer',
		quantity: 'integer',
	},
});

const orm = createOrm({ adapter: createMockAdapter(), schema: testSchema });

// ============================================================================
// Spy Adapter — returns configurable results
// ============================================================================

function createSpyAdapter(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT * FROM "users"',
		parameters: [] as readonly unknown[],
	}));
	const executeSpy = vi.fn(() => Promise.resolve(executeResult));
	const createDumpSpy = vi.fn(
		(
			_plan: unknown,
			compiled: { sql: string; parameters: readonly unknown[] },
		) =>
			({
				sql: compiled.sql,
				params: compiled.parameters,
				plan: {},
			}) as unknown as Dump,
	);

	const adapter = {
		...base,
		compile: compileSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_schemaName: string) => adapter,
	} as unknown as Adapter;
	return adapter;
}

// ============================================================================
// firstOrThrow — NotFoundError
// ============================================================================

describe('firstOrThrow — error paths', () => {
	it('should throw NotFoundError when no results found', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').firstOrThrow()).rejects.toThrow(
			NotFoundError,
		);
	});

	it('should include table name in NotFoundError', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').firstOrThrow()).rejects.toThrow(
			/users/,
		);
	});

	it('should not throw when result exists', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		const result = await ormWithSpy.select('users').firstOrThrow();
		expect(result).toEqual({ id: 1, name: 'Alice' });
	});
});

// ============================================================================
// byIdOrThrow — NotFoundError
// ============================================================================

describe('byIdOrThrow — error paths', () => {
	it('should throw NotFoundError when ID not found', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').byIdOrThrow(999)).rejects.toThrow(
			NotFoundError,
		);
	});

	it('should include hint about primary key in NotFoundError', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').byIdOrThrow(999)).rejects.toThrow(
			/primary key/i,
		);
	});
});

// ============================================================================
// buildPkCondition — composite PK errors
// ============================================================================

describe('buildPkCondition — composite PK error paths', () => {
	it('should throw when composite PK is empty object', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('order_lines').byId({})).rejects.toThrow(
			'Composite primary key cannot be empty',
		);
	});
});

// ============================================================================
// paginate — validation errors
// ============================================================================

describe('paginate — error paths', () => {
	it('should throw InvalidOperationError when page < 1', async () => {
		await expect(
			orm.select('users').paginate({ page: 0, perPage: 10 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include "Page must be >= 1" in error message', async () => {
		// FIND-021: new message uses "positive safe integer" phrasing
		await expect(orm.select('users').paginate({ page: 0 })).rejects.toThrow(
			/page must be a positive safe integer/,
		);
	});

	it('should throw InvalidOperationError when page is negative', async () => {
		await expect(orm.select('users').paginate({ page: -1 })).rejects.toThrow(
			InvalidOperationError,
		);
	});

	it('should throw InvalidOperationError when perPage < 1', async () => {
		await expect(
			orm.select('users').paginate({ page: 1, perPage: 0 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include "perPage must be >= 1" in error message', async () => {
		// FIND-021: new message uses "positive safe integer" phrasing
		await expect(
			orm.select('users').paginate({ page: 1, perPage: 0 }),
		).rejects.toThrow(/perPage must be a positive safe integer/);
	});

	it('should throw when perPage is negative', async () => {
		await expect(
			orm.select('users').paginate({ page: 1, perPage: -5 }),
		).rejects.toThrow(InvalidOperationError);
	});
});

// ============================================================================
// cursorPaginate — validation errors
// ============================================================================

describe('cursorPaginate — error paths', () => {
	it('should NOT throw when limit is 0 (empty page accepted)', async () => {
		// L-3: limit=0 is now accepted — returns empty page, consistent with .limit(0).
		// Use createSpyAdapter so execute() is implemented (createMockAdapter throws).
		const adapter = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		await expect(
			o.select('users').orderBy('id').cursorPaginate({ limit: 0 }),
		).resolves.toBeDefined();
	});

	it('should throw InvalidOperationError when limit is negative', async () => {
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ limit: -1 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include "non-negative safe integer" in error message for negative limit', async () => {
		// FIND-021: updated phrasing — limit=0 now valid, message reflects non-negative
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ limit: -1 }),
		).rejects.toThrow(/limit must be a non-negative safe integer/);
	});

	it('should throw when limit is negative', async () => {
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ limit: -1 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw InvalidOperationError when orderBy is missing', async () => {
		await expect(
			orm.select('users').cursorPaginate({ limit: 10 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should mention orderBy requirement in error message', async () => {
		await expect(
			orm.select('users').cursorPaginate({ limit: 10 }),
		).rejects.toThrow(/orderBy clause/);
	});

	it('should throw InvalidOperationError for invalid cursor string', async () => {
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ cursor: '!!!not-valid-base64!!!' }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should mention "Invalid cursor format" in error message', async () => {
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ cursor: '!!!not-base64!!!' }),
		).rejects.toThrow(/Invalid cursor format/);
	});

	it('should throw for cursor that is valid base64 but invalid JSON', async () => {
		// "not json" encoded as base64
		const badCursor = Buffer.from('not json at all').toString('base64');
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ cursor: badCursor }),
		).rejects.toThrow(InvalidOperationError);
	});
});

// ============================================================================
// getConfiguredAdapter — no adapter
// ============================================================================

describe('getConfiguredAdapter — error paths', () => {
	it('should throw ExecutionError when all() called without adapter', async () => {
		// Construct a QueryBuilderImpl directly without adapter
		const builder = new QueryBuilderImpl(
			{ model: testSchema.model, strictMode: false },
			'users',
		);

		await expect(builder.all()).rejects.toThrow(ExecutionError);
	});

	it('should include "Adapter not configured" in error message', async () => {
		const builder = new QueryBuilderImpl(
			{ model: testSchema.model, strictMode: false },
			'users',
		);

		await expect(builder.all()).rejects.toThrow(/Adapter not configured/);
	});

	it('should throw ExecutionError on first() without adapter', async () => {
		const builder = new QueryBuilderImpl(
			{ model: testSchema.model, strictMode: false },
			'users',
		);

		await expect(builder.first()).rejects.toThrow(ExecutionError);
	});
});

// ============================================================================
// handleAmbiguity — strict mode AmbiguousRelationError
// ============================================================================

describe('handleAmbiguity — strict mode', () => {
	// Create schema with ambiguous relations (multiple FKs to same table)
	const ambiguousSchema = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		messages: {
			id: { type: 'integer', primaryKey: true },
			text: 'string',
			senderId: ref('users', { as: 'sender', inverse: 'sentMessages' }),
			receiverId: ref('users', { as: 'receiver', inverse: 'receivedMessages' }),
		},
	});

	it('should throw AmbiguousRelationError in strict mode for ambiguous include', () => {
		const strictOrm = createOrm({
			adapter: createMockAdapter(),
			schema: ambiguousSchema,
			strictMode: true,
		});

		expect(() => strictOrm.select('messages').include('users').plan()).toThrow(
			AmbiguousRelationError,
		);
	});

	it('should not throw in lenient mode for ambiguous include (adds warning)', () => {
		const lenientOrm = createOrm({
			adapter: createMockAdapter(),
			schema: ambiguousSchema,
			strictMode: false,
		});

		const planReport = lenientOrm.select('messages').include('users').plan();
		// In lenient mode, it should resolve automatically and add a warning
		expect(planReport.warnings.length).toBeGreaterThan(0);
		expect(planReport.warnings[0]?.code).toBe('AMBIGUOUS_RELATION');
	});
});

// ============================================================================
// Hook error chains — query builder
// ============================================================================

describe('Query hook error chains', () => {
	it('should fire onError when beforeQuery throws', async () => {
		const hookError = new Error('beforeQuery hook failed');
		const transformedError = new Error('Transformed by onError');

		const adapter = createSpyAdapter([{ id: 1 }]);
		const hookManager = createHookManager()
			.beforeQuery(() => {
				throw hookError;
			})
			.onError(() => transformedError);

		const ormWithHooks = createOrm({
			adapter,
			schema: testSchema,
			hooks: hookManager,
		});

		await expect(ormWithHooks.select('users').all()).rejects.toThrow(
			'Transformed by onError',
		);
	});

	it('should propagate original error when no onError hooks', async () => {
		const adapter = createSpyAdapter([{ id: 1 }]);
		const hookManager = createHookManager().beforeQuery(() => {
			throw new Error('hook boom');
		});

		const ormWithHooks = createOrm({
			adapter,
			schema: testSchema,
			hooks: hookManager,
		});

		await expect(ormWithHooks.select('users').all()).rejects.toThrow(
			'hook boom',
		);
	});

	it('should fire onError when afterQuery throws', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const hookManager = createHookManager()
			.afterQuery(() => {
				throw new Error('afterQuery hook failed');
			})
			.onError(() => new Error('Transformed after'));

		const ormWithHooks = createOrm({
			adapter,
			schema: testSchema,
			hooks: hookManager,
		});

		await expect(ormWithHooks.select('users').all()).rejects.toThrow(
			'Transformed after',
		);
	});
});

// ============================================================================
// NotFoundError shape
// ============================================================================

describe('NotFoundError shape', () => {
	it('should have table property set', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({ adapter, schema: testSchema });

		try {
			await ormWithSpy.select('users').firstOrThrow();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(NotFoundError);
			expect((error as NotFoundError).table).toBe('users');
		}
	});

	it('should have hint property on byIdOrThrow', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({ adapter, schema: testSchema });

		try {
			await ormWithSpy.select('users').byIdOrThrow(42);
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(NotFoundError);
			expect((error as NotFoundError).hint).toContain('primary key');
		}
	});
});

describe('#1015 builder aggregates refuse an expression projection', () => {
	const message =
		"Invalid aggregate: count(), sum(), avg(), min() and max() combine only with string columns(); with an expression projection from columns() or coalesce(), put the aggregate in columns(), e.g. columns([exprRef('a').as('x'), fn('count', star()).as('n')])";

	it('refuses expression columns set after the aggregate', () => {
		const query = orm
			.select('users')
			.groupBy(['name'])
			.count({ as: 'n' })
			.columns([exprRef('name').as('label')]);
		expect(() => query.dump()).toThrow(InvalidOperationError);
		expect(() => query.dump()).toThrow(message);
	});

	it('refuses expression columns set before the aggregate', () => {
		const query = orm
			.select('users')
			.columns([exprRef('name').as('label')])
			.groupBy(['name'])
			.max('id', 'top');
		expect(() => query.dump()).toThrow(message);
	});

	it('refuses a coalesce() projection beside an aggregate', () => {
		const query = orm
			.select('users')
			.groupBy(['name'])
			.coalesce(['name'], 'label')
			.count();
		expect(() => query.dump()).toThrow(message);
	});

	it('refuses on execution before reaching the adapter', async () => {
		// The mock adapter throws "not implemented" if reached, so only the
		// builder's own refusal carries this message.
		const query = orm
			.select('users')
			.groupBy(['name'])
			.sum('id', 'total')
			.columns([exprRef('name').as('label')]);
		await expect(query.all()).rejects.toThrow(message);
	});
});

// ============================================================================
// ADR 0011 delivery 3: ordering, grouping and aggregate leaves
// ============================================================================

describe('ordering, grouping and aggregate leaf refusals (ADR 0011 delivery 3)', () => {
	const users = orm.tables.users;
	const NOT_A_COLUMN = 'is not a column; use a column name or a ColumnRef';
	const OBJECT_HINT =
		'is not an expression argument; use literal(null), param(value) or an expression';
	const SQL_MESSAGE =
		'sql() is only accepted as an update or upsert value; use literal(), param() or an expression here';

	function thrown(build: () => unknown): unknown {
		try {
			build();
		} catch (error) {
			return error;
		}
		throw new Error('expected a refusal, got none');
	}

	function expectNotYet(
		build: () => unknown,
		construct: string,
		position: string,
		issue: number,
	): void {
		const error = thrown(build);
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({ construct, position, issue });
	}

	function expectInvalid(build: () => unknown, message: string): void {
		const error = thrown(build);
		expect(error).toBeInstanceOf(InvalidOperationError);
		expect((error as Error).message).toBe(message);
	}

	const q = () => orm.select('users') as any;

	it('R1c orderBy constants: a Date, a boolean, a bigint or a non-position number does not order rows', () => {
		for (const [leaf, kind] of [
			[new Date(0), 'a Date'],
			[true, 'a boolean'],
			[1n, 'a bigint'],
			[Number.NaN, 'the number NaN'],
			[1.5, 'the number 1.5'],
			[0, 'the number 0'],
		] as const)
			expectInvalid(
				() => q().orderBy(leaf),
				`Invalid orderBy: ${kind} does not name a column or an expression to order by`,
			);
	});

	it('R1c orderBy list constants: the list form refuses the same leaves and arrays', () => {
		expectInvalid(
			() => q().orderBy([{ column: new Date(0) }]),
			'Invalid orderBy: a Date does not name a column or an expression to order by',
		);
		expectInvalid(
			() => q().orderBy([{ column: [1, 2] }]),
			'Invalid orderBy: an array does not name a column or an expression to order by',
		);
	});

	it('R1c orderBy list elements: an element must be a spec object', () => {
		const message =
			'Invalid orderBy: an orderBy list element must be { column, direction?, nulls? }; use orderBy(x) for a single column';
		expectInvalid(() => q().orderBy(['name']), message);
		expectInvalid(() => q().orderBy([users.id]), message);
		expectInvalid(() => q().orderBy([null]), message);
	});

	it('R1 orderBy null undefined sql: refused with the reference-leaf messages', () => {
		expectInvalid(
			() => q().orderBy(null),
			`Invalid orderBy: null ${OBJECT_HINT}`,
		);
		expectInvalid(
			() => q().orderBy(undefined),
			`Invalid orderBy: undefined ${OBJECT_HINT}`,
		);
		expectInvalid(
			() => q().orderBy(sql('1')),
			`Invalid orderBy: ${SQL_MESSAGE}`,
		);
	});

	it('R1 unfinished caseWhen in orderBy and columns: refused by name', () => {
		const unfinished = () => caseWhen(eq('name', 'a'), literal('x'));
		const message =
			'caseWhen() is unfinished; complete it with .else(value) before using it as a value';
		expectInvalid(
			() => q().orderBy(unfinished()),
			`Invalid orderBy: ${message}`,
		);
		expectInvalid(
			() => q().columns([unfinished()]),
			`Invalid columns: ${message}`,
		);
	});

	const NOT_A_SUBQUERY =
		'this builder is not a subquery; use orm.select(...), subquery(table) or a SubqueryExpression';

	it('R1 orderBy outerRef: not yet supported', () => {
		expectNotYet(
			() => q().orderBy(outerRef('id')),
			'outerRef()',
			'expression argument',
			1029,
		);
	});

	it('R1 orderBy non-select builder: refused by name (ADR 0011 delivery 5)', () => {
		expectInvalid(
			() => q().orderBy(orm.update('posts').set({ title: 'x' })),
			`Invalid orderBy: ${NOT_A_SUBQUERY}`,
		);
	});

	it('R3 orderBy structural builder object: refused by name, never read as a record (ADR 0011 delivery 5)', () => {
		expectInvalid(
			() =>
				q().orderBy({
					buildIntent: () => ({ type: 'select', from: 'posts' }),
				}),
			`Invalid orderBy: ${NOT_A_SUBQUERY}`,
		);
	});

	it('R4 groupBy select builder: still not yet supported (#1072)', () => {
		expectNotYet(
			() => q().groupBy([orm.select('posts').count()]),
			'a query builder',
			'GROUP BY',
			1072,
		);
	});

	it('R4b groupBy non-select builder: refused by name (ADR 0011 delivery 5)', () => {
		expectInvalid(
			() => q().groupBy([orm.update('posts').set({ title: 'x' })]),
			`Invalid groupBy: ${NOT_A_SUBQUERY}`,
		);
	});

	it('R2 columns constants need a name: a bare constant column is refused', () => {
		const message =
			'Invalid columns: a constant column needs a name; use literal(value).as(alias) or param(value).as(alias)';
		for (const leaf of [1, true, 1n, [1], new Date(0)])
			expectInvalid(() => q().columns(['id', leaf]), message);
	});

	it('R2 columns subquery needs a name: a bare subquery column is refused (#1075)', () => {
		expectInvalid(
			() => q().columns(['id', subquery('posts').count()]),
			'Invalid columns: a subquery column needs a name; use .asExpr(alias)',
		);
	});

	it('R5 columns builder needs a name: a bare builder column is refused (ADR 0011 delivery 5)', () => {
		const message =
			'Invalid columns: a subquery column needs a name; use .asExpr(alias)';
		expectInvalid(
			() =>
				q().columns([
					'id',
					orm
						.select('posts')
						.where(eq('user_id', outerRef('id')))
						.count({ as: 'n' }),
				]),
			message,
		);
		expectInvalid(
			() =>
				q().columns([
					'id',
					subquery('posts')
						.select('id')
						.where(eq('user_id', outerRef('id'))),
				]),
			message,
		);
	});

	it('R2 columns other refusals: the reference-leaf refusals apply', () => {
		expectInvalid(
			() => q().columns([null]),
			`Invalid columns: null ${OBJECT_HINT}`,
		);
		expectInvalid(
			() => q().columns([sql('1')]),
			`Invalid columns: ${SQL_MESSAGE}`,
		);
		expectNotYet(
			() => q().columns([outerRef('id')]),
			'outerRef()',
			'expression argument',
			1029,
		);
		expectNotYet(
			() => orm.select('posts').columns([orm.tables.posts.author.name] as any),
			'a relation-reached ColumnRef',
			'expression argument',
			1052,
		);
	});

	it('R2b aliased refs keep the scope refusal: an aliased relation-reached ref is refused', () => {
		expectNotYet(
			() =>
				orm
					.select('posts')
					.columns([orm.tables.posts.author.name.as('a')] as any),
			'a relation-reached ColumnRef',
			'expression argument',
			1052,
		);
	});

	it('R3 column-name expression refusals: an expression is not yet supported (#1072)', () => {
		for (const [build, position] of [
			[() => q().groupBy([exprRef('name')]), 'GROUP BY'],
			[() => q().distinctOn(exprRef('name')), 'DISTINCT ON'],
			[() => q().count(exprRef('name')), 'aggregate field'],
			[() => q().sum(exprRef('name')), 'aggregate field'],
		] as const)
			expectNotYet(build, 'an expression', position, 1072);
	});

	it('R3 column-name null and sql refusals: refused by name', () => {
		const helpers = {
			groupBy: (leaf: unknown) => q().groupBy([leaf]),
			distinctOn: (leaf: unknown) => q().distinctOn(leaf),
			count: (leaf: unknown) => q().count(leaf),
			sum: (leaf: unknown) => q().sum(leaf),
		};
		for (const [helper, build] of Object.entries(helpers)) {
			expectInvalid(
				() => build(null),
				`Invalid ${helper}: null ${NOT_A_COLUMN}`,
			);
			expectInvalid(() => build(sql('1')), `Invalid ${helper}: ${SQL_MESSAGE}`);
		}
	});

	it('R3 groupBy null no longer drops: the GROUP BY is refused instead of dropped', () => {
		expectInvalid(
			() => q().groupBy([null]),
			`Invalid groupBy: null ${NOT_A_COLUMN}`,
		);
	});

	it('R3 count number and subquery: refused instead of becoming count(*)', () => {
		expectNotYet(() => q().count(5), 'a number', 'aggregate field', 1072);
		expectNotYet(
			() => q().count(subquery('posts').count()),
			'a SubqueryExpression',
			'aggregate field',
			1072,
		);
	});

	it('R3 min and max distinct refused: min() and max() take no DISTINCT', () => {
		expectInvalid(
			() => q().min(distinct('name')),
			`Invalid min: a plain object ${NOT_A_COLUMN}`,
		);
		expectInvalid(
			() => q().max(distinct('name')),
			`Invalid max: a plain object ${NOT_A_COLUMN}`,
		);
	});

	it('R3 coerceColumnName category table: each category gets its decided refusal', () => {
		for (const [leaf, construct] of [
			[literal(1), 'an expression'],
			[ref('users.name'), 'ref()'],
			[outerRef('name'), 'outerRef()'],
			[orm.select('users'), 'a query builder'],
			[true, 'a boolean'],
			[1n, 'a bigint'],
			[[1], 'an array'],
			[new Date(0), 'a Date'],
		] as const)
			expectNotYet(() => q().groupBy([leaf]), construct, 'GROUP BY', 1072);
		for (const [leaf, kind] of [
			[undefined, 'undefined'],
			[{ a: 1 }, 'a plain object'],
			[Object.create(null), 'a plain object'],
			[() => 1, 'a function'],
			[Symbol('x'), 'a symbol'],
		] as const)
			expectInvalid(
				() => q().groupBy([leaf]),
				`Invalid groupBy: ${kind} ${NOT_A_COLUMN}`,
			);
		expectInvalid(
			() => q().groupBy([caseWhen(eq('name', 'a'), literal('x'))]),
			'Invalid groupBy: caseWhen() is unfinished; complete it with .else(value) before using it as a value',
		);
	});

	it('AC7 count structural distinct refused: use distinct(field)', () => {
		expectInvalid(
			() => q().count({ field: users.name, distinct: true }),
			'Invalid count: use distinct(field) for COUNT DISTINCT',
		);
	});

	it('AC2c qualified cursor ordering refused: a dotted ordering field is refused before any query', async () => {
		const message =
			'cursorPaginate reads each ordered column from the result row by its output name; order by the column name, e.g. orderBy("id"), or see #1074';
		await expect(
			q().orderBy(users.id).cursorPaginate({ limit: 2 }),
		).rejects.toThrow(message);
		await expect(
			q().orderBy('users.id').cursorPaginate({ limit: 2 }),
		).rejects.toThrow(message);
	});

	it('AC2c qualified second cursor key refused: every ordering key is checked', async () => {
		await expect(
			q().orderBy('id').orderBy('users.name').cursorPaginate({ limit: 2 }),
		).rejects.toThrow(/order by the column name/);
	});

	it('AC2c bare cursor ordering pages: a bare ordering keeps paging', async () => {
		const adapter = createSpyAdapter([{ id: 1 }, { id: 2 }, { id: 3 }]);
		const o = createOrm({ adapter, schema: testSchema });
		const page = await o
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 2 });
		expect(page.data).toEqual([{ id: 1 }, { id: 2 }]);
		expect(page.nextCursor).not.toBeNull();
	});
});
