/**
 * NQL CST-to-AST Visitor
 *
 * Transforms Chevrotain CST (Concrete Syntax Tree) to NQL AST (Abstract Syntax Tree).
 */

import type { CstNode, IToken } from 'chevrotain';
import type {
	NqlAssignment,
	NqlBetweenExpression,
	NqlClause,
	NqlExistsExpression,
	NqlExpression,
	NqlFunctionCall,
	NqlInExpression,
	NqlIsNullExpression,
	NqlJoinParam,
	NqlJoinSpec,
	NqlLetBinding,
	NqlLiteral,
	NqlMutation,
	NqlMutationClause,
	NqlMutationPipeline,
	NqlOrderItem,
	NqlProgram,
	NqlQuery,
	NqlRangeLiteral,
	NqlRangeOpExpression,
	NqlSelectItem,
	NqlStatement,
	NqlSubquery,
	NqlWindowExpression,
} from '../parser/ast.js';
import { nqlParser } from '../parser/grammar.js';

// Helper type for CST context - values are arrays of CstNode or IToken
type CstContext = Record<string, (CstNode | IToken)[] | undefined>;

// Type guard to check if value is a CstNode (has children property)
function isCstNode(value: CstNode | IToken): value is CstNode {
	return 'children' in value;
}

// Helper to safely extract CstNode from context array
function asCstNode(value: CstNode | IToken): CstNode {
	if (!isCstNode(value)) {
		throw new Error(
			`Expected CstNode but got IToken: ${(value as IToken).image}`,
		);
	}
	return value;
}

// Helper to get token image
function getImage(value: CstNode | IToken): string {
	if (isCstNode(value)) {
		throw new Error('Expected IToken but got CstNode');
	}
	return (value as IToken).image;
}

// Get the base visitor class from the parser
const BaseCstVisitor = nqlParser.getBaseCstVisitorConstructor();

/**
 * CST Visitor that transforms Chevrotain CST to NQL AST
 */
export class NqlCstVisitor extends BaseCstVisitor {
	constructor() {
		super();
		this.validateVisitor();
	}

	// ============================================================
	// TOP-LEVEL
	// ============================================================

	program(ctx: CstContext): NqlProgram {
		const bindings: NqlLetBinding[] = [];
		const statements: NqlStatement[] = [];

		if (ctx.letStatement) {
			for (const letCtx of ctx.letStatement) {
				bindings.push(this.visit(asCstNode(letCtx)));
			}
		}

		if (ctx.statement) {
			for (const stmtCtx of ctx.statement) {
				statements.push(this.visit(asCstNode(stmtCtx)));
			}
		}

		return { type: 'program', bindings, statements };
	}

	letStatement(ctx: CstContext): NqlLetBinding {
		if (!ctx.identSegment || !ctx.query) {
			throw new Error('Invalid let statement');
		}
		return {
			type: 'let',
			name: this.visit(asCstNode(ctx.identSegment[0])),
			query: this.visit(asCstNode(ctx.query[0])),
		};
	}

	statement(ctx: CstContext): NqlStatement {
		if (ctx.query) return this.visit(asCstNode(ctx.query[0]));
		if (ctx.mutationPipeline)
			return this.visit(asCstNode(ctx.mutationPipeline[0]));
		throw new Error('Invalid statement');
	}

	// ============================================================
	// QUERIES
	// ============================================================

	query(ctx: CstContext): NqlQuery {
		if (!ctx.tableRef) throw new Error('Query missing table');
		const table = this.visit(asCstNode(ctx.tableRef[0]));
		const clauses: NqlClause[] = [];

		if (ctx.queryClause) {
			for (const clauseCtx of ctx.queryClause) {
				clauses.push(this.visit(asCstNode(clauseCtx)));
			}
		}

		return { type: 'query', table, clauses };
	}

	tableRef(ctx: CstContext): string {
		if (!ctx.identSegment) throw new Error('Table ref missing identifier');
		return this.visit(asCstNode(ctx.identSegment[0]));
	}

	queryClause(ctx: CstContext): NqlClause {
		if (ctx.whereClause) return this.visit(asCstNode(ctx.whereClause[0]));
		if (ctx.selectClause) return this.visit(asCstNode(ctx.selectClause[0]));
		if (ctx.flatClause) return this.visit(asCstNode(ctx.flatClause[0]));
		if (ctx.groupClause) return this.visit(asCstNode(ctx.groupClause[0]));
		if (ctx.orderClause) return this.visit(asCstNode(ctx.orderClause[0]));
		if (ctx.limitClause) return this.visit(asCstNode(ctx.limitClause[0]));
		if (ctx.offsetClause) return this.visit(asCstNode(ctx.offsetClause[0]));
		throw new Error('Unknown query clause');
	}

