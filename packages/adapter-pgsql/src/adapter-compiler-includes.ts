/**
 * Subquery-include compilation: compileSubqueryInclude + M:N variant.
 * Extracted from PgAdapter.compileSubqueryInclude() and
 * PgAdapter.compileSubqueryIncludeManyToMany().
 *
 * @internal
 */

import type {
	CompiledQuery,
	CompileOptions,
	SubqueryIncludeInfo,
} from '@dbsp/types';
import { toColumnList } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import {
	booleanConstNode,
	innerJoin,
	sqlColumnRef,
	sqlColumnRefStar,
	sqlRangeVar,
} from './ast-helpers.js';
import { compilePlan } from './compiler.js';
import { deparseQuoted } from './deparse.js';
import { createCompilerState } from './handlers/index.js';
import { intentToDecisions } from './intent-to-decisions.js';
import { finalizeEnvelope, fromAstProjection } from './projection-envelope.js';
import {
	identifierText,
	queryLocal,
	resolveDeclaredIdentifier,
} from './sql-identifier.js';

function compileIncludeSelectEnvelope(
	selectAst: Node,
	targetTable: string,
	parameters: readonly unknown[],
	deps: AdapterCompilerDeps,
	sql = deparseQuoted(selectAst),
): CompiledQuery {
	return finalizeEnvelope(
		fromAstProjection({
			sql,
			parameters,
			ast: selectAst,
			rootTable: targetTable,
			model: deps.model,
			...(deps.declaredNames !== undefined && {
				declaredNames: deps.declaredNames,
			}),
		}),
	);
}

/** Project requested fields plus keys used by this and nested hydration. */
function includeProjection(
	info: SubqueryIncludeInfo,
	deps: AdapterCompilerDeps,
	alias?: string,
): {
	targetList: Node[];
	parameters: readonly unknown[];
	groupClause?: Node[];
} {
	if (
		!info.select ||
		info.select.type === 'all' ||
		(info.select.type === 'fields' && info.select.fields.includes('*'))
	) {
		return {
			parameters: [],
			targetList: [
				{
					ResTarget: {
						val: sqlColumnRefStar(
							alias === undefined ? undefined : queryLocal(alias),
						),
					},
				},
			],
		};
	}
	const keys = [
		...toColumnList(info.foreignKey),
		...(info.nestedIncludes ?? []).flatMap((nested) =>
			toColumnList(nested.sourceKey),
		),
	];
	if (info.select.type !== 'fields') {
		const decisions = intentToDecisions(
			{ type: 'select', from: info.targetTable, select: info.select },
			info.targetTable,
		);
		for (const column of new Set(keys)) {
			if (
				!decisions.some(
					(d) => d.type === 'select' && d.column === column && !d.alias,
				)
			)
				decisions.push({ type: 'select', table: info.targetTable, column });
		}
		if (decisions.some((d) => d.type === 'selectFunction')) {
			for (const d of [...decisions]) {
				if (d.type === 'select' && d.column)
					decisions.push({
						type: 'groupBy',
						table: info.targetTable,
						column: d.column,
					});
			}
		}
		const compiled = compilePlan(
			{ rootTable: info.targetTable, decisions },
			{
				dbCasing: deps.dbCasing ?? 'preserve',
				...(deps.declaredNames && { declaredNames: deps.declaredNames }),
				...(deps.model && { model: deps.model }),
			},
		);
		const stmt = (
			'SelectStmt' in compiled.ast ? compiled.ast.SelectStmt : undefined
		)!;
		if (alias) {
			const table = identifierText(
				resolveDeclaredIdentifier(
					deps.declaredNames,
					deps.dbCasing ?? 'preserve',
					{ kind: 'table', table: info.targetTable },
				),
			);
			const rebind = (node: unknown): void => {
				if (!node || typeof node !== 'object') return;
				const ref =
					'ColumnRef' in node
						? (node as Extract<Node, { ColumnRef: unknown }>).ColumnRef
						: undefined;
				const first = ref?.fields?.[0];
				if (
					first &&
					'String' in first &&
					first.String?.sval === table &&
					ref!.fields!.length > 1
				)
					first.String.sval = alias;
				for (const child of Object.values(node)) rebind(child);
			};
			rebind(stmt.targetList);
			rebind(stmt.groupClause);
		}
		return {
			targetList: stmt.targetList ?? [],
			parameters: compiled.parameters,
			...(stmt.groupClause && { groupClause: stmt.groupClause }),
		};
	}
	const fields = [...new Set([...info.select.fields, ...keys])];
	return {
		parameters: [],
		targetList: fields.map((column) => ({
			ResTarget: {
				val: sqlColumnRef(
					resolveDeclaredIdentifier(
						deps.declaredNames,
						deps.dbCasing ?? 'preserve',
						{ kind: 'column', table: info.targetTable, column },
					),
					alias === undefined ? undefined : queryLocal(alias),
				),
			},
		})),
	};
}

