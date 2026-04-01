// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access */
/**
 * NQL CST-to-AST Visitor (thin dispatcher)
 *
 * Delegates all logic to domain modules in semantic/.
 * Each method is a one-liner that forwards to the corresponding visitX function.
 * Chevrotain's validateVisitor() requires all grammar rule methods on a single class.
 */

import type { CstNode } from 'chevrotain';
import type { NqlWarning } from '../errors/types.js';
import type { NqlProgram } from '../parser/ast.js';
import { nqlParser } from '../parser/grammar.js';
import type { CstContext, VisitFn } from './helpers.js';
// CTE / WITH clause
import { visitCteItem, visitCteList, visitWithQuery } from './visit-cte.js';
// Boolean, comparison, arithmetic, case, path, relation filters
import {
	visitAddExpr,
	visitAllRelationFilter,
	visitAndExpr,
	visitBetweenSuffix,
	visitBooleanExpr,
	visitCaseExpr,
	visitComparisonSuffix,
	visitCompOp,
	visitExistsCheck,
	visitExpression,
	visitExprList,
	visitInSuffix,
	visitIsNullSuffix,
	visitJsonAccessExpr,
	visitJsonComparisonSuffix,
	visitMulExpr,
	visitNotExpr,
	visitOrExpr,
	visitPathExpr,
	visitPrimaryCond,
	visitPrimaryExpr,
	visitQuantifiedRelationFilter,
	visitRangeOp,
	visitRangeOpSuffix,
	visitScalarSubquery,
	visitSearchedCaseBody,
	visitSimpleCaseBody,
	visitUnaryExpr,
} from './visit-expression.js';
// Function calls + window
import {
	visitFuncArgList,
	visitFuncCall,
	visitOrderClauseInWindow,
	visitPartitionClause,
	visitWindowClause,
} from './visit-function.js';
// Literals + identifiers
import {
	visitIdentList,
	visitIdentSegment,
	visitLiteral,
	visitRangeLiteral,
	visitRangeValue,
	visitValueList,
} from './visit-literal.js';
// Mutations
import {
	visitAssignment,
	visitAssignmentList,
	visitBindClause,
	visitDeleteStmt,
	visitInsertFromStmt,
	visitInsertStmt,
	visitMutation,
	visitMutationClause,
	visitMutationPipeline,
	visitUpdateStmt,
	visitUpsertFromStmt,
	visitUpsertStmt,
	visitValuesTuple,
} from './visit-mutation.js';
// Query structure
import {
	visitFlatClause,
	visitGroupClause,
	visitJoinSpec,
	visitLimitClause,
	visitLockClause,
	visitOffsetClause,
	visitOrderClause,
	visitOrderItem,
	visitOrderList,
	visitParam,
	visitParamList,
	visitProgram,
	visitQuery,
	visitQueryClause,
	visitRelationStarExpr,
	visitSelectClause,
	visitSelectItem,
	visitSelectList,
	visitSetClause,
	visitStatement,
	visitTableRef,
	visitWhereClause,
} from './visit-query.js';

const BaseCstVisitor = nqlParser.getBaseCstVisitorConstructor();

/**
 * CST Visitor that transforms Chevrotain CST to NQL AST.
 * All logic lives in domain modules; this class is a thin dispatcher.
 */
export class NqlCstVisitor extends BaseCstVisitor {
	private readonly v: VisitFn;
	readonly warnings: NqlWarning[] = [];

	constructor() {
		super();
		this.v = (node: CstNode) => this.visit(node);
		this.validateVisitor();
	}

	/** Clear warnings before each parse run (singleton reuse). */
	resetWarnings(): void {
		this.warnings.length = 0;
	}

