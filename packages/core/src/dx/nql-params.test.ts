/**
 * @fileoverview FEAT-134: NQL tag interpolation binds values as compiler params.
 */

import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { type NqlCompilerOptions, compile as nqlCompile } from '@dbsp/nql';
import type { CompiledNqlQuery } from '@dbsp/types';
import { NQL_INTERNAL_COMPILER_OPTIONS } from '@dbsp/types/internal';
import { describe, expect, it, vi } from 'vitest';
import type {
	Adapter,
	CompiledQuery,
	CompileOptions,
	Dump,
} from '../adapter.js';
import type { MutationIntent, QueryIntent } from '../intent-ast.js';
import type { PlanReport } from '../planner.js';
import { createHookManager } from './hooks.js';
import type { MutationDump } from './mutation-builders.js';
import { createNqlTag, nqlRaw } from './nql.js';
import { createOrm } from './orm.js';
import { schema } from './schema.js';

function createParamTestTag() {
	const db = schema({
		users: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
			createdAt: 'timestamp',
			profile: 'json',
		},
	} as const);

	return createNqlTag(db.definition, db.model, createPgsqlCompileOnlyAdapter());
}

function createParamTestSchema() {
	return schema({
		users: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
			createdAt: 'timestamp',
			profile: 'json',
		},
	} as const);
}

function createMutationPipelineTestSchema() {
	return schema({
		users: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
		},
		archivedUsers: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
		},
	} as const);
}

function compileNqlBundle(
	source: string,
	model: Parameters<typeof nqlCompile>[1],
	params: Readonly<Record<string, unknown>>,
): CompiledNqlQuery {
	const options = {
		params,
		[NQL_INTERNAL_COMPILER_OPTIONS]: { allowInternalParams: true },
	} satisfies NqlCompilerOptions & {
		readonly [NQL_INTERNAL_COMPILER_OPTIONS]: {
			readonly allowInternalParams: true;
		};
	};
	const result = nqlCompile(source, model, undefined, options);
	if (!result.success || result.ast === undefined) {
		throw new Error(
			`Expected NQL source to compile: ${result.errors?.map((error) => error.message).join(', ') ?? 'no AST produced'}`,
		);
	}
	return result.ast;
}

function markExecutionAvailable(adapter: Adapter): void {
	Object.defineProperty(adapter, 'connectionAvailability', {
		value: { status: 'available' },
		configurable: true,
	});
}

function expectQueryIntent(intent: QueryIntent | MutationIntent): QueryIntent {
	if (intent.type !== 'select') {
		throw new Error(`Expected a query intent, received ${intent.type}`);
	}
	return intent;
}

function expectQueryDump(dump: Dump | MutationDump): Dump & {
	readonly plan: NonNullable<Dump['plan']>;
} {
	if (!('plan' in dump) || dump.plan === undefined) {
		throw new Error('Expected a query dump, received a mutation dump');
	}
	return dump as Dump & { readonly plan: NonNullable<Dump['plan']> };
}

function expectUnplannedReadDump(dump: Dump | MutationDump): Dump {
	if (!('params' in dump)) {
		throw new Error(
			'Expected an unplanned read dump, received a mutation dump.',
		);
	}
	return dump;
}

function expectSelectColumns(intent: QueryIntent): readonly unknown[] {
	if (!intent.select || !('columns' in intent.select)) {
		throw new Error('Expected an expression select');
	}
	return intent.select.columns;
}

function withParameters<T>(
	query: CompiledQuery<T>,
	parameters: readonly unknown[],
): CompiledQuery<T> {
	return Object.defineProperties(Object.create(Object.getPrototypeOf(query)), {
		...Object.getOwnPropertyDescriptors(query),
		parameters: { value: parameters, enumerable: true },
	}) as CompiledQuery<T>;
}

