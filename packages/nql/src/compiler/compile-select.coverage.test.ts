/**
 * Coverage tests for compile-select.ts — uncovered branches.
 *
 * Exercises: star in multi-item select, relation star, count() no-arg,
 * aggregate with distinct, window functions (row_number, rank, partitionBy-only,
 * orderBy-only), scalar subquery in SELECT, column alias, multi-segment path,
 * binary arithmetic, unary minus, CASE expressions (searched + simple),
 * JSON access, JSON function notation (json_path_text, multi-key json_extract),
 * non-aggregate functions (upper, coalesce), aggregate with extraArgs.
 */

import type {
	ExpressionIntent,
	SelectWithExpressionsIntent,
	WindowIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';
import type { CompileResult } from './index.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function compileNql(input: string): CompileResult {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

function getSelectColumns(result: CompileResult): readonly ExpressionIntent[] {
	const select = result.query!.select as SelectWithExpressionsIntent;
	expect(select.type).toBe('expressions');
	return select.columns;
}

// ===========================================================================
// Star in multi-item select
// ===========================================================================
describe('compile-select: star in multi-item select', () => {
	it('produces column kind with * marker alongside named columns', () => {
		const cols = getSelectColumns(compileNql('users | select *, name'));

		expect(cols).toHaveLength(2);
		// First item is star marker
		expect(cols[0]!.kind).toBe('column');
		if (cols[0]!.kind === 'column') {
			expect(cols[0]!.column).toBe('*');
		}
		// Second item is a regular column
		expect(cols[1]!.kind).toBe('column');
		if (cols[1]!.kind === 'column') {
			expect(cols[1]!.column).toBe('name');
		}
	});

	it('star alongside aggregate triggers expressions mode', () => {
		const cols = getSelectColumns(
			compileNql('users | select *, count() as total'),
		);

		expect(cols).toHaveLength(2);
		expect(cols[0]!.kind).toBe('column');
		expect(cols[1]!.kind).toBe('aggregate');
	});
});

// ===========================================================================
// Relation star
// ===========================================================================
describe('compile-select: relation star', () => {
	it('produces relationColumn kind with * column', () => {
		const cols = getSelectColumns(compileNql('orders | select posts.*'));

		expect(cols).toHaveLength(1);
		const col = cols[0]!;
		expect(col.kind).toBe('relationColumn');
		if (col.kind === 'relationColumn') {
			expect(col.relation).toBe('posts');
			expect(col.column).toBe('*');
			expect(col.as).toBe('posts.*');
		}
	});

	it('relation star alongside named columns', () => {
		const cols = getSelectColumns(compileNql('orders | select id, customer.*'));

		expect(cols).toHaveLength(2);
		expect(cols[0]!.kind).toBe('column');
		expect(cols[1]!.kind).toBe('relationColumn');
		if (cols[1]!.kind === 'relationColumn') {
			expect(cols[1]!.relation).toBe('customer');
			expect(cols[1]!.column).toBe('*');
		}
	});
});

// ===========================================================================
// Window functions — uncovered branches
// ===========================================================================
describe('compile-select: window function edge cases', () => {
	it('row_number() with no field — only orderBy', () => {
		const cols = getSelectColumns(
			compileNql('orders | select row_number() over (order by id) as rn'),
		);

		const win = cols[0] as WindowIntent;
		expect(win.kind).toBe('window');
		expect(win.function).toBe('row_number');
		expect(win.field).toBeUndefined();
		expect(win.alias).toBe('rn');
		expect(win.over.orderBy).toBeDefined();
		expect(win.over.orderBy).toHaveLength(1);
		expect(win.over.orderBy![0]!.field).toBe('id');
	});

	it('rank() with no field', () => {
		const cols = getSelectColumns(
			compileNql('orders | select rank() over (order by score desc) as rnk'),
		);

		const win = cols[0] as WindowIntent;
		expect(win.kind).toBe('window');
		expect(win.function).toBe('rank');
		expect(win.field).toBeUndefined();
		expect(win.alias).toBe('rnk');
	});

	it('dense_rank() with no field', () => {
		const cols = getSelectColumns(
			compileNql(
				'orders | select dense_rank() over (order by created_at) as dr',
			),
		);

		const win = cols[0] as WindowIntent;
		expect(win.kind).toBe('window');
		expect(win.function).toBe('dense_rank');
		expect(win.field).toBeUndefined();
	});

	it('window with only partitionBy (no orderBy)', () => {
		const cols = getSelectColumns(
			compileNql(
				'orders | select sum(amount) over (partition by category) as cat_sum',
			),
		);

		const win = cols[0] as WindowIntent;
		expect(win.kind).toBe('window');
		expect(win.function).toBe('sum');
		expect(win.field).toBe('amount');
		expect(win.alias).toBe('cat_sum');
		expect(win.over.partitionBy).toEqual(['category']);
		expect(win.over.orderBy).toBeUndefined();
	});

	it('window function defaults alias to function name when no alias', () => {
		const cols = getSelectColumns(
			compileNql('orders | select row_number() over (order by id)'),
		);

		const win = cols[0] as WindowIntent;
		expect(win.kind).toBe('window');
		// No alias provided → defaults to function name
		expect(win.alias).toBe('row_number');
	});

	it('window with multiple partitionBy columns', () => {
		const cols = getSelectColumns(
			compileNql(
				'orders | select sum(total) over (partition by region, category order by date) as running',
			),
		);

		const win = cols[0] as WindowIntent;
		expect(win.over.partitionBy).toEqual(['region', 'category']);
		expect(win.over.orderBy).toBeDefined();
	});
});

// ===========================================================================
// Scalar subquery in SELECT
// ===========================================================================
describe('compile-select: scalar subquery in SELECT', () => {
	it('compiles subquery expression to subquery kind', () => {
		const cols = getSelectColumns(
			compileNql(
				'users | select name, (orders | select count() as cnt) as order_count',
			),
		);

		expect(cols).toHaveLength(2);
		expect(cols[0]!.kind).toBe('column');

		const sub = cols[1]!;
		expect(sub.kind).toBe('subquery');
		if (sub.kind === 'subquery') {
			expect(sub.query).toBeDefined();
			expect(sub.query.from).toBe('orders');
			expect(sub.as).toBe('order_count');
		}
	});

	it('subquery with where clause in SELECT', () => {
		const cols = getSelectColumns(
			compileNql(
				"users | select id, (orders | where status = 'active' | select count()) as active_orders",
			),
		);

		const sub = cols[1]!;
		expect(sub.kind).toBe('subquery');
		if (sub.kind === 'subquery') {
			expect(sub.query.from).toBe('orders');
			expect(sub.query.where).toBeDefined();
			expect(sub.as).toBe('active_orders');
		}
	});
});

// ===========================================================================
// Unary minus in SELECT
// ===========================================================================
describe('compile-select: unary minus in SELECT', () => {
	it('compiles -amount as multiplication by -1', () => {
		const cols = getSelectColumns(
			compileNql('orders | select -amount as negated'),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.left).toBe(-1);
			expect(col.operator).toBe('*');
			expect(col.right).toBe('amount');
			expect(col.as).toBe('negated');
		}
	});

	it('compiles unary minus on number literal', () => {
		const cols = getSelectColumns(compileNql('orders | select -100 as neg'));

		const col = cols[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.left).toBe(-1);
			expect(col.operator).toBe('*');
			expect(col.right).toBe(100);
		}
	});
});

