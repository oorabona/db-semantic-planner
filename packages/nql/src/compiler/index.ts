/**
 * NQL Compiler
 *
 * Transforms NQL AST to IntentAST (from @dbsp/core)
 */

import type {
	NqlBetweenExpression,
	NqlBinaryExpression,
	NqlComparisonExpression,
	NqlDelete,
	NqlExpression,
	NqlGroupByClause,
	NqlInExpression,
	NqlInsert,
	NqlIsNullExpression,
	NqlJoinSpec,
	NqlMutationPipeline,
	NqlOrderByClause,
	NqlOrderItem,
	NqlProgram,
	NqlQuery,
	NqlRangeLiteral,
	NqlRangeOpExpression,
	NqlSelectClause,
	NqlSelectItem,
	NqlUnaryExpression,
	NqlUpdate,
	NqlUpsert,
	NqlWindowExpression,
	NqlWithClause,
} from '../parser/ast.js';

// IntentAST types - we define our own compatible types here
// to avoid circular dependency with @dbsp/core
export interface QueryIntent {
	readonly type: 'select';
	readonly from: string;
	readonly select?: SelectIntent;
	readonly where?: WhereIntent;
	readonly include?: readonly IncludeIntent[];
	readonly orderBy?: readonly OrderByIntent[];
	readonly groupBy?: readonly string[];
	readonly having?: WhereIntent;
	readonly distinct?: boolean;
	readonly limit?: number;
	readonly offset?: number;
}

export interface InsertIntent {
	readonly type: 'insert';
	readonly table: string;
	readonly values: readonly Record<string, unknown>[];
	readonly returning?: readonly string[];
}

export interface UpdateIntent {
	readonly type: 'update';
	readonly table: string;
	readonly set: Record<string, unknown>;
	readonly where?: WhereIntent;
	readonly allowAll?: boolean;
	readonly returning?: readonly string[];
}

export interface DeleteIntent {
	readonly type: 'delete';
	readonly table: string;
	readonly where?: WhereIntent;
	readonly allowAll?: boolean;
	readonly returning?: readonly string[];
}

export interface UpsertIntent {
	readonly type: 'upsert';
	readonly table: string;
	readonly values: readonly Record<string, unknown>[];
	readonly onConflict: UpsertConflictTarget;
	readonly action: UpsertConflictAction;
	readonly returning?: readonly string[];
}

export type UpsertConflictTarget =
	| { readonly columns: readonly string[] }
	| { readonly constraint: string };

export type UpsertConflictAction =
	| { readonly type: 'doNothing' }
	| {
			readonly type: 'doUpdate';
			readonly set?: Record<string, unknown>;
			readonly where?: WhereIntent;
	  };

export type SelectIntent =
	| SelectAllIntent
	| SelectFieldsIntent
	| SelectWithExpressionsIntent;

export interface SelectAllIntent {
	readonly type: 'all';
}

export interface SelectFieldsIntent {
	readonly type: 'fields';
	readonly fields: readonly string[];
}

export interface SelectWithExpressionsIntent {
	readonly type: 'expressions';
	readonly columns: readonly ExpressionIntent[];
}

export type ExpressionIntent =
	| { readonly kind: 'column'; readonly column: string; readonly as?: string }
	| {
			readonly kind: 'aggregate';
			readonly function: AggregateFunction;
			readonly field: string | '*';
			readonly as?: string;
			readonly distinct?: boolean;
			/** Extra arguments for multi-arg aggregates like string_agg(field, separator) */
			readonly extraArgs?: readonly unknown[];
	  }
	| {
			readonly kind: 'columnAlias';
			readonly column: string;
			readonly alias: string;
	  }
	| {
			readonly kind: 'relationColumn';
			readonly relation: string;
			readonly column: string;
			readonly as: string;
	  }
	| {
			readonly kind: 'arithmetic';
			readonly left: string | number | unknown;
			readonly operator: '+' | '-' | '*' | '/' | '%';
			readonly right: string | number | unknown;
			readonly as?: string;
	  }
	| {
			readonly kind: 'function';
			readonly name: string;
			readonly args: readonly unknown[];
			readonly as?: string;
	  }
	| {
			readonly kind: 'subquery';
			readonly query: QueryIntent;
			readonly as?: string;
	  }
	| {
			readonly kind: 'window';
			readonly function: WindowFunction;
			readonly field?: string;
			readonly alias: string;
			readonly over: {
				readonly partitionBy?: readonly string[];
				readonly orderBy?: readonly WindowOrderBy[];
			};
	  };

