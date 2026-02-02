/**
 * Condition Compilation Module
 *
 * Extracted from PlanCompiler — handles all WHERE condition compilation,
 * including EXISTS subqueries, IN/NOT IN, BETWEEN, range operators, and value compilation.
 *
 * Functions in this module are stateful: they mutate `ConditionState` (parameters + paramIndex)
 * via reference semantics.
 */

import type { Node } from '@pgsql/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
	requiredColumn,
} from './assert-field.js';
import {
	andExpr,
	booleanConstNode,
	columnRef,
	eqExpr,
	gtExpr,
	gteExpr,
	ilikeExpr,
	likeExpr,
	ltExpr,
	lteExpr,
	neExpr,
	notExpr,
	nullConstNode,
	orExpr,
	rangeVar,
} from './ast-helpers.js';
import type { PlanDecision } from './compiler.js';
import type { NamingPlugin } from './naming-plugin.js';
import { createParamRef, createTypeCastParamRef } from './param-ref.js';

// ============================================================================
// Types
// ============================================================================

/** Immutable context for condition compilation */
export interface ConditionContext {
	readonly naming: NamingPlugin;
	readonly schema?: string | undefined;
	readonly rootTable: string;
	readonly defaultPk?: string;
	readonly deriveFk?: FkColumnDerivation;
}

/** Mutable state accumulated during compilation */
export interface ConditionState {
	parameters: unknown[];
	paramIndex: number;
}

// ============================================================================
// Pure Utilities
// ============================================================================

/**
 * Recursively rewrite table references in a condition tree.
 * Used for self-referential EXISTS and json_agg inner aliases.
 */
export function rewriteConditionTable(
	decision: PlanDecision,
	newTable: string,
): PlanDecision {
	if (
		(decision.type === 'whereAnd' ||
			decision.type === 'whereOr' ||
			decision.type === 'whereNot') &&
		decision.conditions
	) {
		return {
			...decision,
			conditions: (decision.conditions as PlanDecision[]).map((c) =>
				rewriteConditionTable(c, newTable),
			),
		} as PlanDecision;
	}
	if (decision.table) {
		return { ...decision, table: newTable } as PlanDecision;
	}
	return decision;
}

// ============================================================================
// Value Compilation
// ============================================================================

/**
 * Compile a value into a parameterized AST node.
 * Pushes the value into state.parameters and returns a ParamRef.
 */
export function compileValue(value: unknown, state: ConditionState): Node {
	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (typeof value === 'object' && 'paramIndex' in (value as object)) {
		const paramValue = value as { paramIndex: number; value?: unknown };
		state.parameters.push(paramValue.value);
		return createParamRef(paramValue.paramIndex);
	}

	const idx = ++state.paramIndex;
	state.parameters.push(value);
	return createParamRef(idx);
}

// ============================================================================
// Condition Compilation
// ============================================================================

/**
 * Compile a plan decision into a WHERE condition AST node.
 * Handles all operator types, nested AND/OR/NOT, and delegates to
 * specialized functions for EXISTS, IN, BETWEEN, and range operators.
 */
export function compileCondition(
	decision: PlanDecision,
	ctx: ConditionContext,
	state: ConditionState,
): Node {
	// Handle nested compound conditions recursively
	if (decision.type === 'whereAnd' && decision.conditions) {
		const andConditions = decision.conditions.map((c) =>
			compileCondition(c as PlanDecision, ctx, state),
		);
		return andConditions.length === 1
			? andConditions[0]!
			: andExpr(...andConditions);
	}

	if (decision.type === 'whereOr' && decision.conditions) {
		const orConditions = decision.conditions.map((c) =>
			compileCondition(c as PlanDecision, ctx, state),
		);
		return orConditions.length === 1
			? orConditions[0]!
			: orExpr(...orConditions);
	}

	if (decision.type === 'whereNot' && decision.conditions) {
		const nested = compileCondition(
			decision.conditions[0] as PlanDecision,
			ctx,
			state,
		);
		return notExpr(nested);
	}

	// EXISTS/notExists use sourceColumn/targetColumn, not column — dispatch before column extraction
	if (decision.operator === 'exists' || decision.operator === 'notExists') {
		return compileExistsCondition(decision, ctx, state);
	}

	const column = columnRef(
		requiredColumn(decision.column, 'column', 'compileCondition'),
		decision.table,
		undefined,
		ctx.naming,
	);

	// Operators that handle their own parameters — early return before generic compileValue
	if (
		decision.operator === 'contains' ||
		decision.operator === 'containedBy' ||
		decision.operator === 'overlaps'
	) {
		const rangeOp =
			decision.operator === 'contains'
				? '@>'
				: decision.operator === 'containedBy'
					? '<@'
					: '&&';
		return compileRangeOperator(
			decision,
			column,
			rangeOp as '@>' | '<@' | '&&',
			state,
		);
	}
	if (decision.operator === 'in') {
		return compileInCondition(decision, column, false, state, ctx);
	}
	if (decision.operator === 'notIn') {
		return compileInCondition(decision, column, true, state, ctx);
	}
	if (decision.operator === 'between') {
		return compileBetweenCondition(decision, column, state);
	}

	let value: Node;
	if (decision.paramIndex !== undefined) {
		value = createParamRef(decision.paramIndex);
		state.parameters.push(decision.value);
	} else {
		value = compileValue(decision.value, state);
	}

	switch (decision.operator) {
		case '=':
		case 'eq':
			return eqExpr(column, value);
		case '!=':
		case '<>':
		case 'ne':
			return neExpr(column, value);
		case '<':
		case 'lt':
			return ltExpr(column, value);
		case '<=':
		case 'lte':
			return lteExpr(column, value);
		case '>':
		case 'gt':
			return gtExpr(column, value);
		case '>=':
		case 'gte':
			return gteExpr(column, value);
		case 'like':
			return likeExpr(column, value);
		case 'ilike':
			return ilikeExpr(column, value);
		case 'isNull':
			return {
				NullTest: {
					arg: column,
					nulltesttype: 'IS_NULL',
				},
			};
		case 'isNotNull':
			return {
				NullTest: {
					arg: column,
					nulltesttype: 'IS_NOT_NULL',
				},
			};
		default:
			return eqExpr(column, value);
	}
}

