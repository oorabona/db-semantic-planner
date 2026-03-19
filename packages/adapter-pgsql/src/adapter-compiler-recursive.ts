/**
 * Recursive CTE and unnest-CTE compilation.
 * Extracted from PgsqlAdapter.compileRecursive(), compileCteQuery(),
 * buildUnnestCte(), and buildRecursiveAnchorWhere().
 *
 * @internal
 */

import type {
	CompiledQuery,
	CompileOptions,
	CteQueryIntent,
	ModelIR,
	PlanReport,
	RecursivePlanReport,
	UnnestCteIntent,
} from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import { binaryExpr, columnRef, funcCall, integerNode, stringNode } from './ast-helpers.js';
import { deparseQuoted } from './deparse.js';
import { createCompilerState } from './handlers/index.js';
import {
	inferPgArrayType,
} from './compiler-utils.js';
import {
	buildRecursiveCte,
	type RecursiveCteConfig,
} from './recursive/index.js';
import { createTypeCastParamRef } from './param-ref.js';
import { mapComparisonOperator, valueToNode } from './plan-decision-extractor.js';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { compileSelect } from './adapter-compiler-select.js';
import type { CompilerContext } from './handlers/index.js';

// ============================================================================
// compileRecursive
// ============================================================================

/**
 * Compile a recursive CTE plan to executable SQL.
 * Supports adjacency-list and edge-table traversal modes.
 * Extracted body of PgsqlAdapter.compileRecursive().
 */
export function compileRecursive(
	report: RecursivePlanReport,
	_model: ModelIR,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	const schemaName = deps.schemaName ?? options?.schemaName;
	const intent = report.intent;
	const traversal = intent.traversal;

	const trackPath = intent.track?.path !== undefined;
	const trackDepth = intent.track?.depth !== undefined;

	let config: RecursiveCteConfig;

	if (traversal.kind === 'edge-table') {
		const table = traversal.nodeTable;
		const pkColumn = traversal.nodeId;
		const ctx: CompilerContext = {
			naming: deps.naming,
			rootTable: table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: intent.maxDepth,
		};

		// Get columns to select
		const startSelect = intent.start.select ?? [];
		const nodeIdColumn =
			intent.start.nodeIdExpr.kind === 'column'
				? intent.start.nodeIdExpr.name
				: pkColumn;
		const selectColumns = Array.from(new Set([nodeIdColumn, ...startSelect]));

		// Edge-table traversal: join through a junction table
		const edgeFrom =
			traversal.direction === 'in' ? traversal.edgeTo : traversal.edgeFrom;
		const edgeTo =
			traversal.direction === 'in' ? traversal.edgeFrom : traversal.edgeTo;

		// Build anchor WHERE from intent.start.where
		const anchorWhere = intent.start.where
			? buildRecursiveAnchorWhere(intent.start.where, '__n', deps)
			: undefined;

		const base: RecursiveCteConfig = {
			cteAlias: intent.cteName,
			table,
			pkColumn,
			fkColumn: '', // unused in edge-table mode
			outerAlias: 't0',
			isAncestors: false,
			maxDepth: intent.maxDepth,
			selectColumns,
			trackPath,
			usePg14Cycle: false,
			edgeTable: traversal.edgeTable,
			edgeFrom,
			edgeTo,
			ctx,
		};

		// Add optional properties only when defined
		if (traversal.direction === 'both') {
			base.bidirectionalStrategy =
				traversal.edgeStorageHint === 'directed-only' ? 'union-all' : 'union';
		}
		if (anchorWhere) {
			base.anchorWhere = anchorWhere;
		}

		config = base;
	} else if (traversal.kind === 'adjacency') {
		const table = traversal.nodeTable;
		const pkColumn = traversal.nodeId;
		const ctx: CompilerContext = {
			naming: deps.naming,
			rootTable: table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: intent.maxDepth,
		};

		const startSelect = intent.start.select ?? [];
		const nodeIdColumn =
			intent.start.nodeIdExpr.kind === 'column'
				? intent.start.nodeIdExpr.name
				: pkColumn;
		const selectColumns = Array.from(new Set([nodeIdColumn, ...startSelect]));

		// Adjacency-list traversal: self-referencing FK
		config = {
			cteAlias: intent.cteName,
			table,
			pkColumn,
			fkColumn: traversal.parentId,
			outerAlias: 't0',
			isAncestors: traversal.direction === 'ancestors',
			maxDepth: intent.maxDepth,
			selectColumns,
			trackPath,
			usePg14Cycle: false,
			ctx,
		};
	} else {
		// Exhaustive check: only 'custom' remains, which is reserved for P2
		const _exhaustive: 'custom' = traversal.kind;
		throw new Error(
			`PgsqlAdapter.compileRecursive: Unsupported traversal kind '${_exhaustive}'`,
		);
	}

	// Build the recursive CTE
	const { cte, extraCtes } = buildRecursiveCte(config);

	// Build final target list (include __depth and __path when tracked)
	const finalTargets: Node[] = config.selectColumns.map((col: string) => ({
		ResTarget: {
			val: {
				ColumnRef: {
					fields: [
						{ String: { sval: config.cteAlias } },
						{ String: { sval: deps.naming.toDatabase(col) } },
					],
				},
			},
			name: deps.naming.toDatabase(col),
		},
	}));

	if (trackDepth) {
		const depthAlias = intent.track?.depth?.as ?? '__depth';
		finalTargets.push({
			ResTarget: {
				val: {
					ColumnRef: {
						fields: [
							{ String: { sval: config.cteAlias } },
							{ String: { sval: '__depth' } },
						],
					},
				},
				name: depthAlias,
			},
		});
	}

	if (trackPath) {
		const pathAlias = intent.track?.path?.as ?? '__path';
		finalTargets.push({
			ResTarget: {
				val: {
					ColumnRef: {
						fields: [
							{ String: { sval: config.cteAlias } },
							{ String: { sval: '__path' } },
						],
					},
				},
				name: pathAlias,
			},
		});
	}

	// Assemble all CTEs (extra CTEs like __edges_bidir go first)
	const ctes: Node[] = [];
	if (extraCtes) {
		ctes.push(...extraCtes);
	}
	ctes.push(cte);

	// Build the final SELECT that uses the CTE
	const selectStmt: SelectStmt = {
		targetList: finalTargets,
		fromClause: [
			{
				RangeVar: {
					relname: config.cteAlias,
					inh: true,
					relpersistence: 'p',
				},
			},
		],
		withClause: {
			ctes,
			recursive: true,
		},
	};

	// Deparse AST to SQL
	const sql = deparseQuoted({ SelectStmt: selectStmt });

	return {
		sql,
		parameters: [],
	};
}