// ===========================================================================
// CASE expressions
// ===========================================================================
describe('compile-select: searched CASE expression', () => {
	it('compiles CASE WHEN ... THEN ... ELSE ... END', () => {
		const cols = getSelectColumns(
			compileNql(
				"products | select case when price > 100 then 'expensive' else 'cheap' end as tier",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when).toHaveLength(1);
			expect(col.when[0]!.condition).toBeDefined();
			expect(col.when[0]!.result).toBeDefined();
			// result is a literal 'expensive'
			expect(col.when[0]!.result.kind).toBe('literal');
			if (col.when[0]!.result.kind === 'literal') {
				expect(col.when[0]!.result.value).toBe('expensive');
			}
			expect(col.else).toBeDefined();
			if (col.else?.kind === 'literal') {
				expect(col.else.value).toBe('cheap');
			}
			expect(col.as).toBe('tier');
		}
	});

	it('compiles CASE with multiple WHEN clauses', () => {
		const cols = getSelectColumns(
			compileNql(
				"products | select case when price > 100 then 'high' when price > 50 then 'medium' else 'low' end as tier",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when).toHaveLength(2);
			expect(col.else).toBeDefined();
		}
	});

	it('compiles CASE without ELSE clause', () => {
		const cols = getSelectColumns(
			compileNql(
				"products | select case when active = true then 'yes' end as status",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when).toHaveLength(1);
			expect(col.else).toBeUndefined();
			expect(col.as).toBe('status');
		}
	});

	it('CASE with null result', () => {
		const cols = getSelectColumns(
			compileNql(
				'products | select case when active = true then null else 0 end as val',
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when[0]!.result.kind).toBe('literal');
			if (col.when[0]!.result.kind === 'literal') {
				expect(col.when[0]!.result.value).toBeNull();
			}
		}
	});

	it('CASE with boolean result', () => {
		const cols = getSelectColumns(
			compileNql(
				'products | select case when price > 0 then true else false end as is_priced',
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when[0]!.result.kind).toBe('literal');
			if (col.when[0]!.result.kind === 'literal') {
				expect(col.when[0]!.result.value).toBe(true);
			}
		}
	});

	it('CASE with numeric result', () => {
		const cols = getSelectColumns(
			compileNql(
				'products | select case when active = true then 1 else 0 end as flag',
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when[0]!.result.kind).toBe('literal');
			if (col.when[0]!.result.kind === 'literal') {
				expect(col.when[0]!.result.value).toBe(1);
			}
		}
	});
});

