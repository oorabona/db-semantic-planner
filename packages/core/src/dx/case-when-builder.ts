import type {
	CaseExpressionIntent,
	ExpressionIntent,
	WhereIntent,
} from '@dbsp/types';
import { coerceReference, type ReferenceLeaf } from './coerce.js';
import { ExpressionRef } from './expressions.js';

/**
 * A CASE result: a reference leaf (a string is a column, a finite number or
 * boolean is inlined, an array or `Date` is bound, an expression is used as
 * is), or `null` for SQL `NULL`.
 */
export type CaseValue = ReferenceLeaf | null;

function toResultIntent(value: CaseValue, helper: string): ExpressionIntent {
	if (value === null) {
		return { kind: 'literal', value: null } satisfies ExpressionIntent;
	}
	return coerceReference(value, helper);
}

export class CaseBuilder {
	private readonly branches: ReadonlyArray<{
		readonly condition: WhereIntent;
		readonly result: ExpressionIntent;
	}>;

	constructor(
		branches: ReadonlyArray<{
			readonly condition: WhereIntent;
			readonly result: ExpressionIntent;
		}>,
	) {
		this.branches = branches;
	}

	when(condition: WhereIntent, thenValue: CaseValue): CaseBuilder {
		return new CaseBuilder([
			...this.branches,
			{ condition, result: toResultIntent(thenValue, 'caseWhen().when') },
		]);
	}

	else(elseValue: CaseValue): ExpressionRef {
		const intent: CaseExpressionIntent = {
			kind: 'case',
			when: this.branches,
			else: toResultIntent(elseValue, 'caseWhen().else'),
		};
		return new ExpressionRef(intent as ExpressionIntent);
	}

	as(alias: string): ExpressionRef {
		return this.toExpr().as(alias);
	}

	toExpr(): ExpressionRef {
		const intent: CaseExpressionIntent = {
			kind: 'case',
			when: this.branches,
		};
		return new ExpressionRef(intent as ExpressionIntent);
	}
}

export function caseWhen(
	condition: WhereIntent,
	thenValue: CaseValue,
): CaseBuilder {
	return new CaseBuilder([
		{ condition, result: toResultIntent(thenValue, 'caseWhen') },
	]);
}