export type WindowFunction =
	| 'row_number'
	| 'rank'
	| 'dense_rank'
	| 'sum'
	| 'avg'
	| 'count'
	| 'min'
	| 'max'
	| 'lag'
	| 'lead';

export interface WindowOrderBy {
	readonly field: string;
	readonly direction?: SortDirection;
}

export type AggregateFunction =
	| 'count'
	| 'sum'
	| 'avg'
	| 'min'
	| 'max'
	| 'array_agg'
	| 'string_agg';

export type WhereIntent =
	| WhereComparisonIntent
	| WhereInIntent
	| WhereLikeIntent
	| WhereNullIntent
	| WhereRangeIntent
	| WhereAndIntent
	| WhereOrIntent
	| WhereNotIntent;

export interface WhereComparisonIntent {
	readonly kind: 'comparison';
	readonly field: string;
	readonly operator: ComparisonOperator;
	readonly value: unknown;
}

export interface WhereInIntent {
	readonly kind: 'in';
	readonly field: string;
	readonly values: readonly unknown[];
}

export interface WhereLikeIntent {
	readonly kind: 'like';
	readonly field: string;
	readonly pattern: string;
	readonly caseInsensitive?: boolean;
}

export interface WhereNullIntent {
	readonly kind: 'null';
	readonly field: string;
	readonly operator: NullOperator;
}

export type RangeOperator = 'overlaps' | 'contains' | 'containedBy' | 'between';

/**
 * Range filter: field overlaps/contains/containedBy range value
 * or BETWEEN for lower/upper bounds
 */
export interface WhereRangeIntent {
	readonly kind: 'range';
	readonly field: string;
	readonly operator: RangeOperator;
	/** Can be { lower, upper } for BETWEEN or string for PostgreSQL range literal */
	readonly value: { lower: unknown; upper: unknown } | string;
}

export interface WhereAndIntent {
	readonly kind: 'and';
	readonly conditions: readonly WhereIntent[];
}

export interface WhereOrIntent {
	readonly kind: 'or';
	readonly conditions: readonly WhereIntent[];
}

export interface WhereNotIntent {
	readonly kind: 'not';
	readonly condition: WhereIntent;
}

export type ComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
export type NullOperator = 'isNull' | 'isNotNull';

export interface IncludeIntent {
	readonly relation: string;
	readonly select?: SelectIntent;
	readonly where?: WhereIntent;
	readonly include?: readonly IncludeIntent[];
	readonly via?: string;
	readonly limit?: number;
	readonly orderBy?: readonly OrderByIntent[];
}

export interface OrderByIntent {
	readonly field: string;
	readonly direction: SortDirection;
}

export type SortDirection = 'asc' | 'desc';

export type MutationIntent =
	| InsertIntent
	| UpdateIntent
	| DeleteIntent
	| UpsertIntent;

export interface CompileResult {
	readonly query?: QueryIntent;
	readonly mutation?: MutationIntent;
	readonly returning?: readonly string[];
}

/**
 * Compiler that transforms NQL AST to IntentAST
 */
export class NqlCompiler {
	/**
	 * Compile an NQL program to IntentAST
	 * Returns the first statement's result (multiple statements = batch mode, TBD)
	 */
	compile(program: NqlProgram): CompileResult {
		if (program.statements.length === 0) {
			return {};
		}

		const stmt = program.statements[0];

		if (stmt.type === 'query') {
			return { query: this.compileQuery(stmt) };
		} else if (stmt.type === 'mutationPipeline') {
			return this.compileMutationPipeline(stmt);
		}

		return {};
	}

