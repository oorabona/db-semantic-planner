/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
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
	FieldRef,
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
import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
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
	NqlLimitClause,
	NqlMutationPipeline,
	NqlNumberLiteral,
	NqlOffsetClause,
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
	NqlWhereClause,
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
 * Duck-type interface for schema-based column validation.
 * Loose coupling: ModelIR from @dbsp/core satisfies this shape without direct import.
 */
export interface ColumnValidatorSchema {
	getTable(name: string):
		| {
				readonly columns: readonly { readonly name: string }[];
				readonly pseudoColumns?: readonly {
					readonly parentRole: string;
					readonly childRole: string;
				}[];
		  }
		| undefined;
	getRelationsFrom(
		sourceTable: string,
	): readonly { readonly name: string; readonly target: string }[];
}

/**
 * Validates column references against the schema.
 * When no schema is provided, validation is skipped (backward compat).
 */
class ColumnValidator {
	constructor(private readonly schema: ColumnValidatorSchema) {}

	validateColumn(table: string, column: string): void {
		if (column === '*') return;
		const tableInfo = this.schema.getTable(table);
		if (!tableInfo) return; // Unknown table → graceful degradation
		const exists = tableInfo.columns.some((c) => c.name === column);
		if (!exists) {
			const available = tableInfo.columns.map((c) => c.name).join(', ');
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_UNKNOWN_COLUMN,
				`Column '${column}' does not exist on table '${table}'. Available columns: ${available}`,
			);
		}
	}

	validateTable(table: string): void {
		const tableInfo = this.schema.getTable(table);
		if (!tableInfo) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_UNKNOWN_TABLE,
				`Table '${table}' does not exist in the schema`,
			);
		}
	}

	resolveRelationTarget(
		sourceTable: string,
		relationName: string,
	): string | undefined {
		const relations = this.schema.getRelationsFrom(sourceTable);
		const rel = relations.find((r) => r.name === relationName);
		return rel?.target;
	}
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
	private readonly validator: ColumnValidator | null;
	/** Current root table for column validation context. Set at start of compileQuery/compileMutation. */
	private currentFromTable: string | undefined;
	/** Target table of the current relation filter (for inner scope validation). */
	private currentRelationTarget: string | undefined;

	constructor(options?: NqlCompilerOptions, schema?: ColumnValidatorSchema) {
		const keywords =
			options?.pseudoColumnKeywords ?? DEFAULT_PSEUDO_COLUMN_KEYWORDS;
		this.pseudoColumnKeywords = new Set(keywords.map((k) => k.toLowerCase()));
		const recursive = options?.recursiveKeywords ?? DEFAULT_RECURSIVE_KEYWORDS;
		this.recursiveKeywords = new Set(recursive.map((k) => k.toLowerCase()));
		this.validator = schema ? new ColumnValidator(schema) : null;
	}

	/** Validate a column exists on the given table (no-op if no schema). */
	private validateColumn(table: string, column: string): void {
		this.validator?.validateColumn(table, column);
	}

	/** Validate a table exists in the schema (no-op if no schema). */
	private validateTable(table: string): void {
		this.validator?.validateTable(table);
	}

	/** Resolve the target table of a relation from sourceTable. Returns undefined if not found. */
	private resolveRelationTarget(
		sourceTable: string,
		relationName: string,
	): string | undefined {
		return this.validator?.resolveRelationTarget(sourceTable, relationName);
	}

	/**
	 * Validate a WHERE field reference against the current table context.
	 * Handles dotted paths (relation.column) and aliased context (relation filters).
	 */
	private validateWhereField(
		field: string,
		aliasContext?: string,
		originalExpr?: NqlExpression,
	): void {
		if (!this.validator) return;
		if (aliasContext) {
			// Inside relation filter — determine if field is inner or outer scope
			const isInnerScope =
				originalExpr?.type === 'path' &&
				(originalExpr as NqlPathExpression).segments.length > 1 &&
				(originalExpr as NqlPathExpression).segments[0] === aliasContext;
			if (isInnerScope) {
				// Inner scope → validate against relation's target table
				if (this.currentRelationTarget && !field.includes('.')) {
					this.validateColumn(this.currentRelationTarget, field);
				}
			} else {
				// Outer scope (bare column or non-alias-prefixed) → validate against root table
				if (this.currentFromTable && !field.includes('.')) {
					this.validateColumn(this.currentFromTable, field);
				}
			}
			return;
		}
		// Simple column on root table
		if (this.currentFromTable && !field.includes('.')) {
			this.validateColumn(this.currentFromTable, field);
		}
	}

	/**
	 * Compile an NQL program to IntentAST
	 * Returns the first statement's result (multiple statements = batch mode, TBD)
	 */
	compile(program: NqlProgram): CompileResult {
		if (program.statements.length === 0) {
			return {};
		}

		const stmt = program.statements[0]!;

		if (stmt.type === 'query') {
			return { query: this.compileQuery(stmt) };
		} else if (stmt.type === 'mutationPipeline') {
			return this.compileMutationPipeline(stmt);
		}

		return {};
	}

	private compileQuery(query: NqlQuery): QueryIntent {
		this.currentFromTable = query.table;
		this.validateTable(query.table);

		// Track if we've seen groupBy (for WHERE vs HAVING)
		let groupByIndex = -1;
		for (let i = 0; i < query.clauses.length; i++) {
			if (query.clauses[i]?.type === 'groupBy') {
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
		// NQL: per-include limits (e.g. | limit orders 3)
		const includeLimits = new Map<string, number>();

		for (let i = 0; i < query.clauses.length; i++) {
			const clause = query.clauses[i]!;

			switch (clause.type) {
				case 'where': {
					const condition = this.compileExpression(
						(clause as NqlWhereClause).condition,
					);
					if (groupByIndex >= 0 && i > groupByIndex) {
						havingConditions.push(condition);
					} else if (currentIncludeBatch && currentIncludeBatch.length > 0) {
						// WHERE after WITH: attach to current includes
						// For nested includes, attach to last include in the batch
						const targetInclude =
							currentIncludeBatch[currentIncludeBatch.length - 1]!;
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
					select = this.compileSelectClause(clause as NqlSelectClause);
					distinct = (clause as NqlSelectClause).distinct || undefined;
					break;
				case 'flat':
					// NQL v2.1: | flat forces JOIN strategy for all includes
					// Mark that we want JOIN strategy - this is processed after all clauses
					flatMode = true;
					break;
				case 'groupBy':
					groupBy = this.compileGroupByClause(clause as NqlGroupByClause);
					// Reset include context after groupBy
					currentIncludeBatch = undefined;
					break;
				case 'orderBy':
					orderBy = this.compileOrderByClause(clause as NqlOrderByClause);
					break;
				case 'limit': {
					const lc = clause as NqlLimitClause;
					if (lc.relation) {
						// Per-include limit — collect for later merge
						includeLimits.set(lc.relation, lc.count);
					} else {
						limit = lc.count;
					}
					break;
				}
				case 'offset':
					offset = (clause as NqlOffsetClause).count;
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
				const inc = allIncludes[i]!;
				if (!inc.strategy) {
					// Replace with new object including strategy (avoid mutating readonly)
					allIncludes[i] = { ...inc, strategy: 'flat' } as IncludeIntent;
				}
			}
		}

		// Apply per-include limits
		if (includeLimits.size > 0) {
			for (const [relation, limitCount] of includeLimits) {
				const rootRelation = relation.split('.')[0]!;
				const targetInclude = allIncludes.find(
					(inc) => inc.relation === rootRelation,
				);
				if (!targetInclude) {
					throw new Error(
						`limit for relation '${relation}' specified but '${rootRelation}' is not included in the query`,
					);
				}
				applyIncludeLimit(allIncludes, relation, limitCount);
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
		if (clause.items.length === 1 && clause.items[0]?.type === 'star') {
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
					if (this.currentFromTable) {
						this.validateColumn(this.currentFromTable, expr.segments[0]!);
					}
					simpleFields.push(expr.segments[0]!);
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
						this.expressionToField(expr.args[0]!) ??
						this.expressionToSql(expr.args[0]!);
					// Validate aggregate field if it's a simple column
					if (this.currentFromTable && field !== '*' && !field.includes('.')) {
						this.validateColumn(this.currentFromTable, field);
					}
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
					...(item.alias !== undefined && { as: item.alias }),
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
				...(item.alias !== undefined && { as: item.alias }),
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
					this.expressionToField(windowExpr.args[0]!) ??
					this.expressionToSql(windowExpr.args[0]!);
			}

			// Convert partition by expressions to field names
			const partitionBy =
				windowExpr.partitionBy.length > 0
					? windowExpr.partitionBy.map((e) => {
							const f = this.expressionToField(e) ?? this.expressionToSql(e);
							if (
								this.currentFromTable &&
								!f.includes('.') &&
								!f.includes('(')
							) {
								this.validateColumn(this.currentFromTable, f);
							}
							return f;
						})
					: undefined;

			// Convert order by to WindowOrderBy format
			const orderBy =
				windowExpr.orderBy.length > 0
					? windowExpr.orderBy.map((o) => {
							const f =
								this.expressionToField(o.expression) ??
								this.expressionToSql(o.expression);
							if (
								this.currentFromTable &&
								!f.includes('.') &&
								!f.includes('(')
							) {
								this.validateColumn(this.currentFromTable, f);
							}
							return { field: f, direction: o.direction };
						})
					: undefined;

			return {
				kind: 'window',
				function: fn,
				...(field !== undefined && { field }),
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
				...(item.alias !== undefined && { as: item.alias }),
			};
		}

		// Simple path expression (single segment, e.g., "name")
		if (expr.type === 'path' && expr.segments.length === 1) {
			const column = expr.segments[0]!;
			if (this.currentFromTable) {
				this.validateColumn(this.currentFromTable, column);
			}
			if (item.alias) {
				return { kind: 'columnAlias', column, alias: item.alias };
			}
			return { kind: 'column', column };
		}

		// Path expression with multiple segments (e.g., "customer.name", "parent.name")
		if (expr.type === 'path' && expr.segments.length > 1) {
			const segments = expr.segments;
			const firstSegmentLower = (segments[0] as string).toLowerCase();

			// Check for pseudo-column traversal (parent.name, manager.name, ascendant[3].title, etc.)
			if (this.pseudoColumnKeywords.has(firstSegmentLower)) {
				const firstSegment: string = firstSegmentLower;
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
					this.pseudoColumnKeywords.has((segments[i] as string).toLowerCase())
				) {
					traversals.push((segments[i] as string).toLowerCase());
					i++;
				}

				// Last segment must be a non-keyword target column
				if (i >= segments.length) {
					throw new Error(
						`Pseudo-column path must end with a column name: ${segments.join('.')}`,
					);
				}
				const targetColumn = segments[i]!;
				// Pseudo-columns traverse the same table (self-referential)
				if (this.currentFromTable) {
					this.validateColumn(this.currentFromTable, targetColumn);
				}
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
					traversal: traversals[0]! as PseudoColumnTraversal,
					traversals: traversals as PseudoColumnTraversal[],
					targetColumn,
					as: item.alias ?? defaultAlias,
				};
			}

			// Regular relation path (e.g., customer.name)
			const column = segments[segments.length - 1]!;
			const relation = segments.slice(0, -1).join('.');
			// Validate relation and column on target table
			if (this.currentFromTable && this.validator) {
				const targetTable = this.resolveRelationTarget(
					this.currentFromTable,
					segments[0]!,
				);
				if (targetTable) {
					this.validateColumn(targetTable, column);
				}
			}
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
				...(item.alias !== undefined && { as: item.alias }),
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
					...(item.alias !== undefined && { as: item.alias }),
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
				...(item.alias !== undefined && { as: item.alias }),
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
				const field = expr.segments.join('.');
				if (this.currentFromTable && !field.includes('.')) {
					this.validateColumn(this.currentFromTable, field);
				}
				return field;
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
			if (
				this.currentFromTable &&
				!field.includes('.') &&
				!field.includes('(')
			) {
				this.validateColumn(this.currentFromTable, field);
			}
			return { field, direction: item.direction };
		}

		// For complex expressions (aggregates, arithmetic), use SQL representation
		const sqlExpr = this.expressionToSql(item.expression);
		return { field: sqlExpr, direction: item.direction };
	}

	private compileExpression(
		expr: NqlExpression,
		aliasContext?: string,
		outerAliases?: string[],
	): WhereIntent {
		switch (expr.type) {
			case 'binary': {
				const binary = expr as NqlBinaryExpression;
				if (binary.operator === 'and') {
					return {
						kind: 'and',
						conditions: [
							this.compileExpression(binary.left, aliasContext, outerAliases),
							this.compileExpression(binary.right, aliasContext, outerAliases),
						],
					};
				}
				if (binary.operator === 'or') {
					return {
						kind: 'or',
						conditions: [
							this.compileExpression(binary.left, aliasContext, outerAliases),
							this.compileExpression(binary.right, aliasContext, outerAliases),
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
						condition: this.compileExpression(
							unary.operand,
							aliasContext,
							outerAliases,
						),
					};
				}
				throw new Error(`Unsupported unary operator: ${unary.operator}`);
			}

			case 'comparison': {
				const comp = expr as NqlComparisonExpression;
				const field = this.expressionToField(comp.left, aliasContext);
				if (!field) {
					throw new Error('Left side of comparison must be a field reference');
				}
				// Validate WHERE column on current table context
				this.validateWhereField(field, aliasContext, comp.left);

				// Handle LIKE specially
				if (comp.operator === 'like') {
					const pattern = this.resolveFilterValue(
						comp.right,
						aliasContext,
						outerAliases,
					);
					return {
						kind: 'like',
						field,
						pattern: String(pattern),
					};
				}

				const operator = this.mapComparisonOperator(comp.operator);
				const value = this.resolveFilterValue(
					comp.right,
					aliasContext,
					outerAliases,
				);

				return {
					kind: 'comparison',
					field,
					operator,
					value,
				};
			}

			case 'rangeOp': {
				const rangeExpr = expr as NqlRangeOpExpression;
				const field = this.expressionToField(rangeExpr.left, aliasContext);
				if (!field) {
					throw new Error(
						'Left side of range operator must be a field reference',
					);
				}
				this.validateWhereField(field, aliasContext, rangeExpr.left);
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
					rangeValue = this.resolveFilterValue(
						rangeWithScalar.scalar,
						aliasContext,
						outerAliases,
					);
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
				const field = this.expressionToField(inExpr.expression, aliasContext);
				if (!field) {
					throw new Error('IN expression must reference a field');
				}
				this.validateWhereField(field, aliasContext, inExpr.expression);

				let values: unknown[];
				if (Array.isArray(inExpr.values)) {
					values = inExpr.values.map((v) =>
						this.resolveFilterValue(v, aliasContext, outerAliases),
					);
				} else if (
					'type' in inExpr.values &&
					inExpr.values.type === 'subquery'
				) {
					// Subquery is a full QueryIntent — contextual validation at adapter level
					const subquery = this.compileQuery(inExpr.values.query);

					const result: WhereInIntent = {
						kind: 'in',
						field,
						values: [],
						subquery,
					};

					if (inExpr.negated) {
						return { kind: 'not', condition: result };
					}

					return result;
				} else if (
					'type' in inExpr.values &&
					inExpr.values.type === 'dateRange'
				) {
					// Date range requires semantic date expansion (planned for future release)
					throw new Error(
						'Date range in IN clause is not yet supported. ' +
							'Use explicit BETWEEN instead:\n' +
							'  table | where date between "2024-01-01" and "2024-12-31"',
					);
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
				const field = this.expressionToField(between.expression, aliasContext);
				if (!field) {
					throw new Error('BETWEEN expression must reference a field');
				}
				this.validateWhereField(field, aliasContext, between.expression);

				return {
					kind: 'range',
					field,
					operator: 'between',
					value: {
						lower: this.resolveFilterValue(
							between.low,
							aliasContext,
							outerAliases,
						),
						upper: this.resolveFilterValue(
							between.high,
							aliasContext,
							outerAliases,
						),
					},
				};
			}

			case 'isNull': {
				const isNull = expr as NqlIsNullExpression;
				const field = this.expressionToField(isNull.expression, aliasContext);
				if (!field) {
					throw new Error('IS NULL expression must reference a field');
				}
				this.validateWhereField(field, aliasContext, isNull.expression);

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
					'EXISTS (subquery) is not supported in NQL. ' +
						'Use relation filters instead:\n' +
						'  orders | with customer | where customer.active = true\n' +
						'  orders | where exists(customer, active = true)\n' +
						'These compile to efficient EXISTS subqueries automatically.',
				);
			}

			case 'relationFilter': {
				// SPEC-002: Cross-table relation filters
				const relFilter = expr as NqlRelationFilterExpression;
				// Build alias stack: current aliasContext (if any) becomes an outer alias for nested filters
				const nestedOuterAliases = aliasContext
					? [...(outerAliases ?? []), aliasContext]
					: (outerAliases ?? []);
				// Resolve relation target for inner scope validation (first segment of relation path)
				const prevRelationTarget = this.currentRelationTarget;
				if (this.currentFromTable && this.validator && relFilter.relation[0]) {
					this.currentRelationTarget = this.resolveRelationTarget(
						this.currentFromTable,
						relFilter.relation[0],
					);
				}
				const where = this.compileExpression(
					relFilter.condition,
					relFilter.alias,
					nestedOuterAliases,
				);
				this.currentRelationTarget = prevRelationTarget;
				return {
					kind: 'relationFilter',
					relation: relFilter.relation,
					where,
					mode: relFilter.mode,
					...(relFilter.alias !== undefined && { alias: relFilter.alias }),
				};
			}

			default:
				throw new Error(`Unsupported expression type in WHERE: ${expr.type}`);
		}
	}

	private compileMutationPipeline(
		pipeline: NqlMutationPipeline,
	): CompileResult {
		// Set table context for mutation column validation
		this.currentFromTable = pipeline.mutation.table;

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
		this.validateTable(insert.table);
		const values: Record<string, unknown> = {};
		for (const assignment of insert.assignments) {
			this.validateColumn(insert.table, assignment.column);
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
			...(insertFrom.columns !== undefined && { columns: insertFrom.columns }),
			...(insertFrom.where !== undefined && {
				where: this.compileExpression(insertFrom.where),
			}),
			...(insertFrom.limit !== undefined && { limit: insertFrom.limit }),
		};
	}

	private compileUpdate(update: NqlUpdate): UpdateIntent {
		this.currentFromTable = update.table;
		this.validateTable(update.table);
		const set: Record<string, unknown> = {};
		for (const assignment of update.assignments) {
			this.validateColumn(update.table, assignment.column);
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
		this.currentFromTable = del.table;
		this.validateTable(del.table);
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
		this.validateTable(upsert.table);
		const values: Record<string, unknown> = {};
		for (const assignment of upsert.assignments) {
			this.validateColumn(upsert.table, assignment.column);
			values[assignment.column] = this.expressionToValue(assignment.value);
		}

		// Also validate conflict columns
		for (const col of upsert.conflictColumns) {
			this.validateColumn(upsert.table, col);
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
					if (this.currentFromTable && !field.includes('.')) {
						this.validateColumn(this.currentFromTable, field);
					}
					columns.push(item.alias ?? field);
				}
			}
		}

		return columns;
	}

	private expressionToField(
		expr: NqlExpression,
		aliasContext?: string,
	): string | null {
		if (expr.type === 'path') {
			const segments = expr.segments;
			// Strip relation filter alias prefix (e.g., "o.status" → "status" when alias is "o")
			if (aliasContext && segments.length > 1 && segments[0] === aliasContext) {
				return segments.slice(1).join('.');
			}
			return segments.join('.');
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
	 * Resolve a filter RHS value, producing FieldRef when inside an aliased relation filter.
	 * Outside alias context, delegates to expressionToValue().
	 * Inside alias context, path expressions produce typed FieldRef objects:
	 *   - alias-prefixed path → inner scope (same relation)
	 *   - outer alias-prefixed path → outer scope (parent relation)
	 *   - bare column path → outer scope (root table)
	 */
	private resolveFilterValue(
		expr: NqlExpression,
		aliasContext?: string,
		outerAliases?: string[],
	): unknown {
		// No alias context → standard value resolution (literals, $ref, etc.)
		if (!aliasContext) return this.expressionToValue(expr);

		// Only path expressions can produce FieldRef
		if (expr.type === 'path') {
			const segments = (expr as NqlPathExpression).segments;
			// alias-prefixed: e.g., "r.col" when aliasContext = "r"
			if (segments.length > 1 && segments[0] === aliasContext) {
				const column = segments.slice(1).join('.');
				// Validate inner scope column against relation's target table
				if (this.currentRelationTarget && !column.includes('.')) {
					this.validateColumn(this.currentRelationTarget, column);
				}
				return {
					kind: 'fieldRef',
					column,
					scope: 'inner',
				} satisfies FieldRef;
			}
			// outer alias-prefixed: e.g., "x.col" when outerAliases includes "x"
			const firstSegment = segments[0];
			if (
				outerAliases &&
				firstSegment &&
				segments.length > 1 &&
				outerAliases.includes(firstSegment)
			) {
				const column = segments.slice(1).join('.');
				// Outer alias → validate against root table
				if (this.currentFromTable && !column.includes('.')) {
					this.validateColumn(this.currentFromTable, column);
				}
				return {
					kind: 'fieldRef',
					column,
					scope: 'outer',
					alias: firstSegment,
				} satisfies FieldRef;
			}
			// bare column in aliased context → outer scope reference to root table
			const bareColumn = segments.join('.');
			if (this.currentFromTable && !bareColumn.includes('.')) {
				this.validateColumn(this.currentFromTable, bareColumn);
			}
			return {
				kind: 'fieldRef',
				column: bareColumn,
				scope: 'outer',
			} satisfies FieldRef;
		}

		// Non-path expressions (literals, functions, etc.) → standard value
		return this.expressionToValue(expr);
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
 * Apply a per-include limit to the correct level of a nested include tree.
 * Also sets strategy to 'flat' (LATERAL required for per-parent limiting).
 */
function applyIncludeLimit(
	includes: IncludeIntent[],
	path: string,
	limit: number,
): void {
	const segments = path.split('.');
	const root = segments[0]!;
	const idx = includes.findIndex((inc) => inc.relation === root);
	if (idx === -1) return;

	if (segments.length === 1) {
		// Top-level: apply limit + implicit flat (LATERAL required for per-parent limit)
		includes[idx] = {
			...includes[idx]!,
			limit,
			strategy: 'flat',
		};
	} else {
		// Deep path: force flat on intermediate segment (LATERAL cascade required)
		// and recurse into nested includes
		const nested = [...(includes[idx]!.include ?? [])];
		applyIncludeLimit(nested, segments.slice(1).join('.'), limit);
		includes[idx] = { ...includes[idx]!, strategy: 'flat', include: nested };
	}
}

/**
 * Create a compiler instance
 */
export function createCompiler(
	options?: NqlCompilerOptions,
	schema?: ColumnValidatorSchema,
): NqlCompiler {
	return new NqlCompiler(options, schema);
}