	whereClause(ctx: CstContext): NqlClause {
		if (!ctx.booleanExpr) throw new Error('Where clause missing expression');
		return {
			type: 'where',
			condition: this.visit(asCstNode(ctx.booleanExpr[0])),
		};
	}

	selectClause(ctx: CstContext): NqlClause {
		const distinct = !!ctx.Distinct;
		const items: NqlSelectItem[] = [];

		if (ctx.selectList) {
			const listItems = this.visit(
				asCstNode(ctx.selectList[0]),
			) as NqlSelectItem[];
			items.push(...listItems);
		}

		return { type: 'select', distinct, items };
	}

	/**
	 * flat_clause = "flat" ;
	 * NQL v2.1: Forces JOIN strategy instead of json_agg
	 */
	flatClause(_ctx: CstContext): NqlClause {
		return { type: 'flat' };
	}

	groupClause(ctx: CstContext): NqlClause {
		const expressions: NqlExpression[] = [];
		if (ctx.exprList) {
			const exprs = this.visit(asCstNode(ctx.exprList[0])) as NqlExpression[];
			expressions.push(...exprs);
		}
		return { type: 'groupBy', expressions };
	}

	orderClause(ctx: CstContext): NqlClause {
		const items: NqlOrderItem[] = [];
		if (ctx.orderList) {
			const orderItems = this.visit(
				asCstNode(ctx.orderList[0]),
			) as NqlOrderItem[];
			items.push(...orderItems);
		}
		return { type: 'orderBy', items };
	}

	limitClause(ctx: CstContext): NqlClause {
		if (!ctx.NumberLiteral) throw new Error('Limit clause missing number');
		return {
			type: 'limit',
			count: parseInt(getImage(ctx.NumberLiteral[0]), 10),
		};
	}

	offsetClause(ctx: CstContext): NqlClause {
		if (!ctx.NumberLiteral) throw new Error('Offset clause missing number');
		return {
			type: 'offset',
			count: parseInt(getImage(ctx.NumberLiteral[0]), 10),
		};
	}

	// ============================================================
	// JOIN SPECIFICATION
	// ============================================================

	joinSpec(ctx: CstContext): NqlJoinSpec {
		if (!ctx.identSegment) throw new Error('Join spec missing relation');
		const relation = this.visit(asCstNode(ctx.identSegment[0]));
		let via: string | undefined;
		let condition: NqlExpression | undefined;
		let params: NqlJoinParam[] | undefined;

		// Handle via disambiguation
		if (ctx.Via && ctx.identSegment.length > 1) {
			via = this.visit(asCstNode(ctx.identSegment[1]));
		}

		// Handle params
		if (ctx.paramList) {
			params = this.visit(asCstNode(ctx.paramList[0]));
		}

		// Handle ON condition
		if (ctx.On && ctx.booleanExpr) {
			condition = this.visit(asCstNode(ctx.booleanExpr[0]));
		}

		return { relation, via, condition, params };
	}

	paramList(ctx: CstContext): NqlJoinParam[] {
		const params: NqlJoinParam[] = [];
		if (ctx.param) {
			for (const paramCtx of ctx.param) {
				params.push(this.visit(asCstNode(paramCtx)));
			}
		}
		return params;
	}

	param(ctx: CstContext): NqlJoinParam {
		if (!ctx.identSegment || !ctx.literal) {
			throw new Error('Param missing name or value');
		}
		return {
			name: this.visit(asCstNode(ctx.identSegment[0])),
			value: this.visit(asCstNode(ctx.literal[0])),
		};
	}

	// ============================================================
	// SELECT LIST
	// ============================================================

	selectList(ctx: CstContext): NqlSelectItem[] {
		const items: NqlSelectItem[] = [];
		if (ctx.selectItem) {
			for (const itemCtx of ctx.selectItem) {
				items.push(this.visit(asCstNode(itemCtx)));
			}
		}
		return items;
	}