	// -- Query structure --
	program(ctx: CstContext) {
		return visitProgram(ctx, this.v);
	}
	statement(ctx: CstContext) {
		return visitStatement(ctx, this.v);
	}
	query(ctx: CstContext) {
		return visitQuery(ctx, this.v);
	}
	tableRef(ctx: CstContext) {
		return visitTableRef(ctx, this.v);
	}
	queryClause(ctx: CstContext) {
		return visitQueryClause(ctx, this.v);
	}
	whereClause(ctx: CstContext) {
		return visitWhereClause(ctx, this.v);
	}
	selectClause(ctx: CstContext) {
		return visitSelectClause(ctx, this.v);
	}
	flatClause(_ctx: CstContext) {
		return visitFlatClause();
	}
	groupClause(ctx: CstContext) {
		return visitGroupClause(ctx, this.v);
	}
	orderClause(ctx: CstContext) {
		return visitOrderClause(ctx, this.v);
	}
	limitClause(ctx: CstContext) {
		return visitLimitClause(ctx, this.v);
	}
	offsetClause(ctx: CstContext) {
		return visitOffsetClause(ctx);
	}
	joinSpec(ctx: CstContext) {
		return visitJoinSpec(ctx, this.v);
	}
	paramList(ctx: CstContext) {
		return visitParamList(ctx, this.v);
	}
	param(ctx: CstContext) {
		return visitParam(ctx, this.v);
	}
	selectList(ctx: CstContext) {
		return visitSelectList(ctx, this.v);
	}
	selectItem(ctx: CstContext) {
		return visitSelectItem(ctx, this.v);
	}
	relationStarExpr(ctx: CstContext) {
		return visitRelationStarExpr(ctx, this.v);
	}
	orderList(ctx: CstContext) {
		return visitOrderList(ctx, this.v);
	}
	orderItem(ctx: CstContext) {
		return visitOrderItem(ctx, this.v);
	}
	lockClause(ctx: CstContext) {
		return visitLockClause(ctx);
	}

	// -- Boolean + comparison --
	booleanExpr(ctx: CstContext) {
		return visitBooleanExpr(ctx, this.v);
	}
	orExpr(ctx: CstContext) {
		return visitOrExpr(ctx, this.v);
	}
	andExpr(ctx: CstContext) {
		return visitAndExpr(ctx, this.v);
	}
	notExpr(ctx: CstContext) {
		return visitNotExpr(ctx, this.v);
	}
	primaryCond(ctx: CstContext) {
		return visitPrimaryCond(ctx, this.v);
	}
	comparisonSuffix(_ctx: CstContext) {
		return visitComparisonSuffix();
	}
	betweenSuffix(_ctx: CstContext) {
		return visitBetweenSuffix();
	}
	rangeOpSuffix(_ctx: CstContext) {
		return visitRangeOpSuffix();
	}
	jsonComparisonSuffix(_ctx: CstContext) {
		return visitJsonComparisonSuffix();
	}
	inSuffix(_ctx: CstContext) {
		return visitInSuffix();
	}

	// BATCH-001: stub — anySuffix is handled by visitPrimaryCond directly
	anySuffix(_ctx: CstContext) {
		return undefined;
	}
	isNullSuffix(_ctx: CstContext) {
		return visitIsNullSuffix();
	}
	compOp(ctx: CstContext) {
		return visitCompOp(ctx);
	}
	rangeOp(ctx: CstContext) {
		return visitRangeOp(ctx);
	}

	// -- Arithmetic + primary --
	expression(ctx: CstContext) {
		return visitExpression(ctx, this.v);
	}
	addExpr(ctx: CstContext) {
		return visitAddExpr(ctx, this.v);
	}
	mulExpr(ctx: CstContext) {
		return visitMulExpr(ctx, this.v);
	}
	unaryExpr(ctx: CstContext) {
		return visitUnaryExpr(ctx, this.v);
	}
	jsonAccessExpr(ctx: CstContext) {
		return visitJsonAccessExpr(ctx, this.v, this.warnings);
	}
	primaryExpr(ctx: CstContext) {
		return visitPrimaryExpr(ctx, this.v);
	}

	// -- CASE --
	caseExpr(ctx: CstContext) {
		return visitCaseExpr(ctx, this.v);
	}
	searchedCaseBody(_ctx: CstContext) {
		return visitSearchedCaseBody();
	}
	simpleCaseBody(_ctx: CstContext) {
		return visitSimpleCaseBody();
	}

