/**
 * PlanReport Compiler
 *
 * Transforms PlanReport → PostgreSQL AST → SQL
 *
 * This is the core of the adapter-pgsql spike: tree-to-tree transformation
 * that builds PostgreSQL AST nodes and deparses them to SQL.
 */

import type { Node } from '@pgsql/types';
import {
	andExpr,
	booleanConstNode,
	coalesceExpr,
	columnRef,
	columnTarget,
	countDistinct,
	countStar,
	deleteStmt,
	eqExpr,
	funcCall,
	gtExpr,
	gteExpr,
	ilikeExpr,
	innerJoin,
	insertStmt,
	integerNode,
	jsonAggCorrelation,
	jsonAggSubquery,
	leftJoin,
	likeExpr,
	ltExpr,
	lteExpr,
	neExpr,
	notExpr,
	nullConstNode,
	orExpr,
	rangeVar,
	selectStmt,
	sortBy,
	starTarget,
	updateStmt,
	windowFuncCall,
} from './ast-helpers.js';
import { deparseQuoted } from './deparse.js';
import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';
import { createParamRef, createTypeCastParamRef } from './param-ref.js';

// ============================================================================
// Types (simplified for spike - would import from @dbsp/core)
// ============================================================================

/**
 * Simplified PlanDecision for the spike
 * (In production, import from @dbsp/core)
 */
export interface PlanDecision {
	readonly type: string;
	readonly table?: string;
	readonly column?: string;
	readonly alias?: string;
	readonly field?: string;
	readonly operator?: string;
	readonly value?: unknown;
	readonly paramIndex?: number;
	readonly direction?: 'ASC' | 'DESC';
	readonly nulls?: 'FIRST' | 'LAST';
	readonly joinType?: 'inner' | 'left';
	readonly sourceColumn?: string;
	readonly targetColumn?: string;
	readonly targetTable?: string;
	readonly function?: string;
	readonly args?: readonly unknown[];
	readonly conditions?: readonly PlanDecision[];
	readonly columns?: readonly string[];
	readonly values?: readonly unknown[];
	readonly set?: readonly { column: string; value: unknown }[];
	readonly limit?: number | { paramIndex: number };
	readonly offset?: number | { paramIndex: number };
	// Window function properties
	readonly partitionBy?: readonly string[];
	readonly orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
	// Column data type (for range type casting, e.g. 'daterange', 'int4range')
	readonly dataType?: string;
	// JSON aggregation (include strategy: 'json_agg')
	readonly relationName?: string;
	readonly relationType?: 'belongsTo' | 'hasMany' | 'hasOne';
	readonly foreignKey?: string;
	readonly parentKey?: string;
	// Filter/include strategy choice from planner ('join' | 'exists' | 'json_agg')
	readonly choice?: string;
}

/**
 * Simplified PlanReport for the spike
 */
export interface SimplifiedPlanReport {
	readonly rootTable: string;
	readonly decisions: readonly PlanDecision[];
	readonly schema?: string;
}

/**
 * Compiled query result
 */
export interface CompiledResult {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly ast: Node;
}

// ============================================================================
// Compiler
// ============================================================================

export interface CompilerOptions {
	readonly naming?: NamingPlugin;
	readonly schema?: string;
}

/**
 * Compile a PlanReport to SQL via PostgreSQL AST
 */
export class PlanCompiler {
	private readonly naming: NamingPlugin;
	private readonly schema: string | undefined;
	private parameters: unknown[] = [];
	private paramIndex = 0;
	/** Track root table for EXISTS FK correlation */
	private currentRootTable = '';
	/** Pending JOINs registered by filter/include strategies (flushed in compileSelect) */
	private pendingJoins: Array<{
		type: 'JOIN' | 'LEFT JOIN';
		table: string;
		alias?: string;
		on: Node;
	}> = [];

	constructor(options: CompilerOptions = {}) {
		this.naming = options.naming ?? identityNaming;
		this.schema = options.schema ?? undefined;
	}