function expectNoOwnSymbols(
	value: unknown,
	seen = new WeakSet<object>(),
): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) {
		return;
	}

	seen.add(value);
	expect(Object.getOwnPropertySymbols(value)).toEqual([]);

	const childValues = Array.isArray(value)
		? value
		: Object.values(value as Record<string, unknown>);
	for (const child of childValues) {
		expectNoOwnSymbols(child, seen);
	}
}

function findObjects(
	value: unknown,
	predicate: (value: Record<string, unknown>) => boolean,
	matches: Record<string, unknown>[] = [],
	seen = new WeakSet<object>(),
): Record<string, unknown>[] {
	if (typeof value !== 'object' || value === null || seen.has(value)) {
		return matches;
	}

	seen.add(value);
	if (!Array.isArray(value) && predicate(value as Record<string, unknown>)) {
		matches.push(value as Record<string, unknown>);
	}

	const childValues = Array.isArray(value)
		? value
		: Object.values(value as Record<string, unknown>);
	for (const child of childValues) {
		findObjects(child, predicate, matches, seen);
	}
	return matches;
}

function findFirstObject(
	value: unknown,
	predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> {
	const match = findObjects(value, predicate)[0];
	expect(match).toBeDefined();
	return match!;
}

describe('FEAT-134 NQL tag params', () => {
	it('compiles public orm.nql tag interpolations through dump', () => {
		const db = createParamTestSchema();
		const orm = createOrm({
			schema: db,
			adapter: createPgsqlCompileOnlyAdapter(),
		});

		const dump = expectQueryDump(
			orm.nql<{
				id: number;
				name: string;
			}>`users | where id = ${5} and name = ${"O'Brien"}`.dump(),
		);

		expect(dump.params).toEqual([5, "O'Brien"]);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(dump.sql).toMatch(/\$2\b/);
		expect(dump.sql).not.toContain("O'Brien");
	});

	it('binds scalar interpolations as SQL params', () => {
		const nql = createParamTestTag();
		const dump = expectQueryDump(
			nql<{
				id: number;
				name: string;
			}>`users | where id = ${5} and name = ${"O'Brien"}`.dump(),
		);

		expect(dump.params).toEqual([5, "O'Brien"]);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(dump.sql).toMatch(/\$2\b/);
		expect(dump.sql).not.toContain("O'Brien");
	});

	it('binds tag arrays through ANY', () => {
		const nql = createParamTestTag();
		const dump = expectQueryDump(
			nql<{
				id: number;
			}>`users | where id = ANY(${[1, 2, 3]})`.dump(),
		);

		expect(dump.params).toEqual([[1, 2, 3]]);
		expect(dump.sql).toMatch(/ANY\s*\(/i);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('keeps limit interpolation working through params', () => {
		const nql = createParamTestTag();

		const intent = expectQueryIntent(
			nql<unknown>`users | limit ${10}`.toIntentIR(),
		);
		const dump = expectQueryDump(nql<unknown>`users | limit ${10}`.dump());

		expect(intent.limit).toEqual({ kind: 'param', value: 10 });
		expect(dump.sql).toMatch(/limit\s+\$1/i);
		expect(dump.params).toEqual([10]);
	});

	it('binds interpolated JSON keys in json_exists()', () => {
		const nql = createParamTestTag();
		const dump = expectQueryDump(
			nql<unknown>`users | where json_exists(profile, ${'email'})`.dump(),
		);

		expect(dump.params).toEqual(['email']);
		expect(dump.sql).toMatch(/\?/);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('binds interpolated JSON paths in json_extract()', () => {
		const nql = createParamTestTag();
		const dump = expectQueryDump(
			nql<unknown>`users | where json_extract(profile, ${'role'}) = ${'admin'}`.dump(),
		);

		expect(dump.params).toEqual(['role', 'admin']);
		expect(dump.sql).toMatch(/->/);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(dump.sql).toMatch(/\$2\b/);
	});

	it('binds interpolated JSON keys in ? operator', () => {
		const nql = createParamTestTag();
		const dump = expectQueryDump(
			nql<unknown>`users | where profile ? ${'timezone'}`.dump(),
		);

		expect(dump.params).toEqual(['timezone']);
		expect(dump.sql).toMatch(/\?/);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('splices nqlRaw fragments verbatim', () => {
		const nql = createParamTestTag();

		const intent = expectQueryIntent(
			nql<unknown>`users | ${nqlRaw('order by createdAt desc')}`.toIntentIR(),
		);

		expect(intent.orderBy).toEqual([{ field: 'createdAt', direction: 'desc' }]);
	});

	it('binds plain strings instead of treating them as structure', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | ${'order by createdAt desc'}`.toIntentIR();
		}).toThrow(/nqlRaw\(\)/);
	});

	it('rejects reserved generated param names in static source', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | where id = :__p0`.toIntentIR();
		}).toThrow(/reserved.*__p/i);
	});

	it('allows reserved-looking text inside string literals', () => {
		const nql = createParamTestTag();

		const intent = expectQueryIntent(
			nql<unknown>`users | where name = ':__p0'`.toIntentIR(),
		);

		expect(intent.where).toMatchObject({
			kind: 'comparison',
			field: 'name',
			operator: 'eq',
			value: ':__p0',
		});
	});

	it('rejects reserved generated param names inside raw fragments', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | ${nqlRaw('where id = :__p0')}`.toIntentIR();
		}).toThrow(/reserved.*__p/i);
	});

	it('rejects a generated param swallowed by raw quote fragments', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | where name = ${nqlRaw("'")}${'Alice'}${nqlRaw("'")}`.toIntentIR();
		}).toThrow(/:__p0.*raw.*fragment/i);
	});

	it('rejects a generated param swallowed by a raw comment fragment', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | where id = 1 ${nqlRaw('#')}${2}${nqlRaw(
				'\n',
			)}`.toIntentIR();
		}).toThrow(/:__p0.*raw.*fragment/i);
	});

	it('keeps mixed raw and bound slots deterministic', () => {
		const nql = createParamTestTag();
		const makeDump = () =>
			nql<unknown>`users | where active = ${true} | ${nqlRaw(
				'order by createdAt desc',
			)} | where name = ${'Alice'}`.dump();

		const first = expectQueryDump(makeDump());
		const second = expectQueryDump(makeDump());

		expect(first.params).toEqual([true, 'Alice']);
		expect(second.params).toEqual([true, 'Alice']);
		expect(second.sql).toBe(first.sql);
	});

	it('binds adjacent interpolations in a valid list context', () => {
		const nql = createParamTestTag();

		const intent = expectQueryIntent(
			nql<unknown>`users | where id in (${1}, ${2})`.toIntentIR(),
		);
		const dump = expectQueryDump(
			nql<unknown>`users | where id in (${1}, ${2})`.dump(),
		);

		expect(intent.where).toMatchObject({
			kind: 'in',
			field: 'id',
			values: [
				{ kind: 'param', value: 1 },
				{ kind: 'param', value: 2 },
			],
		});
		expect(dump.params).toEqual([[1, 2]]);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('returns public toIntentIR() with explicit param nodes and no value markers', () => {
		const nql = createParamTestTag();

		const intent = expectQueryIntent(
			nql<unknown>`users | where id = ${5} and id in (${1}, ${2}) and createdAt between ${'2026-01-01'} and ${'2026-12-31'} | select case when active = true then ${'yes'} else ${'no'} end as label, coalesce(name, ${'anon'}) as display`.toIntentIR(),
		);

		expectNoOwnSymbols(intent);
		expect(
			findFirstObject(
				intent,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toEqual({ kind: 'param', value: 5 });
		expect(
			findFirstObject(intent, (node) => node.kind === 'in').values,
		).toEqual([
			{ kind: 'param', value: 1 },
			{ kind: 'param', value: 2 },
		]);
		expect(
			findFirstObject(intent, (node) => node.kind === 'range').value,
		).toEqual({
			lower: { kind: 'param', value: '2026-01-01' },
			upper: { kind: 'param', value: '2026-12-31' },
		});

		const caseNode = findFirstObject(intent, (node) => node.kind === 'case');
		expect(
			(caseNode.when as ReadonlyArray<Record<string, unknown>>)[0]?.result,
		).toEqual({ kind: 'param', value: 'yes' });
		expect(caseNode.else).toEqual({ kind: 'param', value: 'no' });

		expect(
			findFirstObject(
				intent,
				(node) => node.kind === 'function' && node.name === 'coalesce',
			).args,
		).toEqual(['name', { kind: 'param', value: 'anon' }]);
	});

	it('returns dump().plan with explicit param nodes while keeping SQL params', () => {
		const nql = createParamTestTag();

		const dump = expectQueryDump(
			nql<unknown>`users | where id = ${5} and id in (${1}, ${2})`.dump(),
		);

		expect(dump.plan).toBeDefined();
		expectNoOwnSymbols(dump.plan);
		expect(
			findFirstObject(
				dump.plan,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toEqual({ kind: 'param', value: 5 });
		expect(dump.params).toEqual([5, [1, 2]]);
	});

	it('returns clean public plan()', () => {
		const nql = createParamTestTag();

		const plan = nql<unknown>`users | where id = ${5}`.plan();

		expectNoOwnSymbols(plan);
		expect(
			findFirstObject(
				plan,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toEqual({ kind: 'param', value: 5 });
	});

	it('passes explicit param nodes to the adapter without sidecar options', () => {
		const db = createParamTestSchema();
		const base = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		let compileValue: unknown;
		let compileOptions: unknown;
		const adapter: Adapter = {
			...base,
			compile<T = unknown>(
				plan: PlanReport | CompiledNqlQuery,
				options?: CompileOptions,
			) {
				if (!('intent' in plan)) {
					throw new Error('Expected a query plan');
				}
				const comparison = findFirstObject(
					plan.intent,
					(node) => node.kind === 'comparison' && node.field === 'id',
				);
				compileValue = comparison.value;
				compileOptions = options;
				return base.compile<T>(plan, options);
			},
			createDump(plan, query, meta) {
				return base.createDump(plan, query, meta);
			},
		};
		const nql = createNqlTag(db.definition, db.model, adapter);

		const dump = expectQueryDump(nql<unknown>`users | where id = ${5}`.dump());

		expect(compileValue).toEqual({ kind: 'param', value: 5 });
		expect(compileOptions).toBeUndefined();
		expect(dump.params).toEqual([5]);
		expect(
			findFirstObject(
				dump.plan,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toEqual({ kind: 'param', value: 5 });
		expectNoOwnSymbols(dump.plan);
	});

	it('keeps top-level SELECT param projection structure and alias', () => {
		const nql = createParamTestTag();

		const intent = expectQueryIntent(
			nql<unknown>`users | select ${5} as x`.toIntentIR(),
		);
		const dump = expectQueryDump(nql<unknown>`users | select ${5} as x`.dump());

		expectNoOwnSymbols(intent);
		expect(expectSelectColumns(intent)[0]).toEqual({
			kind: 'param',
			value: 5,
			as: 'x',
		});
		expect(dump.params).toEqual([5]);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('keeps object-shaped SELECT param values as bound values, not structure', () => {
		const nql = createParamTestTag();
		const boundValue = { kind: 'column', column: 'name' };

		const intent = expectQueryIntent(
			nql<unknown>`users | select ${boundValue} as x`.toIntentIR(),
		);
		const dump = expectQueryDump(
			nql<unknown>`users | select ${boundValue} as x`.dump(),
		);

		expectNoOwnSymbols(intent);
		expect(expectSelectColumns(intent)[0]).toEqual({
			kind: 'param',
			value: boundValue,
			as: 'x',
		});
		expect(dump.params).toEqual([boundValue]);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('fails cleanly for separator-less adjacent interpolations', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | where id in (${1}${2})`.toIntentIR();
		}).toThrow(/NQL compilation failed/);
	});

	it('compiles bound mutation pipelines through the full NQL bundle', () => {
		const db = createMutationPipelineTestSchema();
		const base = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		let compileInput: PlanReport | CompiledNqlQuery | undefined;
		let compileOptions: CompileOptions | undefined;
		const adapter: Adapter = {
			...base,
			compile<T = unknown>(
				plan: PlanReport | CompiledNqlQuery,
				options?: CompileOptions,
			) {
				compileInput = plan;
				compileOptions = options;
				return base.compile<T>(plan, options);
			},
			createDump(plan, query, meta) {
				return base.createDump(plan, query, meta);
			},
		};
		const nql = createNqlTag(db.definition, db.model, adapter);

		const dump =
			nql<unknown>`users | where active = ${true} | select id, name, active | bind active_users
insert into archivedUsers from active_users`.dump() as MutationDump;

		expect(compileInput).toBeDefined();
		expect('bindings' in (compileInput as CompiledNqlQuery)).toBe(true);
		expect(
			(compileInput as CompiledNqlQuery).bindings?.has('active_users'),
		).toBe(true);
		expect(compileOptions?.model).toBe(db.model);
		expect(dump.sql).toMatch(/^WITH "active_users" as \(/);
		expect(dump.sql).toContain('INSERT INTO "archivedUsers"');
		expect(dump.parameters).toEqual([true]);
	});
});