	private compileQuery(query: NqlQuery): QueryIntent {
		// Track if we've seen groupBy (for WHERE vs HAVING)
		let groupByIndex = -1;
		for (let i = 0; i < query.clauses.length; i++) {
			if (query.clauses[i].type === 'groupBy') {
				groupByIndex = i;
				break;
			}
		}

		// Process clauses and collect results
		const whereConditions: WhereIntent[] = [];
		const havingConditions: WhereIntent[] = [];
		let select: SelectIntent | undefined;
		let distinct: boolean | undefined;
		let include: readonly IncludeIntent[] | undefined;
		let groupBy: readonly string[] | undefined;
		let orderBy: readonly OrderByIntent[] | undefined;
		let limit: number | undefined;
		let offset: number | undefined;

		for (let i = 0; i < query.clauses.length; i++) {
			const clause = query.clauses[i];

			switch (clause.type) {
				case 'where': {
					const condition = this.compileExpression(clause.condition);
					if (groupByIndex >= 0 && i > groupByIndex) {
						havingConditions.push(condition);
					} else {
						whereConditions.push(condition);
					}
					break;
				}
				case 'select':
					select = this.compileSelectClause(clause);
					distinct = clause.distinct || undefined;
					break;
				case 'with':
					include = this.compileWithClause(clause);
					break;
				case 'groupBy':
					groupBy = this.compileGroupByClause(clause);
					break;
				case 'orderBy':
					orderBy = this.compileOrderByClause(clause);
					break;
				case 'limit':
					limit = clause.count;
					break;
				case 'offset':
					offset = clause.count;
					break;
			}
		}

		// Combine WHERE conditions
		let where: WhereIntent | undefined;
		if (whereConditions.length === 1) {
			where = whereConditions[0];
		} else if (whereConditions.length > 1) {
			where = { kind: 'and', conditions: whereConditions };
		}

		// Combine HAVING conditions
		let having: WhereIntent | undefined;
		if (havingConditions.length === 1) {
			having = havingConditions[0];
		} else if (havingConditions.length > 1) {
			having = { kind: 'and', conditions: havingConditions };
		}

		// Build result object
		const result: QueryIntent = {
			type: 'select',
			from: query.table,
			...(select !== undefined && { select }),
			...(where !== undefined && { where }),
			...(include !== undefined && { include }),
			...(orderBy !== undefined && { orderBy }),
			...(groupBy !== undefined && { groupBy }),
			...(having !== undefined && { having }),
			...(distinct !== undefined && { distinct }),
			...(limit !== undefined && { limit }),
			...(offset !== undefined && { offset }),
		};

		return result;
	}

	private compileSelectClause(clause: NqlSelectClause): SelectIntent {
		if (clause.items.length === 1 && clause.items[0].type === 'star') {
			return { type: 'all' };
		}

		// Check if all items are simple field references
		const simpleFields: string[] = [];
		const expressions: ExpressionIntent[] = [];
		let hasExpressions = false;

		for (const item of clause.items) {
			if (item.type === 'star') {
				// Star in multi-item select → use column with special '*' marker
				hasExpressions = true;
				expressions.push({ kind: 'column', column: '*' });
			} else if (item.type === 'relationStar') {
				// relation.* → use relationColumn with '*' as column
				hasExpressions = true;
				const relation = item.relation.join('.');
				expressions.push({
					kind: 'relationColumn',
					relation,
					column: '*',
					as: `${relation}.*`,
				});
			} else if (item.type === 'expression') {
				const expr = item.expression;
				if (expr.type === 'path' && expr.segments.length === 1 && !item.alias) {
					// Simple field reference
					simpleFields.push(expr.segments[0]);
				} else {
					hasExpressions = true;
				}
				expressions.push(this.compileSelectExpression(item));
			}
		}

		if (!hasExpressions) {
			return { type: 'fields', fields: simpleFields };
		}

		return { type: 'expressions', columns: expressions };
	}

