import type { ExpressionIntent } from './expression-intent.js';
import type { QueryIntent } from './query-intent.js';
import { NQL_SELECT_AGGREGATE_FUNCTIONS } from './select-function-allowlist.js';
import type { WhereIntent } from './where-intent.js';

const aggregateFunctions: ReadonlySet<string> = new Set([
	...NQL_SELECT_AGGREGATE_FUNCTIONS,
	'array_agg',
	'string_agg',
	'json_agg',
	'jsonb_agg',
	'json_object_agg',
	'jsonb_object_agg',
	'bool_and',
	'bool_or',
]);

/** Legacy operands can also be primitive values, rather than expression nodes. */
function containsAggregateOperand(value: unknown): boolean {
	return value !== null && typeof value === 'object' && 'kind' in value
		? containsAggregate(value as ExpressionIntent)
		: false;
}

/** CASE predicates contain expression structure only in explicit expression nodes. */
function conditionContainsAggregate(condition: WhereIntent): boolean {
	switch (condition.kind) {
		case 'expression':
			return containsAggregate(condition.expr);
		case 'and':
		case 'or':
			return condition.conditions.some(conditionContainsAggregate);
		case 'not':
			return conditionContainsAggregate(condition.condition);
		default:
			return false;
	}
}

/** Walk expression children, never bound data or a nested SELECT's scope. */
function containsAggregate(node: ExpressionIntent): boolean {
	switch (node.kind) {
		case 'aggregate':
			return true;
		case 'function':
		case 'customFn':
			return (
				aggregateFunctions.has(node.name.toLowerCase()) ||
				node.args.some(containsAggregateOperand)
			);
		case 'cast':
			return containsAggregate(node.expr);
		case 'unary':
			return containsAggregate(node.operand);
		case 'arithmetic':
		case 'customOp':
			return (
				containsAggregateOperand(node.left) ||
				containsAggregateOperand(node.right)
			);
		case 'array':
			return node.elements.some(containsAggregate);
		case 'namedArg':
			return containsAggregate(node.value);
		case 'case':
			return (
				node.when.some(
					(branch) =>
						conditionContainsAggregate(branch.condition) ||
						containsAggregate(branch.result),
				) ||
				(node.else !== undefined && containsAggregate(node.else))
			);
		case 'param':
		case 'literal':
		case 'subquery':
		case 'window':
		case 'column':
		case 'columnAlias':
		case 'coalesce':
		case 'raw':
		case 'relationColumn':
		case 'pseudoColumn':
		case 'comparison':
		case 'jsonExtract':
		case 'jsonContains':
		case 'jsonExists':
		case 'jsonPathExtract':
		case 'ref':
		case 'star':
			return false;
		default: {
			const exhaustive: never = node;
			throw new Error(`Unknown expression kind: ${exhaustive}`);
		}
	}
}

/** Shared by join-include refusal and relational projection stripping. */
export function dropsJoinIncludeData(intent: QueryIntent | undefined): boolean {
	return (
		intent?.select?.type === 'aggregate' ||
		(intent?.select?.type === 'expressions' &&
			intent.select.columns.some(containsAggregate)) ||
		intent?.distinct === true ||
		(intent?.groupBy?.length ?? 0) > 0
	);
}

export function belongsToManyJoinIncludeRefusal(path: string): string {
	return `Include ${path} cannot use 'join' for a belongsToMany relation. The relation goes through a junction table that join includes, .join(<relation>), NQL | flat and json_agg/lateral includes do not traverse yet. Join the junction and target tables explicitly with .join(<table>, { on }).`;
}
