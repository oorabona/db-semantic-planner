import type { CaseExpressionIntent, ExpressionIntent, WhereIntent } from "@dbsp/types";
import { ExpressionRef } from "./expressions.js";

function toResultIntent(
	value: ExpressionRef | string | number | boolean | null | undefined,
): ExpressionIntent {
	if (value instanceof ExpressionRef) {
		return value.intent;
	}
	if (value === null || value === undefined) {
		return { kind: "literal", value: null } satisfies ExpressionIntent;
	}
	if (typeof value === "string") {
		return { kind: "ref", column: value } satisfies ExpressionIntent;
	}
	return { kind: "literal", value } satisfies ExpressionIntent;
}

export type CaseValue = ExpressionRef | string | number | boolean | null;

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
			{ condition, result: toResultIntent(thenValue) },
		]);
	}

	else(elseValue: CaseValue): ExpressionRef {
		const intent: CaseExpressionIntent = {
			kind: "case",
			when: this.branches,
			else: toResultIntent(elseValue),
		};
		return new ExpressionRef(intent as ExpressionIntent);
	}

	as(alias: string): ExpressionRef {
		return this.toExpr().as(alias);
	}

	toExpr(): ExpressionRef {
		const intent: CaseExpressionIntent = {
			kind: "case",
			when: this.branches,
		};
		return new ExpressionRef(intent as ExpressionIntent);
	}
}

export function caseWhen(condition: WhereIntent, thenValue: CaseValue): CaseBuilder {
	return new CaseBuilder([{ condition, result: toResultIntent(thenValue) }]);
}
