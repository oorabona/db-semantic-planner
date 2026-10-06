import type { ResolvedRelationPath } from './declared-relation-path.js';
import type { ComparisonOperator, NullOperator } from './intent/operators.js';
import type { RangeOperator } from './intent/where-intent.js';
import type { ResolvedRange } from './resolved-includes.js';

export type ResolvedCast =
	| 'none'
	| 'column-db-type'
	| 'column-array'
	| 'any-array'
	| 'range'
	| 'range-element';
export interface ResolvedColumnOperand {
	readonly kind: 'column' | 'outerRef'; // outerRef replaces outer:true / scope:'outer'
	readonly range: ResolvedRange; // replaces textual qualifier/alias lookup
	readonly column: string; // unqualified logical field/column/target
}
export interface ResolvedParameter {
	readonly kind: 'parameter';
	readonly value: unknown;
	readonly cast: ResolvedCast;
	readonly bound: boolean;
}
export type ResolvedRhs =
	| ResolvedParameter
	| ResolvedColumnOperand
	| ResolvedExpression;

export type ResolvedExpression =
	| { readonly kind: 'wholeRow'; readonly range: ResolvedRange }
	| {
			readonly kind: 'ref';
			readonly operand: ResolvedColumnOperand;
			/** Legacy include-body expression spelling; range authority is retained. */
			readonly unqualified?: true;
	  }
	| {
			readonly kind: 'subquery';
			readonly body: Extract<ResolvedSubqueryBody, { use: 'scalar' }>;
	  }
	| {
			readonly kind: 'call';
			readonly name: string;
			readonly args: readonly ResolvedExpression[];
			readonly distinct?: boolean;
			readonly filter?: ResolvedCondition;
			readonly orderBy?: readonly ResolvedOrder[];
	  }
	| {
			readonly kind: 'operator';
			readonly operator: string;
			readonly syntax: 'custom' | 'unary' | 'arithmetic' | 'comparison';
			readonly operands: readonly ResolvedExpression[];
	  }
	| {
			readonly kind: 'cast';
			readonly expression: ResolvedExpression;
			readonly typeName: string;
	  }
	| {
			readonly kind: 'case';
			readonly branches: readonly {
				condition: ResolvedCondition;
				result: ResolvedExpression;
			}[];
			readonly fallback?: ResolvedExpression;
	  }
	| { readonly kind: 'array'; readonly elements: readonly ResolvedExpression[] }
	| {
			readonly kind: 'namedArg';
			readonly name: string;
			readonly value: ResolvedExpression;
	  }
	| { readonly kind: 'literal' | 'parameter'; readonly value: unknown }
	| { readonly kind: 'star' };

export type ResolvedProjection =
	| {
			readonly kind: 'list';
			readonly projections: readonly ResolvedProjection[];
	  }
	| { readonly kind: 'column'; readonly operand: ResolvedColumnOperand }
	| {
			readonly kind: 'aggregate';
			readonly function: string;
			readonly argument: ResolvedColumnOperand | '*';
			readonly distinct: boolean;
	  }
	| { readonly kind: 'expression'; readonly expression: ResolvedExpression };
export interface ResolvedOrder {
	readonly expression: ResolvedExpression;
	readonly direction: 'asc' | 'desc';
	readonly nulls?: 'first' | 'last';
}
export type ResolvedSubqueryBody =
	| {
			readonly use: 'exists';
			readonly select?: ResolvedProjection;
			readonly range: ResolvedRange;
			readonly where?: ResolvedCondition;
	  }
	| {
			readonly use: 'in';
			readonly range: ResolvedRange;
			readonly select: ResolvedColumnOperand;
			readonly where?: ResolvedCondition;
			readonly orderBy: readonly ResolvedOrder[];
			readonly limit?: number | ResolvedParameter;
	  }
	| {
			readonly use: 'scalar';
			readonly range: ResolvedRange;
			readonly select: ResolvedProjection;
			readonly where?: ResolvedCondition;
			readonly orderBy: readonly ResolvedOrder[];
			readonly limit?: number | ResolvedParameter;
	  };

export interface ResolvedRelationPredicate {
	readonly kind: 'relation';
	readonly quantifier: 'some' | 'every' | 'none';
	readonly path: ResolvedRelationPath;
	readonly source: ResolvedRange;
	readonly hops: readonly { from: ResolvedRange; to: ResolvedRange }[];
	readonly target: ResolvedRange;
	readonly joins: readonly {
		path: ResolvedRelationPath;
		source: ResolvedRange;
		range: ResolvedRange;
		type: 'inner' | 'left';
	}[];
	readonly predicate?: ResolvedCondition;
	readonly vacuous: boolean;
}
export type ResolvedCondition =
	| { readonly kind: 'and'; readonly conditions: readonly ResolvedCondition[] }
	| { readonly kind: 'or'; readonly conditions: readonly ResolvedCondition[] }
	| { readonly kind: 'not'; readonly condition: ResolvedCondition }
	| {
			readonly kind: 'comparison';
			readonly left: ResolvedColumnOperand;
			readonly operator: ComparisonOperator;
			readonly right: ResolvedRhs;
			readonly jsonPath?: readonly ResolvedParameter[];
			readonly jsonMode?: 'json' | 'text';
	  }
	| {
			readonly kind: 'like';
			readonly left: ResolvedColumnOperand;
			readonly pattern: ResolvedParameter;
			readonly caseInsensitive: boolean;
			readonly escape?: ResolvedParameter;
	  }
	| {
			readonly kind: 'in';
			readonly left: ResolvedColumnOperand;
			readonly negated: boolean;
			readonly operand:
				| { kind: 'values'; parameter: ResolvedParameter }
				| {
						kind: 'subquery';
						body: Extract<ResolvedSubqueryBody, { use: 'in' }>;
				  };
	  }
	| {
			readonly kind: 'any';
			readonly left: ResolvedColumnOperand;
			readonly values: ResolvedParameter;
	  }
	| {
			readonly kind: 'null';
			readonly left: ResolvedColumnOperand;
			readonly operator: NullOperator;
	  }
	| {
			readonly kind: 'range';
			readonly left: ResolvedColumnOperand;
			readonly operator: RangeOperator;
			readonly value: ResolvedParameter;
	  }
	| {
			readonly kind: 'jsonContains';
			readonly left: ResolvedColumnOperand;
			readonly value: ResolvedParameter;
			readonly reversed: boolean;
	  }
	| {
			readonly kind: 'jsonExists';
			readonly left: ResolvedColumnOperand;
			readonly key: ResolvedParameter;
	  }
	| {
			readonly kind: 'expression';
			readonly expression: ResolvedExpression;
			readonly comparison?: {
				operator: ComparisonOperator;
				right: ResolvedRhs;
			};
	  }
	| ResolvedRelationPredicate
	| {
			readonly kind: 'subquery';
			readonly use: 'exists';
			readonly negated: boolean;
			readonly body: Extract<ResolvedSubqueryBody, { use: 'exists' }>;
	  }
	| {
			readonly kind: 'subquery';
			readonly use: 'scalar';
			readonly left: ResolvedColumnOperand;
			readonly operator: ComparisonOperator;
			readonly body: Extract<ResolvedSubqueryBody, { use: 'scalar' }>;
	  };