	selectItem(ctx: CstContext): NqlSelectItem {
		// Star (*)
		if (ctx.Star && !ctx.relationStarExpr) {
			return { type: 'star' };
		}

		// Relation star (relation.*)
		if (ctx.relationStarExpr) {
			return this.visit(asCstNode(ctx.relationStarExpr[0]));
		}

		// Expression with optional alias
		if (!ctx.expression) throw new Error('Select item missing expression');
		const expression = this.visit(asCstNode(ctx.expression[0]));
		const alias = ctx.identSegment
			? this.visit(asCstNode(ctx.identSegment[0]))
			: undefined;

		return { type: 'expression', expression, alias };
	}

	relationStarExpr(ctx: CstContext): NqlSelectItem {
		const segments: string[] = [];
		if (ctx.identSegment) {
			for (const segCtx of ctx.identSegment) {
				segments.push(this.visit(asCstNode(segCtx)));
			}
		}
		return { type: 'relationStar', relation: segments };
	}

	// ============================================================
	// ORDER LIST
	// ============================================================

	orderList(ctx: CstContext): NqlOrderItem[] {
		const items: NqlOrderItem[] = [];
		if (ctx.orderItem) {
			for (const itemCtx of ctx.orderItem) {
				items.push(this.visit(asCstNode(itemCtx)));
			}
		}
		return items;
	}

	orderItem(ctx: CstContext): NqlOrderItem {
		if (!ctx.expression) throw new Error('Order item missing expression');
		const expression = this.visit(asCstNode(ctx.expression[0]));
		const direction: 'asc' | 'desc' = ctx.Desc ? 'desc' : 'asc';
		return { expression, direction };
	}

	// ============================================================
	// BOOLEAN EXPRESSIONS
	// ============================================================

	booleanExpr(ctx: CstContext): NqlExpression {
		if (!ctx.orExpr) throw new Error('Boolean expr missing orExpr');
		return this.visit(asCstNode(ctx.orExpr[0]));
	}

	orExpr(ctx: CstContext): NqlExpression {
		if (!ctx.andExpr) throw new Error('Or expr missing andExpr');
		let left = this.visit(asCstNode(ctx.andExpr[0]));

		if (ctx.andExpr.length > 1) {
			for (let i = 1; i < ctx.andExpr.length; i++) {
				const right = this.visit(asCstNode(ctx.andExpr[i]));
				left = { type: 'binary', operator: 'or', left, right };
			}
		}
		return left;
	}

	andExpr(ctx: CstContext): NqlExpression {
		if (!ctx.notExpr) throw new Error('And expr missing notExpr');
		let left = this.visit(asCstNode(ctx.notExpr[0]));

		if (ctx.notExpr.length > 1) {
			for (let i = 1; i < ctx.notExpr.length; i++) {
				const right = this.visit(asCstNode(ctx.notExpr[i]));
				left = { type: 'binary', operator: 'and', left, right };
			}
		}
		return left;
	}

	notExpr(ctx: CstContext): NqlExpression {
		if (!ctx.primaryCond) throw new Error('Not expr missing primaryCond');
		const expr = this.visit(asCstNode(ctx.primaryCond[0]));

		if (ctx.Not) {
			return { type: 'unary', operator: 'not', operand: expr };
		}
		return expr;
	}

	primaryCond(ctx: CstContext): NqlExpression {
		// Parenthesized boolean expression
		if (ctx.booleanExpr) {
			return this.visit(asCstNode(ctx.booleanExpr[0]));
		}

		// EXISTS check
		if (ctx.existsCheck) {
			return this.visit(asCstNode(ctx.existsCheck[0]));
		}

		// Expression-based conditions
		if (!ctx.expression) throw new Error('PrimaryCond missing expression');
		const left = this.visit(asCstNode(ctx.expression[0]));

		// Check for suffix
		if (ctx.comparisonSuffix) {
			return this.buildComparison(left, asCstNode(ctx.comparisonSuffix[0]));
		}
		if (ctx.betweenSuffix) {
			return this.buildBetween(left, asCstNode(ctx.betweenSuffix[0]));
		}
		if (ctx.inSuffix) {
			return this.buildIn(left, asCstNode(ctx.inSuffix[0]));
		}
		if (ctx.isNullSuffix) {
			return this.buildIsNull(left, asCstNode(ctx.isNullSuffix[0]));
		}
		// Range operators (overlaps, contains, containedBy) with range literal
		if (ctx.rangeOpSuffix) {
			return this.buildRangeOp(left, asCstNode(ctx.rangeOpSuffix[0]));
		}

		// Just an expression
		return left;
	}