	/**
	 * Compile a simplified plan report to SQL
	 */
	compile(plan: SimplifiedPlanReport): CompiledResult {
		this.parameters = [];
		this.paramIndex = 0;
		this.currentRootTable = plan.rootTable;
		this.pendingJoins = [];

		// Determine query type from decisions
		const queryType = this.detectQueryType(plan.decisions);

		let ast: Node;

		switch (queryType) {
			case 'select':
				ast = this.compileSelect(plan);
				break;
			case 'insert':
				ast = this.compileInsert(plan);
				break;
			case 'update':
				ast = this.compileUpdate(plan);
				break;
			case 'delete':
				ast = this.compileDelete(plan);
				break;
			default:
				throw new Error(`Unsupported query type: ${queryType}`);
		}

		const sql = deparseQuoted(ast);

		return {
			sql,
			parameters: this.parameters,
			ast,
		};
	}

	private detectQueryType(decisions: readonly PlanDecision[]): string {
		for (const decision of decisions) {
			if (decision.type === 'insert') return 'insert';
			if (decision.type === 'update') return 'update';
			if (decision.type === 'delete') return 'delete';
		}
		return 'select';
	}

	// --------------------------------------------------------------------------
	// SELECT Compilation
	// --------------------------------------------------------------------------

	private compileSelect(plan: SimplifiedPlanReport): Node {
		const targetList: Node[] = [];
		const from: Node[] = [];
		let where: Node | undefined;
		const orderBy: Node[] = [];
		const groupBy: Node[] = [];
		let having: Node | undefined;
		let limit: Node | undefined;
		let offset: Node | undefined;
		let distinct = false;

		// Start with base table
		from.push(
			rangeVar(
				plan.rootTable,
				undefined,
				plan.schema ?? this.schema,
				this.naming,
			),
		);

		for (const decision of plan.decisions) {
			switch (decision.type) {
				case 'select':
					if (decision.column === '*') {
						targetList.push(starTarget(decision.table, this.naming));
					} else if (decision.column) {
						targetList.push(
							columnTarget(
								decision.column,
								decision.alias,
								decision.table,
								this.naming,
							),
						);
					}
					break;

				case 'selectFunction':
					if (decision.function === 'count' && decision.column === '*') {
						targetList.push({
							ResTarget: {
								val: countStar(),
								...(decision.alias ? { name: decision.alias } : {}),
							},
						});
					} else if (decision.function === 'countDistinct' && decision.column) {
						targetList.push({
							ResTarget: {
								val: countDistinct(
									columnRef(
										decision.column,
										decision.table,
										undefined,
										this.naming,
									),
								),
								...(decision.alias ? { name: decision.alias } : {}),
							},
						});
					} else if (decision.function === 'coalesce' && decision.args) {
						// COALESCE: args is array of column names
						// COALESCE is a SQL keyword (not a function), so use CoalesceExpr
						const coalesceArgs = (decision.args as string[]).map((col) =>
							columnRef(col, decision.table, undefined, this.naming),
						);
						targetList.push({
							ResTarget: {
								val: coalesceExpr(coalesceArgs),
								...(decision.alias
									? { name: this.naming.toDatabase(decision.alias) }
									: {}),
							},
						});
					} else if (decision.function && decision.column) {
						targetList.push({
							ResTarget: {
								val: funcCall(decision.function, [
									columnRef(
										decision.column,
										decision.table,
										undefined,
										this.naming,
									),
								]),
								...(decision.alias ? { name: decision.alias } : {}),
							},
						});
					}
					break;

				case 'selectWindow': {
					// Window function: ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) AS alias
					const windowArgs: Node[] = [];
					if (decision.field) {
						windowArgs.push(
							columnRef(decision.field, decision.table, undefined, this.naming),
						);
					}
					// Build over clause conditionally to satisfy exactOptionalPropertyTypes
					const overClause: {
						partitionBy?: readonly string[];
						orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
					} = {};
					if (decision.partitionBy)
						overClause.partitionBy = decision.partitionBy;
					if (decision.orderBy) overClause.orderBy = decision.orderBy;

					targetList.push({
						ResTarget: {
							val: windowFuncCall(
								decision.function!,
								windowArgs,
								overClause,
								this.naming,
								decision.table,
							),
							...(decision.alias ? { name: decision.alias } : {}),
						},
					});
					break;
				}

				case 'selectJsonAgg': {
					// json_agg include: COALESCE((SELECT json_agg(to_jsonb(__t__)) FROM target AS __t__ WHERE ...), '[]'::json) AS "relation_json"
					if (
						decision.relationName &&
						decision.targetTable &&
						decision.relationType
					) {
						const rootAlias = plan.rootTable;

						// Build correlation WHERE based on relation type
						// belongsTo: target.pk = parent.fk  (e.g., authors.id = posts.author_id)
						// hasMany/hasOne: target.fk = parent.pk  (e.g., posts.author_id = authors.id)
						let whereExpr: Node;
						if (decision.relationType === 'belongsTo') {
							// For belongsTo, the FK is in the source table, pointing to target's PK
							whereExpr = jsonAggCorrelation(
								rootAlias,
								decision.foreignKey ?? 'id', // FK in parent (source)
								'__t__',
								decision.parentKey ?? 'id', // PK in target
								this.naming,
							);
						} else {
							// For hasMany/hasOne, the FK is in target table, pointing to source's PK
							whereExpr = jsonAggCorrelation(
								rootAlias,
								decision.parentKey ?? 'id', // PK in parent (source)
								'__t__',
								decision.foreignKey ?? 'id', // FK in target
								this.naming,
							);
						}

						// Build the json_agg subquery SELECT
						// Alias must use {relation}_json pattern for hydration-utils.ts detection
						targetList.push(
							jsonAggSubquery(
								decision.targetTable,
								whereExpr,
								`${decision.relationName}_json`,
								this.schema,
								this.naming,
							),
						);
					}
					break;
				}

				case 'selectLeftJoinInclude': {
					// LEFT JOIN include: add relation columns with "relation.column" aliases
					// and register LEFT JOIN for to-one (belongsTo/hasOne) includes
					if (
						decision.relationName &&
						decision.targetTable &&
						decision.columns
					) {
						const cols = decision.columns;
						// Use relationName as the table alias for column references
						const colTableRef = decision.relationName;

						// Add each column with "relation.column" alias for hydration
						for (const col of cols) {
							targetList.push(
								columnTarget(
									col,
									`${decision.relationName}.${col}`,
									colTableRef,
									this.naming,
								),
							);
						}

						// Register LEFT JOIN
						// For belongsTo: source.FK → target.PK
						const fk =
							decision.foreignKey ?? this.deriveFK(decision.targetTable);
						const onCondition = eqExpr(
							columnRef('id', decision.relationName, undefined, this.naming),
							columnRef(fk, plan.rootTable, undefined, this.naming),
						);

						this.pendingJoins.push({
							type: 'LEFT JOIN',
							table: decision.targetTable,
							// Always alias with relationName for uniqueness
							// (e.g., "author" and "editor" both from "users")
							alias: decision.relationName,
							on: onCondition,
						});
					}
					break;
				}

				case 'where': {
					// JOIN filter: register INNER JOIN instead of EXISTS subquery
					if (
						decision.operator === 'exists' &&
						decision.choice === 'join' &&
						decision.targetTable
					) {
						this.registerJoinFilter(decision);
						// Add user conditions (on joined table) to WHERE
						if (decision.conditions && decision.conditions.length > 0) {
							const condNodes = decision.conditions.map((c) =>
								this.compileCondition(c as PlanDecision),
							);
							const combined =
								condNodes.length === 1 ? condNodes[0]! : andExpr(...condNodes);
							where = where ? andExpr(where, combined) : combined;
						}
						break;
					}
					const whereExpr = this.compileCondition(decision);
					where = where ? andExpr(where, whereExpr) : whereExpr;
					break;
				}

				case 'whereAnd':
					if (decision.conditions) {
						const andConditions = decision.conditions.map((c) =>
							this.compileCondition(c),
						);
						const combined =
							andConditions.length === 1
								? andConditions[0]!
								: andExpr(...andConditions);
						where = where ? andExpr(where, combined) : combined;
					}
					break;

				case 'whereOr':
					if (decision.conditions) {
						const orConditions = decision.conditions.map((c) =>
							this.compileCondition(c),
						);
						const combined =
							orConditions.length === 1
								? orConditions[0]!
								: orExpr(...orConditions);
						where = where ? andExpr(where, combined) : combined;
					}
					break;

				case 'join': {
					const joinExpr = this.compileJoin(decision, plan);
					// Replace or add to from clause
					if (from.length === 1) {
						from[0] = joinExpr;
					} else {
						from.push(joinExpr);
					}
					break;
				}

				case 'orderBy':
					if (decision.column) {
						orderBy.push(
							sortBy(
								columnRef(
									decision.column,
									decision.table,
									undefined,
									this.naming,
								),
								decision.direction ?? 'ASC',
								decision.nulls ?? 'DEFAULT',
							),
						);
					}
					break;

				case 'groupBy':
					if (decision.column) {
						groupBy.push(
							columnRef(
								decision.column,
								decision.table,
								undefined,
								this.naming,
							),
						);
					}
					break;

				case 'having':
					having = this.compileCondition(decision);
					break;

				case 'limit':
					if (typeof decision.limit === 'number') {
						limit = integerNode(decision.limit);
					} else if (decision.limit?.paramIndex !== undefined) {
						limit = createParamRef(decision.limit.paramIndex);
						this.parameters.push(undefined); // Placeholder
					}
					break;

				case 'offset':
					if (typeof decision.offset === 'number') {
						offset = integerNode(decision.offset);
					} else if (decision.offset?.paramIndex !== undefined) {
						offset = createParamRef(decision.offset.paramIndex);
						this.parameters.push(undefined); // Placeholder
					}
					break;

				case 'distinct':
					distinct = true;
					break;
			}
		}

		// Flush pending JOINs into FROM clause
		for (const pj of this.pendingJoins) {
			const targetRV = rangeVar(
				pj.table,
				pj.alias,
				plan.schema ?? this.schema,
				this.naming,
			);
			const base =
				from.length > 0
					? from[0]!
					: rangeVar(
							plan.rootTable,
							undefined,
							plan.schema ?? this.schema,
							this.naming,
						);
			from[0] =
				pj.type === 'LEFT JOIN'
					? leftJoin(base, targetRV, pj.on)
					: innerJoin(base, targetRV, pj.on);
		}

		// Default to SELECT * if no columns specified
		if (targetList.length === 0) {
			targetList.push(starTarget(undefined, this.naming));
		}

		// Build options object, only including defined properties
		const options: Parameters<typeof selectStmt>[0] = {
			targetList,
			from,
		};

		if (where) options.where = where;
		if (groupBy.length > 0) options.groupBy = groupBy;
		if (having) options.having = having;
		if (orderBy.length > 0) options.orderBy = orderBy;
		if (limit) options.limit = limit;
		if (offset) options.offset = offset;
		if (distinct) options.distinct = distinct;

		return selectStmt(options);
	}

