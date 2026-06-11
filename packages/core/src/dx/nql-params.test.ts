/**
 * @fileoverview FEAT-134: NQL tag interpolation binds values as compiler params.
 */

import { isParamExpressionValueIntent } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../adapter-pgsql/src/pgsql-adapter.js';
import type { Adapter } from '../adapter.js';
import type { PlanReport } from '../planner.js';
import { createNqlTag, nqlRaw } from './nql.js';
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
	it('binds scalar interpolations as SQL params', () => {
		const nql = createParamTestTag();
		const dump = nql<{
			id: number;
			name: string;
		}>`users | where id = ${5} and name = ${"O'Brien"}`.dump();

		expect(dump.params).toEqual([5, "O'Brien"]);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(dump.sql).toMatch(/\$2\b/);
		expect(dump.sql).not.toContain("O'Brien");
	});

	it('binds tag arrays through ANY', () => {
		const nql = createParamTestTag();
		const dump = nql<{
			id: number;
		}>`users | where id = ANY(${[1, 2, 3]})`.dump();

		expect(dump.params).toEqual([[1, 2, 3]]);
		expect(dump.sql).toMatch(/ANY\s*\(/i);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('keeps limit interpolation working through params', () => {
		const nql = createParamTestTag();

		const intent = nql<unknown>`users | limit ${10}`.toIntentIR();

		expect(intent.limit).toBe(10);
	});

	it('binds interpolated JSON keys in json_exists()', () => {
		const nql = createParamTestTag();
		const dump =
			nql<unknown>`users | where json_exists(profile, ${'email'})`.dump();

		expect(dump.params).toEqual(['email']);
		expect(dump.sql).toMatch(/\?/);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('binds interpolated JSON paths in json_extract()', () => {
		const nql = createParamTestTag();
		const dump =
			nql<unknown>`users | where json_extract(profile, ${'role'}) = ${'admin'}`.dump();

		expect(dump.params).toEqual(['role', 'admin']);
		expect(dump.sql).toMatch(/->/);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(dump.sql).toMatch(/\$2\b/);
	});

	it('binds interpolated JSON keys in ? operator', () => {
		const nql = createParamTestTag();
		const dump = nql<unknown>`users | where profile ? ${'timezone'}`.dump();

		expect(dump.params).toEqual(['timezone']);
		expect(dump.sql).toMatch(/\?/);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('splices nqlRaw fragments verbatim', () => {
		const nql = createParamTestTag();

		const intent =
			nql<unknown>`users | ${nqlRaw('order by createdAt desc')}`.toIntentIR();

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

		const intent = nql<unknown>`users | where name = ':__p0'`.toIntentIR();

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

		const first = makeDump();
		const second = makeDump();

		expect(first.params).toEqual([true, 'Alice']);
		expect(second.params).toEqual([true, 'Alice']);
		expect(second.sql).toBe(first.sql);
	});

	it('binds adjacent interpolations in a valid list context', () => {
		const nql = createParamTestTag();

		const intent = nql<unknown>`users | where id in (${1}, ${2})`.toIntentIR();
		const dump = nql<unknown>`users | where id in (${1}, ${2})`.dump();

		expect(intent.where).toMatchObject({
			kind: 'in',
			field: 'id',
			values: [1, 2],
		});
		expect(dump.params).toEqual([[1, 2]]);
		expect(dump.sql).toMatch(/\$1\b/);
	});

	it('strips internal param wrappers recursively from public toIntentIR()', () => {
		const nql = createParamTestTag();

		const intent =
			nql<unknown>`users | where id = ${5} and id in (${1}, ${2}) and createdAt between ${'2026-01-01'} and ${'2026-12-31'} | select case when active = true then ${'yes'} else ${'no'} end as label, coalesce(name, ${'anon'}) as display`.toIntentIR();

		expectNoOwnSymbols(intent);
		expect(
			findFirstObject(
				intent,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toBe(5);
		expect(
			findFirstObject(intent, (node) => node.kind === 'in').values,
		).toEqual([1, 2]);
		expect(
			findFirstObject(intent, (node) => node.kind === 'range').value,
		).toEqual({
			lower: '2026-01-01',
			upper: '2026-12-31',
		});

		const caseNode = findFirstObject(intent, (node) => node.kind === 'case');
		expect(
			(caseNode.when as ReadonlyArray<Record<string, unknown>>)[0]?.result,
		).toBe('yes');
		expect(caseNode.else).toBe('no');

		expect(
			findFirstObject(
				intent,
				(node) => node.kind === 'function' && node.name === 'coalesce',
			).args,
		).toEqual(['name', 'anon']);
	});

	it('strips internal param wrappers from dump().plan while keeping SQL params', () => {
		const nql = createParamTestTag();

		const dump =
			nql<unknown>`users | where id = ${5} and id in (${1}, ${2})`.dump();

		expect(dump.plan).toBeDefined();
		expectNoOwnSymbols(dump.plan);
		expect(
			findFirstObject(
				dump.plan,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toBe(5);
		expect(dump.params).toEqual([5, [1, 2]]);
	});

	it('strips internal param wrappers from public plan()', () => {
		const nql = createParamTestTag();

		const plan = nql<unknown>`users | where id = ${5}`.plan();

		expectNoOwnSymbols(plan);
		expect(
			findFirstObject(
				plan,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toBe(5);
	});

	it('keeps adapter compile on the marked internal plan', () => {
		const db = createParamTestSchema();
		const base = createPgsqlCompileOnlyAdapter();
		let compileValue: unknown;
		const adapter: Adapter = {
			...base,
			compile<T = unknown>(plan: PlanReport, options) {
				compileValue = findFirstObject(
					plan.intent,
					(node) => node.kind === 'comparison' && node.field === 'id',
				).value;
				return base.compile<T>(plan, options);
			},
			createDump(plan, query, meta) {
				return base.createDump(plan, query, meta);
			},
		};
		const nql = createNqlTag(db.definition, db.model, adapter);

		const dump = nql<unknown>`users | where id = ${5}`.dump();

		expect(isParamExpressionValueIntent(compileValue)).toBe(true);
		expect(dump.params).toEqual([5]);
		expect(
			findFirstObject(
				dump.plan,
				(node) => node.kind === 'comparison' && node.field === 'id',
			).value,
		).toBe(5);
		expectNoOwnSymbols(dump.plan);
	});

	it('fails cleanly for separator-less adjacent interpolations', () => {
		const nql = createParamTestTag();

		expect(() => {
			nql<unknown>`users | where id in (${1}${2})`.toIntentIR();
		}).toThrow(/NQL compilation failed/);
	});
});

describe('FEAT-134 nqlRaw brand guard', () => {
	it('uses a non-enumerable own symbol brand', () => {
		const raw = nqlRaw('order by createdAt desc');
		const symbols = Object.getOwnPropertySymbols(raw);

		expect(symbols).toHaveLength(1);
		expect(Object.getOwnPropertyDescriptor(raw, symbols[0])?.enumerable).toBe(
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