	private buildComparison(
		left: NqlExpression,
		suffixNode: CstNode,
	): NqlExpression {
		const suffixCtx = suffixNode.children as CstContext;
		if (!suffixCtx.compOp || !suffixCtx.expression) {
			throw new Error('Comparison suffix missing operator or expression');
		}
		const operator = this.visit(asCstNode(suffixCtx.compOp[0])) as
			| '='
			| '!='
			| '<'
			| '>'
			| '<='
			| '>='
			| 'like';
		const right = this.visit(asCstNode(suffixCtx.expression[0]));
		return { type: 'comparison', operator, left, right };
	}

	private buildBetween(
		left: NqlExpression,
		suffixNode: CstNode,
	): NqlBetweenExpression {
		const suffixCtx = suffixNode.children as CstContext;
		if (!suffixCtx.expression || suffixCtx.expression.length < 2) {
			throw new Error('Between suffix missing expressions');
		}
		return {
			type: 'between',
			expression: left,
			low: this.visit(asCstNode(suffixCtx.expression[0])),
			high: this.visit(asCstNode(suffixCtx.expression[1])),
		};
	}

	private buildIn(left: NqlExpression, suffixNode: CstNode): NqlInExpression {
		const suffixCtx = suffixNode.children as CstContext;
		const negated = !!suffixCtx.Not;

		// Date range literal
		if (suffixCtx.StringLiteral) {
			const raw = getImage(suffixCtx.StringLiteral[0]);
			const value = raw.slice(1, -1).replace(/''/g, "'");
			return {
				type: 'in',
				negated,
				expression: left,
				values: { type: 'dateRange', value },
			};
		}

		// Subquery
		if (suffixCtx.scalarSubquery) {
			return {
				type: 'in',
				negated,
				expression: left,
				values: this.visit(asCstNode(suffixCtx.scalarSubquery[0])),
			};
		}

		// Value list
		const values: NqlExpression[] = [];
		if (suffixCtx.valueList) {
			const listValues = this.visit(
				asCstNode(suffixCtx.valueList[0]),
			) as NqlExpression[];
			values.push(...listValues);
		}

		return { type: 'in', negated, expression: left, values };
	}

	private buildIsNull(
		left: NqlExpression,
		suffixNode: CstNode,
	): NqlIsNullExpression {
		const suffixCtx = suffixNode.children as CstContext;
		return {
			type: 'isNull',
			expression: left,
			negated: !!suffixCtx.Not,
		};
	}

	comparisonSuffix(_ctx: CstContext): NqlExpression {
		// This should not be called directly - handled by buildComparison
		throw new Error('comparisonSuffix should not be visited directly');
	}

	compOp(ctx: CstContext): string {
		if (ctx.Equals) return '=';
		if (ctx.NotEquals) return '!=';
		if (ctx.LessThan) return '<';
		if (ctx.GreaterThan) return '>';
		if (ctx.LessThanOrEqual) return '<=';
		if (ctx.GreaterThanOrEqual) return '>=';
		if (ctx.Like) return 'like';
		throw new Error('Unknown comparison operator');
	}

	/**
	 * Range operator: overlaps, contains, containedBy
	 * Handled separately to support full PostgreSQL range syntax.
	 */
	rangeOp(ctx: CstContext): 'overlaps' | 'contains' | 'containedBy' {
		if (ctx.Overlaps) return 'overlaps';
		if (ctx.Contains) return 'contains';
		if (ctx.ContainedBy) return 'containedBy';
		throw new Error('Unknown range operator');
	}

	/**
	 * Range operator suffix: rangeOp rangeLiteral
	 * This should not be called directly - handled by buildRangeOp
	 */
	rangeOpSuffix(_ctx: CstContext): NqlExpression {
		throw new Error('rangeOpSuffix should not be visited directly');
	}

