import {
	getRelationalReadPlan,
	planInScope,
	resolveReportIncludes,
} from '@dbsp/core/internal';
import { markPlannedReport } from '@dbsp/types/internal';
import { andExpr } from './ast-helpers.js';
import {
	buildSubqueryFromIntent,
	compileCondition,
	compileWhereIntent,
} from './condition-compiler.js';
import { createWhereDispatcher } from './handlers/index.js';
import { assertRelationalOutput } from './relational-output.js';
import { compileResolvedCondition } from './resolved-condition-compiler.js';
/**
 * Recursive CTE and unnest-CTE compilation.
 * Extracted from PgAdapter.compileRecursive(), compileCteQuery(),
 * and buildUnnestCte().
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
import {
	compileSelectEnvelope,
	nestedSelectCompiler,
} from './adapter-compiler-select.js';
import {
	binaryExpr,
	funcCall,
	integerNode,
	sqlColumnRef,
	stringNode,
} from './ast-helpers.js';
import {
	emittedBindName,
	hasBindingName,
	localSourcePredicate,
	relationBinding,
	withBindingName,
	withRelationBinding,
} from './binding-registry.js';
import { buildCustomFnFilter } from './compiler.js';
import { inferPgArrayType, stripArraySuffix } from './compiler-utils.js';
import { deparseQuoted } from './deparse.js';
import type { CompilerContext } from './handlers/index.js';
import { createCompilerState } from './handlers/index.js';
import { createParamRef, createTypeCastParamRef } from './param-ref.js';
import {
	dropPositionalUnion,
	finalizeEnvelope,
	fromModelColumns,
	fromOutputDescriptors,
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
import {
	bindAliasAuthority,
	queryScopeForBindingProjections,
} from './relation-target-projection.js';
import { queryLocal, resolveDeclaredIdentifier } from './sql-identifier.js';
import {
	commonTableExpression,
	requireStatementAst,
	setOperationStatement,
	shiftParameters,
	withLeadingCtes,
} from './statement-ast.js';
import { validateIdentifier } from './validate.js';

type CteProjectionRegistry = ReadonlyMap<string, ProjectionEnvelope>;

function withBindingProjectionScope(
	deps: AdapterCompilerDeps,
	bindingNames: AdapterCompilerDeps['bindingNames'],
	projections: CteProjectionRegistry,
): AdapterCompilerDeps {
	const scope = queryScopeForBindingProjections(bindingNames, projections);
	return {
		...deps,
		...(bindingNames !== undefined && { bindingNames }),
		relationTargetProjections: projections,
		...(scope !== undefined && { scope }),
	};
}

function getRegisteredProjection(
	registry: CteProjectionRegistry,
	name: string,
): ProjectionEnvelope | undefined {
	if (registry.size === 0) return undefined;
	return registry.get(name);
}

export function createPlanReportForQuery(
	query: QueryIntent,
	model: ModelIR | undefined,
	defaultFilters?: CompileOptions['defaultFilters'],
	isLocalSource?: (name: string) => boolean,
): PlanReport {
	const resolution = resolveReportIncludes(query, [], model, {
		...(defaultFilters && { defaultFilters }),
		skipRootDefaultFilter: true,
		isLocalSource,
	});
	return markPlannedReport({
		rootTable: query.from,
		decisions: [],
		warnings: [],
		ctes: [],
		intent: query,
		...(resolution.intent !== query && {
			executableIntent: resolution.intent,
		}),
		execution: resolution.execution,
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	});
}

function createPlanReportForCteQuery(
	query: QueryIntent,
	deps: AdapterCompilerDeps,
	hasRegisteredSource = false,
): PlanReport {
	const queryLocalSource =
		hasRegisteredSource || hasBindingName(deps.bindingNames, query.from);
	const isLocalSource = localSourcePredicate(deps.bindingNames, deps.scope);
	const issued = getRelationalReadPlan(query, queryLocalSource);
	if (issued) return issued;
	if (queryLocalSource) {
		return createPlanReportForQuery(
			query,
			deps.model,
			deps.defaultFilters,
			isLocalSource,
		);
	}
	if (deps.model.getTable(query.from) === undefined) {
		return createPlanReportForQuery(
			query,
			deps.model,
			deps.defaultFilters,
			isLocalSource,
		);
	}
	return planInScope(
		query,
		deps.model,
		{
			...(deps.defaultFilters && { defaultFilters: deps.defaultFilters }),
			...(deps.dialectCapabilities !== undefined && {
				dialectCapabilities: deps.dialectCapabilities,
			}),
		},
		{ isLocalSource },
	);
}

function dbOutputKey(name: string): string {
	// CTE projection labels are query-local, including labels that happen to
	// have the same spelling as a declared model column.
	return name;
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

function aliasOutputKey(value: unknown): string | undefined {
	return typeof value === 'string' ? dbOutputKey(value) : undefined;
}

function expressionOutputKey(expr: ExpressionIntent): string | undefined {
	const record = expr as unknown as Record<string, unknown>;
	return aliasOutputKey(record.as ?? record.alias);
}

function buildCteProjectionShape(
	source: ProjectionEnvelope,
	select: SelectIntent | undefined,
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
			const outputKey = dbOutputKey(field);
			addSelection(selections, outputKey, outputKey);
		}
		return { selections, expressions, preserveOneToOne: false };
	}

	if (select.type === 'aggregate') {
		for (const field of select.fields ?? []) {
			const outputKey = dbOutputKey(field);
			addSelection(selections, outputKey, outputKey);
		}
		for (const aggregate of select.aggregates) {
			addExpression(
				expressions,
				aliasOutputKey(aggregate.as),
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
						expressionOutputKey(expr),
						'column projection could not be resolved',
					);
					break;
				}
				addSelection(
					selections,
					dbOutputKey(column),
					aliasOutputKey(record.as) ?? dbOutputKey(column),
				);
				break;
			}
			case 'columnAlias': {
				const column = record.column;
				const alias = record.alias;
				if (typeof column !== 'string' || typeof alias !== 'string') {
					addExpression(
						expressions,
						expressionOutputKey(expr),
						'column alias projection could not be resolved',
					);
					break;
				}
				addSelection(selections, dbOutputKey(column), dbOutputKey(alias));
				break;
			}
			default:
				addExpression(
					expressions,
					expressionOutputKey(expr),
					'expression projection has no raw column provenance',
				);
				break;
		}
	}

	return { selections, expressions, preserveOneToOne: false };
}

function projectCteQueryEnvelope<T = unknown>(
	source: ProjectionEnvelope<T>,
	query: QueryIntent,
	sql: string,
	parameters: readonly unknown[],
	hydrationPlan: PlanReport | undefined,
	ast: Node | undefined,
): ProjectionEnvelope<T> {
	const shape = buildCteProjectionShape(source, query.select);
	if (shape.preserveOneToOne) {
		return preserveOneToOne<T>(source, {
			sql,
			parameters,
			...(ast !== undefined ? { ast } : {}),
			...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
			preserveHydrationPlan: false,
		});
	}
	return projectNamedFields<T>(source, {
		sql,
		parameters,
		...(ast !== undefined ? { ast } : {}),
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
	const registeredSource = getRegisteredProjection(registry, query.from);
	const compiled = compileSelectEnvelope(
		createPlanReportForCteQuery(query, deps, registeredSource !== undefined),
		options,
		deps,
	);
	if (registeredSource) {
		return projectCteQueryEnvelope(
			registeredSource,
			query,
			compiled.sql,
			compiled.parameters,
			compiled.hydrationPlan,
			compiled.ast,
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
	ast: Node,
): ProjectionEnvelope {
	return projectCteQueryEnvelope(
		source,
		query,
		sql,
		parameters,
		compiled.hydrationPlan,
		ast,
	);
}

// ============================================================================
// compileRecursive
// ============================================================================

/**
 * Compile a recursive CTE plan to executable SQL.
 * Supports adjacency-list and edge-table traversal modes.
 * Extracted body of PgAdapter.compileRecursive().
 */