// ============================================================================
// compileCteQuery
// ============================================================================

/**
 * Compile a CTE query backed by unnest() arrays (BATCH-001 Block 5).
 *
 * Strategy: compile CTE nodes to SQL fragments, compile outer query
 * independently (parameters starting at $1), then renumber outer params
 * to start after CTE params and prepend WITH clause.
 *
 * Extracted body of PgsqlAdapter.compileCteQuery().
 */
export function compileCteQuery(
	intent: CteQueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	const schemaName = deps.schemaName ?? options?.schemaName;
	const state = createCompilerState();

	// 1. Build CTE nodes and accumulate CTE parameters
	const cteNodes: Node[] = intent.ctes.map((cte) => {
		if (cte.kind !== 'unnestCte') {
			const kind = (cte as { kind: string }).kind;
			throw new Error(
				`PgsqlAdapter.compileCteQuery: Unsupported CTE kind '${kind}'`,
			);
		}
		return buildUnnestCte(cte, state, deps);
	});

	// 2. Compile outer query independently ($1, $2, ... relative to outer)
	const outerCompileOptions: CompileOptions =
		schemaName !== undefined ? { schemaName } : {};
	const outerPlanReport: PlanReport = {
		rootTable: intent.query.from,
		decisions: [],
		warnings: [],
		ctes: [],
		intent: intent.query,
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	};
	const outerCompiled = compileSelect(outerPlanReport, outerCompileOptions, deps);

	// 3. Renumber outer SQL parameters to follow CTE parameters
	const cteParamCount = state.parameters.length;
	const renumberedOuterSql =
		cteParamCount > 0
			? outerCompiled.sql.replace(
					/\$([0-9]+)/g,
					(_: string, n: string) => '$' + (parseInt(n) + cteParamCount),
				)
			: outerCompiled.sql;

	// 4. Deparse CTE nodes to SQL fragments
	const cteSqlParts = cteNodes.map((n) => deparseQuoted(n));
	const withClause = cteSqlParts.join(', ');

	const sql =
		withClause.length > 0
			? `WITH ${withClause} ${renumberedOuterSql}`
			: renumberedOuterSql;

	return {
		sql,
		parameters: [...state.parameters, ...outerCompiled.parameters],
	};
}