	private compileSelectExpression(item: NqlSelectItem): ExpressionIntent {
		if (item.type === 'star') {
			// Note: SELECT * at expression level - return as column with special marker
			return { kind: 'column', column: '*' };
		}

		if (item.type === 'relationStar') {
			// relation.* - use relationColumn with '*' as column
			const relation = item.relation.join('.');
			return {
				kind: 'relationColumn',
				relation,
				column: '*',
				as: `${relation}.*`,
			};
		}

		const expr = item.expression;

		// Check for functions (aggregate or regular)
		if (expr.type === 'function') {
			const fn = expr.name.toLowerCase();
			if (isAggregateFunction(fn)) {
				let field: string;
				if (expr.args.length === 0) {
					// Only count() without args is valid (COUNT(*))
					if (fn === 'count') {
						field = '*';
					} else {
						throw new Error(
							`Aggregate function ${fn}() requires at least one argument`,
						);
					}
				} else {
					// Try simple field first, fall back to SQL expression for complex args
					// e.g., sum(price * qty) → field = "(price * qty)"
					field =
						this.expressionToField(expr.args[0]) ??
						this.expressionToSql(expr.args[0]);
				}
				// Collect extra arguments for multi-arg aggregates (e.g., string_agg)
				// Use expressionToField first for column refs, fallback to expressionToValue
				const extraArgs =
					expr.args.length > 1
						? expr.args
								.slice(1)
								.map(
									(a) => this.expressionToField(a) ?? this.expressionToValue(a),
								)
						: undefined;
				return {
					kind: 'aggregate',
					function: fn as AggregateFunction,
					field,
					as: item.alias,
					...(extraArgs && { extraArgs }),
				};
			}
			// Non-aggregate function (e.g., now(), upper(), coalesce())
			// Use expressionToField first for column refs, fallback to expressionToValue
			return {
				kind: 'function',
				name: expr.name,
				args: expr.args.map(
					(a) => this.expressionToField(a) ?? this.expressionToValue(a),
				),
				as: item.alias,
			};
		}

		// Window expression (e.g., rank() over (partition by x order by y))
		if (expr.type === 'window') {
			const windowExpr = expr as NqlWindowExpression;
			const fn = windowExpr.function.toLowerCase() as WindowFunction;

			// For aggregate window functions (sum, avg, etc.), get the field
			let field: string | undefined;
			if (windowExpr.args.length > 0) {
				field =
					this.expressionToField(windowExpr.args[0]) ??
					this.expressionToSql(windowExpr.args[0]);
			}

			// Convert partition by expressions to field names
			const partitionBy =
				windowExpr.partitionBy.length > 0
					? windowExpr.partitionBy.map(
							(e) => this.expressionToField(e) ?? this.expressionToSql(e),
						)
					: undefined;

			// Convert order by to WindowOrderBy format
			const orderBy =
				windowExpr.orderBy.length > 0
					? windowExpr.orderBy.map((o) => ({
							field:
								this.expressionToField(o.expression) ??
								this.expressionToSql(o.expression),
							direction: o.direction,
						}))
					: undefined;

			return {
				kind: 'window',
				function: fn,
				field,
				alias: item.alias ?? fn, // Use function name as default alias
				over: {
					...(partitionBy && { partitionBy }),
					...(orderBy && { orderBy }),
				},
			};
		}

		// Subquery in SELECT (scalar subquery)
		if (expr.type === 'subquery') {
			return {
				kind: 'subquery',
				query: this.compileQuery(expr.query),
				as: item.alias,
			};
		}

		// Simple path expression (single segment, e.g., "name")
		if (expr.type === 'path' && expr.segments.length === 1) {
			const column = expr.segments[0];
			if (item.alias) {
				return { kind: 'columnAlias', column, alias: item.alias };
			}
			return { kind: 'column', column };
		}

		// Path expression with multiple segments (e.g., "customer.name")
		if (expr.type === 'path' && expr.segments.length > 1) {
			const segments = expr.segments;
			const column = segments[segments.length - 1];
			const relation = segments.slice(0, -1).join('.');
			return {
				kind: 'relationColumn',
				relation,
				column,
				as: item.alias ?? `${relation}.${column}`,
			};
		}

		// Binary arithmetic expression (e.g., "price * quantity")
		if (
			expr.type === 'binary' &&
			['+', '-', '*', '/', '%'].includes(expr.operator)
		) {
			const leftField = this.expressionToField(expr.left);
			const rightField = this.expressionToField(expr.right);
			return {
				kind: 'arithmetic',
				left: leftField ?? this.expressionToValue(expr.left),
				operator: expr.operator as '+' | '-' | '*' | '/' | '%',
				right: rightField ?? this.expressionToValue(expr.right),
				as: item.alias,
			};
		}

		// Unary minus expression (e.g., "-price")
		if (expr.type === 'unary') {
			const unary = expr as NqlUnaryExpression;
			if (unary.operator === '-') {
				// Convert -expr to (-1) * expr
				// Use expressionToField first (returns string), fallback to expressionToValue
				// This matches binary arithmetic behavior for consistency
				const operandField = this.expressionToField(unary.operand);
				return {
					kind: 'arithmetic',
					left: -1,
					operator: '*',
					right: operandField ?? this.expressionToValue(unary.operand),
					as: item.alias,
				};
			}
			throw new Error(
				`Unsupported unary operator in SELECT: ${unary.operator}`,
			);
		}

		// All expression types should be handled above
		// If we reach here, it's an unhandled expression type
		throw new Error(
			`Unsupported expression type in SELECT: ${expr.type}. ` +
				`This expression cannot be compiled to IntentAST. ` +
				`Consider extending the grammar or using a supported expression.`,
		);
	}

