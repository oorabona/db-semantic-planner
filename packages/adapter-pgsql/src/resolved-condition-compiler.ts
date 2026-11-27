import { escapeDiagnosticText, validateTypeName } from '@dbsp/core/internal';
import type {
	ResolvedColumnOperand,
	ResolvedCondition,
	ResolvedExpression,
	ResolvedLeftOperand,
	ResolvedNestedSelect,
	ResolvedParameter,
	ResolvedProjection,
	ResolvedRange,
	ResolvedRhs,
	ResolvedSubqueryBody,
} from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import {
	andExpr,
	binaryExpr,
	booleanConstNode,
	funcCall,
	integerNode,
	joinExpr,
	notExpr,
	nullConstNode,
	orExpr,
	sortBy,
	sqlColumnRef,
	sqlRangeVar,
	stringConstNode,
	typeCast,
} from './ast-helpers.js';
import { relationBindingFor } from './binding-registry.js';
import { mapModelIRTypeToPgBase } from './compiler-utils.js';
import {
	dbTypeCastTarget,
	isPgBuiltInTypeName,
	renderColumnDbType,
	validateDbType,
} from './db-type.js';
import {
	assertDialectCapability,
	supportsDialectCapability,
} from './dialect-capabilities.js';
import { assertSafeOperator } from './handlers/expression/custom.js';
import { numericLiteralNode } from './handlers/expression/numeric-literal.js';
import type { CompilerContext, CompilerState } from './handlers/types.js';
import { compileAny } from './handlers/where/any.js';
import {
	aggregateResultPgType,
	compileComparison,
} from './handlers/where/comparison.js';
import { compileInValues } from './handlers/where/in.js';
import { compileJsonOperator } from './handlers/where/json.js';
import { compileLike } from './handlers/where/like.js';
import { compileLiteralNullComparison } from './handlers/where/literal-null.js';
import { compileNull } from './handlers/where/null.js';
import { compileRangeParameter } from './handlers/where/range.js';
import {
	compileValue,
	resolveAddressedColumn,
	resolveAddressedColumnMetadata,
} from './handlers/where/utils.js';
import { createParamRef, createTypeCastParamRef } from './param-ref.js';
import { renumberParamRefsInAst } from './param-renumber.js';
import { queryLocal, resolveDeclaredIdentifier } from './sql-identifier.js';
import { validateIdentifier } from './validate.js';

const operators: Record<string, string> = {
	'=': '=',
	'!=': '!=',
	'>': '>',
	'>=': '>=',
	'<': '<',
	'<=': '<=',
	like: 'like',
	ilike: 'ilike',
	eq: '=',
	neq: '!=',
	ne: '!=',
	'<>': '!=',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<=',
	isDistinctFrom: 'isDistinctFrom',
};
function assertComparisonOperator(operator: string): void {
	if (!Object.hasOwn(operators, operator))
		throw new Error(
			`Unsupported comparison operator '${escapeDiagnosticText(operator)}'`,
		);
}
function op(operator: string): string {
	assertComparisonOperator(operator);
	return operators[operator]!;
}
function rangeOp(operator: string): string {
	switch (operator) {
		case 'between':
			return 'BETWEEN';
		case 'contains':
			return '@>';
		case 'containedBy':
			return '<@';
		case 'overlaps':
			return '&&';
		default:
			throw new Error(
				`Unsupported range operator '${escapeDiagnosticText(operator)}'`,
			);
	}
}

