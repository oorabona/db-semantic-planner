/**
 * PlanReport Compiler
 *
 * Transforms PlanReport → PostgreSQL AST → SQL
 *
 * This is the core of the adapter-pgsql spike: tree-to-tree transformation
 * that builds PostgreSQL AST nodes and deparses them to SQL.
 */

import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';

import {
	andExpr,
	booleanConstNode,
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
	leftJoin,
	likeExpr,
	ltExpr,
	lteExpr,
	neExpr,
	nullConstNode,
	orExpr,
	rangeVar,
	selectStmt,
	sortBy,
	starTarget,
	updateStmt,
} from './ast-helpers.js';
import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';
import { createParamRef } from './param-ref.js';

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

		const sql = deparseSync(ast);

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

				case 'where': {
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

	private compileCondition(decision: PlanDecision): Node {
		const column = columnRef(
			decision.column ?? 'id',
			decision.table,
			undefined,
			this.naming,
		);

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
			default:
				return eqExpr(column, value);
		}
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

		if (typeof value === 'string') {
			return { A_Const: { sval: { sval: value } } };
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return { A_Const: { ival: { ival: value } } };
			}
			return { A_Const: { fval: { fval: String(value) } } };
		}

		if (typeof value === 'boolean') {
			return booleanConstNode(value);
		}

		// For complex values, use a parameter
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