	private compileWithClause(clause: NqlWithClause): readonly IncludeIntent[] {
		return clause.joins.map((join) => this.compileJoinSpec(join));
	}

	private compileJoinSpec(join: NqlJoinSpec): IncludeIntent {
		// Build result with optional via and where (both can coexist)
		return {
			relation: join.relation,
			...(join.via && { via: join.via }),
			...(join.condition && { where: this.compileExpression(join.condition) }),
		};
	}

	private compileGroupByClause(clause: NqlGroupByClause): readonly string[] {
		return clause.expressions.map((expr) => {
			if (expr.type === 'path') {
				return expr.segments.join('.');
			}
			// For complex expressions, return string representation
			return this.expressionToSql(expr);
		});
	}

	private compileOrderByClause(
		clause: NqlOrderByClause,
	): readonly OrderByIntent[] {
		return clause.items.map((item) => this.compileOrderItem(item));
	}

	private compileOrderItem(item: NqlOrderItem): OrderByIntent {
		// Try to get field from path expression
		const field = this.expressionToField(item.expression);
		if (field) {
			return { field, direction: item.direction };
		}

		// For complex expressions (aggregates, arithmetic), use SQL representation
		const sqlExpr = this.expressionToSql(item.expression);
		return { field: sqlExpr, direction: item.direction };
	}

	private compileExpression(expr: NqlExpression): WhereIntent {
		switch (expr.type) {
			case 'binary': {
				const binary = expr as NqlBinaryExpression;
				if (binary.operator === 'and') {
					return {
						kind: 'and',
						conditions: [
							this.compileExpression(binary.left),
							this.compileExpression(binary.right),
						],
					};
				}
				if (binary.operator === 'or') {
					return {
						kind: 'or',
						conditions: [
							this.compileExpression(binary.left),
							this.compileExpression(binary.right),
						],
					};
				}
				// Arithmetic binary → comparison context shouldn't reach here
				throw new Error(
					`Unsupported binary operator in WHERE: ${binary.operator}`,
				);
			}

			case 'unary': {
				const unary = expr as NqlUnaryExpression;
				if (unary.operator === 'not') {
					return {
						kind: 'not',
						condition: this.compileExpression(unary.operand),
					};
				}
				throw new Error(`Unsupported unary operator: ${unary.operator}`);
			}

			case 'comparison': {
				const comp = expr as NqlComparisonExpression;
				const field = this.expressionToField(comp.left);
				if (!field) {
					throw new Error('Left side of comparison must be a field reference');
				}

				// Handle LIKE specially
				if (comp.operator === 'like') {
					const pattern = this.expressionToValue(comp.right);
					return {
						kind: 'like',
						field,
						pattern: String(pattern),
					};
				}

				const operator = this.mapComparisonOperator(comp.operator);
				const value = this.expressionToValue(comp.right);

				return {
					kind: 'comparison',
					field,
					operator,
					value,
				};
			}

			case 'rangeOp': {
				const rangeExpr = expr as NqlRangeOpExpression;
				const field = this.expressionToField(rangeExpr.left);
				if (!field) {
					throw new Error(
						'Left side of range operator must be a field reference',
					);
				}
				// Handle both range literals and scalar values
				let rangeValue: string | unknown;
				// Type assertion needed: NqlRangeOpExpression now has optional 'scalar' field
				const rangeWithScalar = rangeExpr as unknown as {
					range?: NqlRangeLiteral;
					scalar?: NqlExpression;
				};
				if (rangeWithScalar.range) {
					rangeValue = this.expressionToRangeValue(rangeWithScalar.range);
				} else if (rangeWithScalar.scalar) {
					// Scalar value for "contains" operator (e.g., contains 25)
					rangeValue = this.expressionToValue(rangeWithScalar.scalar);
				} else {
					throw new Error(
						'Range operator requires either a range literal or scalar value',
					);
				}
				return {
					kind: 'range',
					field,
					operator: rangeExpr.operator,
					value: rangeValue,
				} as WhereRangeIntent;
			}

			case 'in': {
				const inExpr = expr as NqlInExpression;
				const field = this.expressionToField(inExpr.expression);
				if (!field) {
					throw new Error('IN expression must reference a field');
				}

				let values: unknown[];
				if (Array.isArray(inExpr.values)) {
					values = inExpr.values.map((v) => this.expressionToValue(v));
				} else if (
					'type' in inExpr.values &&
					inExpr.values.type === 'subquery'
				) {
					throw new Error('Subquery in IN clause not yet supported');
				} else if (
					'type' in inExpr.values &&
					inExpr.values.type === 'dateRange'
				) {
					// Date range requires semantic expansion (future)
					throw new Error('Date range in IN clause not yet supported');
				} else {
					values = [];
				}

				const result: WhereInIntent = {
					kind: 'in',
					field,
					values,
				};

				if (inExpr.negated) {
					return { kind: 'not', condition: result };
				}

				return result;
			}

			case 'between': {
				const between = expr as NqlBetweenExpression;
				const field = this.expressionToField(between.expression);
				if (!field) {
					throw new Error('BETWEEN expression must reference a field');
				}

				return {
					kind: 'range',
					field,
					operator: 'between',
					value: {
						lower: this.expressionToValue(between.low),
						upper: this.expressionToValue(between.high),
					},
				};
			}

			case 'isNull': {
				const isNull = expr as NqlIsNullExpression;
				const field = this.expressionToField(isNull.expression);
				if (!field) {
					throw new Error('IS NULL expression must reference a field');
				}

				return {
					kind: 'null',
					field,
					operator: isNull.negated ? 'isNotNull' : 'isNull',
				};
			}

			case 'exists': {
				// EXISTS (subquery) syntax is parsed but not yet fully supported
				// IntentAST WhereExistsIntent requires a relation name, not arbitrary subqueries
				// Use: table | with relation | where ... instead
				throw new Error(
					'EXISTS (subquery) is not yet supported in NQL. ' +
						'Use relation-based filtering: table | with relation | where ... ' +
						'or consider using a correlated subquery pattern.',
				);
			}

			default:
				throw new Error(`Unsupported expression type in WHERE: ${expr.type}`);
		}
	}