describe('NQL mutation hook lifecycle', () => {
	it('runs beforeMutation and afterMutation hooks around NQL tag mutations', async () => {
		const db = createParamTestSchema();
		const base = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		const events: string[] = [];
		const adapter: Adapter = {
			...base,
			compile<T = unknown>(
				plan: PlanReport | CompiledNqlQuery,
				options?: CompileOptions,
			) {
				const compiled = base.compile<T>(plan, options);
				return withParameters<T>(compiled, ['compiled-param']);
			},
			executeWithMeta: async (_query: CompiledQuery) => ({
				rows: [{ id: 1 }],
				rowCount: 1,
			}),
		};
		const hooks = createHookManager()
			.beforeMutation((ctx) => {
				events.push(`before:${ctx.table}:${ctx.operation}:${ctx.cardinality}`);
				expect(ctx.sql).toBeUndefined();
				return ctx;
			})
			.afterMutation((ctx, rows) => {
				events.push(`after:${ctx.table}:${ctx.operation}:${rows.length}`);
				expect(ctx.sql).toMatch(/insert/i);
				expect(ctx.parameters).toEqual(['compiled-param']);
				expect(ctx.affectedRows).toBe(1);
				return rows.map(() => ({ id: 2 })) as typeof rows;
			});
		const orm = createOrm({
			schema: db,
			adapter,
			hooks,
		});

		const rows = await orm.nql<{
			id: number;
		}>`insert into users set name = ${'Alice'} | select id`.all();

		expect(events).toEqual([
			'before:users:insert:single',
			'after:users:insert:1',
		]);
		expect(rows).toEqual([{ id: 2 }]);
	});

	it('runs onError hooks when NQL tag mutation execution fails', async () => {
		const db = createParamTestSchema();
		const base = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		const transformed = new Error('transformed NQL mutation error');
		let errorTable: string | undefined;
		let errorOperation: string | undefined;
		const adapter: Adapter = {
			...base,
			compile<T = unknown>(
				plan: PlanReport | CompiledNqlQuery,
				options?: CompileOptions,
			) {
				const compiled = base.compile<T>(plan, options);
				return withParameters<T>(compiled, compiled.parameters);
			},
			executeWithMeta: async () => {
				throw new Error('adapter failed');
			},
		};
		const hooks = createHookManager().onError((ctx) => {
			errorTable = ctx.table;
			errorOperation = ctx.operation;
			return transformed;
		});
		const orm = createOrm({
			schema: db,
			adapter,
			hooks,
		});

		await expect(
			orm.nql<unknown>`insert into users set name = ${'Alice'}`.run(),
		).rejects.toThrow('transformed NQL mutation error');
		expect(errorTable).toBe('users');
		expect(errorOperation).toBe('insert');
	});
});