export function compileRecursive<T = unknown>(
	report: RecursivePlanReport,
	model: ModelIR,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery<T> {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;
	const state = createCompilerState();
	const intent = report.intent;
	const traversal = intent.traversal;

	const trackPath = intent.track?.path !== undefined;
	const trackDepth = intent.track?.depth !== undefined;

	// Older direct reports omit start.from; their anchor source is the node table.
	if (traversal.kind !== 'edge-table' && traversal.kind !== 'adjacency') {
		throw new Error(
			`PgAdapter.compileRecursive: Unsupported traversal kind '${traversal.kind}'`,
		);
	}
	const startTable = intent.start.from ?? traversal.nodeTable;

	if (startTable !== traversal.nodeTable) {
		throw new Error(
			`Recursive start.from '${startTable}' must match traversal.nodeTable '${traversal.nodeTable}'.`,
		);
	}

	const anchorBinding = relationBinding({
		kind: 'declared-table',
		logicalTable: startTable,
		qualifier: queryLocal('__n'),
	});
	const anchorScope = withRelationBinding(deps.scope, anchorBinding);

	// A report planRecursive issued carries start.where resolved (recursiveFilters.start);
	// a report without it (hand-built) keeps the direct compile.
	const anchorWhere =
		intent.start.where && !report.recursiveFilters?.start
			? compileCondition(intent.start.where, {
					position: 'recursive-anchor',
					logicalSourceTable: startTable,
					emittedAlias: '__n',
					visibleAliases: new Map([['__n', startTable]]),
					paramState: state,
					defaultPkColumnName: deps.defaultPk,
					deriveFkColumnName: deps.deriveFk,
					aliasColumnAuthorities: bindAliasAuthority(
						undefined,
						queryLocal('__n'),
						{
							target: queryLocal(startTable),
							logicalTable: startTable,
						},
					),
					model: deps.model,
					...(deps.declaredNames !== undefined && {
						declaredNames: deps.declaredNames,
					}),
					...(schemaName !== undefined && { schemaName }),
					...(deps.dbCasing !== undefined && { dbCasing: deps.dbCasing }),
					...(deps.dialectCapabilities !== undefined && {
						dialectCapabilities: deps.dialectCapabilities,
					}),
					scope: anchorScope,
					currentBinding: anchorBinding,
					compileSubquery: (query, offset, parent) =>
						buildSubqueryFromIntent(
							query,
							offset,
							deps.declaredNames,
							schemaName,
							'rawExists',
							anchorScope,
							deps.dialectCapabilities,
							deps.dbCasing,
							parent,
						),
				})
			: undefined;

	let config: RecursiveCteConfig;

	if (traversal.kind === 'edge-table') {
		const table = traversal.nodeTable;
		const pkColumn = traversal.nodeId;
		const ctx = {
			...deps,
			rootTable: table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: intent.maxDepth,
			compileCustomFnFilter: buildCustomFnFilter,
			createWhereDispatcher: () => createWhereDispatcher(compileWhereIntent),
			compileNestedSelect: nestedSelectCompiler(options, deps),
		} as CompilerContext;

		// Get columns to select
		const startSelect = intent.start.select ?? [];
		const nodeIdColumn =
			intent.start.nodeIdExpr.kind === 'column'
				? intent.start.nodeIdExpr.name
				: pkColumn;
		const selectColumns = Array.from(
			new Set([nodeIdColumn, ...startSelect]),
		).map((column) =>
			resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table,
					column,
				},
			),
		);
		const logicalSelectColumns = Array.from(
			new Set([nodeIdColumn, ...startSelect]),
		);

		// Edge-table traversal: join through a junction table
		const edgeFrom =
			traversal.direction === 'in' ? traversal.edgeTo : traversal.edgeFrom;
		const edgeTo =
			traversal.direction === 'in' ? traversal.edgeFrom : traversal.edgeTo;

		const base: RecursiveCteConfig = {
			cteAlias: queryLocal(intent.cteName),
			table: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'table',
					table,
				},
			),
			pkColumn: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table,
					column: pkColumn,
				},
			),
			anchor: { mode: 'standalone' },
			isAncestors: false,
			maxDepth: intent.maxDepth,
			selectColumns,
			logicalTable: table,
			logicalSelectColumns,
			trackPath,
			usePg14Cycle: false,
			edgeTable: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'table',
					table: traversal.edgeTable,
				},
			),
			edgeFrom: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table: traversal.edgeTable,
					column: edgeFrom,
				},
			),
			edgeTo: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table: traversal.edgeTable,
					column: edgeTo,
				},
			),
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
		const ctx = {
			...deps,
			rootTable: table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: intent.maxDepth,
			compileCustomFnFilter: buildCustomFnFilter,
			createWhereDispatcher: () => createWhereDispatcher(compileWhereIntent),
			compileNestedSelect: nestedSelectCompiler(options, deps),
		} as CompilerContext;

		const startSelect = intent.start.select ?? [];
		const nodeIdColumn =
			intent.start.nodeIdExpr.kind === 'column'
				? intent.start.nodeIdExpr.name
				: pkColumn;
		const selectColumns = Array.from(
			new Set([nodeIdColumn, ...startSelect]),
		).map((column) =>
			resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table,
					column,
				},
			),
		);
		const logicalSelectColumns = Array.from(
			new Set([nodeIdColumn, ...startSelect]),
		);

		// Adjacency-list traversal: self-referencing FK
		config = {
			...(anchorWhere !== undefined && { anchorWhere }),
			cteAlias: queryLocal(intent.cteName),
			table: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'table',
					table,
				},
			),
			pkColumn: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table,
					column: pkColumn,
				},
			),
			fkColumn: resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'column',
					table,
					column: traversal.parentId,
				},
			),
			anchor: { mode: 'standalone' },
			isAncestors: traversal.direction === 'ancestors',
			maxDepth: intent.maxDepth,
			selectColumns,
			logicalTable: table,
			logicalSelectColumns,
			trackPath,
			usePg14Cycle: false,
			ctx,
		};
	} else {
		// Exhaustive check: both supported traversal kinds are handled above.
		const _exhaustive: never = traversal;
		throw new Error(
			`PgAdapter.compileRecursive: Unsupported traversal kind '${(_exhaustive as { kind: string }).kind}'`,
		);
	}

	// Build the recursive CTE
	if (report.recursiveFilters?.start)
		config.anchorWhere = compileResolvedCondition(
			report.recursiveFilters.start,
			config.ctx,
			state,
		);
	if (report.recursiveFilters?.anchor) {
		const predicate = compileResolvedCondition(
			report.recursiveFilters.anchor,
			config.ctx,
			state,
		);
		config.anchorWhere = config.anchorWhere
			? andExpr(config.anchorWhere, predicate)
			: predicate;
	}
	if (report.recursiveFilters?.step)
		config.stepWhere = compileResolvedCondition(
			report.recursiveFilters.step,
			config.ctx,
			state,
		);
	const { cte, extraCtes } = buildRecursiveCte(config);

	// Build final target list (include __depth and __path when tracked)
	const finalSelections: ProjectNamedFieldsSelection[] = [];
	const finalExpressions: ProjectNamedFieldsExpression[] = [];
	const finalTargets: Node[] = config.selectColumns.map((col: string) => {
		const outputKey = col;
		addSelection(finalSelections, outputKey, outputKey);
		return {
			ResTarget: {
				val: {
					ColumnRef: {
						fields: [
							{ String: { sval: config.cteAlias } },
							{ String: { sval: outputKey } },
						],
					},
				},
				name: outputKey,
			},
		};
	});

	if (trackDepth) {
		const depthAlias = intent.track?.depth?.as ?? '__depth';
		addExpression(finalExpressions, depthAlias, 'recursive depth tracker');
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
		addExpression(finalExpressions, pathAlias, 'recursive path tracker');
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
	const sourceEnv = fromModelColumns<T>({
		sql,
		parameters: state.parameters,
		table: config.logicalTable ?? config.table,
		columns: config.logicalSelectColumns ?? config.selectColumns,
		model,
		...(deps.declaredNames !== undefined && {
			declaredNames: deps.declaredNames,
		}),
	});
	const env = projectNamedFields<T>(sourceEnv, {
		sql,
		parameters: state.parameters,
		selections: finalSelections,
		...(finalExpressions.length > 0 ? { expressions: finalExpressions } : {}),
	});

	return finalizeEnvelope<T>(env);
}

