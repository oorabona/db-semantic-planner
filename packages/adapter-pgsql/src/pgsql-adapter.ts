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
	AdapterStreamOptions,
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
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
	compileDelete as compileDeleteMutation,
	compileInsertFrom as compileInsertFromMutation,
	compileInsert as compileInsertMutation,
	compileUpdate as compileUpdateMutation,
	compileUpsert as compileUpsertMutation,
	type DeleteConfig,
	type InsertConfig,
	type InsertFromConfig,
	type UpdateConfig,
	type UpsertConfig,
} from './mutations/index.js';
import { getNamingPlugin, type NamingPlugin } from './naming-plugin.js';
import {
	buildRecursiveCte,
	type RecursiveCteConfig,
} from './recursive/index.js';
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
	/** Naming convention for identifier transformation */
	readonly namingConvention?: NamingConvention;
	/** Optional model for WHERE compilation */
	readonly model?: ModelIR;
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
	private readonly pool: Pool;
	private readonly client: PoolClient | undefined;
	private readonly schemaName: string | undefined;
	private readonly _namingConvention: NamingConvention;
	private readonly naming: NamingPlugin;
	private readonly model: ModelIR | undefined;
	private readonly _capabilities: AdapterCapabilities;

	/**
	 * Create a new PgsqlAdapter.
	 *
	 * @param pool - pg.Pool instance or PoolClient (for transactions)
	 * @param options - Optional configuration
	 */
	constructor(pool: Pool | PoolClient, options?: PgsqlAdapterOptions) {
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

		this.schemaName = options?.schemaName;
		this._namingConvention = options?.namingConvention ?? 'preserve';
		this.naming = getNamingPlugin(this._namingConvention);
		this.model = options?.model;

		// PostgreSQL capabilities - all features supported
		this._capabilities = {
			supportsReturning: true,
			supportsSchemas: true,
			supportsStreaming: true,
			supportsRecursiveCTE: true,
			supportsWindowFunctions: true,
			supportsArrayType: true,
		};
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
		return this.pool;
	}

	// =========================================================================
	// Private Helpers
	// =========================================================================

	/**
	 * Extract selectJsonAgg decisions from plan.decisions for json_agg include strategies.
	 * These are added to the compiler decisions to generate COALESCE(json_agg(...)) SELECT columns.
	 */
	private extractJsonAggDecisions(
		plan: PlanReport,
	): SimplifiedPlanReport['decisions'] {
		// Find include-strategy decisions with choice: 'json_agg'
		const jsonAggIncludeDecisions = plan.decisions.filter(
			(d) => d.type === 'include-strategy' && d.choice === 'json_agg',
		);

		if (jsonAggIncludeDecisions.length === 0) {
			return [];
		}

		// Convert to selectJsonAgg decisions for the compiler
		const results: PlanDecision[] = [];

		for (const d of jsonAggIncludeDecisions) {
			const context = d.context;
			// Skip if target table or relation name is not defined
			// Must match hydrator order: includeAlias takes precedence over relation
			const relationName = context.includeAlias ?? context.relation;
			if (!context.target || !relationName) continue;

			// Cast context to access foreignKey (added in Phase 3)
			const extendedContext = context as typeof context & {
				foreignKey?: string | readonly string[];
			};

			// Derive FK name if not explicitly provided
			// For belongsTo: FK is in source (e.g., posts.authorId -> authors)
			// For hasMany/hasOne: FK is in target (e.g., authors -> posts.authorId)
			let foreignKey: string | readonly string[] | undefined =
				extendedContext.foreignKey;
			if (!foreignKey && context.relationType) {
				if (context.relationType === 'belongsTo') {
					// FK in source points to target's PK
					foreignKey = `${context.target.replace(/s$/, '')}Id`;
				} else {
					// FK in target points to source's PK
					foreignKey = `${context.sourceTable.replace(/s$/, '')}Id`;
				}
			}

			// Resolve relationType with default fallback
			const relationType = context.relationType as
				| 'belongsTo'
				| 'hasMany'
				| 'hasOne'
				| undefined;

			results.push({
				type: 'selectJsonAgg',
				relationName,
				targetTable: context.target,
				...(relationType && { relationType }),
				foreignKey: Array.isArray(foreignKey)
					? foreignKey[0]
					: (foreignKey ?? 'id'),
				parentKey: 'id', // Default to 'id' as PK - could be enhanced later
			});
		}

		return results;
	}

	/**
	 * Extract WHERE EXISTS/NOT EXISTS decisions from plan.decisions.
	 * The planner's filter-strategy decisions contain the correct target table,
	 * while intentToDecisions only has the relation name.
	 * Also processes nested conditions from the intent with the correct target table.
	 */
	private extractExistsDecisions(
		plan: PlanReport,
		model?: ModelIR,
	): SimplifiedPlanReport['decisions'] {
		// Find filter-strategy decisions with choice: 'exists' or 'notExists'
		const existsFilterDecisions = plan.decisions.filter(
			(d) =>
				d.type === 'filter-strategy' &&
				(d.choice === 'exists' || d.choice === 'notExists'),
		);

		if (existsFilterDecisions.length === 0) {
			return [];
		}

		// Helper to find exists/notExists intents in the where clause
		const findExistsIntents = (
			where: unknown,
		): Array<{
			kind: 'exists' | 'notExists';
			relation: string;
			where?: unknown;
		}> => {
			if (!where || typeof where !== 'object') return [];
			const w = where as Record<string, unknown>;
			if (w.kind === 'exists' || w.kind === 'notExists') {
				return [
					w as {
						kind: 'exists' | 'notExists';
						relation: string;
						where?: unknown;
					},
				];
			}
			// Check nested and/or/not conditions
			const results: Array<{
				kind: 'exists' | 'notExists';
				relation: string;
				where?: unknown;
			}> = [];
			if (w.conditions && Array.isArray(w.conditions)) {
				for (const c of w.conditions) {
					results.push(...findExistsIntents(c));
				}
			}
			if (w.condition) {
				results.push(...findExistsIntents(w.condition));
			}
			return results;
		};

		// Find all exists intents from the plan's where clause
		const existsIntents = plan.intent?.where
			? findExistsIntents(plan.intent.where)
			: [];

		// Convert to where decisions for the compiler
		const results: PlanDecision[] = [];

		for (const d of existsFilterDecisions) {
			const context = d.context;
			// Skip if target table is not defined
			if (!context.target) continue;

			// Find the matching intent to get nested conditions
			// Match by relation name or target table (planner may normalize relation names)
			const matchingIntent = existsIntents.find(
				(i) =>
					i.relation === context.relation ||
					i.relation === context.target ||
					i.relation === context.includeAlias,
			);

			// Build nested conditions with correct target table
			let conditions: PlanDecision[] | undefined;
			if (matchingIntent?.where) {
				// Convert nested where using the CORRECT target table
				const nestedDecisions = this.convertWhereToDecisions(
					matchingIntent.where,
					context.target,
				);
				if (nestedDecisions.length > 0) {
					conditions = nestedDecisions;
				}
			}

			// Resolve FK from model relation if available
			// Convention fallback (deriveFK) doesn't work for aliased relations
			// e.g., bundleComponents.bundleId → products (inverse: 'components')
			let foreignKey: string | undefined;
			if (model && context.relation) {
				const sourceTable = context.sourceTable || plan.rootTable;
				const rel = model.getRelation(`${sourceTable}.${context.relation}`);
				if (rel?.foreignKey) {
					foreignKey = typeof rel.foreignKey === 'string'
						? rel.foreignKey
						: rel.foreignKey[0];
				}
			}

			const decision: PlanDecision = {
				type: 'where',
				// d.choice is always 'exists' (planner doesn't distinguish); use intent.kind for negation
				operator: matchingIntent?.kind === 'notExists' ? 'notExists' : 'exists',
				targetTable: context.target,
				...(foreignKey && { foreignKey }),
				...(conditions && { conditions }),
			};
			results.push(decision);
		}

		return results;
	}

	/**
	 * Convert a WhereIntent to PlanDecisions with the given table name.
	 * Used for nested conditions in EXISTS where we need the correct target table.
	 */
	private convertWhereToDecisions(
		where: unknown,
		table: string,
	): PlanDecision[] {
		if (!where || typeof where !== 'object') return [];
		const w = where as Record<string, unknown>;

		switch (w.kind) {
			case 'comparison':
				return [
					{
						type: 'where',
						column: w.field as string,
						operator: w.operator as string,
						value: w.value,
						table,
					},
				];
			case 'and': {
				const conditions = w.conditions as unknown[];
				const subDecisions = conditions.flatMap((c) =>
					this.convertWhereToDecisions(c, table),
				);
				if (subDecisions.length === 0) return [];
				if (subDecisions.length === 1) return subDecisions;
				return [{ type: 'whereAnd', conditions: subDecisions }];
			}
			case 'or': {
				const conditions = w.conditions as unknown[];
				const subDecisions = conditions.flatMap((c) =>
					this.convertWhereToDecisions(c, table),
				);
				if (subDecisions.length === 0) return [];
				if (subDecisions.length === 1) return subDecisions;
				return [{ type: 'whereOr', conditions: subDecisions }];
			}
			case 'not': {
				const subDecisions = this.convertWhereToDecisions(w.condition, table);
				if (subDecisions.length === 0) return [];
				return [{ type: 'whereNot', conditions: subDecisions }];
			}
			default:
				return [];
		}
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

			// Add correct EXISTS decisions from planner's filter-strategy decisions
			// (they have the actual target table in context.target)
			const existsDecisions = this.extractExistsDecisions(plan, options?.model);

			// Phase 3: Add selectJsonAgg decisions for json_agg include strategies
			// Look at plan.decisions (from planner) for include-strategy with choice: 'json_agg'
			const jsonAggDecisions = this.extractJsonAggDecisions(plan);
			const allDecisions = [
			...decisions,
			...existsDecisions,
			...jsonAggDecisions,
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
						const col = table.columns.find(
							(c) => c.name === d.column,
						);
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
		// Phase 3: Implement include compilation
		// For now, compile main query and return empty subqueryIncludes
		const main = this.compile<T>(plan, options);
		return {
			main,
			subqueryIncludes: [],
		};
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

		// Build table name
		const _tableName = schemaName
			? `"${this.naming.toDatabase(schemaName)}"."${this.naming.toDatabase(info.targetTable)}"`
			: `"${this.naming.toDatabase(info.targetTable)}"`;

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

		const config: InsertConfig = {
			table: intent.table,
			columns,
			values,
			...(intent.returning && { returning: [...intent.returning] }),
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
		const config: UpdateConfig = {
			table: intent.table,
			set: Object.entries(intent.set ?? {}).map(([column, value]) => ({
				column,
				value,
			})),
			...(intent.where && { where: [intent.where as any] }),
			...(intent.returning && { returning: [...intent.returning] }),
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
	 * @stub Phase 2 - Recursive CTE
	 */
	compileRecursive(
		report: RecursivePlanReport,
		_model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;
		const intent = report.intent;

		// Validate traversal kind is adjacency (edge-table not yet supported in Phase 1)
		if (intent.traversal.kind !== 'adjacency') {
			throw new Error(
				`PgsqlAdapter.compileRecursive: Only adjacency traversal is supported in Phase 1, got '${intent.traversal.kind}'`,
			);
		}

		const traversal = intent.traversal;
		const table = traversal.nodeTable;
		const pkColumn = traversal.nodeId;
		const fkColumn = traversal.parentId;
		const isAncestors = traversal.direction === 'ancestors';

		// Create compiler context
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: intent.maxDepth,
		};

		// Get columns to select (from start.select or all columns from nodeIdExpr)
		const startSelect = intent.start.select ?? [];
		const nodeIdColumn =
			intent.start.nodeIdExpr.kind === 'column'
				? intent.start.nodeIdExpr.name
				: pkColumn;

		// Combine nodeId + additional select columns, ensure unique
		const selectColumns = Array.from(new Set([nodeIdColumn, ...startSelect]));

		// Build recursive CTE config
		const config: RecursiveCteConfig = {
			cteAlias: intent.cteName,
			table,
			pkColumn,
			fkColumn,
			outerAlias: 't0', // Outer query alias (for anchor WHERE correlation)
			isAncestors,
			maxDepth: intent.maxDepth,
			selectColumns,
			trackPath: intent.track?.path !== undefined,
			usePg14Cycle: false, // TODO: detect PostgreSQL version in Phase 2
			ctx,
		};

		// Build the recursive CTE
		const { cte } = buildRecursiveCte(config);

		// Build the final SELECT that uses the CTE
		const selectStmt: SelectStmt = {
			targetList: selectColumns.map((col: string) => ({
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
			})),
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
				ctes: [cte],
				recursive: true,
			},
		};

		// Deparse AST to SQL
		const sql = deparseQuoted({ SelectStmt: selectStmt });

		return {
			sql,
			parameters: [], // Recursive CTEs typically don't have parameters in basic form
		};
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
		const executor = this.client ?? this.pool;
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
			const client = await adapter.pool.connect();
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
					} catch (_) {
						// Ignore rollback errors during cleanup
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
		const cursorName = `__cursor_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

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
	 * @stub Phase 4 - Introspection
	 */
	async introspect(): Promise<ModelIR> {
		throw new Error('PgsqlAdapter.introspect: Not implemented - Phase 4');
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
		const client = await this.pool.connect();
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
		return new PgsqlAdapter<DB>(this.client ?? this.pool, options);
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
		const executor = this.client ?? this.pool;
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
