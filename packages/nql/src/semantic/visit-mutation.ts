// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access requires non-null assertions on ctx.rule[0] patterns */
/**
 * @module semantic/visit-mutation
 * Mutation visitors: insert, update, delete, upsert, assignments.
 */

import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import type {
	NqlAssignment,
	NqlMutation,
	NqlMutationClause,
	NqlMutationPipeline,
} from '../parser/ast.js';
import type { CstContext, VisitFn } from './helpers.js';
import {
	asCstNode,
	getImage,
	requireFields,
	requireFirst,
	unreachable,
} from './helpers.js';

export function visitMutationPipeline(
	ctx: CstContext,
	visit: VisitFn,
): NqlMutationPipeline {
	requireFirst(ctx, 'mutation', 'Mutation pipeline missing mutation');
	const mutation = visit(asCstNode(ctx.mutation[0]!));
	const clauses: NqlMutationClause[] = [];
	if (ctx.mutationClause) {
		for (const clauseCtx of ctx.mutationClause) {
			clauses.push(visit(asCstNode(clauseCtx)));
		}
	}
	return { type: 'mutationPipeline', mutation, clauses };
}

export function visitMutationClause(
	ctx: CstContext,
	visit: VisitFn,
): NqlMutationClause {
	if (ctx.selectClause) return visit(asCstNode(ctx.selectClause[0]!));
	if (ctx.bindClause) return visit(asCstNode(ctx.bindClause[0]!));
	/* v8 ignore next — defensive: parser guarantees selectClause or bindClause -- @preserve */
	unreachable('Unknown mutation clause');
}

export function visitBindClause(
	ctx: CstContext,
	visit: VisitFn,
): NqlMutationClause {
	requireFirst(ctx, 'identSegment', 'Bind clause missing name');
	return {
		type: 'bind',
		name: visit(asCstNode(ctx.identSegment[0]!)),
	};
}

export function visitMutation(ctx: CstContext, visit: VisitFn): NqlMutation {
	if (ctx.insertFromStmt) return visit(asCstNode(ctx.insertFromStmt[0]!));
	if (ctx.insertStmt) return visit(asCstNode(ctx.insertStmt[0]!));
	if (ctx.updateStmt) return visit(asCstNode(ctx.updateStmt[0]!));
	if (ctx.deleteStmt) return visit(asCstNode(ctx.deleteStmt[0]!));
	if (ctx.upsertFromStmt) return visit(asCstNode(ctx.upsertFromStmt[0]!));
	if (ctx.upsertStmt) return visit(asCstNode(ctx.upsertStmt[0]!));
	/* v8 ignore next — defensive: parser guarantees one of the mutation alternatives -- @preserve */
	unreachable('Unknown mutation type');
}

export function visitInsertStmt(ctx: CstContext, visit: VisitFn): NqlMutation {
	requireFields(ctx, ['identSegment'], 'Insert missing table');
	const table: string = visit(asCstNode(ctx.identSegment[0]!));
	const rows: NqlAssignment[][] = [];

	if (ctx.assignmentList) {
		for (const assignListCtx of ctx.assignmentList) {
			const assignments: NqlAssignment[] = visit(asCstNode(assignListCtx));
			rows.push(assignments);
		}
	}
	if (ctx.valuesTuple) {
		for (const tupleCtx of ctx.valuesTuple) {
			const assignments: NqlAssignment[] = visit(asCstNode(tupleCtx));
			rows.push(assignments);
		}
	}

	/* v8 ignore start — defensive: parser guarantees at least one assignmentList or valuesTuple -- @preserve */
	if (rows.length === 0) {
		throw new Error('Insert statement must have at least one row');
	}
	/* v8 ignore stop -- @preserve */

	return { type: 'insert', table, rows };
}

export function visitInsertFromStmt(
	ctx: CstContext,
	visit: VisitFn,
): NqlMutation {
	/* v8 ignore start — defensive: parser guarantees target and source identifiers -- @preserve */
	if (!ctx.identSegment || ctx.identSegment.length < 2) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Insert FROM missing target or source table',
		);
	}
	/* v8 ignore stop -- @preserve */
	const target = visit(asCstNode(ctx.identSegment[0]!)) as string;
	const source = visit(asCstNode(ctx.identSegment[1]!)) as string;

	return {
		type: 'insert_from',
		table: target,
		source,
		where: ctx.booleanExpr ? visit(asCstNode(ctx.booleanExpr[0]!)) : undefined,
		limit: ctx.NumberLiteral
			? parseInt(getImage(ctx.NumberLiteral[0]!), 10)
			: undefined,
	};
}

