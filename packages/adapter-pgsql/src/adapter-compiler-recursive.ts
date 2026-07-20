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
	ExpressionIntent,
	ModelIR,
	PlanReport,
	QueryIntent,
	RawCteIntent,
	RecursivePlanReport,
	SelectIntent,
	SimpleCteIntent,
	UnnestCteIntent,
} from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { compileSelectEnvelope } from './adapter-compiler-select.js';
import {
	binaryExpr,
	columnRef,
	funcCall,
	integerNode,
	stringNode,
} from './ast-helpers.js';
import { emittedBindName } from './binding-registry.js';
import { buildCustomFnFilter } from './compiler.js';
import { inferPgArrayType, stripArraySuffix } from './compiler-utils.js';
import { deparseQuoted } from './deparse.js';
import type { CompilerContext } from './handlers/index.js';
import { createCompilerState } from './handlers/index.js';
import { compileValue } from './handlers/where/utils.js';
import { createTypeCastParamRef } from './param-ref.js';
import { mapComparisonOperator } from './plan-decision-extractor.js';
import {
	dropPositionalUnion,
	finalizeEnvelope,
	fromAstProjection,
	fromModelColumns,
	type ProjectionEnvelope,
	type ProjectNamedFieldsExpression,
	type ProjectNamedFieldsSelection,
	preserveOneToOne,
	projectNamedFields,
} from './projection-envelope.js';
import {
	buildRecursiveCte,
	type RecursiveCteConfig,
} from './recursive/index.js';

type CteProjectionRegistry = ReadonlyMap<string, ProjectionEnvelope>;

function getRegisteredProjection(
	registry: CteProjectionRegistry,
	name: string,
	deps: AdapterCompilerDeps,
): ProjectionEnvelope | undefined {
	if (registry.size === 0) return undefined;
	const exact = registry.get(name);
	if (exact !== undefined) return exact;
	const naming = deps.naming;
	if (naming === undefined) return undefined;
	return registry.get(emittedBindName(name, naming));
}

function createPlanReportForQuery(query: QueryIntent): PlanReport {
	return {
		rootTable: query.from,
		decisions: [],
		warnings: [],
		ctes: [],
		intent: query,
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	};
}

function dbOutputKey(name: string, deps: AdapterCompilerDeps): string {
	return deps.naming.toDatabase(name);
}

function addSelection(
	selections: ProjectNamedFieldsSelection[],
	inputKey: string,
	outputKey: string,
): void {
	selections.push({ inputKey, outputKey });
}

function addExpression(
	expressions: ProjectNamedFieldsExpression[],
	outputKey: string | undefined,
	reason: string,
): void {
	if (outputKey === undefined) return;
	expressions.push({ outputKey, reason });
}

function addStarSelections(
	source: ProjectionEnvelope,
	selections: ProjectNamedFieldsSelection[],
): void {
	if (source.projection.kind === 'dropped') return;
	for (const outputKey of source.projection.outputs.keys()) {
		addSelection(selections, outputKey, outputKey);
	}
}

function aliasOutputKey(
	value: unknown,
	deps: AdapterCompilerDeps,
): string | undefined {
	return typeof value === 'string' ? dbOutputKey(value, deps) : undefined;
}

function expressionOutputKey(
	expr: ExpressionIntent,
	deps: AdapterCompilerDeps,
): string | undefined {
	const record = expr as unknown as Record<string, unknown>;
	return aliasOutputKey(record.as ?? record.alias, deps);
}

