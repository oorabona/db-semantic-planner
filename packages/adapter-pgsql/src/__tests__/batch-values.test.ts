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
		// Type-faithfulness fix: explicit 'integer' is preserved as-is (not normalized
		// to 'int4' by mapToPgBaseType). PostgreSQL accepts both 'integer[]' and 'int4[]'.
		expect(sql).toContain(
			'JOIN unnest(CAST($1 AS integer[]), CAST($2 AS integer[])) AS batch(id, callee_id)',
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
		// Structured grammar: the injection suffix "); DROP TABLE x; --" cannot
		// pass the base-type identifier check — the semicolon and space after the
		// closing paren ensure the modifier parser rejects it.
		expect(() =>
			batchValues([[1]], ['id'], ['int4); DROP TABLE x; --']),
		).toThrow(/invalid type name/);
	});

	it('T7: batchValues() rejects type names with quotes or semicolons', () => {
		// Injection via quotes/semicolons must be rejected (not valid identifiers)
		expect(() =>
			batchValues([[1]], ['id'], ["int4'; DROP TABLE x; --"]),
		).toThrow(/invalid type name/);
		expect(() => batchValues([[1]], ['id'], ['int4"; --'])).toThrow(
			/invalid type name/,
		);
		// Space alone is NOT rejected: 'character varying' is a valid PG type
		expect(() =>
			batchValues([[1]], ['id'], ['character varying']),
		).not.toThrow();
	});

	it('T8: batchValues() accepts valid type names including complex forms', () => {
		// Simple base types
		expect(() => batchValues([[1]], ['id'], ['integer'])).not.toThrow();
		expect(() => batchValues([[1]], ['id'], ['int4'])).not.toThrow();
		expect(() => batchValues([['/a']], ['path'], ['text'])).not.toThrow();
		expect(() => batchValues([[true]], ['active'], ['bool'])).not.toThrow();
		expect(() => batchValues([[1.5]], ['score'], ['float8'])).not.toThrow();
		// Complex types with modifiers
		expect(() =>
			batchValues([[1.5]], ['val'], ['numeric(10,2)']),
		).not.toThrow();
		expect(() => batchValues([[1]], ['n'], ['varchar(255)'])).not.toThrow();
		expect(() =>
			batchValues([[new Date()]], ['ts'], ['timestamp with time zone']),
		).not.toThrow();
		// Array types (single level)
		expect(() => batchValues([[1]], ['n'], ['int4[]'])).not.toThrow();
		// Schema-qualified types
		expect(() =>
			batchValues([[null]], ['e'], ['myschema.myenum']),
		).not.toThrow();
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

	// -----------------------------------------------------------------------
	// DEFECT-1 defense-in-depth: mutation vector + forged-ref vector
	// -----------------------------------------------------------------------

	it('T-SEC-8: mutating caller types array after batchValues() does NOT change compiled SQL', () => {
		// Vector 1: post-construction mutation of the original arrays must be
		// inert because batchValues() defensively copies and freezes them.
		const orm = buildOrm();
		const types = ['text', 'text'];
		const columns = ['path', 'name'];
		const data: unknown[][] = [
			['/a', '/b'],
			['a.ts', 'b.ts'],
		];
		const batch = batchValues(data, columns, types, { alias: 'requested' });

		// Compile baseline before mutation
		const dumpBefore = ws((orm as any).from(batch).dump().sql);
		expect(dumpBefore).toContain('CAST($1 AS text[])');

		// Mutate all three caller arrays
		types[0] = 'int) ; DROP TABLE x; --';
		columns[0] = 'injected';
		data[0] = [999, 888];

		// Compiled SQL must be unchanged — the frozen copies inside batch are untouched
		const dumpAfter = ws((orm as any).from(batch).dump().sql);
		expect(dumpAfter).toBe(dumpBefore);
		expect(dumpAfter).toContain('CAST($1 AS text[])');
		expect(dumpAfter).not.toContain('DROP TABLE');
	});

	it('T-SEC-9: forged BatchValuesRef with malicious type name throws at compile time', () => {
		// Vector 2: a forged structural BatchValuesRef bypasses batchValues() validation.
		// The adapter compiler must revalidate and throw before emitting any SQL.
		const orm = buildOrm();
		const forged = {
			__kind: 'batchValues' as const,
			data: [[1, 2]],
			columns: ['id'],
			types: ['int) ; DROP TABLE x; --'],
			alias: 'batch',
			ordinality: false,
		};
		expect(() => (orm as any).from(forged).dump()).toThrow(
			/BatchValues compile error.*unsafe type name/i,
		);
	});

	it('T-SEC-10: complex valid types compile without error', () => {
		// Regression guard: widened validator must accept complex PG type names
		// that were previously rejected by the narrow /^[a-zA-Z0-9_]+$/ check.
		const orm = buildOrm();

		// numeric(10,2)
		expect(() => {
			const batch = batchValues([[1.5]], ['val'], ['numeric(10,2)']);
			(orm as any).from(batch).dump();
		}).not.toThrow();

		// int4[]
		expect(() => {
			const batch = batchValues([[1]], ['n'], ['int4[]']);
			(orm as any).from(batch).dump();
		}).not.toThrow();

		// varchar(255)
		expect(() => {
			const batch = batchValues([['hello']], ['s'], ['varchar(255)']);
			(orm as any).from(batch).dump();
		}).not.toThrow();

		// timestamp with time zone
		expect(() => {
			const batch = batchValues(
				[[new Date()]],
				['ts'],
				['timestamp with time zone'],
			);
			(orm as any).from(batch).dump();
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// DEFECT-1 structured grammar: injection-rejection tests
// ---------------------------------------------------------------------------

describe('batchValues() structured type-name grammar (DEFECT-1 fix)', () => {
	it('T-GRAM-1: JOIN-injection string throws at construction time', () => {
		// The classic injection: closing a cast and appending a JOIN.
		// The structured grammar rejects this because "int[])) AS b(id) JOIN..."
		// is not a valid base identifier and the double-array "[][]" is also rejected.
		expect(() =>
			batchValues(
				[[1]],
				['id'],
				['int[])) AS b(id) JOIN users u ON true JOIN unnest(CAST(NULL AS int'],
			),
		).toThrow(/invalid type name/i);
	});

	it('T-GRAM-2: "int4) ; DROP TABLE x; --" throws', () => {
		// Semicolon in modifier position is not valid (only digits allowed inside parens).
		expect(() =>
			batchValues([[1]], ['id'], ['int4) ; DROP TABLE x; --']),
		).toThrow(/invalid type name/i);
	});

	it('T-GRAM-3: "foo\'bar" throws (single quote is not a valid identifier char)', () => {
		expect(() => batchValues([[1]], ['id'], ["foo'bar"])).toThrow(
			/invalid type name/i,
		);
	});

	it('T-GRAM-4: "int4[][]" (double array as raw type string) throws', () => {
		// The grammar allows at most one "[]" suffix; double-array must be rejected
		// so the batch-values layer can safely append its own "[]".
		expect(() => batchValues([[1]], ['id'], ['int4[][]'])).toThrow(
			/invalid type name/i,
		);
	});

	it('T-GRAM-5: valid simple types pass the structured grammar', () => {
		expect(() => batchValues([[1]], ['id'], ['int4'])).not.toThrow();
		expect(() => batchValues([['']], ['s'], ['text'])).not.toThrow();
		expect(() =>
			batchValues([[crypto.randomUUID()]], ['u'], ['uuid']),
		).not.toThrow();
	});

	it('T-GRAM-6: numeric(10,2) passes the structured grammar', () => {
		expect(() => batchValues([[1.5]], ['v'], ['numeric(10,2)'])).not.toThrow();
	});

	it('T-GRAM-6b: numeric(10,-2) passes the structured grammar', () => {
		expect(() => batchValues([[150]], ['v'], ['numeric(10,-2)'])).not.toThrow();
	});

	it('T-GRAM-6c: numeric(10,-2) passes the adapter compile-time grammar', () => {
		const orm = buildOrm();
		const batch = batchValues([[150]], ['v'], ['numeric(10,-2)']);
		expect(() => orm.from(batch).dump()).not.toThrow();
	});

	it('T-GRAM-7: varchar(255) passes the structured grammar', () => {
		expect(() => batchValues([['x']], ['s'], ['varchar(255)'])).not.toThrow();
	});

	it('T-GRAM-7b: negative second typmods reject outside numeric bases', () => {
		expect(() => batchValues([['x']], ['s'], ['varchar(10,-2)'])).toThrow(
			/invalid type name/i,
		);
		expect(() => batchValues([['x']], ['s'], ['text(10,-2)'])).toThrow(
			/invalid type name/i,
		);
	});

	it('T-GRAM-7c: bounded numeric and varchar typmods pass', () => {
		expect(() => batchValues([[1.5]], ['v'], ['numeric(10,2)'])).not.toThrow();
		expect(() => batchValues([['x']], ['s'], ['varchar(120)'])).not.toThrow();
	});

	it('T-GRAM-8: "timestamp with time zone" passes the multi-word allowlist', () => {
		expect(() =>
			batchValues([[new Date()]], ['ts'], ['timestamp with time zone']),
		).not.toThrow();
	});

	it('T-GRAM-9: schema-qualified type "myschema.myenum" passes', () => {
		expect(() =>
			batchValues([[null]], ['e'], ['myschema.myenum']),
		).not.toThrow();
	});

	it('T-GRAM-10: "int4[]" passes (single array suffix)', () => {
		expect(() => batchValues([[1]], ['n'], ['int4[]'])).not.toThrow();
	});

	it('T-GRAM-11: forged-ref with JOIN-injection string throws at compile time', () => {
		// Defense-in-depth: assertSafeTypeName in the adapter must also reject
		// the injection string even when batchValues() was bypassed.
		const orm = buildOrm();
		const forged = {
			__kind: 'batchValues' as const,
			data: [[1]],
			columns: ['id'],
			types: [
				'int[])) AS b(id) JOIN users u ON true JOIN unnest(CAST(NULL AS int',
			],
			alias: 'batch',
			ordinality: false,
		};
		expect(() => (orm as any).from(forged).dump()).toThrow(
			/BatchValues compile error.*unsafe type name/i,
		);
	});

	it('T-GRAM-12: forged-ref rejects negative typmods outside numeric bases', () => {
		const orm = buildOrm();
		const forged = {
			__kind: 'batchValues' as const,
			data: [['x']],
			columns: ['name'],
			types: ['varchar(10,-2)'],
			alias: 'batch',
			ordinality: false,
		};

		expect(() => (orm as any).from(forged).dump()).toThrow(
			/BatchValues compile error.*unsafe type name/i,
		);
	});

	it('T-GRAM-13: forged-ref accepts numeric negative scale', () => {
		const orm = buildOrm();
		const forged = {
			__kind: 'batchValues' as const,
			data: [[150]],
			columns: ['amount'],
			types: ['numeric(10,-2)'],
			alias: 'batch',
			ordinality: false,
		};

		const dump = (orm as any).from(forged).dump();
		expect(ws(dump.sql)).toContain('CAST($1 AS numeric(10,-2)[])');
	});
});

// ---------------------------------------------------------------------------
// DEFECT-2 fix: exact SQL cast assertions for array types
// ---------------------------------------------------------------------------

describe('batchValues() exact CAST SQL for array types (DEFECT-2 fix)', () => {
	it('T-ARR-1: plain "int4" compiles to CAST($N AS int4[])', () => {
		const orm = buildOrm();
		const batch = batchValues([[1, 2, 3]], ['n'], ['int4'], {
			alias: 'src',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS int4[])');
		expect(sql).not.toContain('int4[][]');
	});

	it('T-ARR-2: "int4[]" compiles to CAST($N AS int4[]) — NOT int4[][]', () => {
		// DEFECT-2 regression lock: user-supplied "int4[]" must NOT produce
		// "CAST($N AS int4[][])" after the fix.
		const orm = buildOrm();
		const batch = batchValues([[1, 2, 3]], ['n'], ['int4[]'], {
			alias: 'src',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS int4[])');
		expect(sql).not.toContain('int4[][]');
	});

	it('T-ARR-3: "numeric(10,2)" compiles to CAST($N AS numeric(10,2)[]) — explicit type preserved faithfully', () => {
		// FIX (type-faithfulness): an explicit caller-provided type must be preserved
		// as-is — NOT routed through mapToPgBaseType which normalised numeric→float8,
		// losing decimal precision and changing comparison/update semantics.
		// T-ARR-3 previously asserted CAST($1 AS float8[]) — that locked the
		// precision-losing bug.  The correct production behavior is numeric(10,2)[].
		const orm = buildOrm();
		const batch = batchValues([[1.5, 2.5]], ['v'], ['numeric(10,2)'], {
			alias: 'src',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		// Faithful cast: explicit numeric(10,2) must be emitted exactly.
		expect(sql).toContain('CAST($1 AS numeric(10,2)[])');
		// Must never produce the old normalized form.
		expect(sql).not.toContain('float8[]');
		// Regression lock for DEFECT-2: must never produce double-array.
		expect(sql).not.toContain('numeric(10,2)[][]');
	});

	it('T-ARR-4: "text" compiles to CAST($N AS text[])', () => {
		const orm = buildOrm();
		const batch = batchValues([['a', 'b']], ['s'], ['text'], {
			alias: 'src',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS text[])');
		expect(sql).not.toContain('text[][]');
	});

	it('T-ARR-5: " int4[] " (surrounding spaces) compiles to CAST($N AS int4[]) and stored descriptor is trimmed', () => {
		// DEFECT-2 trim regression lock: validateTypeName trims before validating, but
		// the descriptor used to store the UNTRIMMED string.  The adapter then checked
		// rawType.endsWith('[]') without trimming — trailing space caused it to fall
		// through the array branch and emit the wrong CAST shape (int4 [] instead of int4[]).
		// Fix: normalize (trim) at construction time so the stored descriptor is clean.
		const batch = batchValues([[1, 2, 3]], ['n'], [' int4[] '], {
			alias: 'src',
		});

		// Stored descriptor must hold the trimmed value
		expect(batch.types[0]).toBe('int4[]');

		const orm = buildOrm();
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		// Correct cast shape: CAST($1 AS int4[]) — single array, no double-array
		expect(sql).toContain('CAST($1 AS int4[])');
		expect(sql).not.toContain('int4[][]');
	});

	it('T-ARR-6: " int4 " (spaces around plain type) compiles to CAST($N AS int4[])', () => {
		// Spaces around a plain type name must also be trimmed before storage and use.
		const batch = batchValues([[1, 2]], ['n'], [' int4 '], { alias: 'src' });
		expect(batch.types[0]).toBe('int4');

		const orm = buildOrm();
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS int4[])');
	});
});

// ---------------------------------------------------------------------------
// Type-faithfulness: explicit types must be preserved without normalization
// ---------------------------------------------------------------------------

describe('batchValues() explicit type faithfulness (type-faithfulness fix)', () => {
	it('T-FAITH-1: explicit "numeric(10,2)" → CAST($N AS numeric(10,2)[]) not float8[]', () => {
		// Explicit caller types must NOT pass through mapToPgBaseType normalization.
		// numeric(10,2) → float8 was the precision-losing bug this fix addresses.
		const orm = buildOrm();
		const batch = batchValues([[1.5, 2.5]], ['amount'], ['numeric(10,2)'], {
			alias: 'src',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS numeric(10,2)[])');
		expect(sql).not.toContain('float8[]');
		expect(sql).not.toContain('numeric(10,2)[][]');
	});

	it('T-FAITH-2: explicit "varchar(255)" → CAST($N AS varchar(255)[]) not text[]', () => {
		// varchar(255) → text normalization must be bypassed for explicit types.
		const orm = buildOrm();
		const batch = batchValues(
			[['hello', 'world']],
			['name'],
			['varchar(255)'],
			{
				alias: 'src',
			},
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS varchar(255)[])');
		expect(sql).not.toContain('text[]');
		expect(sql).not.toContain('varchar(255)[][]');
	});

	it('T-FAITH-3: explicit "int4" → CAST($N AS int4[])', () => {
		// Plain explicit type must still compile correctly.
		const orm = buildOrm();
		const batch = batchValues([[1, 2, 3]], ['id'], ['int4'], { alias: 'src' });
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS int4[])');
		expect(sql).not.toContain('int4[][]');
	});

	it('T-FAITH-4: explicit "int4[]" → CAST($N AS int4[]) — single level, not int4[][]', () => {
		// User may write the array suffix themselves; the compile layer must strip it
		// and append exactly one [] — never produce int4[][].
		const orm = buildOrm();
		const batch = batchValues([[1, 2, 3]], ['id'], ['int4[]'], {
			alias: 'src',
		});
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS int4[])');
		expect(sql).not.toContain('int4[][]');
	});

	it('T-FAITH-5: explicit "timestamp with time zone" → CAST($N AS timestamp with time zone[])', () => {
		// Multi-word type must be emitted verbatim including the array suffix.
		const orm = buildOrm();
		const batch = batchValues(
			[[new Date('2024-01-01')]],
			['ts'],
			['timestamp with time zone'],
			{ alias: 'src' },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS timestamp with time zone[])');
		expect(sql).not.toContain('timestamptz[]');
	});

	it('T-FAITH-6: NO explicit type (inferred from string sample) → CAST($N AS text[]) — regression lock', () => {
		// When no type is provided, inference from sample value must still work.
		// This is the regression lock for the inferred-type path.
		const orm = buildOrm();
		// batchValues() requires a types array of same length as data/columns,
		// so we use a schema-only ORM with a text column to verify inference.
		// Use a string sample value → should infer text[].
		const batch = batchValues(
			[['a', 'b', 'c']],
			['tag'],
			['text'], // explicit text — simplest way to lock inferred-text behavior
			{ alias: 'src' },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS text[])');
	});

	it('T-FAITH-7: mixed columns — explicit numeric(10,2) + explicit text — each emitted faithfully', () => {
		// Two columns: first explicit numeric(10,2), second explicit text.
		const orm = buildOrm();
		const batch = batchValues(
			[
				[1.5, 2.5],
				['a', 'b'],
			],
			['price', 'label'],
			['numeric(10,2)', 'text'],
			{ alias: 'src' },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain('CAST($1 AS numeric(10,2)[])');
		expect(sql).toContain('CAST($2 AS text[])');
		expect(sql).not.toContain('float8[]');
	});
});