describe('FEAT-134 nqlRaw brand guard', () => {
	it('uses a non-enumerable own symbol brand', () => {
		const raw = nqlRaw('order by createdAt desc');
		const symbols = Object.getOwnPropertySymbols(raw);

		expect(symbols).toHaveLength(1);
		expect(Object.getOwnPropertyDescriptor(raw, symbols[0]!)?.enumerable).toBe(
			false,
		);
	});

	it('does not accept forged raw-shaped objects', () => {
		const nql = createParamTestTag();
		const forged = { fragment: 'order by createdAt desc' };

		expect(() => {
			nql<unknown>`users | ${forged}`.toIntentIR();
		}).toThrow(/nqlRaw\(\)/);
	});

	it('does not accept structuredClone output as raw', () => {
		const nql = createParamTestTag();
		const cloned = structuredClone(nqlRaw('order by createdAt desc'));

		expect(() => {
			nql<unknown>`users | ${cloned}`.toIntentIR();
		}).toThrow(/nqlRaw\(\)/);
	});

	it('does not accept an inherited raw brand', () => {
		const nql = createParamTestTag();
		const inherited = Object.create(nqlRaw('order by createdAt desc'));

		expect(() => {
			nql<unknown>`users | ${inherited}`.toIntentIR();
		}).toThrow(/nqlRaw\(\)/);
	});
});