	private compileMutationPipeline(
		pipeline: NqlMutationPipeline,
	): CompileResult {
		const mutation = this.compileMutation(pipeline.mutation);

		// Extract RETURNING from select clauses
		let returning: readonly string[] | undefined;
		for (const clause of pipeline.clauses) {
			if (clause.type === 'select') {
				returning = this.extractReturningColumns(clause);
			}
		}

		if (returning) {
			// Add returning to the mutation
			return {
				mutation: { ...mutation, returning } as MutationIntent,
			};
		}

		return { mutation };
	}

	private compileMutation(
		mutation: NqlInsert | NqlUpdate | NqlDelete | NqlUpsert,
	): MutationIntent {
		switch (mutation.type) {
			case 'insert':
				return this.compileInsert(mutation);
			case 'update':
				return this.compileUpdate(mutation);
			case 'delete':
				return this.compileDelete(mutation);
			case 'upsert':
				return this.compileUpsert(mutation);
		}
	}

	private compileInsert(insert: NqlInsert): InsertIntent {
		const values: Record<string, unknown> = {};
		for (const assignment of insert.assignments) {
			values[assignment.column] = this.expressionToValue(assignment.value);
		}

		return {
			type: 'insert',
			table: insert.table,
			values: [values],
		};
	}

	private compileUpdate(update: NqlUpdate): UpdateIntent {
		const set: Record<string, unknown> = {};
		for (const assignment of update.assignments) {
			set[assignment.column] = this.expressionToValue(assignment.value);
		}

		if (update.where) {
			return {
				type: 'update',
				table: update.table,
				set,
				where: this.compileExpression(update.where),
			};
		}

		return {
			type: 'update',
			table: update.table,
			set,
			allowAll: true,
		};
	}

	private compileDelete(del: NqlDelete): DeleteIntent {
		if (del.where) {
			return {
				type: 'delete',
				table: del.table,
				where: this.compileExpression(del.where),
			};
		}

		return {
			type: 'delete',
			table: del.table,
			allowAll: true,
		};
	}

	private compileUpsert(upsert: NqlUpsert): UpsertIntent {
		const values: Record<string, unknown> = {};
		for (const assignment of upsert.assignments) {
			values[assignment.column] = this.expressionToValue(assignment.value);
		}

		return {
			type: 'upsert',
			table: upsert.table,
			values: [values],
			onConflict: { columns: upsert.conflictColumns },
			action: { type: 'doUpdate', set: values },
		};
	}