	// --------------------------------------------------------------------------
	// INSERT Compilation
	// --------------------------------------------------------------------------

	private compileInsert(plan: SimplifiedPlanReport): Node {
		const columns: string[] = [];
		const values: Node[][] = [];
		const returning: Node[] = [];

		for (const decision of plan.decisions) {
			if (decision.type === 'insert') {
				if (decision.columns) {
					columns.push(...decision.columns);
				}
				if (decision.values) {
					const row = decision.values.map((v) => this.compileValue(v));
					values.push(row);
				}
			} else if (decision.type === 'returning') {
				if (decision.column === '*') {
					returning.push(starTarget(undefined, this.naming));
				} else if (decision.column) {
					returning.push(
						columnTarget(
							decision.column,
							decision.alias,
							undefined,
							this.naming,
						),
					);
				}
			}
		}

		const insertOptions: Parameters<typeof insertStmt>[0] = {
			table: plan.rootTable,
			columns,
			values,
			naming: this.naming,
		};

		const schema = plan.schema ?? this.schema;
		if (schema) insertOptions.schema = schema;
		if (returning.length > 0) insertOptions.returning = returning;

		return insertStmt(insertOptions);
	}

	// --------------------------------------------------------------------------
	// UPDATE Compilation
	// --------------------------------------------------------------------------

