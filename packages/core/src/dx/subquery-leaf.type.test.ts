import { describe, expect, it } from 'vitest';
import { caseWhen } from './case-when-builder.js';
import { cast, fn, op } from './expressions.js';
import { eq, gt, inSubquery, rawExists } from './filters.js';
import type { UpdateBuilder } from './mutation-builders.js';
import type { QueryBuilder } from './query-builder-types.js';
import { outerRef, type SubqueryBuilder } from './subquery-builder.js';

// ADR 0011 delivery 5: a select query builder and a subquery(table) builder
// are scalar leaves and subquery arguments; other builders and outerRef() in
// CASE are not. Checked by `pnpm typecheck`.
declare const users: QueryBuilder<{ readonly id: number }>;
declare const qb: QueryBuilder<{ readonly n: number }>;
declare const sqb: SubqueryBuilder;
declare const update: UpdateBuilder<{ readonly title: string }>;

function assertSubqueryLeafTypes(): void {
	fn('abs', qb);
	fn('abs', sqb);
	op('+', qb, 1);
	cast(qb, 'text');
	caseWhen(eq('id', 1), qb).else(0);
	gt(qb, 1);
	users.orderBy(qb);
	users.where({ id: { $gt: qb } });
	users.where({ id: sqb });
	rawExists(qb);
	inSubquery('id', qb);
	users.columns(['id', qb.asExpr('v')]);

	// @ts-expect-error a builder in columns() needs a name: use .asExpr(alias)
	users.columns([qb]);
	// @ts-expect-error a mutation builder is not a subquery
	rawExists(update);
	// @ts-expect-error outerRef() is not an expression argument yet (#1029)
	caseWhen(eq('id', 1), outerRef('id'));
}

void assertSubqueryLeafTypes;

describe('subquery leaf type boundary (ADR 0011 delivery 5)', () => {
	it('accepts select and subquery(table) builders as leaves', () => {
		expect(true).toBe(true);
	});
});
