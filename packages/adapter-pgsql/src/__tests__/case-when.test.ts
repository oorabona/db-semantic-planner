/**
 * FR-6: caseWhen() expression builder integration tests.
 * All assertions use exact SQL matching (toEqual).
 *
 * SQL format note: createPgsqlCompileOnlyAdapter({ model }) uses identityNaming
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
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
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
	it('produces CASE WHEN active = $1 THEN $2 ELSE $3 END AS status', () => {
		const orm = buildOrm();
		const status = caseWhen(eq('active', true), literal('active'))
			.else(literal('inactive'))
			.as('status');
		const dump = orm.select('symbols').columns(['name', status]).dump();
		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name, CASE WHEN symbols.active = $1 THEN $2 ELSE $3 END AS status FROM symbols',
			),
		);
		expect(dump.params).toEqual([true, 'active', 'inactive']);
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
				'SELECT symbols.name, CASE WHEN symbols.score >= $1 THEN $2 WHEN symbols.score >= $3 THEN $4 WHEN symbols.score >= $5 THEN $6 ELSE $7 END AS grade FROM symbols',
			),
		);
		expect(dump.params).toEqual([90, 'A', 70, 'B', 50, 'C', 'D']);
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
				'SELECT symbols.name, CASE WHEN symbols.active = $1 THEN $2 END AS label FROM symbols',
			),
		);
		expect(dump.params).toEqual([true, 'yes']);
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

	it('renders exprRef() ELSE as a column reference with scalar THEN kept bound', () => {
		const orm = buildOrm();
		const label = caseWhen(eq('kind', 'workspace'), literal('workspace'))
			.else(exprRef('source'))
			.as('label');
		const dump = orm.select('symbols').columns(['name', label]).dump();

		expect(ws(dump.sql)).toEqual(
			ws(
				'SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN $2 ELSE source END AS label FROM symbols',
			),
		);
		expect(dump.params).toEqual(['workspace', 'workspace']);
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
				'SELECT symbols.name, CASE WHEN symbols.kind = $1 THEN array_agg(name) FILTER (WHERE symbols.name IS NOT NULL) ELSE $2 END AS agg FROM symbols',
			),
		);
		expect(dump.params).toEqual(['module', 'none']);
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