	private compileUpdate(plan: SimplifiedPlanReport): Node {
		const set: Array<{ column: string; value: Node }> = [];
		let where: Node | undefined;
		const returning: Node[] = [];

		for (const decision of plan.decisions) {
			if (decision.type === 'update') {
				if (decision.set) {
					for (const s of decision.set) {
						set.push({
							column: s.column,
							value: this.compileValue(s.value),
						});
					}
				}
			} else if (decision.type === 'where') {
				const whereExpr = this.compileCondition(decision);
				where = where ? andExpr(where, whereExpr) : whereExpr;
			} else if (decision.type === 'returning') {
				if (decision.column === '*') {
					returning.push(starTarget(undefined, this.naming));
				} else if (decision.column) {
					returning.push(
						columnTarget(
							decision.column,
							decision.alias,
							undefined,
							this.naming,
						),
					);
				}
			}
		}

		const updateOptions: Parameters<typeof updateStmt>[0] = {
			table: plan.rootTable,
			set,
			naming: this.naming,
		};

		const updateSchema = plan.schema ?? this.schema;
		if (updateSchema) updateOptions.schema = updateSchema;
		if (where) updateOptions.where = where;
		if (returning.length > 0) updateOptions.returning = returning;

		return updateStmt(updateOptions);
	}

