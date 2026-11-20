/**
 * Set operation compiler (UNION / INTERSECT / EXCEPT)
 *
 * Compiles a SetOperationIntent tree into one `SelectStmt` tree whose operands
 * are the leaves' trees, then deparses it once. Each operand numbers its
 * parameters from $1; the right operand's `ParamRef` nodes are shifted in the
 * tree by the left operand's parameter count (ADR 0012).
 */

import type {
	CompiledQuery,
	QueryIntent,
	SetOperationIntent,
} from '@dbsp/types';
import { deparseQuoted } from './deparse.js';
import {
	dropPositionalUnion,
	type ProjectionEnvelope,
} from './projection-envelope.js';
import { assertRelationalOutput } from './relational-output.js';
import {
	requireStatementAst,
	setOperationStatement,
	shiftParameters,
} from './statement-ast.js';

/**
 * Compiled set-operation SQL with positional parameters.
 */
export type SetOperationResult<T = unknown> = CompiledQuery<T>;

/** Compiles one leaf of a set operation to an envelope carrying its tree. */
export type SetOperationLeafCompiler = (
	query: QueryIntent,
) => ProjectionEnvelope;

/**
 * Compile a SetOperationIntent to one tree with merged parameters.
 *
 * The left operand is compiled and checked before the right one is compiled.
 * The final set operation drops positional projection provenance through the
 * envelope so `finalizeEnvelope` owns the set-operation `js` fail-loud
 * behavior.
 */
export function compileSetOperationEnvelope(
	intent: SetOperationIntent,
	compileLeaf: SetOperationLeafCompiler,
): ProjectionEnvelope {
	const left = compileLeafOrBranch(intent.left, compileLeaf);

	assertRelationalOutput(left.hydrationPlan, 'Set operations');

	const right = compileLeafOrBranch(intent.right, compileLeaf);

	assertRelationalOutput(right.hydrationPlan, 'Set operations');

	const opName = intent.op.toUpperCase();
	const ast = setOperationStatement(
		intent.op,
		intent.all,
		requireStatementAst(left, `the left operand of ${opName}`),
		shiftParameters(
			requireStatementAst(right, `the right operand of ${opName}`),
			left.parameters.length,
		),
	);
	const parameters = [...left.parameters, ...right.parameters];

	return dropPositionalUnion([left, right], {
		sql: deparseQuoted(ast),
		parameters,
		ast,
		reason: 'set-operation-positional-merge',
	});
}

/**
 * Compile either a leaf QueryIntent or a nested SetOperationIntent branch.
 */
function compileLeafOrBranch(
	intent: QueryIntent | SetOperationIntent,
	compileLeaf: SetOperationLeafCompiler,
): ProjectionEnvelope {
	if ('kind' in intent && intent.kind === 'setOperation') {
		return compileSetOperationEnvelope(
			intent as SetOperationIntent,
			compileLeaf,
		);
	}
	return compileLeaf(intent as QueryIntent);
}
