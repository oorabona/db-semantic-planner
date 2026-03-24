/**
 * @module intent/operators
 * Comparison and logical operator types for intent AST.
 */

/** Comparison operators for scalar values */
export type ComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'isDistinctFrom';

/** String operators */
export type StringOperator = 'like';

/** Array operators */
export type ArrayOperator = 'in';

/** Null operators */
export type NullOperator = 'isNull' | 'isNotNull';

/** Logical operators */
export type LogicalOperator = 'and' | 'or' | 'not';

/** Relation filter operators */
export type RelationOperator = 'exists' | 'notExists';