	/**
	 * Build range comparison expression from column and range operator suffix.
	 */
	private buildRangeOp(
		left: NqlExpression,
		suffixNode: CstNode,
	): NqlRangeOpExpression {
		const suffixCtx = suffixNode.children as CstContext;
		if (!suffixCtx.rangeOp) {
			throw new Error('Range op suffix missing operator');
		}
		const operator = this.visit(asCstNode(suffixCtx.rangeOp[0])) as
			| 'overlaps'
			| 'contains'
			| 'containedBy';

		// Check if we have a range literal or a scalar literal
		if (suffixCtx.rangeLiteral) {
			const range = this.visit(
				asCstNode(suffixCtx.rangeLiteral[0]),
			) as NqlRangeLiteral;
			return {
				type: 'rangeOp',
				operator,
				left,
				range,
			};
		}
		if (suffixCtx.literal) {
			const scalar = this.visit(asCstNode(suffixCtx.literal[0])) as NqlLiteral;
			return {
				type: 'rangeOp',
				operator,
				left,
				scalar,
			};
		}

		throw new Error('Range op suffix missing range literal or scalar value');
	}

	betweenSuffix(_ctx: CstContext): NqlExpression {
		// This should not be called directly - handled by buildBetween
		throw new Error('betweenSuffix should not be visited directly');
	}

	existsCheck(ctx: CstContext): NqlExistsExpression {
		if (!ctx.scalarSubquery) throw new Error('Exists missing subquery');
		return {
			type: 'exists',
			negated: !!ctx.Not,
			subquery: this.visit(asCstNode(ctx.scalarSubquery[0])),
		};
	}

	inSuffix(_ctx: CstContext): NqlExpression {
		// This should not be called directly - handled by buildIn
		throw new Error('inSuffix should not be visited directly');
	}

	isNullSuffix(_ctx: CstContext): NqlExpression {
		// This should not be called directly - handled by buildIsNull
		throw new Error('isNullSuffix should not be visited directly');
	}

	// ============================================================
	// ARITHMETIC EXPRESSIONS
	// ============================================================

	expression(ctx: CstContext): NqlExpression {
		if (!ctx.addExpr) throw new Error('Expression missing addExpr');
		return this.visit(asCstNode(ctx.addExpr[0]));
	}

	addExpr(ctx: CstContext): NqlExpression {
		if (!ctx.mulExpr) throw new Error('AddExpr missing mulExpr');
		let left = this.visit(asCstNode(ctx.mulExpr[0]));

		if (ctx.mulExpr.length > 1) {
			// Collect operators in token order (by startOffset)
			const ops: { op: '+' | '-'; offset: number }[] = [];
			if (ctx.Plus) {
				for (const tok of ctx.Plus as IToken[]) {
					ops.push({ op: '+', offset: tok.startOffset });
				}
			}
			if (ctx.Minus) {
				for (const tok of ctx.Minus as IToken[]) {
					ops.push({ op: '-', offset: tok.startOffset });
				}
			}
			// Sort by position in source
			ops.sort((a, b) => a.offset - b.offset);

			for (let i = 1; i < ctx.mulExpr.length; i++) {
				const right = this.visit(asCstNode(ctx.mulExpr[i]));
				const op = ops[i - 1]?.op || '+';
				left = { type: 'binary', operator: op, left, right };
			}
		}

		return left;
	}

	mulExpr(ctx: CstContext): NqlExpression {
		if (!ctx.unaryExpr) throw new Error('MulExpr missing unaryExpr');
		let left = this.visit(asCstNode(ctx.unaryExpr[0]));

		if (ctx.unaryExpr.length > 1) {
			// Collect operators in token order (by startOffset)
			const ops: { op: '*' | '/' | '%'; offset: number }[] = [];
			if (ctx.Star) {
				for (const tok of ctx.Star as IToken[]) {
					ops.push({ op: '*', offset: tok.startOffset });
				}
			}
			if (ctx.Slash) {
				for (const tok of ctx.Slash as IToken[]) {
					ops.push({ op: '/', offset: tok.startOffset });
				}
			}
			if (ctx.Percent) {
				for (const tok of ctx.Percent as IToken[]) {
					ops.push({ op: '%', offset: tok.startOffset });
				}
			}
			// Sort by position in source
			ops.sort((a, b) => a.offset - b.offset);

			for (let i = 1; i < ctx.unaryExpr.length; i++) {
				const right = this.visit(asCstNode(ctx.unaryExpr[i]));
				const op = ops[i - 1]?.op || '*';
				left = { type: 'binary', operator: op, left, right };
			}
		}

		return left;
	}

	unaryExpr(ctx: CstContext): NqlExpression {
		if (!ctx.primaryExpr) throw new Error('UnaryExpr missing primaryExpr');
		const expr = this.visit(asCstNode(ctx.primaryExpr[0]));

		if (ctx.Minus) {
			return { type: 'unary', operator: '-', operand: expr };
		}
		return expr;
	}