// ============================================================================
// compileSubqueryInclude
// ============================================================================

/**
 * Compile a subquery include query for given parent IDs (DX-033).
 * Generates: SELECT requestedColumns FROM targetTable WHERE foreignKey IN ($1, $2, ...)
 * Extracted body of PgAdapter.compileSubqueryInclude().
 */
export function compileSubqueryInclude(
	info: SubqueryIncludeInfo,
	parentIds: readonly unknown[],
	_options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	if (info.where) {
		throw new Error(
			`Include where is not supported for strategy subquery at include(${info.relationName}).where (oorabona/db-semantic-planner#892).`,
		);
	}
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;
	const state = createCompilerState();

	// Handle empty parent IDs - return query that returns no results
	if (parentIds.length === 0) {
		const dbTargetTable = resolveDeclaredIdentifier(
			deps.declaredNames,
			deps.dbCasing ?? 'preserve',
			{ kind: 'table', table: info.targetTable },
		);
		const projection = includeProjection(info, deps);
		const fromClause = [
			sqlRangeVar(
				dbTargetTable,
				undefined,
				schemaName === undefined ? undefined : queryLocal(schemaName),
			),
		];
		const selectAst: Node = {
			SelectStmt: {
				targetList: projection.targetList,
				...(projection.groupClause && { groupClause: projection.groupClause }),
				fromClause,
			},
		};
		const sql = `${deparseQuoted(selectAst)} WHERE FALSE`;
		selectAst.SelectStmt!.whereClause = booleanConstNode(false);
		return compileIncludeSelectEnvelope(
			selectAst,
			info.targetTable,
			[],
			deps,
			sql,
		);
	}

	// Determine FK column(s)
	const fkColumns = toColumnList(info.foreignKey);
	if (fkColumns.length === 0) {
		throw new Error(
			'Subquery include requires at least one foreignKey column.',
		);
	}

	// For M:N relations with junction table
	if (info.through && info.throughSourceKey && info.throughTargetKey) {
		return compileSubqueryIncludeManyToMany(
			info,
			parentIds,
			schemaName,
			state,
			deps,
		);
	}

	// Build SELECT target list
	const projection = includeProjection(info, deps);

	state.parameters.push(...projection.parameters);
	state.paramIndex = projection.parameters.length;

	// Build FROM clause
	const fromClause = [
		sqlRangeVar(
			resolveDeclaredIdentifier(
				deps.declaredNames,
				deps.dbCasing ?? 'preserve',
				{
					kind: 'table',
					table: info.targetTable,
				},
			),
			undefined,
			schemaName === undefined ? undefined : queryLocal(schemaName),
		),
	];

	// Build WHERE clause: foreignKey IN ($1, $2, ...)
	let whereClause: Node;

	if (fkColumns.length === 1) {
		// Single column FK: column IN ($1, $2, ...)
		const paramRefs = parentIds.map((id) => {
			state.parameters.push(id);
			state.paramIndex++;
			return { ParamRef: { number: state.paramIndex } };
		});

		whereClause = {
			A_Expr: {
				kind: 'AEXPR_IN',
				name: [{ String: { sval: '=' } }],
				lexpr: sqlColumnRef(
					resolveDeclaredIdentifier(
						deps.declaredNames,
						deps.dbCasing ?? 'preserve',
						{
							kind: 'column',
							table: info.targetTable,
							column: fkColumns[0]!,
						},
					),
				),
				rexpr: { List: { items: paramRefs } },
			},
		};
	} else {
		// Composite FK: (col1, col2) IN (($1, $2), ($3, $4), ...)
		// For simplicity, use OR of ANDs
		const conditions = parentIds.map((id) => {
			if (!Array.isArray(id) || id.length !== fkColumns.length) {
				throw new Error(
					`Subquery include composite key parameter width (${Array.isArray(id) ? id.length : 1}) must match foreignKey width (${fkColumns.length}).`,
				);
			}
			const idValues = id;
			const colConditions = fkColumns.map((col, idx) => {
				state.parameters.push(idValues[idx]);
				state.paramIndex++;
				return {
					A_Expr: {
						kind: 'AEXPR_OP',
						name: [{ String: { sval: '=' } }],
						lexpr: sqlColumnRef(
							resolveDeclaredIdentifier(
								deps.declaredNames,
								deps.dbCasing ?? 'preserve',
								{
									kind: 'column',
									table: info.targetTable,
									column: col,
								},
							),
						),
						rexpr: { ParamRef: { number: state.paramIndex } },
					},
				};
			});

			return colConditions.length === 1
				? colConditions[0]
				: { BoolExpr: { boolop: 'AND_EXPR', args: colConditions } };
		});

		whereClause =
			conditions.length === 1
				? (conditions[0] as Node)
				: { BoolExpr: { boolop: 'OR_EXPR', args: conditions as Node[] } };
	}

	// Build SELECT statement
	const selectAst: Node = {
		SelectStmt: {
			targetList: projection.targetList,
			...(projection.groupClause && { groupClause: projection.groupClause }),
			fromClause,
			whereClause,
		},
	};

	return compileIncludeSelectEnvelope(
		selectAst,
		info.targetTable,
		state.parameters,
		deps,
	);
}

