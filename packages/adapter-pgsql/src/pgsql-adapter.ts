/**
 * PgsqlAdapter - Implements the Adapter interface for PostgreSQL using native pg driver.
 *
 * This adapter wraps a pg Pool instance and provides the unified
 * adapter interface for the db-semantic-planner ORM.
 *
 * @module pgsql-adapter
 */

import type {
	Adapter,
	AdapterCapabilities,
	AdapterLogger,
	AdapterStreamOptions,
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
	DbCasing,
	DeleteIntent,
	Dump,
	DumpMeta,
	InsertFromIntent,
	InsertIntent,
	ModelIR,
	NamingConvention,
	PlanReport,
	RecursivePlanReport,
	SubqueryIncludeInfo,
	UpdateIntent,
	UpsertIntent,
} from '@dbsp/core';
import { toNamingConvention } from '@dbsp/core';
import type { Node, SelectStmt } from '@pgsql/types';
import type { Pool, PoolClient } from 'pg';
import { innerJoin, rangeVar } from './ast-helpers.js';
import {
	type CompilerOptions,
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
import {
	type GenerateDDLOptions,
	generateDDL as generateDDLStatements,
} from './ddl/index.js';
import { deparseQuoted } from './deparse.js';
import {
	type CompilerContext,
	createCompilerState,
	type Decision,
} from './handlers/index.js';
import { intentToDecisions } from './intent-to-decisions.js';
import {
	type IntrospectedModelIR,
	type IntrospectionOptions,
	introspect as introspectDb,
} from './introspection.js';
import {
	compileDelete as compileDeleteMutation,
	compileInsertFrom as compileInsertFromMutation,
	compileInsert as compileInsertMutation,
	compileUpdate as compileUpdateMutation,
	compileUpsert as compileUpsertMutation,
	type DeleteConfig,
	type InsertConfig,
	type InsertFromConfig,
	RANGE_TYPES,
	type UpdateConfig,
	type UpsertConfig,
} from './mutations/index.js';
import { getNamingPlugin, type NamingPlugin } from './naming-plugin.js';
import {
	convertDottedFieldsToExists,
	deriveForeignKey,
	extractExistsDecisions,
	extractJsonAggDecisions,
	extractLeftJoinIncludeDecisions,
	mapComparisonOperator,
	valueToNode,
} from './plan-decision-extractor.js';
import {
	buildRecursiveCte,
	type RecursiveCteConfig,
} from './recursive/index.js';
import { generateCursorName } from './streaming/cursor.js';
import { validateIdentifier } from './validate.js';

// ============================================================================
// Options
// ============================================================================

/**
 * Options for PgsqlAdapter.
 */
export interface PgsqlAdapterOptions {
	/** Schema name for multi-tenant queries */
	readonly schemaName?: string;
	/**
	 * DB column casing convention (intuitive semantics).
	 * - `'snake_case'`: DB columns are snake_case → transform to camelCase for JS
	 * - `'camelCase'`: DB columns are camelCase → no transformation
	 * - `'preserve'`: No transformation
	 * Preferred over `namingConvention`.
	 */
	readonly dbCasing?: DbCasing;
	/** @deprecated Use `dbCasing` instead. Legacy naming convention for identifier transformation */
	readonly namingConvention?: NamingConvention;
	/** Optional model for WHERE compilation */
	readonly model?: ModelIR;
	/** Optional logger for debug/error messages */
	readonly logger?: AdapterLogger;
}

// ============================================================================
// PgsqlAdapter
// ============================================================================

/**
 * Adapter implementation for PostgreSQL using native pg driver.
 *
 * @typeParam DB - Database schema type
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = createPgsqlAdapter(pool);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export class PgsqlAdapter<DB = unknown> implements Adapter<DB> {
	private readonly pool: Pool | undefined;
	private readonly client: PoolClient | undefined;
	private readonly schemaName: string | undefined;
	private readonly _namingConvention: NamingConvention;
	private readonly naming: NamingPlugin;
	private readonly model: ModelIR | undefined;
	private readonly logger: AdapterLogger | undefined;
	private readonly _capabilities: AdapterCapabilities;

	/**
	 * Create a new PgsqlAdapter.
	 *
	 * @param pool - pg.Pool instance, PoolClient (transactions), or undefined (compile-only mode)
	 * @param options - Optional configuration
	 */
	constructor(
		pool?: Pool | PoolClient | undefined,
		options?: PgsqlAdapterOptions,
	) {
		if (pool != null) {
			// Detect if this is a PoolClient (transaction context)
			if ('release' in pool && typeof pool.release === 'function') {
				this.client = pool as PoolClient;
				// For clients, we need to get the pool reference
				// This is a limitation - we'll use the client directly
				this.pool = pool as unknown as Pool;
			} else {
				this.pool = pool as Pool;
				this.client = undefined;
			}
		} else {
			// Compile-only mode — no pool/client
			this.pool = undefined;
			this.client = undefined;
		}

		this.schemaName = options?.schemaName;
		// Prefer dbCasing (intuitive) over legacy namingConvention
		this._namingConvention = options?.dbCasing
			? toNamingConvention(options.dbCasing)
			: (options?.namingConvention ?? 'preserve');
		this.naming = getNamingPlugin(this._namingConvention);
		this.model = options?.model;
		this.logger = options?.logger;

		// PostgreSQL capabilities — streaming requires a connection
		this._capabilities = {
			supportsReturning: true,
			supportsSchemas: true,
			supportsStreaming: pool != null,
			supportsRecursiveCTE: true,
			supportsWindowFunctions: true,
			supportsArrayType: true,
		};
	}

	/**
	 * Returns the pool/client executor, or throws if in compile-only mode.
	 */
	private requireConnection(): Pool | PoolClient {
		const executor = this.client ?? this.pool;
		if (!executor) {
			throw new Error(
				'PgsqlAdapter is in compile-only mode (no database connection). ' +
					'Use createPgsqlAdapter(pool) for a full adapter with execution capabilities.',
			);
		}
		return executor;
	}

	/** Adapter capabilities for feature detection */
	get capabilities(): AdapterCapabilities {
		return this._capabilities;
	}

	/**
	 * Naming convention used by this adapter.
	 */
	get namingConvention(): NamingConvention {
		return this._namingConvention;
	}

	/**
	 * Get the underlying pg Pool instance.
	 */
	getPoolInstance(): Pool {
		return this.requireConnection() as Pool;
	}

	// =========================================================================
	// Private Helpers
	// =========================================================================

	/**
	 * Build a column-type map for a table, filtered to only columns
	 * whose type requires explicit type-casting (e.g. range types).
	 * Returns undefined if no type-cast columns are found (or model unavailable).
	 */
	private getColumnTypes(
		tableName: string,
		columns: string[],
	): Record<string, string> | undefined {
		if (!this.model) return undefined;
		const table = this.model.getTable(tableName);
		if (!table) return undefined;
		let result: Record<string, string> | undefined;
		for (const col of columns) {
			const columnIR = table.columns.find((c) => c.name === col);
			if (columnIR && RANGE_TYPES.has(columnIR.type)) {
				result ??= {};
				result[col] = columnIR.type;
			}
		}
		return result;
	}

	// =========================================================================
	// CompilingAdapter Methods
	// =========================================================================

	/**
	 * Compile a plan to executable SQL.
	 */
	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T> {
		const schemaName = this.schemaName ?? options?.schemaName;

		const compilerOptions: CompilerOptions = schemaName
			? { naming: this.naming, schema: schemaName }
			: { naming: this.naming };

		// Convert PlanReport (core) → SimplifiedPlanReport (pgsql compiler)
		// The core's plan.decisions contain observability data, not SQL instructions.
		// The actual query structure is in plan.intent (QueryIntent).
		// Note: For unit tests with mock plans (no intent), fall back to plan.decisions directly.
		let simplifiedPlan: SimplifiedPlanReport;

		if (plan.intent) {
			// Real usage: convert intent to decisions
			let decisions = intentToDecisions(plan.intent, plan.rootTable);

			// Filter out broken EXISTS decisions from intentToDecisions
			// (they use relation name as targetTable instead of actual table name)
			decisions = decisions.filter(
				(d) =>
					!(
						d.type === 'where' &&
						(d.operator === 'exists' || d.operator === 'notExists')
					),
			);

			// Convert dotted-field comparisons (e.g., "parent.name") to EXISTS subqueries
			// NQL compiles relation-path filters as plain comparisons with dotted field names
			const resolvedModel = options?.model ?? this.model;
			if (resolvedModel) {
				decisions = convertDottedFieldsToExists(
					decisions,
					plan.rootTable,
					resolvedModel,
				);
			}

			// Add correct EXISTS decisions from planner's filter-strategy decisions
			// (they have the actual target table in context.target)
			const existsDecisions = extractExistsDecisions(plan, options?.model);

			// Phase 3: Add selectJsonAgg decisions for json_agg include strategies
			// Look at plan.decisions (from planner) for include-strategy with choice: 'json_agg'
			const jsonAggDecisions = extractJsonAggDecisions(plan);

			// Phase 3 (F-006): Add LEFT JOIN include decisions for to-one relations
			const leftJoinIncludeDecisions = extractLeftJoinIncludeDecisions(plan);

			// Propagate filter conditions from EXISTS to matching json_agg decisions
			// When a relation is both filtered and included, the filter should appear
			// in both the EXISTS subquery AND the json_agg subquery
			const enrichedJsonAggDecisions = jsonAggDecisions.map((jd) => {
				if (jd.type !== 'selectJsonAgg' || !jd.relationName) return jd;

				// Check planner-derived EXISTS decisions
				// Match by relationName OR targetTable (planner may resolve aliases differently)
				const matchingExists = existsDecisions.find(
					(ed) =>
						ed.type === 'where' &&
						(ed.operator === 'exists' || ed.operator === 'notExists') &&
						(ed.relationName === jd.relationName ||
							ed.targetTable === jd.targetTable) &&
						ed.conditions &&
						(ed.conditions as PlanDecision[]).length > 0,
				);

				if (matchingExists?.conditions) {
					return { ...jd, conditions: matchingExists.conditions };
				}
				return jd;
			});

			const allDecisions = [
				...decisions,
				...existsDecisions,
				...enrichedJsonAggDecisions,
				...leftJoinIncludeDecisions,
			];

			// Enrich range operator decisions with dataType from model
			// (PostgreSQL requires explicit type casts for range parameters)
			const model = options?.model;
			if (model) {
				for (let i = 0; i < allDecisions.length; i++) {
					const d = allDecisions[i];
					if (
						d &&
						d.type === 'where' &&
						(d.operator === 'contains' ||
							d.operator === 'containedBy' ||
							d.operator === 'overlaps')
					) {
						const tableName = d.table || plan.rootTable;
						const table = model.getTable(tableName);
						if (table) {
							const col = table.columns.find((c) => c.name === d.column);
							if (col?.type.endsWith('range')) {
								allDecisions[i] = {
									...d,
									dataType: col.type,
								} as typeof d;
							}
						}
					}
				}
			}

			simplifiedPlan = schemaName
				? {
						rootTable: plan.rootTable,
						decisions: allDecisions,
						schema: schemaName,
					}
				: { rootTable: plan.rootTable, decisions: allDecisions };
		} else {
			// Unit test with mock data: use decisions directly (legacy format)
			simplifiedPlan = schemaName
				? {
						rootTable: plan.rootTable,
						decisions:
							plan.decisions as unknown as SimplifiedPlanReport['decisions'],
						schema: schemaName,
					}
				: {
						rootTable: plan.rootTable,
						decisions:
							plan.decisions as unknown as SimplifiedPlanReport['decisions'],
					};
		}

		const result = compilePlan(simplifiedPlan, compilerOptions);

		return {
			sql: result.sql,
			parameters: result.parameters,
		};
	}

	/**
	 * Compile a plan with includes, returning subquery include metadata (DX-033).
	 * @stub Phase 3 - Include support
	 */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T> {
		const main = this.compile<T>(plan, options);

		// Extract subquery include info from planner decisions
		// Decisions with choice === 'subquery' need separate execution
		const subqueryIncludes: SubqueryIncludeInfo[] = [];

		for (const d of plan.decisions) {
			if (d.type !== 'include-strategy' || d.choice !== 'subquery') continue;

			const ctx = d.context;
			if (!ctx.target) continue;

			const relationName = ctx.includeAlias ?? ctx.relation;
			if (!relationName) continue;

			// Derive FK using shared helper
			const rawFk = deriveForeignKey(ctx) ?? 'id';
			const fk = Array.isArray(rawFk) ? rawFk[0]! : rawFk;

			// For subquery include, we need:
			// - sourceKey: column on the parent result to extract IDs from
			// - foreignKey: column on the target table to match via WHERE ... IN
			//
			// belongsTo (posts → author): FK=authorId is on source.
			//   Extract authorId from parents → SELECT * FROM authors WHERE id IN (...)
			//   sourceKey=authorId, foreignKey=id (target PK)
			//
			// hasMany (authors → posts): FK=authorId is on target.
			//   Extract id from parents → SELECT * FROM posts WHERE author_id IN (...)
			//   sourceKey=id, foreignKey=authorId (target FK)
			const isBelongsTo = ctx.relationType === 'belongsTo';
			const sourceKey = isBelongsTo ? fk : 'id';
			const targetFk = isBelongsTo ? 'id' : fk;

			// Find matching include intent for select/where passthrough
			const includeIntent = (
				plan.intent?.include as Array<Record<string, unknown>> | undefined
			)?.find(
				(i) => i.relation === relationName || i.relation === ctx.includeAlias,
			);

			const entry: SubqueryIncludeInfo = {
				relationName,
				targetTable: ctx.target,
				foreignKey: targetFk,
				sourceKey,
				sourceTable: ctx.sourceTable ?? plan.rootTable,
			};
			if (typeof ctx.relationType === 'string') {
				(entry as unknown as Record<string, unknown>).relationType =
					ctx.relationType;
			}
			if (includeIntent?.select != null) {
				(entry as { select: SubqueryIncludeInfo['select'] }).select =
					includeIntent.select as SubqueryIncludeInfo['select'];
			}
			if (includeIntent?.where != null) {
				(entry as { where: SubqueryIncludeInfo['where'] }).where =
					includeIntent.where as SubqueryIncludeInfo['where'];
			}
			subqueryIncludes.push(entry);
		}

		return { main, subqueryIncludes };
	}

	/**
	 * Compile a subquery include query for given parent IDs (DX-033).
	 * Generates: SELECT * FROM targetTable WHERE foreignKey IN ($1, $2, ...)
	 *
	 * @param info - Subquery include metadata
	 * @param parentIds - Parent record IDs to fetch related records for
	 * @param options - Compile options
	 * @returns Compiled query for fetching related records
	 */
	compileSubqueryInclude(
		info: SubqueryIncludeInfo,
		parentIds: readonly unknown[],
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;
		const state = createCompilerState();

		// Handle empty parent IDs - return query that returns no results
		if (parentIds.length === 0) {
			const tableName = schemaName
				? `"${this.naming.toDatabase(schemaName)}"."${this.naming.toDatabase(info.targetTable)}"`
				: `"${this.naming.toDatabase(info.targetTable)}"`;

			return {
				sql: `SELECT * FROM ${tableName} WHERE FALSE`,
				parameters: [],
			};
		}

		// Determine FK column(s)
		const fkColumns = Array.isArray(info.foreignKey)
			? info.foreignKey
			: [info.foreignKey];

		// For M:N relations with junction table
		if (info.through && info.throughSourceKey && info.throughTargetKey) {
			return this.compileSubqueryIncludeManyToMany(
				info,
				parentIds,
				schemaName,
				state,
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
					relname: this.naming.toDatabase(info.targetTable),
					inh: true,
					relpersistence: 'p',
					...(schemaName && {
						schemaname: this.naming.toDatabase(schemaName),
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
								{ String: { sval: this.naming.toDatabase(fkColumns[0]!) } },
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
				const idValues = id as unknown[];
				const colConditions = fkColumns.map((col, idx) => {
					state.parameters.push(idValues[idx]);
					state.paramIndex++;
					return {
						A_Expr: {
							kind: 'AEXPR_OP',
							name: [{ String: { sval: '=' } }],
							lexpr: {
								ColumnRef: {
									fields: [{ String: { sval: this.naming.toDatabase(col) } }],
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

	/**
	 * Internal: Compile M:N subquery include with junction table.
	 */
	private compileSubqueryIncludeManyToMany(
		info: SubqueryIncludeInfo,
		parentIds: readonly unknown[],
		schemaName: string | undefined,
		state: ReturnType<typeof createCompilerState>,
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
		const targetPk = Array.isArray(info.sourceKey)
			? info.sourceKey[0]!
			: info.sourceKey;

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
							{ String: { sval: this.naming.toDatabase(throughSourceKey) } },
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
							{ String: { sval: this.naming.toDatabase(targetPk) } },
						],
					},
				},
				rexpr: {
					ColumnRef: {
						fields: [
							{ String: { sval: junctionAlias } },
							{ String: { sval: this.naming.toDatabase(throughTargetKey) } },
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
			this.naming,
		);

		const junctionRangeVar = rangeVar(
			throughTable,
			junctionAlias,
			schemaName,
			this.naming,
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

	/**
	 * Compile an insert intent to executable SQL.
	 */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert InsertIntent to InsertConfig
		// Extract columns and values from intent
		const firstRow = intent.values?.[0] ?? {};
		const columns = Object.keys(firstRow);
		const values = (intent.values ?? []).map((row) =>
			columns.map((col) => row[col]),
		);

		const columnTypes = this.getColumnTypes(intent.table, columns);

		const config: InsertConfig = {
			table: intent.table,
			columns,
			values,
			...(intent.returning && { returning: [...intent.returning] }),
			...(columnTypes && { columnTypes }),
		};

		const ast = compileInsertMutation(config, ctx, state);
		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile an insert-from intent to executable SQL (NQL-ALIGN).
	 * INSERT INTO target (cols) SELECT cols FROM source WHERE ... LIMIT ... RETURNING ...
	 */
	compileInsertFrom(
		intent: InsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.source, // Source table for WHERE compilation
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert InsertFromIntent to InsertFromConfig
		const config: InsertFromConfig = {
			targetTable: intent.table,
			sourceTable: intent.source,
			...(intent.columns && { columns: [...intent.columns] }),
			...(intent.where && { where: [intent.where as unknown as Decision] }),
			...(intent.limit !== undefined && { limit: intent.limit }),
			...(intent.returning && { returning: [...intent.returning] }),
		};

		const ast = compileInsertFromMutation(config, ctx, state);
		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile an update intent to executable SQL.
	 */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert UpdateIntent to UpdateConfig
		const setColumns = Object.keys(intent.set ?? {});
		const columnTypes = this.getColumnTypes(intent.table, setColumns);

		const config: UpdateConfig = {
			table: intent.table,
			set: Object.entries(intent.set ?? {}).map(([column, value]) => ({
				column,
				value,
			})),
			...(intent.where && { where: [intent.where as any] }),
			...(intent.returning && { returning: [...intent.returning] }),
			...(columnTypes && { columnTypes }),
		};

		const ast = compileUpdateMutation(config, ctx, state);
		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile a delete intent to executable SQL.
	 */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert DeleteIntent to DeleteConfig
		const config: DeleteConfig = {
			table: intent.table,
			...(intent.where && { where: [intent.where as any] }),
			...(intent.returning && { returning: [...intent.returning] }),
		};

		const ast = compileDeleteMutation(config, ctx, state);
		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile an upsert intent to executable SQL (DX-026).
	 */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert UpsertIntent to UpsertConfig
		// Extract columns and values from intent
		const firstRow = intent.values?.[0] ?? {};

		// If explicit set values are provided for doUpdate, merge them into insert values
		// so that EXCLUDED.column references have the correct values
		const mergedFirstRow =
			intent.action.type === 'doUpdate' && intent.action.set
				? { ...firstRow, ...intent.action.set }
				: firstRow;

		const columns = Object.keys(mergedFirstRow);
		const values = (intent.values ?? []).map((row) => {
			const mergedRow =
				intent.action.type === 'doUpdate' && intent.action.set
					? { ...row, ...intent.action.set }
					: row;
			return columns.map((col) => mergedRow[col]);
		});

		// Build conflict target
		const conflictTarget: {
			columns?: string[];
			constraint?: string;
		} = {};

		if ('columns' in intent.onConflict) {
			conflictTarget.columns = [...intent.onConflict.columns];
		} else if ('constraint' in intent.onConflict) {
			conflictTarget.constraint = intent.onConflict.constraint;
		}

		// Build conflict action
		const conflictAction: 'nothing' | 'update' =
			intent.action.type === 'doNothing' ? 'nothing' : 'update';

		// Determine update columns
		let updateColumns: string[] | undefined;
		if (intent.action.type === 'doUpdate') {
			if (intent.action.set) {
				// Explicit update columns from set
				// Values were merged into INSERT VALUES above, so EXCLUDED.column will reference them
				updateColumns = Object.keys(intent.action.set);
			} else {
				// Default: update all non-conflict columns
				const conflictCols =
					'columns' in intent.onConflict ? intent.onConflict.columns : [];
				updateColumns = columns.filter((col) => !conflictCols.includes(col));
			}
		}

		const config: UpsertConfig = {
			table: intent.table,
			columns,
			values,
			conflictTarget,
			conflictAction,
			...(updateColumns && { updateColumns }),
			...(intent.returning && { returning: [...intent.returning] }),
		};

		const ast = compileUpsertMutation(config, ctx, state);
		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile a recursive CTE plan to executable SQL.
	 * Supports adjacency-list and edge-table traversal modes.
	 */
	compileRecursive(
		report: RecursivePlanReport,
		_model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;
		const intent = report.intent;
		const traversal = intent.traversal;

		const trackPath = intent.track?.path !== undefined;
		const trackDepth = intent.track?.depth !== undefined;

		let config: RecursiveCteConfig;

		if (traversal.kind === 'edge-table') {
			const table = traversal.nodeTable;
			const pkColumn = traversal.nodeId;
			const ctx: CompilerContext = {
				naming: this.naming,
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
				? this.buildRecursiveAnchorWhere(intent.start.where, '__n')
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
				naming: this.naming,
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
			throw new Error(
				`PgsqlAdapter.compileRecursive: Unsupported traversal kind '${(traversal as any).kind}'`,
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
							{ String: { sval: this.naming.toDatabase(col) } },
						],
					},
				},
				name: this.naming.toDatabase(col),
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

	/**
	 * Build an anchor WHERE clause AST node from a WhereIntent.
	 * Used for edge-table recursive CTE anchor queries.
	 */
	private buildRecursiveAnchorWhere(where: unknown, tableAlias: string): Node {
		if (!where || typeof where !== 'object') {
			return { A_Const: { boolval: { boolval: true } } };
		}
		const w = where as Record<string, unknown>;

		switch (w.kind) {
			case 'comparison': {
				const dbCol = this.naming.toDatabase(w.field as string);
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
					this.buildRecursiveAnchorWhere(c, tableAlias),
				);
				if (conditions.length === 1) return conditions[0]!;
				return { BoolExpr: { boolop: 'AND_EXPR', args: conditions } };
			}
			case 'or': {
				const conditions = (w.conditions as unknown[]).map((c) =>
					this.buildRecursiveAnchorWhere(c, tableAlias),
				);
				if (conditions.length === 1) return conditions[0]!;
				return { BoolExpr: { boolop: 'OR_EXPR', args: conditions } };
			}
			default:
				return { A_Const: { boolval: { boolval: true } } };
		}
	}

	/**
	 * Create a dump for observability.
	 */
	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump {
		return {
			plan,
			sql: query.sql,
			params: query.parameters,
			meta: {
				...(this.schemaName !== undefined && { schema: this.schemaName }),
				compiledAt: new Date(),
				...meta,
			},
		};
	}

	// =========================================================================
	// ExecutingAdapter Methods
	// =========================================================================

	/**
	 * Execute a query and return all results.
	 * Results are transformed to use model naming convention (e.g., snake_case → camelCase)
	 */
	async execute<T>(query: CompiledQuery<T>): Promise<T[]> {
		const executor = this.requireConnection();
		const result = await executor.query(query.sql, query.parameters as any[]);
		return this.transformResultRows(result.rows) as T[];
	}

	/**
	 * Transform result rows from database naming to model naming convention.
	 * For CamelCaseNamingPlugin: price_cents → priceCents
	 */
	private transformResultRows(
		rows: Record<string, unknown>[],
	): Record<string, unknown>[] {
		return rows.map((row) => {
			const transformed: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				// Use toModel to convert database column name to model column name
				const modelKey = this.naming.toModel(key);
				transformed[modelKey] = value;
			}
			return transformed;
		});
	}

	/**
	 * Execute a query and return the first result or null.
	 */
	async executeOne<T>(query: CompiledQuery<T>): Promise<T | null> {
		const results = await this.execute<T>(query);
		return results[0] ?? null;
	}

	/**
	 * Execute a query and return the first result or throw.
	 */
	async executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T> {
		const result = await this.executeOne<T>(query);
		if (result === null) {
			throw new Error('No results found');
		}
		return result;
	}

	// =========================================================================
	// StreamingAdapter Methods
	// =========================================================================

	/**
	 * Stream query results as an async iterable iterator.
	 * Uses PostgreSQL cursors for efficient streaming.
	 *
	 * Note: The cursor must be used within a transaction. If not already
	 * in a transaction, this method wraps the streaming in one.
	 *
	 * @param query - Compiled query to stream
	 * @param options - Stream options (chunkSize)
	 * @returns AsyncIterableIterator that yields rows one by one
	 */
	stream<T>(
		query: CompiledQuery<T>,
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		const chunkSize = options?.chunkSize ?? 100;
		const adapter = this;

		// Use a wrapper to create the async generator
		async function* streamGenerator(): AsyncIterableIterator<T> {
			// If already in transaction (has client), use it directly
			if (adapter.client) {
				yield* adapter.streamWithClient<T>(adapter.client, query, chunkSize);
				return;
			}

			// Otherwise, acquire a client and create a transaction
			const pool = adapter.requireConnection() as Pool;
			const client = await pool.connect();
			let committed = false;
			try {
				await client.query('BEGIN');
				yield* adapter.streamWithClient<T>(client, query, chunkSize);
				await client.query('COMMIT');
				committed = true;
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				// On early break, yield* returns without reaching COMMIT.
				// ROLLBACK the open transaction to avoid leaking it to the pool.
				if (!committed) {
					try {
						await client.query('ROLLBACK');
					} catch (rollbackErr) {
						// Rollback errors during cleanup are non-actionable;
						// the connection returns to the pool regardless.
						adapter.logger?.debug?.(
							'Rollback failed during cleanup',
							rollbackErr,
						);
					}
				}
				client.release();
			}
		}

		return streamGenerator();
	}

	/**
	 * Internal: Stream with an existing client using cursors.
	 */
	private async *streamWithClient<T>(
		client: PoolClient,
		query: CompiledQuery<T>,
		chunkSize: number,
	): AsyncIterableIterator<T> {
		// Generate unique cursor name
		const cursorName = generateCursorName();

		// Declare cursor
		await client.query(
			`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query.sql}`,
			query.parameters as unknown[],
		);

		try {
			// Fetch in batches
			while (true) {
				const result = await client.query(
					`FETCH FORWARD ${chunkSize} FROM ${cursorName}`,
				);

				if (result.rows.length === 0) {
					break;
				}

				for (const row of result.rows) {
					yield row as T;
				}

				// If we got fewer rows than batch size, we're done
				if (result.rows.length < chunkSize) {
					break;
				}
			}
		} finally {
			// Always close the cursor
			await client.query(`CLOSE ${cursorName}`);
		}
	}

	// =========================================================================
	// IntrospectingAdapter Methods
	// =========================================================================

	/**
	 * Introspect the database schema and return a ModelIR.
	 *
	 * @param options - Optional introspection options (schema, include/exclude filters)
	 * @returns IntrospectedModelIR with tables, relations, and hierarchy metadata
	 *
	 * @example
	 * ```typescript
	 * const model = await adapter.introspect();
	 * const model = await adapter.introspect({ schema: 'tenant_1' });
	 * const model = await adapter.introspect({ exclude: ['_prisma*'] });
	 * ```
	 */
	async introspect(
		options?: IntrospectionOptions,
	): Promise<IntrospectedModelIR> {
		if (!this.pool) {
			throw new Error(
				'Cannot introspect without a database connection (compile-only adapter)',
			);
		}
		return introspectDb(this.pool, options);
	}

	// =========================================================================
	// TransactionalAdapter Methods
	// =========================================================================

	/**
	 * Execute a callback within a database transaction.
	 */
	async transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T> {
		// If already in a transaction (this.client exists), reuse it
		if (this.client) {
			return fn(this);
		}

		// Otherwise, acquire a client and start transaction
		const pool = this.requireConnection() as Pool;
		const client = await pool.connect();
		try {
			await client.query('BEGIN');

			// Create transaction-scoped adapter
			const txOptions: PgsqlAdapterOptions = {
				...(this.schemaName !== undefined && { schemaName: this.schemaName }),
				...(this._namingConvention !== undefined && {
					namingConvention: this._namingConvention,
				}),
				...(this.model !== undefined && { model: this.model }),
			};
			const txAdapter = new PgsqlAdapter<DB>(client, txOptions);

			const result = await fn(txAdapter);

			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * Create a schema-scoped adapter for multi-tenant queries.
	 */
	withSchema(schemaName: string): Adapter<DB> {
		// Validate schema name
		validateIdentifier(schemaName, 'schema');

		// Create new adapter with schema scope
		const options: PgsqlAdapterOptions = {
			schemaName,
			...(this._namingConvention !== undefined && {
				namingConvention: this._namingConvention,
			}),
			...(this.model !== undefined && { model: this.model }),
		};
		return new PgsqlAdapter<DB>(this.client ?? this.pool ?? undefined, options);
	}

	// =========================================================================
	// RawSqlAdapter Methods
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 *
	 * ⚠️  WARNING: Use parameter placeholders ($1, $2, etc.) for all values.
	 */
	async executeRaw<T = unknown>(
		sql: string,
		parameters: readonly unknown[] = [],
	): Promise<T[]> {
		const executor = this.requireConnection();
		const result = await executor.query(sql, parameters as any[]);
		return result.rows as T[];
	}

	// =========================================================================
	// DDLGeneratingAdapter Methods
	// =========================================================================

	/**
	 * Generate DDL statements from a ModelIR schema.
	 *
	 * Uses PostgreSQL AST nodes and pgsql-deparser for consistent SQL generation.
	 * Applies the naming plugin for identifier transformation.
	 *
	 * @param schema - The ModelIR schema to generate DDL from
	 * @returns Array of DDL statements in dependency order
	 */
	generateDDL(schema: ModelIR): string[] {
		const options: GenerateDDLOptions = {
			...(this.schemaName ? { schemaName: this.schemaName } : {}),
			naming: this.naming,
		};
		return generateDDLStatements(schema, options);
	}

	// =========================================================================
	// Validation
	// =========================================================================

	/**
	 * Validate an identifier (table name, column name, schema name).
	 */
	validateIdentifier(value: string, type: string): void {
		// Cast to expected type union
		const identifierType = type as 'table' | 'column' | 'schema' | 'alias';
		validateIdentifier(value, identifierType);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a PgsqlAdapter from a pg Pool instance.
 *
 * @param pool - pg Pool instance
 * @param options - Optional configuration
 * @returns A new PgsqlAdapter instance
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = createPgsqlAdapter(pool);
 *
 * // With naming convention
 * const adapter = createPgsqlAdapter(pool, { namingConvention: 'camelCase' });
 * ```
 */
export function createPgsqlAdapter<DB = unknown>(
	pool: Pool,
	options?: PgsqlAdapterOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(pool, options);
}

/**
 * Creates a compile-only PgsqlAdapter for SQL generation without a database connection.
 *
 * All compilation methods (compile, compileInsert, etc.), createDump(), and generateDDL()
 * work normally. Execution methods (execute, stream, transaction, etc.) throw an error.
 *
 * @example
 * ```typescript
 * import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
 * import { createOrm } from '@dbsp/core';
 *
 * const adapter = createPgsqlCompileOnlyAdapter();
 * const orm = createOrm({ model, adapter });
 * const dump = await orm.select('users').dump();
 * console.log(dump.sql);
 * ```
 */
export function createPgsqlCompileOnlyAdapter<DB = unknown>(
	options?: PgsqlAdapterOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(undefined, options);
}
