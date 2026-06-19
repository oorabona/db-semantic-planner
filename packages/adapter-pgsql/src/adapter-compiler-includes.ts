/**
 * Subquery-include compilation: compileSubqueryInclude + M:N variant.
 * Extracted from PgsqlAdapter.compileSubqueryInclude() and
 * PgsqlAdapter.compileSubqueryIncludeManyToMany().
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
import { innerJoin, rangeVar } from './ast-helpers.js';
import { deparseQuoted } from './deparse.js';
import { createCompilerState } from './handlers/index.js';

// ============================================================================
// compileSubqueryInclude
// ============================================================================

/**
 * Compile a subquery include query for given parent IDs (DX-033).
 * Generates: SELECT * FROM targetTable WHERE foreignKey IN ($1, $2, ...)
 * Extracted body of PgsqlAdapter.compileSubqueryInclude().
 */
export function compileSubqueryInclude(
	info: SubqueryIncludeInfo,
	parentIds: readonly unknown[],
	_options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;
	const state = createCompilerState();

	// Handle empty parent IDs - return query that returns no results
	if (parentIds.length === 0) {
		const tableName = schemaName
			? `"${deps.naming.toDatabase(schemaName)}"."${deps.naming.toDatabase(info.targetTable)}"`
			: `"${deps.naming.toDatabase(info.targetTable)}"`;

		return {
			sql: `SELECT * FROM ${tableName} WHERE FALSE`,
			parameters: [],
		};
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
	const targetList = [
		{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } },
	];

	// Build FROM clause
	const fromClause = [
		{
			RangeVar: {
				relname: deps.naming.toDatabase(info.targetTable),
				inh: true,
				relpersistence: 'p',
				...(schemaName && {
					schemaname: deps.naming.toDatabase(schemaName),
				}),
			},
		},
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
				lexpr: {
					ColumnRef: {
						fields: [
							{ String: { sval: deps.naming.toDatabase(fkColumns[0]!) } },
						],
					},
				},
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
						lexpr: {
							ColumnRef: {
								fields: [{ String: { sval: deps.naming.toDatabase(col) } }],
							},
						},
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
			targetList,
			fromClause,
			whereClause,
		},
	};

	const sql = deparseQuoted(selectAst);

	return {
		sql,
		parameters: state.parameters,
	};
}

// ============================================================================
// compileSubqueryIncludeManyToMany (internal)
// ============================================================================

/**
 * Compile M:N subquery include with junction table.
 * Extracted body of PgsqlAdapter.compileSubqueryIncludeManyToMany().
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

	// Determine target PK (usually 'id', but could be from sourceKey)
	const targetPkColumns = toColumnList(info.sourceKey);
	if (targetPkColumns.length !== 1) {
		throw new Error(
			`Many-to-many subquery include requires a single-column target key; got ${JSON.stringify(targetPkColumns)}.`,
		);
	}
	const targetPk = targetPkColumns[0]!;

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
			lexpr: {
				ColumnRef: {
					fields: [
						{ String: { sval: junctionAlias } },
						{ String: { sval: deps.naming.toDatabase(throughSourceKey) } },
					],
				},
			},
			rexpr: { List: { items: paramRefs } },
		},
	};

	// Build JOIN condition: t.pk = j.throughTargetKey
	const joinQuals: Node = {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: {
				ColumnRef: {
					fields: [
						{ String: { sval: targetAlias } },
						{ String: { sval: deps.naming.toDatabase(targetPk) } },
					],
				},
			},
			rexpr: {
				ColumnRef: {
					fields: [
						{ String: { sval: junctionAlias } },
						{ String: { sval: deps.naming.toDatabase(throughTargetKey) } },
					],
				},
			},
		},
	};

	// Build FROM clause with JOIN using helper functions
	const targetRangeVar = rangeVar(
		info.targetTable,
		targetAlias,
		schemaName,
		deps.naming,
	);

	const junctionRangeVar = rangeVar(
		throughTable,
		junctionAlias,
		schemaName,
		deps.naming,
	);

	// Use innerJoin helper for proper typing
	const joinNode = innerJoin(targetRangeVar, junctionRangeVar, joinQuals);
	const fromClause = [joinNode];

	// Build SELECT t.*
	const targetList = [
		{
			ResTarget: {
				val: {
					ColumnRef: {
						fields: [{ String: { sval: targetAlias } }, { A_Star: {} }],
					},
				},
			},
		},
	];

	const selectAst: Node = {
		SelectStmt: {
			targetList,
			fromClause,
			whereClause,
		},
	};

	const sql = deparseQuoted(selectAst);

	return {
		sql,
		parameters: state.parameters,
	};
}