// ============================================================================
// buildUnnestCte (internal)
// ============================================================================

/**
 * Build a CommonTableExpr AST node for an unnest-backed CTE.
 * Produces: CommonTableExpr { ctename: 'name', ctequery: SelectStmt {...} }
 * Extracted body of PgsqlAdapter.buildUnnestCte().
 */
function buildUnnestCte(
	cte: UnnestCteIntent,
	state: ReturnType<typeof createCompilerState>,
	deps: AdapterCompilerDeps,
): Node {
	const columns = Object.keys(cte.columns);
	const hasIndex = cte.indexColumn !== undefined;
	const indexCol = cte.indexColumn ?? 'ordinality';

	// Build unnest arguments: CAST($N AS type[]) for each column
	const unnestArgs: Node[] = columns.map((col) => {
		const colArray = cte.columns[col] as unknown[];
		const sampleValue = colArray.find((v) => v !== null && v !== undefined);
		const pgArrayType = inferPgArrayType(col, undefined, sampleValue);
		const pgBaseType = pgArrayType.endsWith('[]')
			? pgArrayType.slice(0, -2)
			: pgArrayType;

		state.parameters.push(colArray);
		state.paramIndex++;
		return createTypeCastParamRef(state.paramIndex, pgBaseType, true);
	});

	// All column alias names: col1, col2, ...[, ordinality]
	const allAliasNames = [
		...columns.map((c) => deps.naming.toDatabase(c)),
		...(hasIndex ? ['ordinality'] : []),
	];

	// FROM unnest(args...) [WITH ORDINALITY] AS t("col1", "col2"[, ordinality])
	const rangeFunc: Node = {
		RangeFunction: {
			ordinality: hasIndex,
			functions: [{ List: { items: [funcCall('unnest', unnestArgs)] } }],
			alias: {
				aliasname: 't',
				colnames: allAliasNames.map((n) => stringNode(n)),
			},
		},
	};

	// SELECT targets: t."col1", t."col2"[, (t.ordinality - 1) AS "idx"]
	const targets: Node[] = columns.map((col) => ({
		ResTarget: {
			val: columnRef(col, 't', undefined, deps.naming),
			name: deps.naming.toDatabase(col),
		},
	}));
	if (hasIndex) {
		targets.push({
			ResTarget: {
				val: binaryExpr(
					'-',
					columnRef('ordinality', 't'),
					integerNode(1),
				),
				name: indexCol,
			},
		});
	}

	const cteSelectStmt: SelectStmt = {
		targetList: targets,
		fromClause: [rangeFunc],
	};

	return {
		CommonTableExpr: {
			ctename: cte.name,
			ctequery: { SelectStmt: cteSelectStmt },
		},
	};
}

// ============================================================================
// buildRecursiveAnchorWhere (internal)
// ============================================================================

/**
 * Build an anchor WHERE clause AST node from a WhereIntent.
 * Used for edge-table recursive CTE anchor queries.
 * Extracted body of PgsqlAdapter.buildRecursiveAnchorWhere().
 */
function buildRecursiveAnchorWhere(
	where: unknown,
	tableAlias: string,
	deps: AdapterCompilerDeps,
): Node {
	if (!where || typeof where !== 'object') {
		return { A_Const: { boolval: { boolval: true } } };
	}
	const w = where as Record<string, unknown>;

	switch (w.kind) {
		case 'comparison': {
			const dbCol = deps.naming.toDatabase(w.field as string);
			const left: Node = {
				ColumnRef: {
					fields: [
						{ String: { sval: tableAlias } },
						{ String: { sval: dbCol } },
					],
				},
			};
			const op = mapComparisonOperator(w.operator as string);
			const right: Node = valueToNode(w.value);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: op } }],
					lexpr: left,
					rexpr: right,
				},
			};
		}
		case 'and': {
			const conditions = (w.conditions as unknown[]).map((c) =>
				buildRecursiveAnchorWhere(c, tableAlias, deps),
			);
			if (conditions.length === 1) return conditions[0]!;
			return { BoolExpr: { boolop: 'AND_EXPR', args: conditions } };
		}
		case 'or': {
			const conditions = (w.conditions as unknown[]).map((c) =>
				buildRecursiveAnchorWhere(c, tableAlias, deps),
			);
			if (conditions.length === 1) return conditions[0]!;
			return { BoolExpr: { boolop: 'OR_EXPR', args: conditions } };
		}
		default:
			return { A_Const: { boolval: { boolval: true } } };
	}
}