function buildCteProjectionShape(
	source: ProjectionEnvelope,
	select: SelectIntent | undefined,
	deps: AdapterCompilerDeps,
): {
	selections: ProjectNamedFieldsSelection[];
	expressions: ProjectNamedFieldsExpression[];
	preserveOneToOne: boolean;
} {
	if (
		!select ||
		typeof select !== 'object' ||
		!('type' in select) ||
		select.type === 'all'
	) {
		return { selections: [], expressions: [], preserveOneToOne: true };
	}

	const selections: ProjectNamedFieldsSelection[] = [];
	const expressions: ProjectNamedFieldsExpression[] = [];

	if (select.type === 'fields') {
		for (const field of select.fields) {
			if (field === '*') {
				addStarSelections(source, selections);
				continue;
			}
			const outputKey = dbOutputKey(field, deps);
			addSelection(selections, outputKey, outputKey);
		}
		return { selections, expressions, preserveOneToOne: false };
	}

	if (select.type === 'aggregate') {
		for (const field of select.fields ?? []) {
			const outputKey = dbOutputKey(field, deps);
			addSelection(selections, outputKey, outputKey);
		}
		for (const aggregate of select.aggregates) {
			addExpression(
				expressions,
				aliasOutputKey(aggregate.as, deps),
				'aggregate projection has no raw column provenance',
			);
		}
		return { selections, expressions, preserveOneToOne: false };
	}

	for (const expr of select.columns) {
		const record = expr as unknown as Record<string, unknown>;
		switch (expr.kind) {
			case 'column': {
				const column = record.column;
				if (column === '*') {
					addStarSelections(source, selections);
					break;
				}
				if (typeof column !== 'string') {
					addExpression(
						expressions,
						expressionOutputKey(expr, deps),
						'column projection could not be resolved',
					);
					break;
				}
				addSelection(
					selections,
					dbOutputKey(column, deps),
					aliasOutputKey(record.as, deps) ?? dbOutputKey(column, deps),
				);
				break;
			}
			case 'columnAlias': {
				const column = record.column;
				const alias = record.alias;
				if (typeof column !== 'string' || typeof alias !== 'string') {
					addExpression(
						expressions,
						expressionOutputKey(expr, deps),
						'column alias projection could not be resolved',
					);
					break;
				}
				addSelection(
					selections,
					dbOutputKey(column, deps),
					dbOutputKey(alias, deps),
				);
				break;
			}
			default:
				addExpression(
					expressions,
					expressionOutputKey(expr, deps),
					'expression projection has no raw column provenance',
				);
				break;
		}
	}

	return { selections, expressions, preserveOneToOne: false };
}

function projectCteQueryEnvelope(
	source: ProjectionEnvelope,
	query: QueryIntent,
	sql: string,
	parameters: readonly unknown[],
	deps: AdapterCompilerDeps,
	hydrationPlan: PlanReport | undefined,
): ProjectionEnvelope {
	const shape = buildCteProjectionShape(source, query.select, deps);
	if (shape.preserveOneToOne) {
		return preserveOneToOne(source, {
			sql,
			parameters,
			...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
			preserveHydrationPlan: false,
		});
	}
	return projectNamedFields(source, {
		sql,
		parameters,
		selections: shape.selections,
		expressions: shape.expressions,
		...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
		preserveHydrationPlan: false,
	});
}

function compileQueryEnvelope(
	query: QueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
	registry: CteProjectionRegistry,
): ProjectionEnvelope {
	const compiled = compileSelectEnvelope(
		createPlanReportForQuery(query),
		options,
		deps,
	);
	const registeredSource = getRegisteredProjection(registry, query.from, deps);
	if (registeredSource) {
		return projectCteQueryEnvelope(
			registeredSource,
			query,
			compiled.sql,
			compiled.parameters,
			deps,
			compiled.hydrationPlan,
		);
	}
	return compiled;
}