	// -- Subquery + path + list --
	scalarSubquery(ctx: CstContext) {
		return visitScalarSubquery(ctx, this.v);
	}
	pathExpr(ctx: CstContext) {
		return visitPathExpr(ctx, this.v);
	}
	exprList(ctx: CstContext) {
		return visitExprList(ctx, this.v);
	}

	// -- Relation filters --
	existsCheck(ctx: CstContext) {
		return visitExistsCheck(ctx, this.v);
	}
	quantifiedRelationFilter(ctx: CstContext) {
		return visitQuantifiedRelationFilter(ctx, this.v);
	}
	allRelationFilter(ctx: CstContext) {
		return visitAllRelationFilter(ctx, this.v);
	}

	// -- Functions + window --
	funcCall(ctx: CstContext) {
		return visitFuncCall(ctx, this.v);
	}
	windowClause(ctx: CstContext) {
		return visitWindowClause(ctx, this.v);
	}
	partitionClause(ctx: CstContext) {
		return visitPartitionClause(ctx, this.v);
	}
	orderClauseInWindow(ctx: CstContext) {
		return visitOrderClauseInWindow(ctx, this.v);
	}
	funcArgList(ctx: CstContext) {
		return visitFuncArgList(ctx, this.v);
	}

	// -- Literals + identifiers --
	literal(ctx: CstContext) {
		return visitLiteral(ctx, this.v);
	}
	rangeLiteral(ctx: CstContext) {
		return visitRangeLiteral(ctx, this.v);
	}
	rangeValue(ctx: CstContext) {
		return visitRangeValue(ctx);
	}
	identSegment(ctx: CstContext) {
		return visitIdentSegment(ctx);
	}
	identList(ctx: CstContext) {
		return visitIdentList(ctx, this.v);
	}
	valueList(ctx: CstContext) {
		return visitValueList(ctx, this.v);
	}

	// -- Mutations --
	mutationPipeline(ctx: CstContext) {
		return visitMutationPipeline(ctx, this.v);
	}
	mutationClause(ctx: CstContext) {
		return visitMutationClause(ctx, this.v);
	}
	bindClause(ctx: CstContext) {
		return visitBindClause(ctx, this.v);
	}
	setClause(ctx: CstContext) {
		return visitSetClause(ctx, this.v);
	}
	mutation(ctx: CstContext) {
		return visitMutation(ctx, this.v);
	}
	insertStmt(ctx: CstContext) {
		return visitInsertStmt(ctx, this.v);
	}
	insertFromStmt(ctx: CstContext) {
		return visitInsertFromStmt(ctx, this.v);
	}
	updateStmt(ctx: CstContext) {
		return visitUpdateStmt(ctx, this.v);
	}
	deleteStmt(ctx: CstContext) {
		return visitDeleteStmt(ctx, this.v);
	}
	upsertStmt(ctx: CstContext) {
		return visitUpsertStmt(ctx, this.v);
	}
	upsertFromStmt(ctx: CstContext) {
		return visitUpsertFromStmt(ctx, this.v);
	}
	assignmentList(ctx: CstContext) {
		return visitAssignmentList(ctx, this.v);
	}
	valuesTuple(ctx: CstContext) {
		return visitValuesTuple(ctx, this.v);
	}
	assignment(ctx: CstContext) {
		return visitAssignment(ctx, this.v);
	}

	// -- CTE / WITH --
	withQuery(ctx: CstContext) {
		return visitWithQuery(ctx, this.v);
	}
	cteList(ctx: CstContext) {
		return visitCteList(ctx, this.v);
	}
	cteItem(ctx: CstContext) {
		return visitCteItem(ctx, this.v);
	}
}

// Singleton visitor instance
export const nqlVisitor = new NqlCstVisitor();

/**
 * Transform CST to AST, collecting any warnings emitted during traversal.
 */
export function cstToAst(cst: CstNode): {
	ast: NqlProgram;
	warnings: NqlWarning[];
} {
	nqlVisitor.resetWarnings();
	const ast: NqlProgram = nqlVisitor.visit(cst);
	return { ast, warnings: [...nqlVisitor.warnings] };
}
