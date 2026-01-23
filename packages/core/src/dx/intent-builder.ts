/**
 * IntentBuilder - Builds QueryIntent AST from builder state.
 *
 * DX-103: Extracted from QueryBuilderImpl to separate intent construction
 * from execution, hydration, and other concerns.
 *
 * @module intent-builder
 */

import type {
	AggregateIntent,
	ExpressionIntent,
	IncludeIntent,
	IncludeRecursiveOptions,
	OrderByIntent,
	OrderedColumn,
	QueryIntent,
	SelectAggregateIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';

import { InvalidOperationError } from './errors.js';
import { and } from './filters.js';
import {
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
import {
	type AggregateOptions,
	type ColumnSpec,
	type ExpressionSpec,
	type IncludeOptionsWithRecursive,
	isExpressionSpec,
	type NestedInclude,
	type OrderByRecord,
	type OrderBySpec,
	type RecursiveIncludeOptions,
	type RelationHints,
	type SortDirection,
} from './types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if options indicate a recursive include.
 */
export function isRecursiveIncludeOptions(
	options?: IncludeOptionsWithRecursive,
): options is RecursiveIncludeOptions {
	return (
		options !== undefined &&
		'recursive' in options &&
		options.recursive === true
	);
}

/**
 * Convert IncludeOptions to IncludeIntent.
 * Handles exactOptionalPropertyTypes by only including defined properties.
 */
export function includeOptionsToIntent(
	relation: string,
	options?: IncludeOptionsWithRecursive,
): IncludeIntent {
	if (!options) {
		return { relation };
	}

	const intent: IncludeIntent = { relation };

	if (options.via !== undefined) {
		(intent as { via: string }).via = options.via;
	}
	if (options.where !== undefined) {
		(intent as { where: WhereIntent }).where = options.where;
	}
	if (options.select !== undefined) {
		(intent as { select: SelectIntent }).select = options.select;
	}
	if (options.include !== undefined && options.include.length > 0) {
		(intent as { include: readonly IncludeIntent[] }).include =
			options.include.map((nested) => nestedIncludeToIntent(nested));
	}

	// Handle recursive options (DX-017)
	if (isRecursiveIncludeOptions(options)) {
		const recursiveOpts: IncludeRecursiveOptions = {};
		// Only set maxDepth if defined
		if (options.maxDepth !== undefined) {
			(recursiveOpts as { maxDepth: number }).maxDepth = options.maxDepth;
		}
		// Convert includeDepth to track.depth
		if (options.includeDepth) {
			(recursiveOpts as { track: { depth: boolean } }).track = { depth: true };
		}
		(intent as { recursive: IncludeRecursiveOptions }).recursive =
			recursiveOpts;
	}

	return intent;
}

/**
 * Convert NestedInclude to IncludeIntent.
 */
export function nestedIncludeToIntent(nested: NestedInclude): IncludeIntent {
	const intent: IncludeIntent = { relation: nested.relation };

	if (nested.via !== undefined) {
		(intent as { via: string }).via = nested.via;
	}
	if (nested.where !== undefined) {
		(intent as { where: WhereIntent }).where = nested.where;
	}
	if (nested.select !== undefined) {
		(intent as { select: SelectIntent }).select = nested.select;
	}
	if (nested.include !== undefined && nested.include.length > 0) {
		(intent as { include: readonly IncludeIntent[] }).include =
			nested.include.map((n) => nestedIncludeToIntent(n));
	}

	return intent;
}

/**
 * Parse dot notation include into nested IncludeIntent.
 *
 * @example
 * 'posts.comments.author' becomes:
 * { relation: 'posts', include: [{ relation: 'comments', include: [{ relation: 'author' }] }] }
 */
export function parseDotNotationInclude(
	path: string,
	options?: IncludeOptionsWithRecursive,
): IncludeIntent {
	const parts = path.split('.');
	if (parts.length === 0) {
		throw new Error('Invalid include path');
	}

	// Build from the end (deepest level) to the beginning
	// Options apply to the deepest (last) relation
	const lastPart = parts[parts.length - 1];
	if (!lastPart) {
		throw new Error('Invalid include path: empty segment');
	}
	let current: IncludeIntent = includeOptionsToIntent(lastPart, options);

	// Work backwards through the path, wrapping each level
	for (let i = parts.length - 2; i >= 0; i--) {
		const part = parts[i];
		if (!part) continue;
		current = { relation: part, include: [current] };
	}

	return current;
}

/**
 * Validate recursive include options.
 * Throws InvalidOperationError if:
 * - Relation is not self-referential (source !== target)
 * - Direction is missing
 * - Direction conflicts with relation cardinality
 */
export function validateRecursiveInclude(
	model: ModelIR,
	sourceTable: string,
	relationName: string,
	options: RecursiveIncludeOptions,
): void {
	// Get the relation from the model
	const qualifiedName = `${sourceTable}.${relationName}`;
	const relation = model.getRelation(qualifiedName);

	if (!relation) {
		// Let the planner handle the "relation not found" error
		return;
	}

	// Check if direction is provided (INV-2)
	if (!options.direction) {
		throw new InvalidOperationError(
			'recursive include',
			`'direction' is required when using recursive: true. ` +
				`Use 'ancestors' for parent traversal or 'descendants' for children traversal.`,
		);
	}

	// Check if relation is self-referential (INV-1, PRE-1)
	if (relation.source !== relation.target) {
		throw new InvalidOperationError(
			'recursive include',
			`Recursive include requires a self-referential relation. ` +
				`Relation '${relationName}' connects '${relation.source}' to '${relation.target}', ` +
				`but both must be the same table for recursive traversal.`,
		);
	}

	// Check direction vs relation type (PRE-2, PRE-3, ERR-3)
	// ancestors requires belongsTo/hasOne (to-one), descendants requires hasMany (to-many)
	const { direction } = options;
	const relType = relation.type;

	if (direction === 'ancestors') {
		// ancestors traversal: follow the "parent" direction (N:1 or 1:1)
		// The relation should be belongsTo or hasOne (e.g., category -> parent category)
		if (relType === 'hasMany' || relType === 'belongsToMany') {
			throw new InvalidOperationError(
				'recursive include',
				`Direction 'ancestors' requires a to-one relation (belongsTo or hasOne). ` +
					`Relation '${relationName}' has type '${relType}'. ` +
					`Use 'descendants' for hasMany/belongsToMany relations.`,
			);
		}
	} else if (direction === 'descendants') {
		// descendants traversal: follow the "children" direction (1:N)
		// The relation should be hasMany (e.g., category -> child categories)
		if (relType === 'belongsTo' || relType === 'hasOne') {
			throw new InvalidOperationError(
				'recursive include',
				`Direction 'descendants' requires a to-many relation (hasMany). ` +
					`Relation '${relationName}' has type '${relType}'. ` +
					`Use 'ancestors' for belongsTo/hasOne relations.`,
			);
		}
	}
}

// ============================================================================
// RecursiveIncludeConfig
// ============================================================================

/**
 * Configuration for a recursive include.
 * Stores the relation name and recursive options for later processing.
 */
export interface RecursiveIncludeConfig {
	readonly relation: string;
	readonly options: RecursiveIncludeOptions;
}

// ============================================================================
// IntentBuilderState
// ============================================================================

/**
 * Internal state for intent building.
 * Encapsulates all the mutable state that gets accumulated via builder methods.
 * Note: Optional properties explicitly allow undefined for exactOptionalPropertyTypes compliance.
 */
export interface IntentBuilderState {
	readonly from: string;
	selectIntent?: SelectIntent | undefined;
	whereIntents: WhereIntent[];
	havingIntents: WhereIntent[];
	includes: IncludeIntent[];
	recursiveIncludes: RecursiveIncludeConfig[];
	aggregates: AggregateIntent[];
	groupByFields: string[];
	orderByIntents: OrderByIntent[];
	limitValue?: number | undefined;
	offsetValue?: number | undefined;
	isDistinct?: boolean | undefined;
}

// ============================================================================
// IntentBuilder
// ============================================================================

/**
 * Builds QueryIntent AST from accumulated state.
 *
 * This class is responsible for:
 * - Accumulating filter, select, include, and ordering state
 * - Converting builder method calls to intent AST nodes
 * - Building the final QueryIntent for planning
 *
 * @typeParam TResult - The expected result type (for type inference)
 */
export class IntentBuilder<TResult = unknown> {
	private readonly model: ModelIR;
	private readonly relationHints: RelationHints;
	readonly state: IntentBuilderState;

	constructor(
		model: ModelIR,
		from: string,
		relationHints: RelationHints = {},
		initialState?: Partial<IntentBuilderState>,
	) {
		this.model = model;
		this.relationHints = relationHints;
		this.state = {
			from,
			whereIntents: initialState?.whereIntents
				? [...initialState.whereIntents]
				: [],
			havingIntents: initialState?.havingIntents
				? [...initialState.havingIntents]
				: [],
			includes: initialState?.includes ? [...initialState.includes] : [],
			recursiveIncludes: initialState?.recursiveIncludes
				? [...initialState.recursiveIncludes]
				: [],
			aggregates: initialState?.aggregates ? [...initialState.aggregates] : [],
			groupByFields: initialState?.groupByFields
				? [...initialState.groupByFields]
				: [],
			orderByIntents: initialState?.orderByIntents
				? [...initialState.orderByIntents]
				: [],
			selectIntent: initialState?.selectIntent,
			limitValue: initialState?.limitValue,
			offsetValue: initialState?.offsetValue,
			isDistinct: initialState?.isDistinct,
		};
	}

	/**
	 * Add an include to the builder.
	 */
	addInclude(relation: string, options?: IncludeOptionsWithRecursive): void {
		// Validate recursive includes (self-referential relations)
		if (isRecursiveIncludeOptions(options)) {
			validateRecursiveInclude(this.model, this.state.from, relation, options);
			// Note: recursive options are now converted to IncludeIntent.recursive
			// by includeOptionsToIntent, no longer stored separately
		}

		// Support dot notation for nested includes: 'posts.comments.author'
		if (relation.includes('.')) {
			this.state.includes.push(parseDotNotationInclude(relation, options));
		} else {
			this.state.includes.push(includeOptionsToIntent(relation, options));
		}
	}

	/**
	 * Set column selection.
	 */
	setColumns(columns: readonly ColumnSpec[]): void {
		// Build ordered columns array (preserves original order)
		const orderedColumns: OrderedColumn[] = [];
		let hasExpressions = false;

		for (const col of columns) {
			if (isExpressionSpec(col)) {
				hasExpressions = true;
				orderedColumns.push({
					type: 'expression',
					expression: (col as ExpressionSpec).intent,
				});
			} else {
				orderedColumns.push({ type: 'field', name: col as string });
			}
		}

		// Use SelectWithExpressionsIntent if we have any expressions
		if (hasExpressions) {
			this.state.selectIntent = {
				type: 'expressions',
				columns: orderedColumns,
			};
		} else {
			// Simple fields only - extract field names
			const fields = orderedColumns.map((c) => (c as { name: string }).name);
			this.state.selectIntent = { type: 'fields', fields };
		}
	}

	/**
	 * Add a WHERE condition.
	 */
	addWhere(condition: WhereIntent | WhereFilter<TResult>): void {
		// Convert object filter to WhereIntent if needed
		const intent = isWhereIntent(condition)
			? condition
			: objectToWhereIntent(condition as WhereFilter<Record<string, unknown>>);
		this.state.whereIntents.push(intent);
	}

	/**
	 * Add an aggregate function.
	 * DX-034: Now supports distinct flag for COUNT(DISTINCT field), etc.
	 */
	addAggregate(
		func: 'count' | 'sum' | 'avg' | 'min' | 'max',
		field?: string,
		options?: AggregateOptions & { distinct?: boolean },
	): void {
		const agg: AggregateIntent = { function: func };
		if (field !== undefined) {
			(agg as { field: string }).field = field;
		} else if (options?.field !== undefined) {
			(agg as { field: string }).field = options.field;
		}
		if (options?.as !== undefined) {
			(agg as { as: string }).as = options.as;
		}
		// DX-034: Support distinct aggregates
		if (options?.distinct) {
			(agg as { distinct: boolean }).distinct = true;
		}
		this.state.aggregates.push(agg);
	}

	/**
	 * Add GROUP BY fields.
	 */
	addGroupBy(fields: readonly string[]): void {
		this.state.groupByFields.push(...fields);
	}

	/**
	 * Add a HAVING condition for filtering on aggregates.
	 * DX-034: HAVING is applied after GROUP BY.
	 */
	addHaving(condition: WhereIntent): void {
		this.state.havingIntents.push(condition);
	}

	/**
	 * Set SELECT DISTINCT mode.
	 * DX-034: Deduplicates result rows.
	 */
	setDistinct(value: boolean = true): void {
		this.state.isDistinct = value;
	}

	/**
	 * Add ORDER BY clauses.
	 */
	addOrderBy(
		fieldOrRecordOrSpecs: string | OrderByRecord | readonly OrderBySpec[],
		direction?: SortDirection,
	): void {
		// String form: orderBy('field') or orderBy('field', 'desc')
		if (typeof fieldOrRecordOrSpecs === 'string') {
			this.state.orderByIntents.push({
				field: fieldOrRecordOrSpecs,
				direction: direction ?? 'asc',
			});
			return;
		}

		// Array form: orderBy([{ column, direction, nulls }])
		if (Array.isArray(fieldOrRecordOrSpecs)) {
			for (const spec of fieldOrRecordOrSpecs) {
				this.state.orderByIntents.push({
					field: spec.column,
					direction: spec.direction ?? 'asc',
					nulls: spec.nulls,
				});
			}
			return;
		}

		// Object form: orderBy({ field1: 'desc', field2: 'asc' })
		for (const [field, dir] of Object.entries(fieldOrRecordOrSpecs)) {
			this.state.orderByIntents.push({
				field,
				direction: dir,
			});
		}
	}

	/**
	 * Set LIMIT value.
	 */
	setLimit(count: number): void {
		this.state.limitValue = count;
	}

	/**
	 * Set OFFSET value.
	 */
	setOffset(count: number): void {
		this.state.offsetValue = count;
	}

	/**
	 * Build the QueryIntent from accumulated state.
	 * Handles exactOptionalPropertyTypes by only including defined properties.
	 */
	buildIntent(): QueryIntent {
		const intent: QueryIntent = {
			type: 'select',
			from: this.state.from,
		};

		// Handle aggregates - convert to SelectAggregateIntent
		if (this.state.aggregates.length > 0) {
			const aggregateSelect: SelectAggregateIntent = {
				type: 'aggregate',
				aggregates: [...this.state.aggregates],
			};
			// Add group by fields to the select for projection
			if (this.state.groupByFields.length > 0) {
				(aggregateSelect as { fields: readonly string[] }).fields = [
					...this.state.groupByFields,
				];
			}
			(intent as { select: SelectIntent }).select = aggregateSelect;
		} else if (this.state.selectIntent !== undefined) {
			(intent as { select: SelectIntent }).select = this.state.selectIntent;
		}

		// Combine multiple where conditions with AND
		if (this.state.whereIntents.length === 1) {
			const singleWhere = this.state.whereIntents[0];
			if (singleWhere !== undefined) {
				(intent as { where: WhereIntent }).where = singleWhere;
			}
		} else if (this.state.whereIntents.length > 1) {
			(intent as { where: WhereIntent }).where = and(
				...this.state.whereIntents,
			);
		}

		if (this.state.includes.length > 0) {
			(intent as { include: readonly IncludeIntent[] }).include =
				this.state.includes;
		}

		if (this.state.groupByFields.length > 0) {
			(intent as { groupBy: readonly string[] }).groupBy = [
				...this.state.groupByFields,
			];
		}

		// DX-034: HAVING clause for filtering on aggregates
		if (this.state.havingIntents.length === 1) {
			const singleHaving = this.state.havingIntents[0];
			if (singleHaving !== undefined) {
				(intent as { having: WhereIntent }).having = singleHaving;
			}
		} else if (this.state.havingIntents.length > 1) {
			(intent as { having: WhereIntent }).having = and(
				...this.state.havingIntents,
			);
		}

		// DX-034: SELECT DISTINCT
		if (this.state.isDistinct) {
			(intent as { distinct: boolean }).distinct = true;
		}

		if (this.state.orderByIntents.length > 0) {
			(intent as { orderBy: readonly OrderByIntent[] }).orderBy = [
				...this.state.orderByIntents,
			];
		}

		if (this.state.limitValue !== undefined) {
			(intent as { limit: number }).limit = this.state.limitValue;
		}

		if (this.state.offsetValue !== undefined) {
			(intent as { offset: number }).offset = this.state.offsetValue;
		}

		return intent;
	}

	/**
	 * Apply relation hints to includes that don't have explicit `via`.
	 */
	applyRelationHints(intent: QueryIntent): QueryIntent {
		if (!intent.include || Object.keys(this.relationHints).length === 0) {
			return intent;
		}

		const updatedIncludes = intent.include.map((inc) =>
			this.applyHintToInclude(inc),
		);

		return {
			...intent,
			include: updatedIncludes,
		};
	}

	/**
	 * Apply relation hint to a single include (recursively).
	 */
	private applyHintToInclude(inc: IncludeIntent): IncludeIntent {
		// If already has explicit via, don't override
		if (inc.via !== undefined) {
			// But still process nested includes
			if (inc.include && inc.include.length > 0) {
				return {
					...inc,
					include: inc.include.map((nested) => this.applyHintToInclude(nested)),
				};
			}
			return inc;
		}

		// Check if we have a hint for this target
		const hint = this.relationHints[inc.relation];
		const result: IncludeIntent = hint ? { ...inc, via: hint } : inc;

		// Process nested includes
		if (result.include && result.include.length > 0) {
			return {
				...result,
				include: result.include.map((nested) =>
					this.applyHintToInclude(nested),
				),
			};
		}

		return result;
	}

	/**
	 * Clone the current state for immutable builder pattern.
	 */
	clone(): IntentBuilder<TResult> {
		return new IntentBuilder<TResult>(
			this.model,
			this.state.from,
			{ ...this.relationHints },
			{
				selectIntent: this.state.selectIntent,
				whereIntents: [...this.state.whereIntents],
				includes: [...this.state.includes],
				recursiveIncludes: [...this.state.recursiveIncludes],
				aggregates: [...this.state.aggregates],
				groupByFields: [...this.state.groupByFields],
				orderByIntents: [...this.state.orderByIntents],
				limitValue: this.state.limitValue,
				offsetValue: this.state.offsetValue,
			},
		);
	}
}