export function visitUpdateStmt(ctx: CstContext, visit: VisitFn): NqlMutation {
	requireFields(
		ctx,
		['identSegment', 'assignmentList'],
		'Update missing table or assignments',
	);
	return {
		type: 'update',
		table: visit(asCstNode(ctx.identSegment[0]!)),
		assignments: visit(asCstNode(ctx.assignmentList[0]!)),
		where: ctx.booleanExpr ? visit(asCstNode(ctx.booleanExpr[0]!)) : undefined,
	};
}

export function visitDeleteStmt(ctx: CstContext, visit: VisitFn): NqlMutation {
	requireFirst(ctx, 'identSegment', 'Delete missing table');
	return {
		type: 'delete',
		table: visit(asCstNode(ctx.identSegment[0]!)),
		where: ctx.booleanExpr ? visit(asCstNode(ctx.booleanExpr[0]!)) : undefined,
	};
}

export function visitUpsertStmt(ctx: CstContext, visit: VisitFn): NqlMutation {
	requireFields(
		ctx,
		['identSegment', 'assignmentList'],
		'Upsert missing table or assignments',
	);

	const conflictColumns: string[] = [];
	if (ctx.identList) {
		const cols = visit(asCstNode(ctx.identList[0]!)) as string[];
		conflictColumns.push(...cols);
	} else if (ctx.identSegment.length > 1) {
		conflictColumns.push(visit(asCstNode(ctx.identSegment[1]!)));
	}

	return {
		type: 'upsert',
		table: visit(asCstNode(ctx.identSegment[0]!)),
		conflictColumns,
		assignments: visit(asCstNode(ctx.assignmentList[0]!)),
		where: ctx.booleanExpr ? visit(asCstNode(ctx.booleanExpr[0]!)) : undefined,
	};
}

export function visitUpsertFromStmt(
	ctx: CstContext,
	visit: VisitFn,
): NqlMutation {
	/* v8 ignore start — defensive: parser guarantees target and source identifiers -- @preserve */
	if (!ctx.identSegment || ctx.identSegment.length < 2) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Upsert FROM missing target or source table',
		);
	}
	/* v8 ignore stop -- @preserve */

	const conflictColumns: string[] = [];
	let sourceIndex: number;

	if (ctx.identList) {
		const cols = visit(asCstNode(ctx.identList[0]!)) as string[];
		conflictColumns.push(...cols);
		sourceIndex = 1;
	} else if (ctx.identSegment.length >= 3) {
		conflictColumns.push(visit(asCstNode(ctx.identSegment[1]!)));
		sourceIndex = 2;
	} /* v8 ignore start — defensive: parser guarantees identList or >= 3 identSegments -- @preserve */ else {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Upsert FROM missing conflict columns or source table',
		);
	}
	/* v8 ignore stop -- @preserve */

	const target = visit(asCstNode(ctx.identSegment[0]!)) as string;
	const source = visit(asCstNode(ctx.identSegment[sourceIndex]!)) as string;

	return {
		type: 'upsert_from',
		table: target,
		conflictColumns,
		source,
		where: ctx.booleanExpr ? visit(asCstNode(ctx.booleanExpr[0]!)) : undefined,
		limit: ctx.NumberLiteral
			? parseInt(getImage(ctx.NumberLiteral[0]!), 10)
			: undefined,
	};
}

export function visitAssignmentList(
	ctx: CstContext,
	visit: VisitFn,
): NqlAssignment[] {
	const assignments: NqlAssignment[] = [];
	if (ctx.assignment) {
		for (const assignCtx of ctx.assignment) {
			assignments.push(visit(asCstNode(assignCtx)));
		}
	}
	return assignments;
}

export function visitValuesTuple(
	ctx: CstContext,
	visit: VisitFn,
): NqlAssignment[] {
	requireFields(ctx, ['assignmentList'], 'Values tuple missing assignments');
	return visit(asCstNode(ctx.assignmentList[0]!));
}

export function visitAssignment(
	ctx: CstContext,
	visit: VisitFn,
): NqlAssignment {
	requireFields(
		ctx,
		['identSegment', 'expression'],
		'Assignment missing column or value',
	);
	return {
		column: visit(asCstNode(ctx.identSegment[0]!)),
		value: visit(asCstNode(ctx.expression[0]!)),
	};
}