/** Validate the complete resolved subtree before allocating parameters or AST nodes. */
function validateOperators(input: unknown): void {
	if (!input || typeof input !== 'object') return;
	if (Array.isArray(input)) {
		for (const child of input) validateOperators(child);
		return;
	}
	const node = input as Record<string, unknown>;
	if (node.kind === 'operator') {
		const operator = node.operator as string;
		switch (node.syntax) {
			case 'arithmetic':
				if (!['+', '-', '*', '/', '%'].includes(operator))
					throw new Error(
						`Unsupported arithmetic operator '${escapeDiagnosticText(operator)}'`,
					);
				break;
			case 'comparison':
				assertComparisonOperator(operator);
				break;
			case 'custom':
				assertSafeOperator(operator);
				break;
			case 'unary':
				assertSafeOperator(operator, { allowWords: ['NOT'] });
				break;
			default:
				throw new Error(
					`Unsupported operator syntax '${escapeDiagnosticText(String(node.syntax))}'`,
				);
		}
	}
	if (
		node.kind === 'comparison' ||
		(node.kind === 'subquery' && node.use === 'scalar')
	)
		assertComparisonOperator(node.operator as string);
	if (node.kind === 'range') {
		rangeOp(node.operator as string);
		// A range constructor's bounds can be expressions, so they are walked.
		const value = node.value as
			| { kind?: unknown; lower?: unknown; upper?: unknown }
			| undefined;
		if (value?.kind === 'rangeConstructor') {
			validateOperators(value.lower);
			validateOperators(value.upper);
		}
	}
	if (node.kind === 'expression' && node.comparison)
		assertComparisonOperator(
			(node.comparison as { operator: string }).operator,
		);
	if (node.kind === 'namedArg') validateOperators(node.value);
	// Parameter values, ranges and relation-path metadata are data, not syntax.
	for (const key of [
		'conditions',
		'condition',
		'expression',
		'operands',
		'args',
		'filter',
		'branches',
		'result',
		'fallback',
		'elements',
		'operand',
		'body',
		'where',
		'select',
		'projections',
		'argument',
		'orderBy',
		'predicate',
		'right',
		'comparison',
	]) {
		validateOperators(node[key]);
	}
}

function address(
	operand: ResolvedColumnOperand,
	ctx: CompilerContext,
	correlationRelation?: string,
) {
	// A root over a batch/CTE source keeps that source's emitted qualifier. In a
	// nested select, an outerRef names an enclosing range by its emitted qualifier.
	const alias =
		operand.kind === 'outerRef' && ctx.enclosingQualifiers !== undefined
			? (ctx.enclosingQualifiers.get(operand.range.alias) ??
				operand.range.alias)
			: operand.range.table === ctx.rootTable &&
					operand.range.alias === ctx.rootTable
				? (ctx.currentAlias ?? operand.range.alias)
				: operand.range.alias;
	return resolveAddressedColumn(
		{ ...operand, range: { ...operand.range, alias } },
		ctx,
		correlationRelation,
	);
}
function column(
	operand: ResolvedColumnOperand,
	ctx: CompilerContext,
	correlationRelation?: string,
): Node {
	const { binding, identifier } = address(operand, ctx, correlationRelation);
	return sqlColumnRef(identifier, binding.qualifier);
}
function metadata(
	operand: ResolvedColumnOperand,
	ctx: CompilerContext,
	state: CompilerState,
) {
	return resolveAddressedColumnMetadata(
		address(operand, ctx).binding.logicalTable,
		operand.column,
		ctx,
		state,
	);
}
function columnType(
	operand: ResolvedColumnOperand,
	ctx: CompilerContext,
	state: CompilerState,
): string | undefined {
	const col = metadata(operand, ctx, state);
	if (!col?.originalDbType) return undefined;
	const type = renderColumnDbType(col, ctx.schema).trim();
	validateDbType(type);
	return dbTypeCastTarget(type);
}
const BUILT_IN_RANGE_TYPES = new Set([
	'int4range',
	'int8range',
	'numrange',
	'tsrange',
	'tstzrange',
	'daterange',
]);

/**
 * Split a rendered SQL type name into its identifier parts. A quoted part keeps
 * its spelling; an unquoted part is folded to lower case, as PostgreSQL folds
 * it when it reads the same text in a cast.
 */