// ============================================================================
// EXISTS Subquery
// ============================================================================

/**
 * Compile an EXISTS or NOT EXISTS subquery condition.
 * EXISTS (SELECT 1 FROM targetTable WHERE fk = source.pk [AND conditions])
 */
function compileExistsCondition(
	decision: PlanDecision,
	ctx: ConditionContext,
	state: ConditionState,
): Node {
	const targetTable = decision.targetTable;
	if (!targetTable) {
		throw new Error('EXISTS condition requires targetTable');
	}

	const sourceTable = ctx.rootTable;

	// For self-referential relations, alias the inner table
	const needsAlias = targetTable === sourceTable;
	const innerAlias = needsAlias
		? decision.relationName || `${targetTable}_1`
		: undefined;
	const innerRef = innerAlias || targetTable;

	const targetList: Node[] = [
		{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } },
	];

	const fromClause: Node[] = [
		rangeVar(targetTable, innerAlias, ctx.schema, ctx.naming),
	];

	// Build FK correlation condition
	const fkColumn = decision.foreignKey
		? typeof decision.foreignKey === 'string'
			? decision.foreignKey
			: decision.foreignKey[0]
		: (ctx.deriveFk ?? defaultFkDerivation)(
				sourceTable,
				ctx.defaultPk ?? DEFAULT_PK_COLUMN,
			);

	// belongsTo: FK is in source (outer), PK is in target (inner)
	// hasMany/hasOne: FK is in target (inner), PK is in source (outer)
	const defaultPk = ctx.defaultPk ?? DEFAULT_PK_COLUMN;
	const fkCorrelation =
		decision.relationType === 'belongsTo'
			? eqExpr(
					columnRef(defaultPk, innerRef, undefined, ctx.naming),
					columnRef(fkColumn, sourceTable, undefined, ctx.naming),
				)
			: eqExpr(
					columnRef(fkColumn, innerRef, undefined, ctx.naming),
					columnRef(defaultPk, sourceTable, undefined, ctx.naming),
				);

	let whereClause: Node = fkCorrelation;

	if (decision.conditions && decision.conditions.length > 0) {
		const conditions = innerAlias
			? (decision.conditions as PlanDecision[]).map((c) =>
					rewriteConditionTable(c, innerRef),
				)
			: (decision.conditions as PlanDecision[]);
		const condNodes = conditions.map((c) => compileCondition(c, ctx, state));
		whereClause = andExpr(fkCorrelation, ...condNodes);
	}

	const subSelect: Node = {
		SelectStmt: {
			targetList,
			fromClause,
			...(whereClause && { whereClause }),
		},
	};

	const subLink: Node = {
		SubLink: {
			subLinkType: 'EXISTS_SUBLINK',
			subselect: subSelect,
		},
	};

	if (decision.operator === 'notExists') {
		return {
			BoolExpr: {
				boolop: 'NOT_EXPR',
				args: [subLink],
			},
		};
	}

	return subLink;
}

// ============================================================================
// IN / NOT IN
// ============================================================================