function rehomeQueryEnvelope(
	source: ProjectionEnvelope,
	query: QueryIntent,
	compiled: ProjectionEnvelope,
	sql: string,
	parameters: readonly unknown[],
	deps: AdapterCompilerDeps,
): ProjectionEnvelope {
	return projectCteQueryEnvelope(
		source,
		query,
		sql,
		parameters,
		deps,
		compiled.hydrationPlan,
	);
}

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
	model: ModelIR,
	_options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;
	const state = createCompilerState();
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
			compileCustomFnFilter: buildCustomFnFilter,
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
			? buildRecursiveAnchorWhere(intent.start.where, '__n', deps, state)
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
			compileCustomFnFilter: buildCustomFnFilter,
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
	const env = fromModelColumns({
		sql,
		parameters: state.parameters,
		table: config.table,
		columns: config.selectColumns,
		model,
		naming: deps.naming,
	});

	return finalizeEnvelope(env);
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
	initialProjectionByName?: CteProjectionRegistry,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const state = createCompilerState();

	// All parameters accumulated from all CTEs (in declaration order)
	const allCteParams: unknown[] = [];

	// 1. Build CTE SQL fragments, accumulating parameters
	const cteSqlFragments: string[] = [];
	const cteProjectionByName = new Map<string, ProjectionEnvelope>(
		initialProjectionByName,
	);
	let isRecursive = false;

	for (const cte of intent.ctes) {
		if (cte.kind === 'unnestCte') {
			// Unnest-backed CTE: builds an AST node, deparses it
			const beforeUnnestParamCount = state.parameters.length;
			state.paramIndex = allCteParams.length;
			const node = buildUnnestCte(cte, state, deps);
			const cteParams = state.parameters.slice(beforeUnnestParamCount);
			allCteParams.push(...cteParams);
			const cteSql = deparseQuoted(node);
			cteSqlFragments.push(cteSql);
			const cteQueryAst = (node as { CommonTableExpr?: { ctequery?: Node } })
				.CommonTableExpr?.ctequery;
			cteProjectionByName.set(
				cte.name,
				fromAstProjection({
					sql: cteSql,
					parameters: cteParams,
					ast: cteQueryAst ?? node,
					rootTable: cte.name,
					model: undefined,
					naming: deps.naming,
				}),
			);
		} else if (cte.kind === 'rawCte') {
			// Raw WITH RECURSIVE CTE: compile base + step independently
			isRecursive = true;
			const currentParamOffset = allCteParams.length;
			const rawCte = buildRawCte(cte, deps, options, cteProjectionByName);
			const renumberedRawCteSql =
				currentParamOffset > 0
					? rawCte.sql.replace(
							/\$([0-9]+)/g,
							(_: string, n: string) =>
								`$${parseInt(n, 10) + currentParamOffset}`,
						)
					: rawCte.sql;
			allCteParams.push(...rawCte.params);
			cteSqlFragments.push(renumberedRawCteSql);
			cteProjectionByName.set(
				cte.name,
				preserveOneToOne(rawCte.projection, {
					sql: renumberedRawCteSql,
					parameters: rawCte.params,
					preserveHydrationPlan: false,
				}),
			);
		} else if (cte.kind === 'simpleCte') {
			// Simple named subquery CTE: compile inner query, wrap in ctename AS (...)
			const innerCte = cte as SimpleCteIntent;
			const innerCompiled = compileQueryEnvelope(
				innerCte.query,
				options,
				deps,
				cteProjectionByName,
			);
			// Renumber inner params to follow all previously accumulated CTE params
			const currentParamOffset = allCteParams.length;
			const renumberedInnerSql =
				currentParamOffset > 0
					? innerCompiled.sql.replace(
							/\$([0-9]+)/g,
							(_: string, n: string) =>
								`$${parseInt(n, 10) + currentParamOffset}`,
						)
					: innerCompiled.sql;
			allCteParams.push(...innerCompiled.parameters);
			cteSqlFragments.push(`"${innerCte.name}" AS (${renumberedInnerSql})`);
			cteProjectionByName.set(
				innerCte.name,
				preserveOneToOne(innerCompiled, {
					sql: renumberedInnerSql,
					parameters: innerCompiled.parameters,
					preserveHydrationPlan: false,
				}),
			);
		} else {
			const kind = (cte as { kind: string }).kind;
			throw new Error(
				`PgsqlAdapter.compileCteQuery: Unsupported CTE kind '${kind}'`,
			);
		}
	}

	// 2. Compile outer query independently ($1, $2, ... relative to outer)
	const outerCompiled = compileSelectEnvelope(
		createPlanReportForQuery(intent.query),
		options,
		deps,
	);

	// 3. Renumber outer SQL parameters to follow all CTE parameters.
	// Safety: the deparser always emits user values as $N parameters, never as inline string
	// literals — so the /\$([0-9]+)/ regex cannot match user data embedded in quoted strings.
	const cteParamCount = allCteParams.length;
	const renumberedOuterSql =
		cteParamCount > 0
			? outerCompiled.sql.replace(
					/\$([0-9]+)/g,
					(_: string, n: string) => `$${parseInt(n, 10) + cteParamCount}`,
				)
			: outerCompiled.sql;

	// 4. Build WITH [RECURSIVE] clause
	const withClause = cteSqlFragments.join(', ');
	const withKeyword = isRecursive ? 'WITH RECURSIVE' : 'WITH';

	const sql =
		withClause.length > 0
			? `${withKeyword} ${withClause} ${renumberedOuterSql}`
			: renumberedOuterSql;
	const parameters = [...allCteParams, ...outerCompiled.parameters];
	const registeredSource = getRegisteredProjection(
		cteProjectionByName,
		intent.query.from,
		deps,
	);
	const env = registeredSource
		? projectCteQueryEnvelope(
				registeredSource,
				intent.query,
				sql,
				parameters,
				deps,
				outerCompiled.hydrationPlan,
			)
		: preserveOneToOne(outerCompiled, { sql, parameters });

	return finalizeEnvelope(env);
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
		const pgBaseType = stripArraySuffix(pgArrayType);

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
				val: binaryExpr('-', columnRef('ordinality', 't'), integerNode(1)),
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