function typeNameParts(type: string): string[] {
	const parts: string[] = [];
	let i = 0;
	while (i < type.length) {
		if (type[i] === '"') {
			let part = '';
			let j = i + 1;
			while (j < type.length) {
				if (type[j] === '"') {
					if (type[j + 1] === '"') {
						part += '"';
						j += 2;
						continue;
					}
					break;
				}
				part += type[j];
				j++;
			}
			parts.push(part);
			i = j + 1;
		} else {
			const dot = type.indexOf('.', i);
			const end = dot === -1 ? type.length : dot;
			parts.push(type.slice(i, end).trim().toLowerCase());
			i = end;
		}
		if (type[i] === '.') i++;
	}
	return parts;
}

/**
 * The range constructor for a `RangeValue` on this column (#1047): the
 * column's declared SQL type, named exactly as its cast names it, or one of
 * the built-in range column types. A column with no range type is refused.
 */
function rangeConstructorName(
	operand: ResolvedColumnOperand,
	ctx: CompilerContext,
	state: CompilerState,
): string[] {
	const col = metadata(operand, ctx, state);
	const refuse = (detail: string): never => {
		throw new Error(
			`A range value { lower, upper } needs a column declared with a range type; '${operand.column}' ${detail}. Declare the column's range type, or use the tuple form with a rangeType.`,
		);
	};
	if (col?.originalDbType) {
		const rendered = renderColumnDbType(col, ctx.schema).trim();
		validateDbType(rendered);
		const base = typeNameParts(rendered).at(-1) ?? '';
		if (
			rendered.endsWith('[]') ||
			rendered.includes('(') ||
			base.endsWith('multirange') ||
			(isPgBuiltInTypeName(rendered) && !BUILT_IN_RANGE_TYPES.has(base))
		)
			refuse(`is declared '${rendered}'`);
		return typeNameParts(dbTypeCastTarget(rendered));
	}
	if (col?.type !== undefined && BUILT_IN_RANGE_TYPES.has(col.type))
		return [col.type];
	return refuse(
		col?.type !== undefined
			? `is declared '${col.type}'`
			: 'has no declared type',
	);
}