// ============================================================================
// compileCteQuery
// ============================================================================

/**
 * Compile a CTE query: simple, unnest-backed and raw recursive CTEs, then the
 * outer query, as one `SelectStmt` with a `WithClause` (ADR 0012).
 *
 * Each CTE body and the outer query are compiled with parameters from $1; each
 * subtree's `ParamRef` nodes are shifted in the tree by the parameters of the
 * CTEs before it, and the statement is deparsed once.
 *
 * Extracted body of PgAdapter.compileCteQuery().
 */
export function compileCteQuery<T = unknown>(
	intent: CteQueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
	initialProjectionByName?: CteProjectionRegistry,
): CompiledQuery<T> {
	return finalizeEnvelope<T>(
		compileCteQueryEnvelope<T>(intent, options, deps, initialProjectionByName),
	);
}

function compileCteQueryEnvelope<T = unknown>(
	intent: CteQueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
	initialProjectionByName?: CteProjectionRegistry,
): ProjectionEnvelope<T> {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const state = createCompilerState();

	// All parameters accumulated from all CTEs (in declaration order)
	const allCteParams: unknown[] = [];

	// 1. Build CTE nodes, accumulating parameters
	const cteNodes: Node[] = [];
	const cteProjectionByName = new Map<string, ProjectionEnvelope>(
		initialProjectionByName,
	);
	let isRecursive = false;
	// CTE names share the binding-name registry because both are query-local
	// relations that must not be schema-qualified. A CTE body may only refer to
	// earlier declarations; the outer query may refer to every declaration.
	let visibleCteDeps = withBindingProjectionScope(
		deps,
		deps.bindingNames,
		cteProjectionByName,
	);

	for (const cte of intent.ctes) {
		validateIdentifier(cte.name, 'table');
		const emittedCteName = emittedBindName(queryLocal(cte.name));
		if (cte.kind === 'unnestCte') {
			// Unnest-backed CTE: its counter starts after the earlier CTEs' parameters
			const beforeUnnestParamCount = state.parameters.length;
			state.paramIndex = allCteParams.length;
			const node = buildUnnestCte(cte, state);
			const cteParams = state.parameters.slice(beforeUnnestParamCount);
			allCteParams.push(...cteParams);
			cteNodes.push(node);
			cteProjectionByName.set(
				emittedCteName,
				fromOutputDescriptors({
					sql: deparseQuoted(node),
					parameters: cteParams,
					columns: [
						...Object.keys(cte.columns),
						...(cte.indexColumn !== undefined ? [cte.indexColumn] : []),
					],
				}),
			);
		} else if (cte.kind === 'rawCte') {
			// Raw WITH RECURSIVE CTE: base UNION [ALL] step as one tree
			isRecursive = true;
			const rawCteStepDeps = withBindingProjectionScope(
				visibleCteDeps,
				withBindingName(visibleCteDeps.bindingNames, queryLocal(cte.name)),
				cteProjectionByName,
			);
			const rawCte = buildRawCte(
				cte,
				visibleCteDeps,
				rawCteStepDeps,
				options,
				cteProjectionByName,
			);
			// Keep positional-UNION result metadata fail-closed even though the
			// separate binding projection below retains local output labels.
			finalizeEnvelope(rawCte.projection);
			cteNodes.push(shiftParameters(rawCte.ast, allCteParams.length));
			allCteParams.push(...rawCte.params);
			cteProjectionByName.set(emittedCteName, rawCte.bindingProjection);
		} else if (cte.kind === 'simpleCte') {
			// Simple named subquery CTE: ctename AS (inner query tree)
			const innerCte = cte as SimpleCteIntent;
			const innerCompiled = compileQueryEnvelope(
				innerCte.query,
				options,
				visibleCteDeps,
				cteProjectionByName,
			);
			assertRelationalOutput(innerCompiled.hydrationPlan, 'Relational bodies');
			cteNodes.push(
				commonTableExpression(
					emittedCteName,
					shiftParameters(
						requireStatementAst(innerCompiled, `CTE '${cte.name}'`),
						allCteParams.length,
					),
				),
			);
			allCteParams.push(...innerCompiled.parameters);
			cteProjectionByName.set(
				emittedCteName,
				preserveOneToOne(innerCompiled, {
					sql: innerCompiled.sql,
					parameters: innerCompiled.parameters,
					preserveHydrationPlan: false,
				}),
			);
		} else {
			const kind = (cte as { kind: string }).kind;
			throw new Error(
				`PgAdapter.compileCteQuery: Unsupported CTE kind '${kind}'`,
			);
		}

		visibleCteDeps = withBindingProjectionScope(
			visibleCteDeps,
			withBindingName(visibleCteDeps.bindingNames, queryLocal(cte.name)),
			cteProjectionByName,
		);
	}

	// 2. Compile outer query independently ($1, $2, ... relative to outer)
	const outerRegisteredSource = getRegisteredProjection(
		cteProjectionByName,
		intent.query.from,
	);
	const outerCompiled = compileSelectEnvelope(
		createPlanReportForCteQuery(
			intent.query,
			visibleCteDeps,
			outerRegisteredSource !== undefined,
		),
		options,
		{
			...visibleCteDeps,
			relationTargetProjections: cteProjectionByName,
		},
	);

	// 3. Shift the outer query's parameters after the CTEs' and attach the CTEs
	const ast = withLeadingCtes(
		shiftParameters(
			requireStatementAst(outerCompiled, 'the outer query of a CTE query'),
			allCteParams.length,
		),
		cteNodes,
		isRecursive,
	);
	const sql = deparseQuoted(ast);
	const parameters = [...allCteParams, ...outerCompiled.parameters];
	return outerRegisteredSource
		? projectCteQueryEnvelope<T>(
				outerRegisteredSource as ProjectionEnvelope<T>,
				intent.query,
				sql,
				parameters,
				outerCompiled.hydrationPlan,
				ast,
			)
		: preserveOneToOne<T>(outerCompiled, { sql, parameters, ast });
}