	// --------------------------------------------------------------------------
	// DELETE Compilation
	// --------------------------------------------------------------------------

	private compileDelete(plan: SimplifiedPlanReport): Node {
		let where: Node | undefined;
		const returning: Node[] = [];

		for (const decision of plan.decisions) {
			if (decision.type === 'where') {
				const whereExpr = this.compileCondition(decision);
				where = where ? andExpr(where, whereExpr) : whereExpr;
			} else if (decision.type === 'returning') {
				if (decision.column === '*') {
					returning.push(starTarget(undefined, this.naming));
				} else if (decision.column) {
					returning.push(
						columnTarget(
							decision.column,
							decision.alias,
							undefined,
							this.naming,
						),
					);
				}
			} else if (decision.type === 'delete') {
				// Mark as delete query (handled by detectQueryType)
			}
		}

		const deleteOptions: Parameters<typeof deleteStmt>[0] = {
			table: plan.rootTable,
			naming: this.naming,
		};

		const deleteSchema = plan.schema ?? this.schema;
		if (deleteSchema) deleteOptions.schema = deleteSchema;
		if (where) deleteOptions.where = where;
		if (returning.length > 0) deleteOptions.returning = returning;

		return deleteStmt(deleteOptions);
	}

	// --------------------------------------------------------------------------
	// Helpers
	// --------------------------------------------------------------------------

	/**
	 * Derive FK column name from source table using convention.
	 * Convention: FK = {singularSourceTable}Id
	 * Examples: authors → authorId, posts → postId, categories → categoryId
	 */
	private deriveFK(sourceTable: string): string {
		// Simple singularization: remove trailing 's'
		// Handles: authors → author, posts → post, comments → comment
		let singular = sourceTable;
		if (singular.endsWith('ies')) {
			// categories → category
			singular = `${singular.slice(0, -3)}y`;
		} else if (singular.endsWith('s') && !singular.endsWith('ss')) {
			// authors → author (but not 'address' → 'addres')
			singular = singular.slice(0, -1);
		}
		return `${singular}Id`;
	}