	primaryExpr(ctx: CstContext): NqlExpression {
		// Literals
		if (ctx.literal) {
			return this.visit(asCstNode(ctx.literal[0]));
		}

		// Function call
		if (ctx.funcCall) {
			return this.visit(asCstNode(ctx.funcCall[0]));
		}

		// Path expression
		if (ctx.pathExpr) {
			return this.visit(asCstNode(ctx.pathExpr[0]));
		}

		// Parenthesized expression
		if (ctx.LParen && ctx.expression) {
			return this.visit(asCstNode(ctx.expression[0]));
		}

		// Scalar subquery
		if (ctx.scalarSubquery) {
			return this.visit(asCstNode(ctx.scalarSubquery[0]));
		}

		throw new Error('Invalid primary expression');
	}

	scalarSubquery(ctx: CstContext): NqlSubquery {
		if (!ctx.query) throw new Error('Scalar subquery missing query');
		return {
			type: 'subquery',
			query: this.visit(asCstNode(ctx.query[0])),
		};
	}

	pathExpr(ctx: CstContext): NqlExpression {
		const segments: string[] = [];
		if (ctx.identSegment) {
			for (const segCtx of ctx.identSegment) {
				segments.push(this.visit(asCstNode(segCtx)));
			}
		}
		return { type: 'path', segments };
	}

	funcCall(ctx: CstContext): NqlFunctionCall | NqlWindowExpression {
		// Get function name - either from window function keywords or identSegment
		let name: string;
		if (ctx.RowNumber) {
			name = 'row_number';
		} else if (ctx.Rank) {
			name = 'rank';
		} else if (ctx.DenseRank) {
			name = 'dense_rank';
		} else if (ctx.Lag) {
			name = 'lag';
		} else if (ctx.Lead) {
			name = 'lead';
		} else if (ctx.identSegment) {
			name = this.visit(asCstNode(ctx.identSegment[0]));
		} else {
			throw new Error('Function call missing name');
		}

		const args: NqlExpression[] = [];

		// count(*)
		if (ctx.Star) {
			args.push({ type: 'path', segments: ['*'] });
		} else if (ctx.funcArgList) {
			const argList = this.visit(
				asCstNode(ctx.funcArgList[0]),
			) as NqlExpression[];
			args.push(...argList);
		}

		// If there's a windowClause, return NqlWindowExpression
		if (ctx.windowClause) {
			const windowSpec = this.visit(asCstNode(ctx.windowClause[0])) as {
				partitionBy: NqlExpression[];
				orderBy: NqlOrderItem[];
			};
			return {
				type: 'window',
				function: name,
				args,
				partitionBy: windowSpec.partitionBy,
				orderBy: windowSpec.orderBy,
			};
		}

		return { type: 'function', name, args };
	}

	windowClause(ctx: CstContext): {
		partitionBy: NqlExpression[];
		orderBy: NqlOrderItem[];
	} {
		let partitionBy: NqlExpression[] = [];
		let orderBy: NqlOrderItem[] = [];

		if (ctx.partitionClause) {
			partitionBy = this.visit(
				asCstNode(ctx.partitionClause[0]),
			) as NqlExpression[];
		}

		if (ctx.orderClauseInWindow) {
			orderBy = this.visit(
				asCstNode(ctx.orderClauseInWindow[0]),
			) as NqlOrderItem[];
		}

		return { partitionBy, orderBy };
	}

	partitionClause(ctx: CstContext): NqlExpression[] {
		if (ctx.exprList) {
			return this.visit(asCstNode(ctx.exprList[0])) as NqlExpression[];
		}
		return [];
	}

	orderClauseInWindow(ctx: CstContext): NqlOrderItem[] {
		if (ctx.orderList) {
			return this.visit(asCstNode(ctx.orderList[0])) as NqlOrderItem[];
		}
		return [];
	}

	funcArgList(ctx: CstContext): NqlExpression[] {
		// funcArgList can be:
		// - Star (for count(*)) - handled in funcCall
		// - exprList (normal function arguments)
		if (ctx.exprList) {
			return this.visit(asCstNode(ctx.exprList[0])) as NqlExpression[];
		}
		return [];
	}

	exprList(ctx: CstContext): NqlExpression[] {
		const expressions: NqlExpression[] = [];
		if (ctx.expression) {
			for (const exprCtx of ctx.expression) {
				expressions.push(this.visit(asCstNode(exprCtx)));
			}
		}
		return expressions;
	}