/** A column's cast type, or for an aggregate HAVING alias its result type. */
function leftType(
	operand: ResolvedLeftOperand,
	ctx: CompilerContext,
	state: CompilerState,
): string | undefined {
	if (operand.kind !== 'aggregate') return columnType(operand, ctx, state);
	return aggregateResultPgType(
		operand.function,
		operand.column ? columnType(operand.column, ctx, state) : undefined,
	);
}
function parameter(
	p: ResolvedParameter,
	ctx: CompilerContext,
	state: CompilerState,
	left?: ResolvedLeftOperand,
	force = false,
): Node {
	const type =
		left && (p.cast === 'column-db-type' || p.cast === 'column-array')
			? leftType(left, ctx, state)
			: undefined;
	// A resolved parameter's value is data: no parameter syntax is read in it.
	if (!p.bound && !force && (p.value === null || p.value === undefined))
		return nullConstNode();
	const index = ++state.paramIndex;
	state.parameters.push(p.value);
	return type ? createTypeCastParamRef(index, type) : createParamRef(index);
}
function rhs(
	value: ResolvedRhs,
	ctx: CompilerContext,
	state: CompilerState,
	left?: ResolvedLeftOperand,
): Node {
	if ('range' in value && 'column' in value) return column(value, ctx);
	if (value.kind === 'parameter' && 'cast' in value)
		return parameter(value, ctx, state, left);
	return compileResolvedExpressionUnchecked(value, ctx, state);
}
function comparison(
	operator: string,
	left: Node,
	right: ResolvedRhs,
	ctx: CompilerContext,
	state: CompilerState,
	operand?: ResolvedLeftOperand,
): Node {
	if (right.kind === 'parameter' && 'bound' in right && !right.bound) {
		const nullResult = compileLiteralNullComparison(
			op(operator),
			left,
			right.value,
		);
		if (nullResult) return nullResult;
	}
	if (operator === 'like' || operator === 'ilike')
		return compileLike(
			left,
			rhs(right, ctx, state, operand),
			operator === 'ilike',
		);
	return compileComparison(op(operator), left, rhs(right, ctx, state, operand));
}
function from(range: ResolvedRange, ctx: CompilerContext): Node {
	const binding = relationBindingFor(ctx.scope, queryLocal(range.table));
	const local =
		binding?.kind === 'cte-bind' || binding?.kind === 'batch-values'
			? binding
			: undefined;
	return sqlRangeVar(
		local?.qualifier ??
			resolveDeclaredIdentifier(ctx.declaredNames, ctx.dbCasing ?? 'preserve', {
				kind: 'table',
				table: range.table,
			}),
		queryLocal(range.alias),
		(local && local.kind !== 'declared-table') || ctx.schema === undefined
			? undefined
			: queryLocal(ctx.schema),
	);
}
function projection(
	p: ResolvedProjection,
	ctx: CompilerContext,
	state: CompilerState,
): Node[] {
	switch (p.kind) {
		case 'list':
			return p.projections.flatMap((item) => projection(item, ctx, state));
		case 'column':
			return [column(p.operand, ctx)];
		case 'expression':
			return [compileResolvedExpressionUnchecked(p.expression, ctx, state)];
		case 'aggregate':
			if (p.argument === '*' && p.distinct)
				throw new Error(
					`${p.function}(DISTINCT *) is not valid SQL — PostgreSQL does not support DISTINCT on a star aggregate; provide a specific column.`,
				);
			return [
				funcCall(
					p.function.toLowerCase(),
					p.argument === '*' ? [] : [column(p.argument, ctx)],
					{ star: p.argument === '*', distinct: p.distinct },
				),
			];
	}
}
function compileResolvedSubqueryBodyUnchecked(
	body: ResolvedSubqueryBody,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const selected =
		body.use === 'in'
			? [column(body.select, ctx)]
			: body.select
				? projection(body.select, ctx, state)
				: [integerNode(1)];
	const stmt: SelectStmt = {
		targetList: selected.map((val) => ({ ResTarget: { val } })),
		fromClause: [from(body.range, ctx)],
		...(body.where && {
			whereClause: compileResolvedConditionUnchecked(body.where, ctx, state),
		}),
	};
	if (body.defaultFilter) {
		const filter = compileResolvedConditionUnchecked(
			body.defaultFilter,
			ctx,
			state,
		);
		stmt.whereClause = stmt.whereClause
			? andExpr(stmt.whereClause, filter)
			: filter;
	}
	if (body.use !== 'exists') {
		if (body.orderBy.length)
			stmt.sortClause = body.orderBy.map((o) =>
				sortBy(
					compileResolvedExpressionUnchecked(o.expression, ctx, state),
					o.direction === 'desc' ? 'DESC' : 'ASC',
					o.nulls === 'first'
						? 'FIRST'
						: o.nulls === 'last'
							? 'LAST'
							: 'DEFAULT',
				),
			);
		if (body.limit !== undefined)
			stmt.limitCount =
				typeof body.limit === 'number'
					? integerNode(body.limit)
					: parameter(body.limit, ctx, state, undefined, true);
	}
	return { SelectStmt: stmt };
}
/** A nested select, compiled by the root select compiler, in this statement's parameter sequence. */
function nestedSelect(
	select: ResolvedNestedSelect,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	if (!ctx.compileNestedSelect)
		throw new Error(
			'An expression subquery reached the adapter without its nested select.',
		);
	const compiled = ctx.compileNestedSelect(select, ctx);
	const ast = renumberParamRefsInAst(compiled.ast, state.paramIndex);
	state.parameters.push(...compiled.parameters);
	state.paramIndex += compiled.parameters.length;
	return ast;
}
function compileResolvedExpressionUnchecked(
	expr: ResolvedExpression,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const compile = (e: ResolvedExpression) =>
		compileResolvedExpressionUnchecked(e, ctx, state);
	switch (expr.kind) {
		case 'wholeRow':
			return {
				ColumnRef: {
					fields: [
						{
							String: {
								sval: address(
									{ kind: 'column', range: expr.range, column: '*' },
									ctx,
								).binding.qualifier,
							},
						},
					],
				},
			};
		case 'ref':
			return expr.unqualified
				? sqlColumnRef(address(expr.operand, ctx).identifier)
				: column(expr.operand, ctx);
		case 'parameter': {
			const index = ++state.paramIndex;
			state.parameters.push(expr.value);
			return createParamRef(index);
		}
		case 'literal':
			if (expr.value == null) return nullConstNode();
			if (typeof expr.value === 'boolean') return booleanConstNode(expr.value);
			if (typeof expr.value === 'number') return numericLiteralNode(expr.value);
			if (typeof expr.value === 'string') return stringConstNode(expr.value);
			throw new Error(
				`literal(): unsupported value type "${typeof expr.value}". Only null, boolean, number, and string are allowed. Use param() to bind computed or user-supplied values.`,
			);
		case 'star':
			return { ColumnRef: { fields: [{ A_Star: {} }] } };
		case 'array':
			return { A_ArrayExpr: { elements: expr.elements.map(compile) } };
		case 'namedArg':
			if (typeof expr.name !== 'string')
				throw new Error(
					`namedArg(): name must be a plain string, got ${typeof expr.name}.`,
				);
			validateIdentifier(expr.name, 'alias');
			return {
				NamedArgExpr: {
					name: expr.name,
					arg: compile(expr.value),
					argnumber: -1,
				},
			} as unknown as Node;
		case 'cast':
			if (typeof expr.typeName !== 'string')
				throw new Error(
					`cast(): typeName must be a plain string, got ${typeof expr.typeName}.`,
				);
			validateTypeName(expr.typeName);
			return typeCast(compile(expr.expression), expr.typeName);
		case 'subquery':
			return {
				SubLink: {
					subLinkType: 'EXPR_SUBLINK',
					subselect:
						'select' in expr
							? nestedSelect(expr.select, ctx, state)
							: compileResolvedSubqueryBodyUnchecked(expr.body, ctx, state),
				},
			};
		case 'operator': {
			if (
				expr.syntax === 'arithmetic' &&
				!['+', '-', '*', '/', '%'].includes(expr.operator)
			)
				throw new Error(
					`Unsupported arithmetic operator '${escapeDiagnosticText(expr.operator)}'`,
				);
			const comparisonOperator =
				expr.syntax === 'comparison' ? op(expr.operator) : undefined;
			if (expr.syntax === 'custom' || expr.syntax === 'unary')
				assertSafeOperator(
					expr.operator,
					expr.syntax === 'unary' ? { allowWords: ['NOT'] } : undefined,
				);
			const nodes = expr.operands.map(compile);
			if (expr.syntax === 'comparison')
				return compileComparison(comparisonOperator!, nodes[0]!, nodes[1]!);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: expr.operator } }],
					...(nodes.length > 1 && { lexpr: nodes[0] }),
					rexpr: nodes[nodes.length - 1]!,
				},
			};
		}
		case 'call': {
			const args = expr.args.map(compile);
			const orderBy = expr.orderBy?.map((o) =>
				sortBy(
					compile(o.expression),
					o.direction === 'desc' ? 'DESC' : 'ASC',
					o.nulls === 'first'
						? 'FIRST'
						: o.nulls === 'last'
							? 'LAST'
							: 'DEFAULT',
				),
			);
			const filter =
				expr.filter &&
				compileResolvedConditionUnchecked(expr.filter, ctx, state);
			return funcCall(expr.name.split('.'), args, {
				distinct: expr.distinct === true,
				...(orderBy?.length && { orderBy }),
				...(filter && { filter }),
			});
		}
		case 'case':
			if (!expr.branches.length)
				throw new Error('CASE expression requires at least one WHEN clause');
			return {
				CaseExpr: {
					args: expr.branches.map((b) => ({
						CaseWhen: {
							expr: compileResolvedConditionUnchecked(b.condition, ctx, state),
							result: compile(b.result),
						},
					})),
					...(expr.fallback && { defresult: compile(expr.fallback) }),
				},
			};
	}
}
function compileResolvedConditionUnchecked(
	tree: ResolvedCondition,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const visit = (n: ResolvedCondition) =>
		compileResolvedConditionUnchecked(n, ctx, state);
	const col = (c: ResolvedColumnOperand) => column(c, ctx);
	/** A HAVING alias compiles as its aggregate call, its FILTER bound first. */
	const left = (c: ResolvedLeftOperand): Node =>
		c.kind !== 'aggregate'
			? col(c)
			: funcCall(c.function.toLowerCase(), c.column ? [col(c.column)] : [], {
					...(!c.column && { star: true }),
					...(c.distinct && { distinct: true }),
					...(c.filter && { filter: visit(c.filter) }),
				});
	switch (tree.kind) {
		case 'and':
		case 'or': {
			const nodes = tree.conditions.map(visit);
			return !nodes.length
				? booleanConstNode(tree.kind === 'and')
				: nodes.length === 1
					? nodes[0]!
					: tree.kind === 'and'
						? andExpr(...nodes)
						: orExpr(...nodes);
		}
		case 'not':
			return notExpr(visit(tree.condition));
		case 'null':
			return compileNull(left(tree.left), tree.operator === 'isNull');
		case 'comparison': {
			assertComparisonOperator(tree.operator);
			let leftNode = left(tree.left);
			if (tree.jsonPath?.length) {
				assertDialectCapability(
					ctx.dialectCapabilities,
					'supportsJsonOperators',
					'JSON operators are',
				);
				tree.jsonPath.forEach((p, i) => {
					leftNode = compileJsonOperator(
						leftNode,
						parameter(p, ctx, state),
						i === tree.jsonPath!.length - 1 && tree.jsonMode !== 'json'
							? '->>'
							: '->',
					);
				});
			}
			return comparison(
				tree.operator,
				leftNode,
				tree.right,
				ctx,
				state,
				tree.jsonPath ? undefined : tree.left,
			);
		}
		case 'like': {
			const left = col(tree.left);
			if (!tree.pattern.bound) {
				const n = compileLiteralNullComparison(
					tree.caseInsensitive ? 'ilike' : 'like',
					left,
					tree.pattern.value,
				);
				if (n) return n;
			}
			return compileLike(
				left,
				parameter(tree.pattern, ctx, state, undefined, true),
				tree.caseInsensitive,
				tree.escape && parameter(tree.escape, ctx, state, undefined, true),
			);
		}
		case 'any': {
			if (tree.values.cast !== 'any-array')
				throw new Error('Resolved ANY requires any-array cast authority');
			assertDialectCapability(
				ctx.dialectCapabilities,
				'supportsArrayType',
				'ANY array operator is',
			);
			const type = leftType(tree.left, ctx, state);
			// Without a physical type, the model's abstract type sets the array base;
			// for an aggregate, the base is the aggregate's result over that type.
			const modelBase = (operand: ResolvedColumnOperand): string | undefined =>
				mapModelIRTypeToPgBase(metadata(operand, ctx, state)?.type ?? '');
			const base = type
				? undefined
				: tree.left.kind !== 'aggregate'
					? modelBase(tree.left)
					: aggregateResultPgType(
							tree.left.function,
							tree.left.column ? modelBase(tree.left.column) : undefined,
						);
			return compileAny(
				left(tree.left),
				Array.isArray(tree.values.value) ? tree.values.value : [],
				state,
				type,
				base,
			);
		}
		case 'in': {
			if (tree.operand.kind === 'subquery') {
				const node: Node = {
					SubLink: {
						subLinkType: 'ANY_SUBLINK',
						testexpr: left(tree.left),
						operName: [{ String: { sval: '=' } }],
						subselect: compileResolvedSubqueryBodyUnchecked(
							tree.operand.body,
							ctx,
							state,
						),
					},
				};
				return tree.negated ? notExpr(node) : node;
			}
			const values = tree.operand.parameter.value;
			// An empty list is a constant: no operand is compiled, so an aggregate's
			// FILTER binds no parameter.
			if (Array.isArray(values) && values.length === 0)
				return booleanConstNode(tree.negated);
			if (!Array.isArray(values))
				throw new Error(
					`[in handler] Received a non-array value for operator '${tree.negated ? 'notIn' : 'in'}' on column '${tree.left.kind === 'aggregate' ? tree.left.function : tree.left.column}'. This is a compiler bug: expected a scalar array but received ${values == null ? String(values) : typeof values}. File a bug report.`,
				);
			return compileInValues(
				left(tree.left),
				state,
				values,
				tree.negated,
				tree.operand.parameter.cast === 'column-array'
					? leftType(tree.left, ctx, state)
					: undefined,
				supportsDialectCapability(ctx.dialectCapabilities, 'supportsArrayType'),
			);
		}
		case 'range': {
			const rangeOperator = rangeOp(tree.operator);
			if (tree.operator === 'between') {
				const v = (tree.value as ResolvedParameter).value as {
					lower: unknown;
					upper: unknown;
				};
				const lower = compileValue(v.lower, state, undefined, true),
					upper = compileValue(v.upper, state, undefined, true);
				return {
					A_Expr: {
						kind: 'AEXPR_BETWEEN',
						name: [{ String: { sval: 'BETWEEN' } }],
						lexpr: col(tree.left),
						rexpr: { List: { items: [lower, upper] } },
					},
				};
			}
			assertDialectCapability(
				ctx.dialectCapabilities,
				'supportsRangeTypes',
				'Range operators are',
			);
			const rangeValue = tree.value;
			if (rangeValue.kind === 'rangeConstructor') {
				const name = rangeConstructorName(tree.left, ctx, state);
				// A null bound is a bound parameter (an unbounded side), never NULL text.
				const bound = (side: ResolvedRhs): Node =>
					side.kind === 'parameter' && 'cast' in side
						? parameter(side, ctx, state, undefined, true)
						: rhs(side, ctx, state);
				return {
					A_Expr: {
						kind: 'AEXPR_OP',
						name: [{ String: { sval: rangeOperator } }],
						lexpr: col(tree.left),
						rexpr: funcCall(name, [
							bound(rangeValue.lower),
							bound(rangeValue.upper),
							stringConstNode(rangeValue.bounds),
						]),
					},
				};
			}
			const type = metadata(tree.left, ctx, state)?.type;
			let castType: string | undefined =
				rangeValue.cast !== 'none' && type?.endsWith('range')
					? type
					: undefined;
			if (castType && rangeValue.cast === 'range-element') {
				castType = castType.replace(/range$/, '');
				castType =
					(
						{
							int4: 'integer',
							int8: 'bigint',
							tstz: 'timestamptz',
							ts: 'timestamp',
						} as Record<string, string>
					)[castType] ?? castType;
			}
			return compileRangeParameter(
				col(tree.left),
				rangeOperator,
				rangeValue.value,
				state,
				castType,
			);
		}
		case 'jsonContains':
		case 'jsonExists':
			assertDialectCapability(
				ctx.dialectCapabilities,
				'supportsJsonOperators',
				'JSON operators are',
			);
			return compileJsonOperator(
				col(tree.left),
				parameter(
					tree.kind === 'jsonContains' ? tree.value : tree.key,
					ctx,
					state,
				),
				tree.kind === 'jsonExists' ? '?' : tree.reversed ? '<@' : '@>',
			);
		case 'expression': {
			if (tree.comparison) assertComparisonOperator(tree.comparison.operator);
			const left = compileResolvedExpressionUnchecked(
				tree.expression,
				ctx,
				state,
			);
			return tree.comparison
				? comparison(
						tree.comparison.operator,
						left,
						tree.comparison.right,
						ctx,
						state,
					)
				: left;
		}
		case 'subquery': {
			if (tree.use !== 'exists') assertComparisonOperator(tree.operator);
			const node: Node = {
				SubLink: {
					subLinkType:
						tree.use === 'exists' ? 'EXISTS_SUBLINK' : 'EXPR_SUBLINK',
					subselect: compileResolvedSubqueryBodyUnchecked(
						tree.body,
						ctx,
						state,
					),
				},
			};
			return tree.use === 'exists'
				? tree.negated
					? notExpr(node)
					: node
				: compileComparison(op(tree.operator), left(tree.left), node);
		}
		case 'relation': {
			if (tree.vacuous) return booleanConstNode(true);
			const correlation = (
				source: ResolvedRange,
				target: ResolvedRange,
				pairs: readonly { fromColumn: string; toColumn: string }[],
				relationName: string,
			) => {
				const nodes = pairs.map((p) =>
					binaryExpr(
						'=',
						col({ kind: 'column', range: source, column: p.fromColumn }),
						column(
							{ kind: 'column', range: target, column: p.toColumn },
							ctx,
							relationName,
						),
					),
				);
				if (!nodes.length)
					throw new Error(
						'Resolved condition relation requires declared correlation keys',
					);
				return nodes.length === 1 ? nodes[0]! : andExpr(...nodes);
			};
			let predicate = tree.predicate && visit(tree.predicate);
			if (predicate && tree.quantifier === 'every')
				predicate = notExpr(predicate);
			for (let i = tree.hops.length - 1; i >= 0; i--) {
				const hop = tree.hops[i]!;
				let quals = correlation(
					hop.from,
					hop.to,
					tree.path.hops[i]!.pairs,
					tree.path.logicalSegments[i]!,
				);
				if (hop.defaultFilter) quals = andExpr(quals, visit(hop.defaultFilter));
				let source = from(hop.to, ctx);
				if (i === tree.hops.length - 1)
					for (const join of tree.joins) {
						let on = correlation(
							join.source,
							join.range,
							join.path.hops[0]!.pairs,
							join.path.logicalSegments[0]!,
						);
						if (join.defaultFilter) on = andExpr(on, visit(join.defaultFilter));
						source = joinExpr(
							join.type === 'left' ? 'JOIN_LEFT' : 'JOIN_INNER',
							source,
							from(join.range, ctx),
							on,
						);
					}
				predicate = {
					SubLink: {
						subLinkType: 'EXISTS_SUBLINK',
						subselect: {
							SelectStmt: {
								targetList: [{ ResTarget: { val: integerNode(1) } }],
								fromClause: [source],
								whereClause: predicate ? andExpr(quals, predicate) : quals,
							},
						},
					},
				};
			}
			return tree.quantifier === 'some' ? predicate! : notExpr(predicate!);
		}
	}
}

export function compileResolvedCondition(
	tree: ResolvedCondition,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	validateOperators(tree);
	return compileResolvedConditionUnchecked(tree, ctx, state);
}
export function compileResolvedExpression(
	expr: ResolvedExpression,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	validateOperators(expr);
	return compileResolvedExpressionUnchecked(expr, ctx, state);
}
export function compileResolvedSubqueryBody(
	body: ResolvedSubqueryBody,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	validateOperators(body);
	return compileResolvedSubqueryBodyUnchecked(body, ctx, state);
}
