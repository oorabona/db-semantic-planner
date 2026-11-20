/**
 * FR-6: caseWhen() expression builder integration tests.
 * All assertions use exact SQL matching (toEqual).
 *
 * SQL format note: createPgCompileOnlyAdapter({ model }) uses identityNaming
 * which produces unquoted identifiers without table aliases (e.g. symbols.name, not "t0"."name").
 */
import {
	array,
	caseWhen,
	createOrm,
	eq,
	exprRef,
	fn,
	gte,
	isNotNull,
	literal,
	op,
	param,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		source: { type: 'text' },
		kind: { type: 'text' },
		file_id: { type: 'integer' },
		score: { type: 'integer' },
		active: { type: 'boolean' },
	},
} as const);

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

describe('1. caseWhen() in orderBy() — file affinity pattern', () => {
	it('produces CASE WHEN col = $1 THEN 0 ELSE 1 END in ORDER BY ASC', () => {
		const orm = buildOrm();
		const aff = caseWhen(eq('file_id', 42), literal(0)).else(literal(1));
		const dump = orm.select('symbols').columns(['name']).orderBy(aff).dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name FROM symbols ORDER BY CASE WHEN symbols.file_id = $1 THEN 0 ELSE 1 END ASC',
			),
		);
		expect(dump.params).toEqual([42]);
	});
	it('preserves DESC direction', () => {
		const orm = buildOrm();
		const aff = caseWhen(eq('file_id', 7), literal(0)).else(literal(1));
		const dump = orm
			.select('symbols')
			.columns(['name'])
			.orderBy(aff, 'desc')
			.dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name FROM symbols ORDER BY CASE WHEN symbols.file_id = $1 THEN 0 ELSE 1 END DESC',
			),
		);
		expect(dump.params).toEqual([7]);
	});
});

describe('2. caseWhen() in columns() with .as()', () => {
	it("produces CASE WHEN active = $1 THEN 'active' ELSE 'inactive' END AS status", () => {
		const orm = buildOrm();
		const status = caseWhen(eq('active', true), literal('active'))
			.else(literal('inactive'))
			.as('status');
		const dump = orm.select('symbols').columns(['name', status]).dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.active = $1 THEN 'active' ELSE 'inactive' END AS status FROM symbols",
			),
		);
		expect(dump.params).toEqual([true]);
	});
});

describe('3. Multi-branch caseWhen() with 3 WHEN clauses', () => {
	it('produces 3 WHEN branches in correct order', () => {
		const orm = buildOrm();
		const grade = caseWhen(gte('score', 90), literal('A'))
			.when(gte('score', 70), literal('B'))
			.when(gte('score', 50), literal('C'))
			.else(literal('D'))
			.as('grade');
		const dump = orm.select('symbols').columns(['name', grade]).dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.score >= $1 THEN 'A' WHEN symbols.score >= $2 THEN 'B' WHEN symbols.score >= $3 THEN 'C' ELSE 'D' END AS grade FROM symbols",
			),
		);
		expect(dump.params).toEqual([90, 70, 50]);
	});
});

describe('4. caseWhen() with numeric literal THEN/ELSE', () => {
	it('embeds integer literals directly without $N params', () => {
		const orm = buildOrm();
		// Use plain string values in eq() — eq() treats its 2nd arg as a plain param.
		// literal(1/2/3) in THEN/ELSE positions produce embedded integers (no $N params).
		const priority = caseWhen(eq('kind', 'function'), literal(1))
			.when(eq('kind', 'class'), literal(2))
			.else(literal(3))
			.as('priority');
		const dump = orm.select('symbols').columns(['name', priority]).dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN 1 WHEN symbols.kind = $2 THEN 2 ELSE 3 END AS priority FROM symbols',
			),
		);
		expect(dump.params).toEqual(['function', 'class']);
	});
});

describe('5. caseWhen() without ELSE via toExpr()', () => {
	it('produces CASE WHEN ... END without ELSE clause', () => {
		const orm = buildOrm();
		const label = caseWhen(eq('active', true), literal('yes'))
			.toExpr()
			.as('label');
		const dump = orm.select('symbols').columns(['name', label]).dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.active = $1 THEN 'yes' END AS label FROM symbols",
			),
		);
		expect(dump.params).toEqual([true]);
	});
});