function compileInCondition(
	decision: PlanDecision,
	column: Node,
	negate: boolean,
	state: ConditionState,
	ctx?: ConditionContext,
): Node {
	// IN (subquery): field IN (SELECT col FROM table WHERE ...)
	if (decision.subquery) {
		return compileInSubquery(decision, column, negate, state, ctx);
	}

	const values = decision.value as unknown[];
	if (!Array.isArray(values)) {
		throw new Error('IN condition requires array value');
	}

	if (values.length === 0) {
		return booleanConstNode(!negate);
	}

	const paramIdx = ++state.paramIndex;
	state.parameters.push(values);

	// Use AEXPR_OP_ANY / AEXPR_OP_ALL instead of FuncCall to avoid
	// pg-deparse quoting "any"/"all" as identifiers
	const kind = negate ? 'AEXPR_OP_ALL' : 'AEXPR_OP_ANY';
	const op = negate ? '<>' : '=';

	return {
		A_Expr: {
			kind,
			name: [{ String: { sval: op } }],
			lexpr: column,
			rexpr: createParamRef(paramIdx),
		},
	};
}

/**
 * Compile IN (subquery): field IN (SELECT col FROM table WHERE ...)
 * Uses SubLink with ANY_SUBLINK / ALL_SUBLINK to match pg semantics.
 */
function compileInSubquery(
	decision: PlanDecision,
	column: Node,
	negate: boolean,
	state: ConditionState,
	ctx?: ConditionContext,
): Node {
	const sub = decision.subquery as {
		from: string;
		select: string;
		where?: unknown;
	};

	// Build inner SELECT: SELECT col FROM table
	const selectColumn = sub.select || '*';
	const innerTargetList: Node[] = [
		{
			ResTarget: {
				val: columnRef(selectColumn, sub.from, undefined, ctx?.naming),
			},
		},
	];

	const innerFromClause: Node[] = [
		rangeVar(sub.from, undefined, ctx?.schema, ctx?.naming),
	];

	// Build inner WHERE if present — use subquery's own table as rootTable
	let innerWhere: Node | undefined;
	if (sub.where) {
		const subCtx: ConditionContext = {
			naming: ctx?.naming ?? {
				toDatabase: (n: string) => n,
				toModel: (n: string) => n,
			},
			rootTable: sub.from,
			...(ctx?.schema && { schema: ctx.schema }),
		};
		innerWhere = compileCondition(sub.where as PlanDecision, subCtx, state);
	}

	const subSelect: Node = {
		SelectStmt: {
			targetList: innerTargetList,
			fromClause: innerFromClause,
			...(innerWhere && { whereClause: innerWhere }),
		},
	};

	// SubLink: column IN (SELECT ...) or column NOT IN (SELECT ...)
	const subLinkType = negate ? 'ALL_SUBLINK' : 'ANY_SUBLINK';
	const op = negate ? '<>' : '=';

	return {
		SubLink: {
			subLinkType,
			subselect: subSelect,
			testexpr: column,
			operName: [{ String: { sval: op } }],
		},
	};
}

// ============================================================================
// BETWEEN
// ============================================================================

function compileBetweenCondition(
	decision: PlanDecision,
	column: Node,
	state: ConditionState,
): Node {
	const range = decision.value as [unknown, unknown];
	if (!Array.isArray(range) || range.length !== 2) {
		throw new Error('BETWEEN condition requires [min, max] array');
	}

	const minIdx = ++state.paramIndex;
	state.parameters.push(range[0]);
	const minNode = createParamRef(minIdx);

	const maxIdx = ++state.paramIndex;
	state.parameters.push(range[1]);
	const maxNode = createParamRef(maxIdx);

	return {
		A_Expr: {
			kind: 'AEXPR_BETWEEN',
			name: [{ String: { sval: 'BETWEEN' } }],
			lexpr: column,
			rexpr: { List: { items: [minNode, maxNode] } },
		},
	};
}

// ============================================================================
// Range Operators (@>, <@, &&)
// ============================================================================

function compileRangeOperator(
	decision: PlanDecision,
	column: Node,
	operator: '@>' | '<@' | '&&',
	state: ConditionState,
): Node {
	const value = decision.value;

	let paramValue: unknown;
	let isScalar = false;
	if (
		value !== null &&
		typeof value === 'object' &&
		'lower' in (value as object)
	) {
		const range = value as { lower?: unknown; upper?: unknown };
		const lower = range.lower ?? '';
		const upper = range.upper ?? '';
		paramValue = `[${lower},${upper})`;
	} else if (typeof value === 'string' && /^\[.*,.*[)\]]$/.test(value)) {
		paramValue = value;
	} else {
		paramValue = value;
		isScalar = true;
	}

	const paramIdx = ++state.paramIndex;
	state.parameters.push(paramValue);

	let castType = decision.dataType;
	if (castType && isScalar) {
		castType = castType.replace(/range$/, '');
		if (castType === 'int4') castType = 'integer';
		if (castType === 'int8') castType = 'bigint';
		if (castType === 'tstz') castType = 'timestamptz';
		if (castType === 'ts') castType = 'timestamp';
	}
	const rexpr = castType
		? createTypeCastParamRef(paramIdx, castType)
		: createParamRef(paramIdx);

	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: operator } }],
			lexpr: column,
			rexpr,
		},
	};
}