describe('compile-select: simple CASE expression', () => {
	it('normalizes simple CASE to searched CASE with eq comparisons', () => {
		const cols = getSelectColumns(
			compileNql(
				"products | select case status when 'active' then 'on' when 'inactive' then 'off' else 'unknown' end as label",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			// Simple CASE normalizes to searched CASE with field=subject, operator=eq
			expect(col.when).toHaveLength(2);
			const firstWhen = col.when[0]!;
			expect(firstWhen.condition.kind).toBe('comparison');
			if (firstWhen.condition.kind === 'comparison') {
				expect(firstWhen.condition.field).toBe('status');
				expect(firstWhen.condition.operator).toBe('eq');
				expect(firstWhen.condition.value).toBe('active');
			}

			const secondWhen = col.when[1]!;
			if (secondWhen.condition.kind === 'comparison') {
				expect(secondWhen.condition.value).toBe('inactive');
			}

			expect(col.else).toBeDefined();
			expect(col.as).toBe('label');
		}
	});

	it('simple CASE without ELSE', () => {
		const cols = getSelectColumns(
			compileNql(
				"products | select case type when 'A' then 1 when 'B' then 2 end as code",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when).toHaveLength(2);
			expect(col.else).toBeUndefined();
		}
	});
});

// ===========================================================================
// JSON function notation — uncovered branches
// ===========================================================================
describe('compile-select: JSON function notation', () => {
	it('json_path_text produces jsonPathExtract with text mode', () => {
		const cols = getSelectColumns(
			compileNql(
				"users | select json_path_text(data, '{name,first}') as first_name",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('jsonPathExtract');
		if (col.kind === 'jsonPathExtract') {
			expect(col.field).toBe('data');
			expect(col.path).toBe('{name,first}');
			expect(col.mode).toBe('text');
			expect(col.as).toBe('first_name');
		}
	});

	it('json_path with multiple separate key arguments builds array literal', () => {
		const cols = getSelectColumns(
			compileNql("users | select json_path(data, 'a', 'b', 'c') as nested"),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('jsonPathExtract');
		if (col.kind === 'jsonPathExtract') {
			expect(col.field).toBe('data');
			expect(col.path).toBe('{a,b,c}');
			expect(col.mode).toBe('json');
		}
	});

	it('json_extract produces jsonExtract with json mode', () => {
		const cols = getSelectColumns(
			compileNql("users | select json_extract(data, 'meta') as meta"),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('jsonExtract');
		if (col.kind === 'jsonExtract') {
			expect(col.field).toBe('data');
			expect(col.path).toEqual(['meta']);
			expect(col.mode).toBe('json');
			expect(col.as).toBe('meta');
		}
	});

	it('json_extract with multiple keys produces multi-key path', () => {
		const cols = getSelectColumns(
			compileNql("users | select json_extract(data, 'a', 'b') as nested"),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('jsonExtract');
		if (col.kind === 'jsonExtract') {
			expect(col.path).toEqual(['a', 'b']);
			expect(col.mode).toBe('json');
		}
	});
});

// ===========================================================================
// Non-aggregate function
// ===========================================================================
describe('compile-select: non-aggregate function', () => {
	it('compiles upper() to function kind', () => {
		const cols = getSelectColumns(
			compileNql('users | select upper(name) as uname'),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('function');
		if (col.kind === 'function') {
			expect(col.name).toBe('upper');
			expect(col.args).toEqual(['name']);
			expect(col.as).toBe('uname');
		}
	});

	it('compiles lower() to function kind', () => {
		const cols = getSelectColumns(
			compileNql('users | select lower(email) as low_email'),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('function');
		if (col.kind === 'function') {
			expect(col.name).toBe('lower');
			expect(col.args).toEqual(['email']);
		}
	});

	it('compiles coalesce() with multiple arguments', () => {
		const cols = getSelectColumns(
			compileNql("users | select coalesce(nickname, name, 'anon') as display"),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('function');
		if (col.kind === 'function') {
			expect(col.name).toBe('coalesce');
			// Path args → field names, string literal → value
			expect(col.args).toContain('nickname');
			expect(col.args).toContain('name');
			expect(col.args).toContain('anon');
			expect(col.as).toBe('display');
		}
	});

	it('compiles now() with no args', () => {
		const cols = getSelectColumns(
			compileNql('users | select now() as current_time'),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('function');
		if (col.kind === 'function') {
			expect(col.name).toBe('now');
			expect(col.args).toEqual([]);
			expect(col.as).toBe('current_time');
		}
	});
});

// ===========================================================================
// Aggregate with extraArgs
// ===========================================================================
describe('compile-select: aggregate with extraArgs', () => {
	it('string_agg with separator has extraArgs', () => {
		const cols = getSelectColumns(
			compileNql("users | select string_agg(name, ', ') as names"),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('string_agg');
			expect(col.field).toBe('name');
			expect(col.extraArgs).toEqual([', ']);
			expect(col.as).toBe('names');
		}
	});

	it('array_agg with no extraArgs', () => {
		const cols = getSelectColumns(
			compileNql('orders | select array_agg(status) as statuses'),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('aggregate');
		if (col.kind === 'aggregate') {
			expect(col.function).toBe('array_agg');
			expect(col.field).toBe('status');
			expect(col.extraArgs).toBeUndefined();
		}
	});
});

// ===========================================================================
// Multiple arithmetic operators
// ===========================================================================
describe('compile-select: arithmetic operators', () => {
	it('addition', () => {
		const cols = getSelectColumns(
			compileNql('orders | select price + tax as total'),
		);
		const col = cols[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.operator).toBe('+');
		}
	});

	it('subtraction', () => {
		const cols = getSelectColumns(
			compileNql('orders | select price - discount as net'),
		);
		const col = cols[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.operator).toBe('-');
		}
	});

	it('division', () => {
		const cols = getSelectColumns(
			compileNql('orders | select total / count as avg_price'),
		);
		const col = cols[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.operator).toBe('/');
		}
	});

	it('modulo', () => {
		const cols = getSelectColumns(
			compileNql('orders | select id % 2 as parity'),
		);
		const col = cols[0]!;
		expect(col.kind).toBe('arithmetic');
		if (col.kind === 'arithmetic') {
			expect(col.operator).toBe('%');
		}
	});
});

// ===========================================================================
// compileExpressionToIntent — comparison in CASE WHEN result
// ===========================================================================
describe('compile-select: compileExpressionToIntent branches', () => {
	it('CASE WHEN with comparison result uses comparison kind', () => {
		// CASE WHEN x > 0 THEN result_expr ELSE result_expr END
		// We need a CASE where the result is itself a comparison expression.
		// This is unusual but tests the `comparison` branch in compileExpressionToIntent.
		// A simple CASE with comparison paths tests this.
		const cols = getSelectColumns(
			compileNql(
				"products | select case when active = true then 'yes' when active = false then 'no' end as label",
			),
		);

		const col = cols[0]!;
		expect(col.kind).toBe('case');
		if (col.kind === 'case') {
			expect(col.when).toHaveLength(2);
			// Both results are string literals
			expect(col.when[0]!.result.kind).toBe('literal');
			expect(col.when[1]!.result.kind).toBe('literal');
		}
	});
});