	valueList(ctx: CstContext): NqlExpression[] {
		const values: NqlExpression[] = [];
		if (ctx.expression) {
			for (const exprCtx of ctx.expression) {
				values.push(this.visit(asCstNode(exprCtx)));
			}
		}
		return values;
	}

	// ============================================================
	// LITERALS
	// ============================================================

	literal(ctx: CstContext): NqlLiteral {
		if (ctx.StringLiteral) {
			const raw = getImage(ctx.StringLiteral[0]);
			return { type: 'string', value: raw.slice(1, -1).replace(/''/g, "'") };
		}
		if (ctx.NumberLiteral) {
			return {
				type: 'number',
				value: parseFloat(getImage(ctx.NumberLiteral[0])),
			};
		}
		if (ctx.True) {
			return { type: 'boolean', value: true };
		}
		if (ctx.False) {
			return { type: 'boolean', value: false };
		}
		if (ctx.Null) {
			return { type: 'null' };
		}
		if (ctx.rangeLiteral) {
			return this.visit(asCstNode(ctx.rangeLiteral[0])) as NqlRangeLiteral;
		}
		throw new Error('Invalid literal');
	}

	/**
	 * Range literal: [ or ( for lower, ] or ) for upper
	 * Grammar-based parsing for PostgreSQL range syntax.
	 * Examples: [1,10], (0,100), [1,10), (0,10]
	 */
	rangeLiteral(ctx: CstContext): NqlRangeLiteral {
		// Check opening bracket: [ = inclusive, ( = exclusive
		const lowerInclusive = ctx.LBracket !== undefined;
		// Check closing bracket: ] = inclusive, ) = exclusive
		const upperInclusive = ctx.RBracket !== undefined;

		// Get lower and upper values from labeled subrules
		if (!ctx.lower || !ctx.upper) {
			throw new Error('Range literal missing lower or upper bound');
		}
		const lower = this.visit(asCstNode(ctx.lower[0])) as string;
		const upper = this.visit(asCstNode(ctx.upper[0])) as string;

		// Reconstruct the raw value for compatibility
		const openBracket = lowerInclusive ? '[' : '(';
		const closeBracket = upperInclusive ? ']' : ')';
		const value = `${openBracket}${lower},${upper}${closeBracket}`;

		return {
			type: 'rangeLiteral',
			value,
			lowerInclusive,
			upperInclusive,
			lower,
			upper,
		};
	}

	/**
	 * Range value: RANGE_VALUE (date/time) or optional minus + NUMBER
	 */
	rangeValue(ctx: CstContext): string {
		if (ctx.RangeValue) {
			return getImage(ctx.RangeValue[0]);
		}
		// NumberLiteral with optional Minus
		const numToken = ctx.NumberLiteral;
		if (!numToken) {
			throw new Error('Range value must contain RangeValue or NumberLiteral');
		}
		const minus = ctx.Minus ? '-' : '';
		const num = getImage(numToken[0]);
		return `${minus}${num}`;
	}

	// ============================================================
	// IDENTIFIERS
	// ============================================================

	identSegment(ctx: CstContext): string {
		if (ctx.Identifier) {
			return getImage(ctx.Identifier[0]);
		}
		if (ctx.QuotedIdentifier) {
			const raw = getImage(ctx.QuotedIdentifier[0]);
			return raw.slice(1, -1).replace(/""/g, '"');
		}
		// Pseudo-column keywords can appear in paths (parent, child, ascendant, descendant)
		if (ctx.Parent) {
			return getImage(ctx.Parent[0]);
		}
		if (ctx.Child) {
			return getImage(ctx.Child[0]);
		}
		if (ctx.Ascendant) {
			return getImage(ctx.Ascendant[0]);
		}
		if (ctx.Descendant) {
			return getImage(ctx.Descendant[0]);
		}
		throw new Error('Invalid identifier');
	}

	identList(ctx: CstContext): string[] {
		const idents: string[] = [];
		if (ctx.identSegment) {
			for (const segCtx of ctx.identSegment) {
				idents.push(this.visit(asCstNode(segCtx)));
			}
		}
		return idents;
	}

	// ============================================================
	// MUTATIONS
	// ============================================================