	private extractReturningColumns(clause: NqlSelectClause): readonly string[] {
		const columns: string[] = [];

		for (const item of clause.items) {
			if (item.type === 'star') {
				// * means return all columns - adapter will handle
				return ['*'];
			}
			if (item.type === 'expression') {
				const field = this.expressionToField(item.expression);
				if (field) {
					columns.push(item.alias ?? field);
				}
			}
		}

		return columns;
	}

	private expressionToField(expr: NqlExpression): string | null {
		if (expr.type === 'path') {
			return expr.segments.join('.');
		}
		return null;
	}

	private expressionToValue(expr: NqlExpression): unknown {
		switch (expr.type) {
			case 'string':
				return expr.value;
			case 'number':
				return expr.value;
			case 'boolean':
				return expr.value;
			case 'null':
				return null;
			case 'path':
				// Path in value context → treat as field reference (for computed columns)
				return { $ref: expr.segments.join('.') };
			case 'function': {
				// Function call in value context → special value
				return {
					$fn: expr.name,
					$args: expr.args.map((a) => this.expressionToValue(a)),
				};
			}
			case 'binary': {
				// Arithmetic expression → special value
				const binary = expr as NqlBinaryExpression;
				return {
					$op: binary.operator,
					$left: this.expressionToValue(binary.left),
					$right: this.expressionToValue(binary.right),
				};
			}
			case 'unary': {
				// Unary expression (e.g., -price, -5)
				const unary = expr as NqlUnaryExpression;
				if (unary.operator === '-') {
					const operand = this.expressionToValue(unary.operand);
					// Optimize: if operand is a number, negate it directly
					if (typeof operand === 'number') {
						return -operand;
					}
					// Otherwise, represent as multiplication by -1
					return {
						$op: '*',
						$left: -1,
						$right: operand,
					};
				}
				// 'not' operator shouldn't reach here (handled in compileExpression)
				throw new Error(
					`Unsupported unary operator in value context: ${unary.operator}`,
				);
			}
			default:
				throw new Error(`Cannot convert ${expr.type} to value`);
		}
	}

	/**
	 * Extract range value from expression (for range operators)
	 * Returns either the raw range literal string or a scalar value
	 */
	private expressionToRangeValue(expr: NqlExpression): string {
		if (expr.type === 'rangeLiteral') {
			const range = expr as NqlRangeLiteral;
			return range.value;
		}
		// For scalar values (e.g., `contains 25`), convert to string
		if (expr.type === 'number') {
			return String(expr.value);
		}
		if (expr.type === 'string') {
			return expr.value;
		}
		throw new Error(
			`Range operator requires a range literal or scalar value, got ${expr.type}`,
		);
	}

	private expressionToSql(expr: NqlExpression): string {
		switch (expr.type) {
			case 'path':
				return expr.segments.join('.');
			case 'string':
				return `'${expr.value.replace(/'/g, "''")}'`;
			case 'number':
				return String(expr.value);
			case 'boolean':
				return expr.value ? 'true' : 'false';
			case 'null':
				return 'NULL';
			case 'function':
				return `${expr.name}(${expr.args.map((a) => this.expressionToSql(a)).join(', ')})`;
			case 'binary': {
				const binary = expr as NqlBinaryExpression;
				return `(${this.expressionToSql(binary.left)} ${binary.operator} ${this.expressionToSql(binary.right)})`;
			}
			case 'unary': {
				const unary = expr as NqlUnaryExpression;
				return `${unary.operator} ${this.expressionToSql(unary.operand)}`;
			}
			default:
				return String(expr);
		}
	}

	private mapComparisonOperator(
		op: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
	): ComparisonOperator {
		switch (op) {
			case '=':
				return 'eq';
			case '!=':
				return 'neq';
			case '<':
				return 'lt';
			case '>':
				return 'gt';
			case '<=':
				return 'lte';
			case '>=':
				return 'gte';
			default:
				throw new Error(`Cannot map operator ${op} to ComparisonOperator`);
		}
	}
}

function isAggregateFunction(name: string): boolean {
	return [
		'count',
		'sum',
		'avg',
		'min',
		'max',
		'array_agg',
		'string_agg',
	].includes(name.toLowerCase());
}

/**
 * Create a compiler instance
 */
export function createCompiler(): NqlCompiler {
	return new NqlCompiler();
}
