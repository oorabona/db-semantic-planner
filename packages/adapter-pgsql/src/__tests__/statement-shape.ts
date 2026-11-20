/**
 * The parse-back projection of ADR 0012: the parts of a statement tree that
 * composition decides. A built tree omits defaults a parse fills in (`op`,
 * `limitOption`, `ctematerialized`), so trees are compared through this
 * projection, not whole.
 */

import type { CompiledQuery } from '@dbsp/types';
import type {
	CommonTableExpr,
	Node,
	SelectStmt,
	WithClause,
} from '@pgsql/types';
import { parseSync } from 'pgsql-parser';
import { compiledStatementAst } from '../projection-envelope.js';

export type WithShape = {
	readonly recursive: boolean;
	readonly ctes: readonly {
		readonly name: string;
		readonly columns: readonly string[];
	}[];
};

export type StatementShape =
	| {
			readonly op: string;
			readonly all: boolean;
			readonly larg: StatementShape;
			readonly rarg: StatementShape;
			readonly with?: WithShape;
	  }
	| {
			readonly sort: boolean;
			readonly limit: boolean;
			readonly offset: boolean;
			readonly lock: boolean;
			readonly with?: WithShape;
	  }
	| { readonly statement: string; readonly with?: WithShape };

function withShape(clause: WithClause | undefined): WithShape | undefined {
	if (clause === undefined) return undefined;
	return {
		recursive: clause.recursive === true,
		ctes: (clause.ctes ?? []).map((node) => {
			const cte = (node as { CommonTableExpr: CommonTableExpr })
				.CommonTableExpr;
			return {
				name: cte.ctename ?? '',
				columns: (cte.aliascolnames ?? []).map(
					(column) => (column as { String: { sval: string } }).String.sval,
				),
			};
		}),
	};
}

function selectShape(stmt: SelectStmt): StatementShape {
	const clauseWith = withShape(stmt.withClause);
	const op = stmt.op;
	if (op !== undefined && op !== 'SETOP_NONE') {
		return {
			op,
			all: stmt.all === true,
			larg: selectShape(stmt.larg as SelectStmt),
			rarg: selectShape(stmt.rarg as SelectStmt),
			...(clauseWith !== undefined && { with: clauseWith }),
		};
	}
	return {
		sort: (stmt.sortClause?.length ?? 0) > 0,
		limit: Boolean(stmt.limitCount),
		offset: Boolean(stmt.limitOffset),
		lock: (stmt.lockingClause?.length ?? 0) > 0,
		...(clauseWith !== undefined && { with: clauseWith }),
	};
}

export function statementShape(statement: Node): StatementShape {
	const [kind] = Object.keys(statement);
	const body = (statement as Record<string, SelectStmt>)[kind as string];
	if (kind === 'SelectStmt') return selectShape(body as SelectStmt);
	const clauseWith = withShape(
		(body as { withClause?: WithClause }).withClause,
	);
	return {
		statement: kind as string,
		...(clauseWith !== undefined && { with: clauseWith }),
	};
}

/** The projection of the single statement `sql` parses to. */
export function parsedShape(sql: string): StatementShape {
	const parsed = parseSync(sql) as { stmts: { stmt: Node }[] };
	if (parsed.stmts.length !== 1) {
		throw new Error(`expected one statement, parsed ${parsed.stmts.length}`);
	}
	return statementShape(parsed.stmts[0]!.stmt);
}

/** The projection of the tree a compiled query was deparsed from. */
export function builtShape(query: CompiledQuery): StatementShape {
	const ast = compiledStatementAst(query);
	if (ast === undefined) throw new Error('the compiled query kept no tree');
	return statementShape(ast);
}
