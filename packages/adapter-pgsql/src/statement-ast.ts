/**
 * Composition of statement trees (ADR 0012).
 *
 * A composed statement (set operation, WITH, a mutation with a source, an NQL
 * program's bindings) is built as one PostgreSQL tree and deparsed once. A
 * subtree compiled on its own numbers its parameters from $1; its `ParamRef`
 * nodes are shifted in the tree before it is nested, never in emitted text.
 *
 * @internal
 */

import type {
	CommonTableExpr,
	Node,
	SelectStmt,
	SetOperation,
	WithClause,
} from '@pgsql/types';
import { renumberParamRefsInAst } from './param-renumber.js';

const statementKinds = [
	'SelectStmt',
	'InsertStmt',
	'UpdateStmt',
	'DeleteStmt',
] as const;
type StatementKind = (typeof statementKinds)[number];

function statementKindOf(node: Node): StatementKind | undefined {
	const [key] = Object.keys(node as object);
	return statementKinds.find((kind) => kind === key);
}

/** Refuses, by name, a composition whose operand carries no statement tree. */
export function requireStatementAst(
	envelope: { readonly ast?: Node },
	context: string,
): Node {
	const ast = envelope.ast;
	if (ast === undefined || statementKindOf(ast) === undefined) {
		throw new Error(
			`Cannot compose ${context}: its compiled operand carries no statement tree, and composed SQL is built from trees only (ADR 0012).`,
		);
	}
	return ast;
}

/** Shift every parameter of a subtree compiled from $1 by `offset`. */
export function shiftParameters(ast: Node, offset: number): Node {
	return renumberParamRefsInAst(ast, offset);
}

function selectStmtOf(ast: Node, context: string): SelectStmt {
	const select = (ast as { SelectStmt?: SelectStmt }).SelectStmt;
	if (select === undefined) {
		throw new Error(
			`Cannot compose ${context}: the operand is not a SELECT statement.`,
		);
	}
	return select;
}

const setOperationNodes: Readonly<
	Record<'union' | 'intersect' | 'except', SetOperation>
> = {
	union: 'SETOP_UNION',
	intersect: 'SETOP_INTERSECT',
	except: 'SETOP_EXCEPT',
};

/** `left <op> [ALL] right` as one `SelectStmt`; operands are SELECT trees. */
export function setOperationStatement(
	op: 'union' | 'intersect' | 'except',
	all: boolean,
	left: Node,
	right: Node,
): Node {
	return {
		SelectStmt: {
			op: setOperationNodes[op],
			all,
			larg: selectStmtOf(left, `the left operand of ${op.toUpperCase()}`),
			rarg: selectStmtOf(right, `the right operand of ${op.toUpperCase()}`),
		},
	};
}

/** `name [(columns)] AS (query)`. */
export function commonTableExpression(
	name: string,
	query: Node,
	options: {
		readonly columns?: readonly string[];
		readonly recursive?: boolean;
	} = {},
): Node {
	const cte: CommonTableExpr = {
		ctename: name,
		ctequery: query,
		...(options.columns !== undefined &&
			options.columns.length > 0 && {
				aliascolnames: options.columns.map((column) => ({
					String: { sval: column },
				})),
			}),
		...(options.recursive === true && { cterecursive: true }),
	};
	return { CommonTableExpr: cte };
}

/**
 * Prefix `ctes` to a statement's own `WITH`, which keeps its CTEs after them.
 * Works on SELECT (set operations included), INSERT, UPDATE and DELETE.
 */
export function withLeadingCtes(
	statement: Node,
	ctes: readonly Node[],
	recursive = false,
): Node {
	if (ctes.length === 0 && !recursive) return statement;
	const kind = statementKindOf(statement);
	if (kind === undefined) {
		throw new Error(
			'Cannot attach a WITH clause: the statement is not a SELECT, INSERT, UPDATE or DELETE tree.',
		);
	}
	const body = (
		statement as Record<StatementKind, { withClause?: WithClause }>
	)[kind];
	const existing = body.withClause;
	const withClause: WithClause = {
		ctes: [...ctes, ...(existing?.ctes ?? [])],
		recursive: recursive || existing?.recursive === true,
	};
	return { [kind]: { ...body, withClause } } as Node;
}
