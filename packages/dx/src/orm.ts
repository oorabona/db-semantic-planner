import type {
	IncludeIntent,
	ModelIR,
	PlanOptions,
	PlanReport,
	QueryIntent,
	SelectIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import { AmbiguousPlanError, plan } from '@db-semantic-planner/core';

import { AmbiguousRelationError } from './errors.js';
import type {
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptions,
	QueryBuilder,
} from './types.js';

/**
 * Create an ORM instance with the specified configuration.
 *
 * @param options - Configuration options including model and strictMode
 * @returns An ORM instance for building and planning queries
 *
 * @example
 * ```typescript
 * const orm = createOrm({
 *   model: mySchema,
 *   strictMode: true,  // Throws on ambiguous relations
 * });
 *
 * const plan = orm.query('users')
 *   .include('posts', { via: 'authoredPosts' })
 *   .plan();
 * ```
 */
export function createOrm(options: OrmOptions): OrmInstance {
	const { model, strictMode = false } = options;

	return {
		strictMode,
		query(from: string): QueryBuilder {
			return new QueryBuilderImpl(model, strictMode, from);
		},
	};
}

/**
 * Convert IncludeOptions to IncludeIntent.
 * Handles exactOptionalPropertyTypes by only including defined properties.
 */
function includeOptionsToIntent(
	relation: string,
	options?: IncludeOptions
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

	return intent;
}

/**
 * Convert NestedInclude to IncludeIntent.
 */
function nestedIncludeToIntent(nested: NestedInclude): IncludeIntent {
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
 * Internal query builder implementation.
 */
class QueryBuilderImpl implements QueryBuilder {
	private readonly model: ModelIR;
	private readonly strictMode: boolean;
	private readonly from: string;
	private readonly includes: IncludeIntent[] = [];
	private selectIntent?: SelectIntent;
	private whereIntent?: WhereIntent;

	constructor(model: ModelIR, strictMode: boolean, from: string) {
		this.model = model;
		this.strictMode = strictMode;
		this.from = from;
	}

	include(relation: string, options?: IncludeOptions): QueryBuilder {
		const builder = this.clone();
		builder.includes.push(includeOptionsToIntent(relation, options));
		return builder;
	}

	select(fields: readonly string[]): QueryBuilder {
		const builder = this.clone();
		builder.selectIntent = { type: 'fields', fields: [...fields] };
		return builder;
	}

	where(condition: WhereIntent): QueryBuilder {
		const builder = this.clone();
		builder.whereIntent = condition;
		return builder;
	}

	plan(): PlanReport {
		const intent = this.buildIntent();

		try {
			return plan(intent, this.model);
		} catch (error) {
			if (error instanceof AmbiguousPlanError) {
				return this.handleAmbiguity(error, intent);
			}
			throw error;
		}
	}

	/**
	 * Build the QueryIntent from current state.
	 * Handles exactOptionalPropertyTypes by only including defined properties.
	 */
	private buildIntent(): QueryIntent {
		const intent: QueryIntent = {
			type: 'select',
			from: this.from,
		};

		if (this.selectIntent !== undefined) {
			(intent as { select: SelectIntent }).select = this.selectIntent;
		}
		if (this.whereIntent !== undefined) {
			(intent as { where: WhereIntent }).where = this.whereIntent;
		}
		if (this.includes.length > 0) {
			(intent as { include: readonly IncludeIntent[] }).include = this.includes;
		}

		return intent;
	}

	/**
	 * Handle ambiguity based on strict mode setting.
	 */
	private handleAmbiguity(
		error: AmbiguousPlanError,
		intent: QueryIntent
	): PlanReport {
		if (this.strictMode) {
			// Strict mode: convert to AmbiguousRelationError and throw
			throw new AmbiguousRelationError(
				error.sourceTable,
				error.targetTable,
				error.options
			);
		}

		// Lenient mode: use first relation and add warning
		const firstRelation = error.options[0];
		if (!firstRelation) {
			throw error; // Safety: should never happen
		}

		const disambiguateKey = `${error.sourceTable}.${error.targetTable}`;
		const planOptions: PlanOptions = {
			disambiguate: {
				[disambiguateKey]: firstRelation,
			},
		};

		// Re-plan with disambiguation
		const result = plan(intent, this.model, planOptions);

		// Add warning about automatic disambiguation
		const warning = {
			code: 'AMBIGUOUS_RELATION' as const,
			message:
				`Ambiguous relation to '${error.targetTable}' from '${error.sourceTable}' ` +
				`was automatically resolved to '${firstRelation}'. ` +
				`Available options: ${error.options.join(', ')}.`,
			suggestion: `Use { via: '${firstRelation}' } or another option to make this explicit.`,
		};

		return {
			...result,
			warnings: [...result.warnings, warning],
		};
	}

	/**
	 * Create a shallow clone of this builder.
	 */
	private clone(): QueryBuilderImpl {
		const builder = new QueryBuilderImpl(
			this.model,
			this.strictMode,
			this.from
		);
		builder.includes.push(...this.includes);
		if (this.selectIntent !== undefined) {
			builder.selectIntent = this.selectIntent;
		}
		if (this.whereIntent !== undefined) {
			builder.whereIntent = this.whereIntent;
		}
		return builder;
	}
}