/**
 * Build a "name AS (base UNION [ALL] step)" SQL fragment for a raw recursive CTE.
 *
 * Strategy:
 *   1. Compile base QueryIntent independently → base SQL + base params
 *   2. Compile step QueryIntent independently → step SQL + step params ($1-relative)
 *   3. Renumber step params to follow base params
 *   4. Return: `"name" AS (baseSql UNION [ALL] renumberedStepSql)` + all params
 *
 * The outer query params are renumbered separately by compileCteQuery().
 */
function buildRawCte(
	cte: RawCteIntent,
	deps: AdapterCompilerDeps,
	options: CompileOptions | undefined,
	registry: CteProjectionRegistry,
): {
	sql: string;
	params: readonly unknown[];
	projection: ProjectionEnvelope;
} {
	// Compile base (anchor) query
	const baseQuery = cte.base as QueryIntent;
	const baseCompiled = compileQueryEnvelope(baseQuery, options, deps, registry);

	// Compile step (recursive) query
	const stepQuery = cte.step as QueryIntent;
	const rawStepCompiled = compileSelectEnvelope(
		createPlanReportForQuery(stepQuery),
		options,
		deps,
	);

	// Renumber step params to follow base params.
	// Safety: the deparser always emits user values as $N parameters, never as inline string
	// literals — so the /\$([0-9]+)/ regex cannot match user data embedded in quoted strings.
	// This would only be a risk if the deparser inlined literals like 'Price: $10', which it
	// does not do. The regex is therefore safe against the SQL it compiles from AST.
	const baseParamCount = baseCompiled.parameters.length;
	const renumberedStepSql =
		baseParamCount > 0
			? rawStepCompiled.sql.replace(
					/\$([0-9]+)/g,
					(_: string, n: string) => `$${parseInt(n, 10) + baseParamCount}`,
				)
			: rawStepCompiled.sql;

	// Inject depth guard: WHERE "depthColumn" < $N (or AND-ed with existing WHERE)
	const allParams: unknown[] = [
		...baseCompiled.parameters,
		...rawStepCompiled.parameters,
	];
	let finalStepSql = renumberedStepSql;
	if (cte.maxDepth !== undefined) {
		const depthCol = `"${(cte.depthColumn ?? 'depth').replace(/"/g, '""')}"`;
		const depthParamIndex = allParams.length + 1; // next $N
		allParams.push(cte.maxDepth);
		// Detect whether the step SQL already has a WHERE clause
		const hasWhere = /\bWHERE\b/i.test(finalStepSql);
		finalStepSql = hasWhere
			? `${finalStepSql} AND ${depthCol} < $${depthParamIndex}`
			: `${finalStepSql} WHERE ${depthCol} < $${depthParamIndex}`;
	}
	const stepRegisteredSource =
		stepQuery.from === cte.name
			? baseCompiled
			: getRegisteredProjection(registry, stepQuery.from, deps);
	const stepCompiled = stepRegisteredSource
		? rehomeQueryEnvelope(
				stepRegisteredSource,
				stepQuery,
				rawStepCompiled,
				finalStepSql,
				allParams,
				deps,
			)
		: preserveOneToOne(rawStepCompiled, {
				sql: finalStepSql,
				parameters: allParams,
			});

	const setOp = cte.unionAll ? 'UNION ALL' : 'UNION';
	const cteName = `"${cte.name.replace(/"/g, '""')}"`;
	const cteSql = `${cteName} AS (${baseCompiled.sql} ${setOp} ${finalStepSql})`;

	return {
		sql: cteSql,
		params: allParams,
		projection: dropPositionalUnion([baseCompiled, stepCompiled], {
			sql: cteSql,
			parameters: allParams,
			reason: 'raw-recursive-cte-positional-merge',
		}),
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
	state: ReturnType<typeof createCompilerState>,
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
			const right: Node = compileValue(w.value, state, undefined, true);
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
				buildRecursiveAnchorWhere(c, tableAlias, deps, state),
			);
			if (conditions.length === 1) return conditions[0]!;
			return { BoolExpr: { boolop: 'AND_EXPR', args: conditions } };
		}
		case 'or': {
			const conditions = (w.conditions as unknown[]).map((c) =>
				buildRecursiveAnchorWhere(c, tableAlias, deps, state),
			);
			if (conditions.length === 1) return conditions[0]!;
			return { BoolExpr: { boolop: 'OR_EXPR', args: conditions } };
		}
		default:
			return { A_Const: { boolval: { boolval: true } } };
	}
}