	private compileCondition(decision: PlanDecision): Node {
		// Handle nested compound conditions recursively
		if (decision.type === 'whereAnd' && decision.conditions) {
			const andConditions = decision.conditions.map((c) =>
				this.compileCondition(c as PlanDecision),
			);
			return andConditions.length === 1
				? andConditions[0]!
				: andExpr(...andConditions);
		}

		if (decision.type === 'whereOr' && decision.conditions) {
			const orConditions = decision.conditions.map((c) =>
				this.compileCondition(c as PlanDecision),
			);
			return orConditions.length === 1
				? orConditions[0]!
				: orExpr(...orConditions);
		}

		if (decision.type === 'whereNot' && decision.conditions) {
			const nested = this.compileCondition(
				decision.conditions[0] as PlanDecision,
			);
			return notExpr(nested);
		}

		const column = columnRef(
			decision.column ?? 'id',
			decision.table,
			undefined,
			this.naming,
		);

		// Range operators handle their own parameters (with formatting + type cast)
		// Must early-return before generic value compilation pushes raw value
		if (
			decision.operator === 'contains' ||
			decision.operator === 'containedBy' ||
			decision.operator === 'overlaps'
		) {
			const rangeOp =
				decision.operator === 'contains'
					? '@>'
					: decision.operator === 'containedBy'
						? '<@'
						: '&&';
			return this.compileRangeOperator(
				decision,
				column,
				rangeOp as '@>' | '<@' | '&&',
			);
		}

		let value: Node;
		if (decision.paramIndex !== undefined) {
			value = createParamRef(decision.paramIndex);
			this.parameters.push(decision.value);
		} else {
			value = this.compileValue(decision.value);
		}

		switch (decision.operator) {
			case '=':
			case 'eq':
				return eqExpr(column, value);
			case '!=':
			case '<>':
			case 'ne':
				return neExpr(column, value);
			case '<':
			case 'lt':
				return ltExpr(column, value);
			case '<=':
			case 'lte':
				return lteExpr(column, value);
			case '>':
			case 'gt':
				return gtExpr(column, value);
			case '>=':
			case 'gte':
				return gteExpr(column, value);
			case 'like':
				return likeExpr(column, value);
			case 'ilike':
				return ilikeExpr(column, value);
			case 'isNull':
				return {
					NullTest: {
						arg: column,
						nulltesttype: 'IS_NULL',
					},
				};
			case 'isNotNull':
				return {
					NullTest: {
						arg: column,
						nulltesttype: 'IS_NOT_NULL',
					},
				};
			case 'exists':
			case 'notExists':
				return this.compileExistsCondition(decision);
			case 'in':
				return this.compileInCondition(decision, column, false);
			case 'notIn':
				return this.compileInCondition(decision, column, true);
			case 'between':
				return this.compileBetweenCondition(decision, column);
			// Note: range operators (contains/containedBy/overlaps) handled by early return above
			default:
				return eqExpr(column, value);
		}
	}

	/**
	 * Compile an EXISTS or NOT EXISTS subquery condition.
	 * EXISTS (SELECT 1 FROM targetTable WHERE fk = source.pk [AND conditions])
	 *
	 * FK correlation is generated using convention: target.{singularSource}Id = source.id
	 * Example: EXISTS (SELECT 1 FROM posts WHERE posts.author_id = authors.id)
	 */
	private compileExistsCondition(decision: PlanDecision): Node {
		const targetTable = decision.targetTable;
		if (!targetTable) {
			throw new Error('EXISTS condition requires targetTable');
		}

		const sourceTable = this.currentRootTable;

		// Build SELECT 1 FROM targetTable (no alias - conditions reference table name directly)
		const targetList: Node[] = [
			{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } },
		];

		const fromClause: Node[] = [
			rangeVar(targetTable, undefined, this.schema, this.naming),
		];

		// Build FK correlation condition
		// Use explicit foreignKey from decision if available (resolved from model),
		// otherwise fall back to convention: {singularSourceTable}Id
		const fkColumn = decision.foreignKey
			? typeof decision.foreignKey === 'string'
				? decision.foreignKey
				: decision.foreignKey[0]
			: this.deriveFK(sourceTable);
		const fkCorrelation = eqExpr(
			columnRef(fkColumn, targetTable, undefined, this.naming),
			columnRef('id', sourceTable, undefined, this.naming),
		);