	mutationPipeline(ctx: CstContext): NqlMutationPipeline {
		if (!ctx.mutation) throw new Error('Mutation pipeline missing mutation');
		const mutation = this.visit(asCstNode(ctx.mutation[0]));
		const clauses: NqlMutationClause[] = [];

		if (ctx.mutationClause) {
			for (const clauseCtx of ctx.mutationClause) {
				clauses.push(this.visit(asCstNode(clauseCtx)));
			}
		}

		return { type: 'mutationPipeline', mutation, clauses };
	}

	mutationClause(ctx: CstContext): NqlMutationClause {
		if (ctx.selectClause) return this.visit(asCstNode(ctx.selectClause[0]));
		if (ctx.bindClause) return this.visit(asCstNode(ctx.bindClause[0]));
		throw new Error('Unknown mutation clause');
	}

	bindClause(ctx: CstContext): NqlMutationClause {
		if (!ctx.identSegment) throw new Error('Bind clause missing name');
		return {
			type: 'bind',
			name: this.visit(asCstNode(ctx.identSegment[0])),
		};
	}

	mutation(ctx: CstContext): NqlMutation {
		if (ctx.insertStmt) return this.visit(asCstNode(ctx.insertStmt[0]));
		if (ctx.updateStmt) return this.visit(asCstNode(ctx.updateStmt[0]));
		if (ctx.deleteStmt) return this.visit(asCstNode(ctx.deleteStmt[0]));
		if (ctx.upsertStmt) return this.visit(asCstNode(ctx.upsertStmt[0]));
		throw new Error('Unknown mutation type');
	}

	insertStmt(ctx: CstContext): NqlMutation {
		if (!ctx.identSegment || !ctx.assignmentList) {
			throw new Error('Insert missing table or assignments');
		}
		return {
			type: 'insert',
			table: this.visit(asCstNode(ctx.identSegment[0])),
			assignments: this.visit(asCstNode(ctx.assignmentList[0])),
		};
	}

	updateStmt(ctx: CstContext): NqlMutation {
		if (!ctx.identSegment || !ctx.assignmentList) {
			throw new Error('Update missing table or assignments');
		}
		return {
			type: 'update',
			table: this.visit(asCstNode(ctx.identSegment[0])),
			assignments: this.visit(asCstNode(ctx.assignmentList[0])),
			where: ctx.booleanExpr
				? this.visit(asCstNode(ctx.booleanExpr[0]))
				: undefined,
		};
	}

	deleteStmt(ctx: CstContext): NqlMutation {
		if (!ctx.identSegment) throw new Error('Delete missing table');
		return {
			type: 'delete',
			table: this.visit(asCstNode(ctx.identSegment[0])),
			where: ctx.booleanExpr
				? this.visit(asCstNode(ctx.booleanExpr[0]))
				: undefined,
		};
	}

	upsertStmt(ctx: CstContext): NqlMutation {
		if (!ctx.identSegment || !ctx.assignmentList) {
			throw new Error('Upsert missing table or assignments');
		}

		// Conflict columns
		const conflictColumns: string[] = [];
		if (ctx.identList) {
			const cols = this.visit(asCstNode(ctx.identList[0])) as string[];
			conflictColumns.push(...cols);
		} else if (ctx.identSegment.length > 1) {
			// Single conflict column without parens
			conflictColumns.push(this.visit(asCstNode(ctx.identSegment[1])));
		}

		return {
			type: 'upsert',
			table: this.visit(asCstNode(ctx.identSegment[0])),
			conflictColumns,
			assignments: this.visit(asCstNode(ctx.assignmentList[0])),
			where: ctx.booleanExpr
				? this.visit(asCstNode(ctx.booleanExpr[0]))
				: undefined,
		};
	}

	assignmentList(ctx: CstContext): NqlAssignment[] {
		const assignments: NqlAssignment[] = [];
		if (ctx.assignment) {
			for (const assignCtx of ctx.assignment) {
				assignments.push(this.visit(asCstNode(assignCtx)));
			}
		}
		return assignments;
	}

	assignment(ctx: CstContext): NqlAssignment {
		if (!ctx.identSegment || !ctx.expression) {
			throw new Error('Assignment missing column or value');
		}
		return {
			column: this.visit(asCstNode(ctx.identSegment[0])),
			value: this.visit(asCstNode(ctx.expression[0])),
		};
	}
}

// Singleton visitor instance
export const nqlVisitor = new NqlCstVisitor();

/**
 * Transform CST to AST
 */
export function cstToAst(cst: CstNode): NqlProgram {
	return nqlVisitor.visit(cst);
}
