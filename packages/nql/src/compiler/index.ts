/**
 * NQL Compiler
 *
 * Transforms NQL AST to IntentAST.
 *
 * @since ARCH-007: IntentAST types centralized in @dbsp/types to avoid circular dependencies.
 */

// IntentAST types from @dbsp/types (canonical source)
import type {
	AggregateFunction,
	ComparisonOperator,
	DeleteIntent,
	ExpressionIntent,
	IncludeIntent,
	InsertFromIntent,
	InsertIntent,
	MutationIntent,
	NullOperator,
	OrderByIntent,
	PseudoColumnTraversal,
	QueryIntent,
	RangeOperator,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SortDirection,
	UpdateIntent,
	UpsertConflictAction,
	UpsertConflictTarget,
	UpsertIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRangeIntent,
	WhereRelationFilterIntent,
	WindowFunction,
	WindowOrderBy,
} from '@dbsp/types';
import type {
	NqlBetweenExpression,
	NqlBinaryExpression,
	NqlBooleanLiteral,
	NqlCaseExpression,
	NqlComparisonExpression,
	NqlDelete,
	NqlExpression,
	NqlGroupByClause,
	NqlInExpression,
	NqlInsert,
	NqlInsertFrom,
	NqlIsNullExpression,
	NqlMutationPipeline,
	NqlNumberLiteral,
	NqlOrderByClause,
	NqlOrderItem,
	NqlPathExpression,
	NqlProgram,
	NqlQuery,
	NqlRangeLiteral,
	NqlRangeOpExpression,
	NqlRelationFilterExpression,
	NqlSelectClause,
	NqlSelectItem,
	NqlStringLiteral,
	NqlUnaryExpression,
	NqlUpdate,
	NqlUpsert,
	NqlWindowExpression,
} from '../parser/ast.js';

// Re-export all types for backward compatibility
export type {
	AggregateFunction,
	ComparisonOperator,
	DeleteIntent,
	ExpressionIntent,
	IncludeIntent,
	InsertFromIntent,
	InsertIntent,
	MutationIntent,
	NullOperator,
	OrderByIntent,
	PseudoColumnTraversal,
	QueryIntent,
	RangeOperator,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SortDirection,
	UpdateIntent,
	UpsertConflictAction,
	UpsertConflictTarget,
	UpsertIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRangeIntent,
	WhereRelationFilterIntent,
	WindowFunction,
	WindowOrderBy,
};
export interface CompileResult {
	readonly query?: QueryIntent;
	readonly mutation?: MutationIntent;
	readonly returning?: readonly string[];
}

/**
 * Options for the NQL compiler.
 * Allows dynamic pseudo-column keywords from schema configuration.
 */
export interface NqlCompilerOptions {
	/**
	 * All pseudo-column keywords recognized by the compiler.
	 * These are path expression prefixes that trigger self-referential traversal.
	 * @default ['parent', 'child', 'ascendant', 'descendant']
	 * @example ['manager', 'managee', 'ascendant', 'descendant']
	 */
	readonly pseudoColumnKeywords?: readonly string[];

	/**
	 * Subset of pseudo-column keywords that support scoped depth syntax [N].
	 * Only recursive traversals (ascendant/descendant) support this.
	 * @default ['ascendant', 'descendant']
	 */
	readonly recursiveKeywords?: readonly string[];
}

/**
 * Compiler that transforms NQL AST to IntentAST
 */
export class NqlCompiler {
	private readonly pseudoColumnKeywords: Set<string>;
	private readonly recursiveKeywords: Set<string>;