// ============================================================================
// compileSubqueryIncludeManyToMany (internal)
// ============================================================================

/**
 * Compile M:N subquery include with junction table.
 * Extracted body of PgAdapter.compileSubqueryIncludeManyToMany().
 */
function compileSubqueryIncludeManyToMany(
	info: SubqueryIncludeInfo,
	parentIds: readonly unknown[],
	schemaName: string | undefined,
	state: ReturnType<typeof createCompilerState>,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// M:N: SELECT t.* FROM target t
	//      JOIN junction j ON t.pk = j.throughTargetKey
	//      WHERE j.throughSourceKey IN ($1, $2, ...)

	const targetAlias = 't';
	const junctionAlias = 'j';

	const throughTable = info.through!;
	const throughSourceKey = info.throughSourceKey!;
	const throughTargetKey = info.throughTargetKey!;
	const targetTable = resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{ kind: 'table', table: info.targetTable },
	);
	const junctionTable = resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{ kind: 'table', table: throughTable },
	);
	const junctionSourceColumn = resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{ kind: 'column', table: throughTable, column: throughSourceKey },
	);
	const junctionTargetColumn = resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{ kind: 'column', table: throughTable, column: throughTargetKey },
	);

	// Determine target PK (usually 'id', but could be from sourceKey)
	const targetPkColumns = toColumnList(info.sourceKey);
	if (targetPkColumns.length !== 1) {
		throw new Error(
			`Many-to-many subquery include requires a single-column target key; got ${JSON.stringify(targetPkColumns)}.`,
		);
	}
	const targetPk = targetPkColumns[0]!;
	const targetPkColumn = resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{ kind: 'column', table: info.targetTable, column: targetPk },
	);

	const projection = includeProjection(info, deps, targetAlias);
	state.parameters.push(...projection.parameters);
	state.paramIndex = projection.parameters.length;

	// Build param refs for parent IDs
	const paramRefs = parentIds.map((id) => {
		state.parameters.push(id);
		state.paramIndex++;
		return { ParamRef: { number: state.paramIndex } };
	});

	// Build WHERE clause: j.throughSourceKey IN (...)
	const whereClause: Node = {
		A_Expr: {
			kind: 'AEXPR_IN',
			name: [{ String: { sval: '=' } }],
			lexpr: sqlColumnRef(junctionSourceColumn, queryLocal(junctionAlias)),
			rexpr: { List: { items: paramRefs } },
		},
	};

	// Build JOIN condition: t.pk = j.throughTargetKey
	const joinQuals: Node = {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: sqlColumnRef(targetPkColumn, queryLocal(targetAlias)),
			rexpr: sqlColumnRef(junctionTargetColumn, queryLocal(junctionAlias)),
		},
	};

	// Build FROM clause with JOIN using helper functions
	const targetRangeVar = sqlRangeVar(
		targetTable,
		queryLocal(targetAlias),
		schemaName === undefined ? undefined : queryLocal(schemaName),
	);

	const junctionRangeVar = sqlRangeVar(
		junctionTable,
		queryLocal(junctionAlias),
		schemaName === undefined ? undefined : queryLocal(schemaName),
	);

	// Use innerJoin helper for proper typing
	const joinNode = innerJoin(targetRangeVar, junctionRangeVar, joinQuals);
	const fromClause = [joinNode];

	const selectAst: Node = {
		SelectStmt: {
			targetList: projection.targetList,
			...(projection.groupClause && { groupClause: projection.groupClause }),
			fromClause,
			whereClause,
		},
	};

	return compileIncludeSelectEnvelope(
		selectAst,
		info.targetTable,
		state.parameters,
		deps,
	);
}
