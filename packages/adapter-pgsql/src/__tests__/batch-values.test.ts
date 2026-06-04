/**
 * FR-3: BatchValues tests.
 * Assertions match actual pgsql-deparser output:
 *   - CAST($N AS type[]) form (not $N::type[] shorthand)
 *   - Identifiers unquoted for simple names
 *   - int4 for integer, text for text
 */

import {
	batchValues,
	createOrm,
	eq,
	exprRef,
	gt,
	ref,
	schema,
} from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: { type: 'integer' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
		name: { type: 'text' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

describe('FR-3: batchValues()', () => {
	it('T1: SELECT FROM unnest batch — basic', () => {
		const orm = buildOrm();
		const batch = batchValues(
			[
				['/a', '/b'],
				['a.ts', 'b.ts'],
			],
			['path', 'name'],
			['text', 'text'],
			{ alias: 'requested' },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain(
			'FROM unnest(CAST($1 AS text[]), CAST($2 AS text[])) AS requested(path, name)',
		);
		expect(dump.params[0]).toEqual(['/a', '/b']);
		expect(dump.params[1]).toEqual(['a.ts', 'b.ts']);
	});

	it('T2: WITH ORDINALITY adds ord column', () => {
		const orm = buildOrm();
		const batch = batchValues(
			[
				['/a', '/b'],
				['a.ts', 'b.ts'],
			],
			['path', 'name'],
			['text', 'text'],
			{ alias: 'requested', ordinality: true },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('WITH ORDINALITY AS requested(path, name, ord)');
		expect(dump.params).toEqual([
			['/a', '/b'],
			['a.ts', 'b.ts'],
		]);
	});

	it('T3: batch JOIN — unnest as rarg with explicit ON condition', () => {
		const orm = buildOrm();
		const batch = batchValues(
			[
				[1, 2, 3],
				[10, 20, 30],
			],
			['id', 'callee_id'],
			['integer', 'integer'],
			{ alias: 'batch' },
		);
		const onCond: WhereComparisonIntent = {
			kind: 'comparison',
			field: 'calls.id',
			operator: 'eq',
			value: { kind: 'fieldRef', column: 'id', scope: 'outer' },
		};
		const dump = (orm as any)
			.select('calls')
			.join(batch, { on: onCond, type: 'inner' })
			.dump();
		const sql = ws(dump.sql);
		expect(sql).toContain(
			'JOIN unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS batch(id, callee_id)',
		);
		expect(sql).toContain('calls.id = batch.id');
		expect(dump.params[0]).toEqual([1, 2, 3]);
		expect(dump.params[1]).toEqual([10, 20, 30]);
	});

	it('T4: batchValues() returns correct BatchValuesRef shape', () => {
		const batch = batchValues(
			[
				[1, 2],
				[10, 20],
			],
			['id', 'value'],
			['integer', 'integer'],
			{ alias: 'my_batch', ordinality: false },
		);
		expect(batch.__kind).toBe('batchValues');
		expect(batch.alias).toBe('my_batch');
		expect(batch.columns).toEqual(['id', 'value']);
		expect(batch.types).toEqual(['integer', 'integer']);
		expect(batch.data).toEqual([
			[1, 2],
			[10, 20],
		]);
		expect(batch.ordinality).toBe(false);
	});

	it('T5: batchValues() defaults alias to batch when not specified', () => {
		const batch = batchValues([[1]], ['id'], ['integer']);
		expect(batch.alias).toBe('batch');
	});

	it('T6: batchValues() rejects type names with SQL-injection characters', () => {
		// Bug 1 fix: type names like 'int4); DROP TABLE x; --' must be rejected
		expect(() =>
			batchValues([[1]], ['id'], ['int4); DROP TABLE x; --']),
		).toThrow(/invalid type name/);
	});

	it('T7: batchValues() rejects type names with spaces', () => {
		expect(() => batchValues([[1]], ['id'], ['character varying'])).toThrow(
			/invalid type name/,
		);
	});

	it('T8: batchValues() accepts valid type names', () => {
		// All of these must pass validation
		expect(() => batchValues([[1]], ['id'], ['integer'])).not.toThrow();
		expect(() => batchValues([[1]], ['id'], ['int4'])).not.toThrow();
		expect(() => batchValues([['/a']], ['path'], ['text'])).not.toThrow();
		expect(() => batchValues([[true]], ['active'], ['bool'])).not.toThrow();
		expect(() => batchValues([[1.5]], ['score'], ['float8'])).not.toThrow();
	});

	it('T9: ref() in batchValues join ON clause compiles as column reference, not literal', () => {
		// Regression test: ref() from @dbsp/core is the schema ref (returns RefDefinition
		// with __brand:'ref'), NOT the expression ref (ExpressionRef with __expr:true).
		// When used in eq('table.col', ref('alias.col')), the right-hand value must be
		// compiled to "alias"."col" — not parameterised as a JSON literal object.
		const usersSchema = schema({
			users: { id: 'uuid', name: 'string', active: 'boolean' },
		} as const);
		const adapter = createPgsqlCompileOnlyAdapter({ model: usersSchema.model });
		const orm = createOrm({ model: usersSchema.model, adapter });

		const ids = ['11111111-1111-1111-1111-111111111111'];
		const batch = batchValues([ids], ['id'], ['uuid'], { alias: 'filter' });

		const dump = orm
			.select('users')
			.join(batch, { on: eq('users.id', ref('filter.id')), type: 'inner' })
			.dump();

		// Normalise SQL whitespace before assertion (consistency with T1-T8).
		const sql = ws(dump.sql);

		// Expected: column-to-column comparison ON clause.
		// The deparser renders simple identifiers unquoted: 'filter.id' not '"filter"."id"'.
		// Consistent with T3 which asserts 'calls.id = batch.id'.
		expect(sql).toContain('users.id = filter.id');

		// Bug check: the JSON-serialised RefDefinition must NOT appear in SQL
		expect(sql).not.toContain('__brand');
		expect(sql).not.toContain('target');

		// Param check: only the batch array is a parameter, not the ref() value
		expect(dump.params).toEqual([ids]);
	});

	it('T10: exprRef() in batchValues join ON clause compiles as column reference (regression guard for ExpressionRef path)', () => {
		// Mirror of T9 but using the expression-layer ref helper instead of the schema FK ref.
		// Both should produce the same SQL (column-to-column join).
		const usersSchema = schema({
			users: { id: 'uuid', name: 'string', active: 'boolean' },
		} as const);
		const adapter = createPgsqlCompileOnlyAdapter({ model: usersSchema.model });
		const orm = createOrm({ model: usersSchema.model, adapter });
		const ids = ['11111111-1111-1111-1111-111111111111'];
		const batch = batchValues([ids], ['id'], ['uuid'], { alias: 'filter' });
		const dump = orm
			.select('users')
			.join(batch, { on: eq('users.id', exprRef('filter.id')), type: 'inner' })
			.dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('users.id = filter.id');
		expect(sql).not.toContain('__expr');
		expect(sql).not.toContain('__brand');
		expect(dump.params).toEqual([ids]);
	});

	it('T11: non-eq comparison operator (gt) with ref() in batchValues join ON clause', () => {
		const usersSchema = schema({
			users: { id: 'uuid', priority: 'integer' },
		} as const);
		const adapter = createPgsqlCompileOnlyAdapter({ model: usersSchema.model });
		const orm = createOrm({ model: usersSchema.model, adapter });
		const ids = [1, 2, 3];
		const batch = batchValues([ids], ['threshold'], ['integer'], {
			alias: 'filter',
		});
		const dump = orm
			.select('users')
			.join(batch, {
				on: gt('users.priority', ref('filter.threshold')),
				type: 'inner',
			})
			.dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('users.priority > filter.threshold');
		expect(sql).not.toContain('__brand');
		expect(dump.params).toEqual([ids]);
	});
});

// ---------------------------------------------------------------------------
// Security / injection tests (DEFECT-1 fix)
// ---------------------------------------------------------------------------

describe('batchValues() SQL injection prevention (DEFECT-1)', () => {
	it('T-SEC-1: malicious column name throws at construction — SQL injection prevented', () => {
		// A column name containing SQL metacharacters must be rejected at batchValues()
		// construction time, BEFORE any SQL is emitted.
		expect(() =>
			batchValues([[1]], ['a"); DROP TABLE x; --'], ['integer']),
		).toThrow(/column name contains invalid characters/i);
	});

	it('T-SEC-2: malicious alias throws at construction', () => {
		expect(() =>
			batchValues([[1]], ['id'], ['integer'], {
				alias: 'a"); DROP TABLE x; --',
			}),
		).toThrow(/alias name contains invalid characters/i);
	});

	it('T-SEC-3: empty column name is rejected', () => {
		expect(() => batchValues([[1]], [''], ['integer'])).toThrow(
			/column name must not be empty/i,
		);
	});

	it('T-SEC-4: column name starting with a digit is rejected', () => {
		expect(() => batchValues([[1]], ['1col'], ['integer'])).toThrow(
			/column name contains invalid characters/i,
		);
	});

	it('T-SEC-5: valid column names still work after validation', () => {
		// Regression: ensure valid names are not incorrectly rejected
		const batch = batchValues(
			[
				[1, 2],
				['a', 'b'],
			],
			['user_id', 'name_$'],
			['integer', 'text'],
			{ alias: 'my_batch' },
		);
		expect(batch.alias).toBe('my_batch');
		expect(batch.columns).toEqual(['user_id', 'name_$']);
	});

	it('T-SEC-6: deparser quotes mixed-case column names (defense-in-depth)', () => {
		// A column name with uppercase letters passes validateIdentifier (allowed)
		// but the deparser must still quote it to be safe.
		const orm = buildOrm();
		const batch = batchValues([[1, 2]], ['UserId'], ['integer'], {
			alias: 'MyBatch',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		// Deparser quoteIdent wraps mixed-case names in double-quotes
		expect(sql).toContain('"MyBatch"');
		expect(sql).toContain('"UserId"');
	});

	it('T-SEC-7: deparser quotes column names in JOIN unnest (defense-in-depth)', () => {
		const usersSchema = schema({
			users: { id: 'uuid', name: 'string' },
		} as const);
		const adapter = createPgsqlCompileOnlyAdapter({ model: usersSchema.model });
		const orm = createOrm({ model: usersSchema.model, adapter });
		const batch = batchValues(
			[['11111111-1111-1111-1111-111111111111']],
			['MyId'],
			['uuid'],
			{ alias: 'FilterSet' },
		);
		const dump = orm
			.select('users')
			.join(batch, { on: eq('users.id', ref('FilterSet.MyId')), type: 'inner' })
			.dump();
		const sql = ws(dump.sql);
		// Both alias and column must be double-quoted in the AS clause
		expect(sql).toContain('"FilterSet"');
		expect(sql).toContain('"MyId"');
	});
});