	constructor(options?: NqlCompilerOptions) {
		const keywords =
			options?.pseudoColumnKeywords ?? DEFAULT_PSEUDO_COLUMN_KEYWORDS;
		this.pseudoColumnKeywords = new Set(keywords.map((k) => k.toLowerCase()));
		const recursive = options?.recursiveKeywords ?? DEFAULT_RECURSIVE_KEYWORDS;
		this.recursiveKeywords = new Set(recursive.map((k) => k.toLowerCase()));
	}

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
		// Use mutable array to accumulate includes and track current batch for WHERE association
		const allIncludes: IncludeIntent[] = [];
		let currentIncludeBatch: IncludeIntent[] | undefined;
		let groupBy: readonly string[] | undefined;
		let orderBy: readonly OrderByIntent[] | undefined;
		let limit: number | undefined;
		let offset: number | undefined;
		// NQL v2.1: | flat forces JOIN strategy instead of json_agg
		let flatMode = false;

		for (let i = 0; i < query.clauses.length; i++) {
			const clause = query.clauses[i];

			switch (clause.type) {
				case 'where': {
					const condition = this.compileExpression(clause.condition);
					if (groupByIndex >= 0 && i > groupByIndex) {
						havingConditions.push(condition);
					} else if (currentIncludeBatch && currentIncludeBatch.length > 0) {
						// WHERE after WITH: attach to current includes
						// For nested includes, attach to last include in the batch
						const targetInclude =
							currentIncludeBatch[currentIncludeBatch.length - 1];
						if (targetInclude.where) {
							// Combine with existing where using AND
							(targetInclude as { where: WhereIntent }).where = {
								kind: 'and',
								conditions: [targetInclude.where, condition],
							};
						} else {
							(targetInclude as { where: WhereIntent }).where = condition;
						}
					} else {
						whereConditions.push(condition);
					}
					break;
				}
				case 'select':
					select = this.compileSelectClause(clause);
					distinct = clause.distinct || undefined;
					break;
				case 'flat':
					// NQL v2.1: | flat forces JOIN strategy for all includes
					// Mark that we want JOIN strategy - this is processed after all clauses
					flatMode = true;
					break;
				case 'groupBy':
					groupBy = this.compileGroupByClause(clause);
					// Reset include context after groupBy
					currentIncludeBatch = undefined;
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

		// NQL v2.1: Detect relation paths in SELECT and auto-generate includes
		// Supports deep dotted paths (e.g., userRoles.role.rolePermissions.permission)
		// by building nested IncludeIntent trees.
		if (select && select.type === 'expressions') {
			const relationPaths = new Set<string>();
			for (const expr of select.columns) {
				if (expr.kind === 'relationColumn') {
					relationPaths.add(expr.relation);
				}
			}
			if (relationPaths.size > 0) {
				const nestedIncludes = buildNestedIncludes(relationPaths, flatMode);
				// Merge with existing includes (avoid duplicates at top level)
				for (const inc of nestedIncludes) {
					const exists = allIncludes.some(
						(existing) => existing.relation === inc.relation,
					);
					if (!exists) {
						allIncludes.push(inc);
					}
				}
			}
		}

		// NQL v2.1: Apply flat mode strategy to pre-existing includes (from explicit syntax if any)
		// This handles includes that were created before flatMode was detected
		if (flatMode && allIncludes.length > 0) {
			for (let i = 0; i < allIncludes.length; i++) {
				if (!allIncludes[i].strategy) {
					// Replace with new object including strategy (avoid mutating readonly)
					allIncludes[i] = { ...allIncludes[i], strategy: 'flat' };
				}
			}
		}

		// Use accumulated includes
		const include: readonly IncludeIntent[] | undefined =
			allIncludes.length > 0 ? allIncludes : undefined;

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
					...(expr.distinct && { distinct: true }),
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

		// Path expression with multiple segments (e.g., "customer.name", "parent.name")
		if (expr.type === 'path' && expr.segments.length > 1) {
			const segments = expr.segments;
			const firstSegment = segments[0].toLowerCase();

			// Check for pseudo-column traversal (parent.name, manager.name, ascendant[3].title, etc.)
			if (this.pseudoColumnKeywords.has(firstSegment)) {
				const depthHint = expr.type === 'path' ? expr.depthHint : undefined;

				// Validate depthHint: only recursive traversals support scoped depth
				if (depthHint !== undefined) {
					if (!this.recursiveKeywords.has(firstSegment)) {
						throw new Error(
							`Scoped depth [${depthHint}] is not supported on '${firstSegment}'. ` +
								`Only recursive traversals support depth hints.`,
						);
					}
					if (!Number.isFinite(depthHint) || depthHint < 1 || depthHint > 100) {
						throw new Error(
							`Invalid depth hint [${depthHint}]: must be an integer between 1 and 100.`,
						);
					}
				}

				// Collect all consecutive pseudo-column keywords as traversals
				// e.g., parent.parent.name → traversals=['parent','parent'], targetColumn='name'
				// e.g., parent.name → traversals=['parent'], targetColumn='name'
				const traversals: string[] = [firstSegment];
				let i = 1;
				while (
					i < segments.length &&
					this.pseudoColumnKeywords.has(segments[i].toLowerCase())
				) {
					traversals.push(segments[i].toLowerCase());
					i++;
				}

				// Last segment must be a non-keyword target column
				if (i >= segments.length) {
					throw new Error(
						`Pseudo-column path must end with a column name: ${segments.join('.')}`,
					);
				}
				const targetColumn = segments[i];
				const defaultAlias = segments.map((s) => s.toLowerCase()).join('.');

				if (traversals.length === 1) {
					// Simple single-hop: parent.name
					return {
						kind: 'pseudoColumn',
						traversal: firstSegment as PseudoColumnTraversal,
						targetColumn,
						as: item.alias ?? defaultAlias,
						...(depthHint !== undefined && { depth: depthHint }),
					};
				}

				// Chained multi-hop: parent.parent.name
				return {
					kind: 'pseudoColumn',
					traversal: traversals[0] as PseudoColumnTraversal,
					traversals: traversals as PseudoColumnTraversal[],
					targetColumn,
					as: item.alias ?? defaultAlias,
				};
			}

			// Regular relation path (e.g., customer.name)
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

		// CASE expression (e.g., "case when price > 100 then 'high' else 'low' end")
		if (expr.type === 'case') {
			const caseExpr = expr as NqlCaseExpression;
			return {
				kind: 'case' as const,
				when: caseExpr.whenClauses.map((wc) => ({
					condition: this.compileExpressionToIntent(wc.condition),
					result: this.compileExpressionToIntent(wc.result),
				})),
				...(caseExpr.elseClause && {
					else: this.compileExpressionToIntent(caseExpr.elseClause),
				}),
				as: item.alias,
			};
		}

		// All expression types should be handled above
		// If we reach here, it's an unhandled expression type
		throw new Error(
			`Unsupported expression type in SELECT: ${expr.type}. ` +
				`This expression cannot be compiled to IntentAST. ` +
				`Consider extending the grammar or using a supported expression.`,
		);
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

			case 'relationFilter': {
				// SPEC-002: Cross-table relation filters
				const relFilter = expr as NqlRelationFilterExpression;
				return {
					kind: 'relationFilter',
					relation: relFilter.relation,
					where: this.compileExpression(relFilter.condition),
					mode: relFilter.mode,
					alias: relFilter.alias,
				};
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
		mutation: NqlInsert | NqlInsertFrom | NqlUpdate | NqlDelete | NqlUpsert,
	): MutationIntent {
		switch (mutation.type) {
			case 'insert':
				return this.compileInsert(mutation);
			case 'insert_from':
				return this.compileInsertFrom(mutation);
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

	private compileInsertFrom(insertFrom: NqlInsertFrom): InsertFromIntent {
		return {
			type: 'insert_from',
			table: insertFrom.table,
			source: insertFrom.source,
			columns: insertFrom.columns,
			where: insertFrom.where
				? this.compileExpression(insertFrom.where)
				: undefined,
			limit: insertFrom.limit,
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

	/**
	 * Compile an NqlExpression to ExpressionIntent for use in CASE conditions/results.
	 * Handles comparison expressions (for WHEN conditions) and literals/columns (for THEN/ELSE).
	 */
	private compileExpressionToIntent(expr: NqlExpression): ExpressionIntent {
		// Handle comparison expressions (for CASE WHEN conditions)
		if (expr.type === 'comparison') {
			const cmp = expr as NqlComparisonExpression;
			// Left side should be a path (column reference)
			if (cmp.left.type !== 'path') {
				throw new Error(
					`CASE WHEN condition left side must be a column path, got ${cmp.left.type}`,
				);
			}
			const column = (cmp.left as NqlPathExpression).segments.join('.');
			const value = this.expressionToValue(cmp.right);
			return {
				kind: 'comparison',
				column,
				operator: cmp.operator,
				value,
			};
		}

		// Handle literal values (string, number, boolean, null)
		if (
			expr.type === 'string' ||
			expr.type === 'number' ||
			expr.type === 'boolean' ||
			expr.type === 'null'
		) {
			const value =
				expr.type === 'null'
					? null
					: (expr as NqlStringLiteral | NqlNumberLiteral | NqlBooleanLiteral)
							.value;
			return {
				kind: 'literal',
				value,
			};
		}

		// For other expressions (columns, functions, etc.), wrap and use compileSelectExpression
		const selectItem: NqlSelectItem = {
			type: 'expression',
			expression: expr,
		};
		return this.compileSelectExpression(selectItem);
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
 * Default pseudo-column keywords for self-referential traversal.
 * These can be overridden via NqlCompilerOptions.pseudoColumnKeywords.
 */
const DEFAULT_PSEUDO_COLUMN_KEYWORDS: readonly string[] = [
	'parent',
	'child',
	'ascendant',
	'descendant',
];

/**
 * Default recursive keywords that support scoped depth syntax [N].
 * These can be overridden via NqlCompilerOptions.recursiveKeywords.
 */
const DEFAULT_RECURSIVE_KEYWORDS: readonly string[] = [
	'ascendant',
	'descendant',
];

/**
 * Build nested IncludeIntent[] from a set of dotted relation paths.
 *
 * Given paths like:
 *   - "userRoles.role"
 *   - "userRoles.role.rolePermissions.permission"
 *
 * Produces:
 *   [{ relation: "userRoles", include: [
 *     { relation: "role", include: [
 *       { relation: "rolePermissions", include: [
 *         { relation: "permission" }
 *       ]}
 *     ]}
 *   ]}]
 *
 * Strategy-agnostic: the planner/adapter decides execution strategy.
 * flatMode propagates to all levels when enabled.
 */
function buildNestedIncludes(
	paths: Set<string>,
	flatMode: boolean,
): IncludeIntent[] {
	// Build a tree structure from all paths
	interface TreeNode {
		children: Map<string, TreeNode>;
	}
	const root: TreeNode = { children: new Map() };

	for (const path of paths) {
		const segments = path.split('.');
		let node = root;
		for (const segment of segments) {
			if (!node.children.has(segment)) {
				node.children.set(segment, { children: new Map() });
			}
			node = node.children.get(segment)!;
		}
	}

	// Convert tree to nested IncludeIntent[]
	function treeToIncludes(node: TreeNode): IncludeIntent[] {
		const includes: IncludeIntent[] = [];
		for (const [relation, child] of node.children) {
			const childIncludes = treeToIncludes(child);
			const include: IncludeIntent = {
				relation,
				...(flatMode ? { strategy: 'flat' as const } : {}),
				...(childIncludes.length > 0 ? { include: childIncludes } : {}),
			};
			includes.push(include);
		}
		return includes;
	}

	return treeToIncludes(root);
}

/**
 * Create a compiler instance
 */
export function createCompiler(options?: NqlCompilerOptions): NqlCompiler {
	return new NqlCompiler(options);
}