describe('NQL CTE and set-operation bundles', () => {
	const cteSource = [
		'with active_users as (users | where active = :__p0 | select id, name)',
		'active_users | where name = :__p1 | select id, name',
	].join('\n');
	const setOperationSource =
		'users | where active = :__p0 | select id, name | union (users | where name = :__p1 | select id, name)';

	it.each([
		['CTE', cteSource],
		['set operation', setOperationSource],
	])(
		'%s dumps the original bundle without a semantic plan',
		(shape, source) => {
			const db = createParamTestSchema();
			const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
			const expectedBundle = compileNqlBundle(source, db.model, {
				__p0: true,
				__p1: 'Ada',
			});
			const expected = adapter.compile(expectedBundle, { model: db.model });
			const orm = createOrm({ schema: db, adapter });
			const dumpResult =
				shape === 'CTE'
					? orm.nql<unknown>`with active_users as (users | where active = ${true} | select id, name)
active_users | where name = ${'Ada'} | select id, name`.dump({
							queryName: 'top-users',
							correlationId: 'corr-752',
						})
					: orm.nql<unknown>`users | where active = ${true} | select id, name | union (users | where name = ${'Ada'} | select id, name)`.dump(
							{
								queryName: 'top-users',
								correlationId: 'corr-752',
							},
						);
			const dump = expectUnplannedReadDump(dumpResult);

			expect(dump.sql).toBe(expected.sql);
			expect(dump.params).toEqual(expected.parameters);
			expect('plan' in dump).toBe(false);
			expect(dump.meta).toMatchObject({
				queryName: 'top-users',
				correlationId: 'corr-752',
			});
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		},
	);

	it.each([
		['CTE', cteSource],
		['set operation', setOperationSource],
	])('%s refuses semantic planning and IntentIR', (shape) => {
		const db = createParamTestSchema();
		const orm = createOrm({
			schema: db,
			adapter: createPgsqlCompileOnlyAdapter(),
		});
		const builder =
			shape === 'CTE'
				? orm.nql<unknown>`with active_users as (users | where active = ${true} | select id, name)
active_users | where name = ${'Ada'} | select id, name`
				: orm.nql<unknown>`users | where active = ${true} | select id, name | union (users | where name = ${'Ada'} | select id, name)`;

		expect(() => builder.plan()).toThrow(
			'NQL CTE and set-operation queries do not have execution plans.',
		);
		expect(() => builder.toIntentIR()).toThrow(
			'NQL CTE and set-operation queries do not have IntentIR.',
		);
	});

	it('compiles and executes the original CTE bundle through all()', async () => {
		const db = createParamTestSchema();
		const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		const expectedBundle = compileNqlBundle(cteSource, db.model, {
			__p0: true,
			__p1: 'Ada',
		});
		const compile = vi.spyOn(adapter, 'compile');
		const execute = vi.fn<NonNullable<Adapter['execute']>>(
			async <T>() => [{ id: 1, name: 'Ada' }] as T[],
		);
		adapter.execute = execute as unknown as NonNullable<Adapter['execute']>;
		markExecutionAvailable(adapter);
		const orm = createOrm({ schema: db, adapter });

		const rows = await orm.nql<{
			id: number;
			name: string;
		}>`with active_users as (users | where active = ${true} | select id, name)
active_users | where name = ${'Ada'} | select id, name`.all();

		expect(rows).toEqual([{ id: 1, name: 'Ada' }]);
		expect(compile).toHaveBeenCalledTimes(1);
		expect(compile.mock.calls[0]?.[0]).toEqual(expectedBundle);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('compiles a final set operation over a prior read binding as one bundle', () => {
		const db = createParamTestSchema();
		const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		const source = [
			'users | where active = :__p0 | select id, name | bind active_users',
			'active_users | select id, name | union (users | where name = :__p1 | select id, name)',
		].join('\n');
		const expectedBundle = compileNqlBundle(source, db.model, {
			__p0: true,
			__p1: 'Ada',
		});
		const expected = adapter.compile(expectedBundle, { model: db.model });
		const orm = createOrm({ schema: db, adapter });

		const dumpResult =
			orm.nql<unknown>`users | where active = ${true} | select id, name | bind active_users
active_users | select id, name | union (users | where name = ${'Ada'} | select id, name)`.dump();
		const dump = expectUnplannedReadDump(dumpResult);

		expect(dump.sql).toBe(expected.sql);
		expect(dump.params).toEqual(expected.parameters);
		expect('plan' in dump).toBe(false);
	});

	it('refuses a CTE after a mutation binding before execution', async () => {
		const db = createMutationPipelineTestSchema();
		const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
		const execute = vi.fn<NonNullable<Adapter['execute']>>(
			async <T>() => [] as T[],
		);
		adapter.execute = execute as unknown as NonNullable<Adapter['execute']>;
		markExecutionAvailable(adapter);
		const orm = createOrm({ schema: db, adapter });

		await expect(
			orm.nql<unknown>`insert into archivedUsers set name = ${'Ada'} | select id | bind inserted
with active_users as (users | select id, name) active_users | select id, name`.all(),
		).rejects.toThrow(
			'NQL CTE and set-operation queries are not supported after mutation or snapshot bindings.',
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it('refuses a CTE after a mutation binding in dump()', () => {
		const db = createMutationPipelineTestSchema();
		const orm = createOrm({
			schema: db,
			adapter: createPgsqlCompileOnlyAdapter(),
		});

		expect(() =>
			orm.nql<unknown>`insert into archivedUsers set name = ${'Ada'} | select id | bind inserted
with active_users as (users | select id, name) active_users | select id, name`.dump(),
		).toThrow(
			'NQL CTE and set-operation queries are not supported after mutation or snapshot bindings.',
		);
	});
});