		// Build WHERE clause: FK correlation AND user conditions
		let whereClause: Node = fkCorrelation;

		if (decision.conditions && decision.conditions.length > 0) {
			const condNodes = decision.conditions.map((c) =>
				this.compileCondition(c as PlanDecision),
			);
			// Combine FK correlation with user conditions using AND
			whereClause = andExpr(fkCorrelation, ...condNodes);
		}

		const subSelect: Node = {
			SelectStmt: {
				targetList,
				fromClause,
				...(whereClause && { whereClause }),
			},
		};

		const subLink: Node = {
			SubLink: {
				subLinkType: 'EXISTS_SUBLINK',
				subselect: subSelect,
			},
		};

		// For NOT EXISTS, wrap with NOT BoolExpr
		// (SubLinkType only has EXISTS_SUBLINK; deparser renders as "NOT (EXISTS ...)")
		if (decision.operator === 'notExists') {
			return {
				BoolExpr: {
					boolop: 'NOT_EXPR',
					args: [subLink],
				},
			};
		}

		return subLink;
	}

	/**
	 * Register an INNER JOIN for a belongsTo filter-strategy decision.
	 * The JOIN replaces the EXISTS subquery when the planner chooses 'join'.
	 * The ON condition correlates FK → PK (belongsTo: source.FK = target.PK).
	 */
	private registerJoinFilter(decision: PlanDecision): void {
		const targetTable = decision.targetTable!;
		const sourceTable = this.currentRootTable;

		// For belongsTo: FK is on source table, references target PK
		// e.g., posts.author_id → authors.id
		const fkColumn = decision.foreignKey ?? this.deriveFK(targetTable);
		const onCondition = eqExpr(
			columnRef('id', targetTable, undefined, this.naming),
			columnRef(fkColumn, sourceTable, undefined, this.naming),
		);

		// Use relation-based alias for self-referential tables
		const alias =
			targetTable === sourceTable
				? (decision.relationName ?? `${targetTable}_join`)
				: undefined;

		this.pendingJoins.push({
			type: 'JOIN',
			table: targetTable,
			...(alias && { alias }),
			on: onCondition,
		});
	}

	/**
	 * Compile an IN or NOT IN condition.
	 * Uses PostgreSQL idioms: col = ANY($N) for IN, col <> ALL($N) for NOT IN
	 */
	private compileInCondition(
		decision: PlanDecision,
		column: Node,
		negate: boolean,
	): Node {
		const values = decision.value as unknown[];
		if (!Array.isArray(values)) {
			throw new Error('IN condition requires array value');
		}

		// Handle empty arrays
		if (values.length === 0) {
			// Empty IN is always false, empty NOT IN is always true
			return booleanConstNode(!negate);
		}

		const paramIdx = ++this.paramIndex;
		this.parameters.push(values);

		// Use = ANY($N) for IN, <> ALL($N) for NOT IN
		const funcName = negate ? 'all' : 'any';
		const op = negate ? '<>' : '=';

		const funcCall: Node = {
			FuncCall: {
				funcname: [{ String: { sval: funcName } }],
				args: [createParamRef(paramIdx)],
			},
		};

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: op } }],
				lexpr: column,
				rexpr: funcCall,
			},
		};
	}

	/**
	 * Compile a BETWEEN condition.
	 * column BETWEEN $1 AND $2
	 */
	private compileBetweenCondition(decision: PlanDecision, column: Node): Node {
		const range = decision.value as [unknown, unknown];
		if (!Array.isArray(range) || range.length !== 2) {
			throw new Error('BETWEEN condition requires [min, max] array');
		}

		const minIdx = ++this.paramIndex;
		this.parameters.push(range[0]);
		const minNode = createParamRef(minIdx);

		const maxIdx = ++this.paramIndex;
		this.parameters.push(range[1]);
		const maxNode = createParamRef(maxIdx);

		return {
			A_Expr: {
				kind: 'AEXPR_BETWEEN',
				name: [{ String: { sval: 'BETWEEN' } }],
				lexpr: column,
				rexpr: { List: { items: [minNode, maxNode] } },
			},
		};
	}

	/**
	 * Compile a PostgreSQL range operator condition (@>, <@, &&).
	 * For range types: column @> value, column <@ range, column && range
	 *
	 * Value can be:
	 * - Scalar (for @> point containment)
	 * - { lower, upper } object (for range comparison)
	 */
	private compileRangeOperator(
		decision: PlanDecision,
		column: Node,
		operator: '@>' | '<@' | '&&',
	): Node {
		const value = decision.value;

		// Convert value to appropriate format
		let paramValue: unknown;
		let isScalar = false;
		if (
			value !== null &&
			typeof value === 'object' &&
			'lower' in (value as object)
		) {
			// Range value: { lower, upper } → PostgreSQL range literal
			const range = value as { lower?: unknown; upper?: unknown };
			// Format as PostgreSQL range literal: [lower,upper)
			const lower = range.lower ?? '';
			const upper = range.upper ?? '';
			paramValue = `[${lower},${upper})`;
		} else if (typeof value === 'string' && /^\[.*,.*[)\]]$/.test(value)) {
			// Range literal string (e.g., "[2024-01-16,2024-01-17)") from NQL parser
			paramValue = value;
		} else {
			// Scalar value (for @> point containment)
			paramValue = value;
			isScalar = true;
		}

		const paramIdx = ++this.paramIndex;
		this.parameters.push(paramValue);

		// Use TypeCast when dataType is available (required for range types like daterange, int4range)
		// For scalar values (point containment), cast to element type (e.g. 'date' not 'daterange')
		let castType = decision.dataType;
		if (castType && isScalar) {
			// Strip 'range' suffix to get element type: daterange → date, int4range → int4, tstzrange → tstz
			castType = castType.replace(/range$/, '');
			// Map PostgreSQL range element type names to proper type names
			if (castType === 'int4') castType = 'integer';
			if (castType === 'int8') castType = 'bigint';
			if (castType === 'tstz') castType = 'timestamptz';
			if (castType === 'ts') castType = 'timestamp';
		}
		const rexpr = castType
			? createTypeCastParamRef(paramIdx, castType)
			: createParamRef(paramIdx);

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: operator } }],
				lexpr: column,
				rexpr,
			},
		};
	}

	private compileValue(value: unknown): Node {
		if (value === null || value === undefined) {
			return nullConstNode();
		}

		if (typeof value === 'object' && 'paramIndex' in (value as object)) {
			const paramValue = value as { paramIndex: number; value?: unknown };
			this.parameters.push(paramValue.value);
			return createParamRef(paramValue.paramIndex);
		}

		// Use parameters for all scalar values for consistency with Kysely
		// and security best practices (prevents SQL injection)
		const idx = ++this.paramIndex;
		this.parameters.push(value);
		return createParamRef(idx);
	}

	private compileJoin(
		decision: PlanDecision,
		plan: SimplifiedPlanReport,
	): Node {
		const baseTable = rangeVar(
			plan.rootTable,
			undefined,
			plan.schema ?? this.schema,
			this.naming,
		);
		const targetTable = rangeVar(
			decision.targetTable ?? '',
			decision.alias,
			plan.schema ?? this.schema,
			this.naming,
		);

		const onCondition = eqExpr(
			columnRef(
				decision.sourceColumn ?? 'id',
				undefined,
				undefined,
				this.naming,
			),
			columnRef(
				decision.targetColumn ?? 'id',
				decision.alias ?? decision.targetTable,
				undefined,
				this.naming,
			),
		);

		if (decision.joinType === 'left') {
			return leftJoin(baseTable, targetTable, onCondition, decision.alias);
		}

		return innerJoin(baseTable, targetTable, onCondition, decision.alias);
	}
}

/**
 * Convenience function to compile a plan
 */
export function compilePlan(
	plan: SimplifiedPlanReport,
	options?: CompilerOptions,
): CompiledResult {
	const compiler = new PlanCompiler(options);
	return compiler.compile(plan);
}
