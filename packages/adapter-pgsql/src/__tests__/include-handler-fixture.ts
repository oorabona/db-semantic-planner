/** Low-level handlers receive the physical keys that the plan/boundary normally supplies. */
import type { CompilerContext, Decision } from '../handlers/types.js';
import { deriveConditionKeys } from '../legacy-condition-keys.js';
export function includeHandlerFixture<T extends object>(
	decision: Decision,
	input: T,
	child = false,
): Decision {
	const context = input as CompilerContext;
	const keys = deriveConditionKeys(
		decision,
		context.rootTable,
		context.defaultPkColumnName,
		context.deriveFkColumnName,
	);
	return {
		...decision,
		sourceColumn:
			decision.sourceColumn ??
			(child ||
			decision.type === 'selectJsonAgg' ||
			decision.strategy === 'json_agg'
				? keys.sourceColumn
				: undefined),
		targetColumn: decision.targetColumn ?? keys.targetColumn,
		...(decision.children && {
			children: decision.children.map((child) =>
				includeHandlerFixture(
					child,
					{
						...context,
						rootTable: decision.targetTable ?? context.rootTable,
					},
					true,
				),
			),
		}),
	};
}