describe('6. caseWhen() THEN/ELSE expression values', () => {
	it('renders fn() THEN and exprRef() ELSE as SQL expressions', () => {
		const orm = buildOrm();
		const pkg = caseWhen(
			eq('kind', 'package'),
			fn('split_part', exprRef('source'), literal('/'), literal(1)),
		)
			.else(exprRef('source'))
			.as('pkg');
		const dump = orm.select('symbols').columns(['name', pkg]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN split_part(source, '/', 1) ELSE source END AS pkg FROM symbols",
			),
		);
		expect(dump.params).toEqual(['package']);
	});

	it('renders nested op() and fn() THEN expressions recursively', () => {
		const orm = buildOrm();
		const pkgPath = caseWhen(
			eq('kind', 'module'),
			op(
				'||',
				fn('split_part', exprRef('source'), literal('/'), literal(1)),
				literal('/'),
			),
		)
			.else(exprRef('source'))
			.as('pkg_path');
		const dump = orm.select('symbols').columns(['name', pkgPath]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN split_part(source, '/', 1) || '/' ELSE source END AS pkg_path FROM symbols",
			),
		);
		expect(dump.params).toEqual(['module']);
	});

	it('renders exprRef() ELSE as a column reference with literal() THEN inlined', () => {
		const orm = buildOrm();
		const label = caseWhen(eq('kind', 'workspace'), literal('workspace'))
			.else(exprRef('source'))
			.as('label');
		const dump = orm.select('symbols').columns(['name', label]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN 'workspace' ELSE source END AS label FROM symbols",
			),
		);
		expect(dump.params).toEqual(['workspace']);
	});

	it('renders array() THEN/ELSE as ARRAY[...] instead of binding the intent', () => {
		const orm = buildOrm();
		const arr = caseWhen(eq('kind', 'list'), array(literal(1), literal(2)))
			.else(array())
			.as('arr');
		const dump = orm.select('symbols').columns(['name', arr]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN ARRAY[1, 2] ELSE ARRAY[] END AS arr FROM symbols',
			),
		);
		expect(dump.params).toEqual(['list']);
	});

	it('preserves the customFn FILTER clause on a THEN aggregate', () => {
		const orm = buildOrm();
		const agg = caseWhen(
			eq('kind', 'module'),
			fn('array_agg', exprRef('name')).filter(isNotNull('name')),
		)
			.else(literal('none'))
			.as('agg');
		const dump = orm.select('symbols').columns(['name', agg]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				"SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN array_agg(name) FILTER (WHERE symbols.name IS NOT NULL) ELSE 'none' END AS agg FROM symbols",
			),
		);
		expect(dump.params).toEqual(['module']);
	});

	it('threads a bound param nested inside a THEN expression', () => {
		const orm = buildOrm();
		const lc = caseWhen(eq('kind', 'file'), fn('lower', param('SECRET')))
			.else(exprRef('name'))
			.as('lc');
		const dump = orm.select('symbols').columns(['name', lc]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN lower($2) ELSE name END AS lc FROM symbols',
			),
		);
		expect(dump.params).toEqual(['file', 'SECRET']);
	});
});

describe('8. CASE results follow the reference-leaf rule (ADR 0011)', () => {
	it('AC3 case-string-column: a string result is a column', () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([caseWhen(eq('score', 1), 'name').else('kind').as('x')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN name ELSE kind END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1]);
	});

	it('AC3 case-number-inline: a number result is inlined', () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([caseWhen(eq('score', 1), 10).else(0).as('x')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN 10 ELSE 0 END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1]);
	});

	it('AC3 case-null: a null result is NULL', () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([caseWhen(eq('score', 1), null).else('name').as('x')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN NULL ELSE name END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1]);
	});

	it("AC3 case-literal-select: literal('A') is inlined in a SELECT-list CASE", () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([
				caseWhen(eq('score', 1), literal('A')).else(literal('B')).as('x'),
			])
			.dump();
		expect(dump.sql).toBe(
			"SELECT CASE WHEN symbols.score = $1 THEN 'A' ELSE 'B' END AS x FROM symbols",
		);
		expect(dump.params).toEqual([1]);
	});

	it("AC3 case-literal-where: literal('A') is inlined in a resolved WHERE CASE", () => {
		const dump = buildOrm()
			.select('symbols')
			.where(caseWhen(eq('score', 1), literal('A')).else(literal('B')).eq('A'))
			.dump();
		expect(dump.sql).toBe(
			"SELECT symbols.* FROM symbols WHERE CASE WHEN symbols.score = $1 THEN 'A' ELSE 'B' END = $2",
		);
		expect(dump.params).toEqual([1, 'A']);
	});

	it('AC3 case-asexpr: an asExpr() subquery as a .when() result compiles as a subquery', () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([
				caseWhen(eq('score', 1), 0)
					.when(eq('score', 2), subquery('symbols').count().asExpr('n'))
					.else(1)
					.as('x'),
			])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN 0 WHEN symbols.score = $2 THEN (SELECT count(*) FROM symbols AS symbols_1) ELSE 1 END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1, 2]);
	});

	it('AC3 case-nan: a NaN result is bound', () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([caseWhen(eq('score', 1), Number.NaN).else(0).as('x')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN $2 ELSE 0 END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1, Number.NaN]);
	});

	it('AC3 case-array-date-select: array and Date results are bound in the SELECT list', () => {
		const date = new Date(0);
		const dump = buildOrm()
			.select('symbols')
			.columns([caseWhen(eq('score', 1), [1, 2]).else(date).as('x')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN $2 ELSE $3 END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1, [1, 2], date]);
	});

	it('AC3 case-array-date-where: array and Date results are bound in a resolved WHERE', () => {
		const date = new Date(0);
		const dump = buildOrm()
			.select('symbols')
			.where(caseWhen(eq('score', 1), [1, 2]).else(date).eq(1))
			.dump();
		expect(dump.sql).toBe(
			'SELECT symbols.* FROM symbols WHERE CASE WHEN symbols.score = $1 THEN $2 ELSE $3 END = $4',
		);
		expect(dump.params).toEqual([1, [1, 2], date, 1]);
	});

	it('AC1b bigint-case: a 2n result gives THEN 2', () => {
		const dump = buildOrm()
			.select('symbols')
			.columns([caseWhen(eq('score', 1), 2n).else(0).as('x')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CASE WHEN symbols.score = $1 THEN 2 ELSE 0 END AS x FROM symbols',
		);
		expect(dump.params).toEqual([1]);
	});
});

describe('7. CaseBuilder immutability', () => {
	it('.when() returns a new builder without mutating original', () => {
		const base = caseWhen(eq('score', 100), literal('perfect'));
		const extended = base.when(gte('score', 50), literal('pass'));
		const orm = buildOrm();
		const d1 = orm
			.select('symbols')
			.columns([base.else(literal('fail')).as('r1')])
			.dump();
		const d2 = orm
			.select('symbols')
			.columns([extended.else(literal('fail')).as('r2')])
			.dump();
		expect(d1.sql.split('WHEN').length - 1).toBe(1);
		expect(d2.sql.split('WHEN').length - 1).toBe(2);
	});
});