// ============================================================================
// buildUnnestCte (internal)
// ============================================================================

/**
 * Build a CommonTableExpr AST node for an unnest-backed CTE.
 * Produces: CommonTableExpr { ctename: 'name', ctequery: SelectStmt {...} }
 * Extracted body of PgAdapter.buildUnnestCte().
 */
function buildUnnestCte(
	cte: UnnestCteIntent,
	state: ReturnType<typeof createCompilerState>,
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
	const allAliasNames = [...columns, ...(hasIndex ? ['ordinality'] : [])];

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
			val: sqlColumnRef(queryLocal(col), queryLocal('t')),
			name: col,
		},
	}));
	if (hasIndex) {
		targets.push({
			ResTarget: {
				val: binaryExpr(
					'-',
					sqlColumnRef(queryLocal('ordinality'), queryLocal('t')),
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
			ctename: emittedBindName(queryLocal(cte.name)),
			ctequery: { SelectStmt: cteSelectStmt },
		},
	};
}

/**
 * Build a `name AS (base UNION [ALL] step)` CTE node for a raw recursive CTE.
 *
 * Strategy:
 *   1. Compile base QueryIntent independently → base tree + base params
 *   2. Compile step QueryIntent independently → step tree ($1-relative)
 *   3. Shift the step's ParamRefs after the base's, in the tree
 *   4. AND the depth guard into the step's WHERE, read from its tree
 *
 * The CTE's parameters are numbered from $1; compileCteQuery() shifts them.
 */
function buildRawCte(
	cte: RawCteIntent,
	anchorDeps: AdapterCompilerDeps,
	stepDeps: AdapterCompilerDeps,
	options: CompileOptions | undefined,
	registry: CteProjectionRegistry,
): {
	ast: Node;
	params: readonly unknown[];
	projection: ProjectionEnvelope;
	bindingProjection: ProjectionEnvelope;
} {
	// Compile base (anchor) query
	const baseQuery = cte.base as QueryIntent;
	const baseCompiled = compileQueryEnvelope(
		baseQuery,
		options,
		anchorDeps,
		registry,
	);
	// The recursive name enters the step query with the anchor's projected
	// labels. A name-only binding cannot safely resolve `chain.name`.
	const stepProjectionRegistry = new Map(registry);
	stepProjectionRegistry.set(
		emittedBindName(queryLocal(cte.name)),
		baseCompiled,
	);
	const scopedStepDeps = withBindingProjectionScope(
		stepDeps,
		stepDeps.bindingNames,
		stepProjectionRegistry,
	);

	// Compile step (recursive) query
	const stepQuery = cte.step as QueryIntent;
	const rawStepCompiled = compileSelectEnvelope(
		createPlanReportForCteQuery(
			stepQuery,
			scopedStepDeps,
			getRegisteredProjection(stepProjectionRegistry, stepQuery.from) !==
				undefined,
		),
		options,
		scopedStepDeps,
	);

	const baseAst = requireStatementAst(
		baseCompiled,
		`the base of recursive CTE '${cte.name}'`,
	);
	const shiftedStepAst = shiftParameters(
		requireStatementAst(
			rawStepCompiled,
			`the step of recursive CTE '${cte.name}'`,
		),
		baseCompiled.parameters.length,
	);
	const allParams: unknown[] = [
		...baseCompiled.parameters,
		...rawStepCompiled.parameters,
	];
	let stepAst = shiftedStepAst;
	if (cte.maxDepth !== undefined) {
		// Depth guard: "depthColumn" < $N, ANDed with the step's own WHERE
		allParams.push(cte.maxDepth);
		stepAst = withDepthGuard(
			shiftedStepAst,
			cte.depthColumn ?? 'depth',
			allParams.length,
			cte.name,
		);
	}
	const stepSql = deparseQuoted(stepAst);
	const stepRegisteredSource =
		stepQuery.from === cte.name
			? baseCompiled
			: getRegisteredProjection(stepProjectionRegistry, stepQuery.from);
	const stepCompiled = stepRegisteredSource
		? rehomeQueryEnvelope(
				stepRegisteredSource,
				stepQuery,
				rawStepCompiled,
				stepSql,
				allParams,
				stepAst,
			)
		: preserveOneToOne(rawStepCompiled, {
				sql: stepSql,
				parameters: allParams,
				ast: stepAst,
			});

	const ast = commonTableExpression(
		emittedBindName(queryLocal(cte.name)),
		setOperationStatement('union', cte.unionAll === true, baseAst, stepAst),
	);
	const cteSql = deparseQuoted(ast);

	return {
		ast,
		params: allParams,
		projection: dropPositionalUnion([baseCompiled, stepCompiled], {
			sql: cteSql,
			parameters: allParams,
			reason: 'raw-recursive-cte-positional-merge',
		}),
		// Recursive UNION output labels come from the anchor SELECT. Preserve them
		// for the CTE relation binding while keeping result metadata conservative.
		bindingProjection: preserveOneToOne(baseCompiled, {
			sql: cteSql,
			parameters: allParams,
			preserveHydrationPlan: false,
		}),
	};
}

/** AND `"depthColumn" < $paramNumber` into a step's WHERE, read from its tree. */
function withDepthGuard(
	stepAst: Node,
	depthColumn: string,
	paramNumber: number,
	cteName: string,
): Node {
	const step = (stepAst as { SelectStmt?: SelectStmt }).SelectStmt;
	if (
		step === undefined ||
		(step.op !== undefined && step.op !== 'SETOP_NONE')
	) {
		throw new Error(
			`Cannot add the depth guard of recursive CTE '${cteName}': its step is not a plain SELECT.`,
		);
	}
	const guard = binaryExpr(
		'<',
		{ ColumnRef: { fields: [stringNode(depthColumn)] } },
		createParamRef(paramNumber),
	);
	return {
		SelectStmt: {
			...step,
			whereClause:
				step.whereClause !== undefined
					? andExpr(step.whereClause, guard)
					: guard,
		},
	};
}
