/**
 * @module compiler
 * SQL Compiler - Transforms PlanReport into Kysely queries.
 */

import type {
	ModelIR,
	PlanReport,
	QueryIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import type { CompiledQuery, Kysely, SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';
import { CompilationError } from './errors.js';

// ============================================================================
// Compiler State
// ============================================================================

interface CompilerState {
	/** Current table alias counter */
	aliasCounter: number;
	/** Map of table name to alias */
	tableAliases: Map<string, string>;
	/** Collected parameters */
	parameters: unknown[];
}

// ============================================================================
// Main Compiler
// ============================================================================

/**
 * Compile a PlanReport into a Kysely CompiledQuery
 */
export function compile(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const state: CompilerState = {
		aliasCounter: 0,
		tableAliases: new Map(),
		parameters: [],
	};

	const intent = plan.intent;
	const rootTable = intent.from;

	// Get root alias
	const rootAlias = getNextAlias(state);
	state.tableAliases.set(rootTable, rootAlias);

	// Build the base query
	let query = buildBaseQuery(intent, rootAlias, kysely, schemaName);

	// Add WHERE clause
	if (intent.where) {
		query = addWhere(query, intent.where, rootAlias, model, plan, state);
	}

	// Add ORDER BY
	if (intent.orderBy) {
		for (const order of intent.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			query = query.orderBy(`${rootAlias}.${order.field}`, direction);
		}
	}

	// Add LIMIT
	if (intent.limit !== undefined) {
		query = query.limit(intent.limit);
	}

	// Add OFFSET
	if (intent.offset !== undefined) {
		query = query.offset(intent.offset);
	}

	// Wrap with CTEs if needed
	if (plan.ctes.length > 0) {
		query = addCTEs(query, plan, model, kysely, state);
	}

	return query.compile();
}

// ============================================================================
// Query Building
// ============================================================================

function buildBaseQuery(
	intent: QueryIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const tableName = schemaName ? `${schemaName}.${intent.from}` : intent.from;

	// Start with FROM
	let query = kysely.selectFrom(`${tableName} as ${alias}`);

	// Add SELECT
	if (!intent.select || intent.select.type === 'all') {
		query = query.selectAll(alias);
	} else {
		const fields = intent.select.fields.map((f: string) => `${alias}.${f}`);
		query = query.select(fields);
	}

	return query;
}

// ============================================================================
// WHERE Compilation
// ============================================================================

function addWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	return query.where((eb) =>
		compileWhere(eb, where, alias, model, plan, state),
	);
}

function compileWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	switch (where.kind) {
		case 'comparison':
			return compileComparison(eb, where, alias);

		case 'like':
			return eb(`${alias}.${where.field}`, 'like', where.pattern);

		case 'in':
			return eb(`${alias}.${where.field}`, 'in', where.values);

		case 'null':
			if (where.operator === 'isNull') {
				return eb(`${alias}.${where.field}`, 'is', null);
			}
			return eb(`${alias}.${where.field}`, 'is not', null);

		case 'and':
			return eb.and(
				where.conditions.map((c: WhereIntent) =>
					compileWhere(eb, c, alias, model, plan, state),
				),
			);

		case 'or':
			return eb.or(
				where.conditions.map((c: WhereIntent) =>
					compileWhere(eb, c, alias, model, plan, state),
				),
			);

		case 'not':
			return eb.not(
				compileWhere(eb, where.condition, alias, model, plan, state),
			);

		case 'exists':
			return compileExists(eb, where, alias, model, plan, state, false);

		case 'notExists':
			return compileExists(eb, where, alias, model, plan, state, true);

		case 'relationFilter':
			return compileRelationFilter(eb, where, alias, model, plan, state);

		default:
			throw new CompilationError(
				`Unknown where kind: ${(where as WhereIntent).kind}`,
			);
	}
}

function compileComparison(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		kind: 'comparison';
		field: string;
		operator: string;
		value: unknown;
	},
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	const column = `${alias}.${where.field}`;

	switch (where.operator) {
		case 'eq':
			return eb(column, '=', where.value);
		case 'neq':
			return eb(column, '!=', where.value);
		case 'gt':
			return eb(column, '>', where.value);
		case 'gte':
			return eb(column, '>=', where.value);
		case 'lt':
			return eb(column, '<', where.value);
		case 'lte':
			return eb(column, '<=', where.value);
		default:
			throw new CompilationError(
				`Unknown comparison operator: ${where.operator}`,
			);
	}
}

// ============================================================================
// EXISTS Compilation
// ============================================================================

function compileExists(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: { relation: string; where?: WhereIntent },
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	negate: boolean,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	// Find the relation
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;

	// Try direct lookup first
	let relation = model.getRelation(`${sourceTable}.${where.relation}`);

	// If not found, check if planner resolved it to a different relation name
	// This happens when disambiguate option is used
	if (!relation) {
		// Look for planner decision that resolved this relation
		const decision = plan.decisions.find(
			(d) =>
				d.type === 'filter-strategy' &&
				d.context.sourceTable === sourceTable &&
				d.context.target === where.relation,
		);
		if (decision?.context.relation) {
			relation = model.getRelation(
				`${sourceTable}.${decision.context.relation}`,
			);
		}
	}

	// Also try to find relation by target table (for ambiguous cases resolved by planner)
	if (!relation) {
		const relationsFromSource = model.getRelationsFrom(sourceTable);
		const byTarget = relationsFromSource.filter(
			(r) => r.target === where.relation,
		);
		if (byTarget.length === 1) {
			// Unambiguous - only one relation to target
			relation = byTarget[0];
		}
	}

	if (!relation) {
		throw new CompilationError(
			`Unknown relation: ${sourceTable}.${where.relation}`,
		);
	}

	// Get alias for related table
	const relatedAlias = getNextAlias(state);
	state.tableAliases.set(`${relation.target}_${relatedAlias}`, relatedAlias);

	// Build EXISTS subquery
	// For hasMany: target.foreignKey = source.primaryKey
	// foreignKey can be string or array, take first if array
	const fk = Array.isArray(relation.foreignKey)
		? relation.foreignKey[0]
		: (relation.foreignKey ?? 'id');

	// Get source table's primary key (use relation.source which is same as sourceTable)
	const sourceTableDef = model.getTable(relation.source);
	const sourcePk = sourceTableDef?.primaryKey;
	const sourceKey = Array.isArray(sourcePk)
		? (sourcePk[0] ?? 'id')
		: (sourcePk ?? 'id');

	const subquery = eb
		.selectFrom(`${relation.target} as ${relatedAlias}`)
		.select(sql`1`)
		.whereRef(`${relatedAlias}.${fk}`, '=', `${sourceAlias}.${sourceKey}`);

	// Add nested WHERE if present
	let finalSubquery = subquery;
	if (where.where) {
		finalSubquery = subquery.where((innerEb: unknown) =>
			compileWhere(
				innerEb,
				where.where as WhereIntent,
				relatedAlias,
				model,
				plan,
				state,
			),
		);
	}

	if (negate) {
		return eb.not(eb.exists(finalSubquery));
	}
	return eb.exists(finalSubquery);
}

function compileRelationFilter(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		relation: string;
		where: WhereIntent;
		mode: 'some' | 'every' | 'none';
	},
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	switch (where.mode) {
		case 'some':
			return compileExists(
				eb,
				{ relation: where.relation, where: where.where },
				sourceAlias,
				model,
				plan,
				state,
				false,
			);

		case 'none':
			return compileExists(
				eb,
				{ relation: where.relation, where: where.where },
				sourceAlias,
				model,
				plan,
				state,
				true,
			);

		case 'every': {
			// every = NOT EXISTS (records that DON'T match)
			// Implemented as: NOT EXISTS (SELECT 1 FROM rel WHERE NOT (condition))
			const invertedWhere: WhereIntent = {
				kind: 'not',
				condition: where.where,
			};
			return compileExists(
				eb,
				{ relation: where.relation, where: invertedWhere },
				sourceAlias,
				model,
				plan,
				state,
				true,
			);
		}
	}
}

// ============================================================================
// CTE Compilation
// ============================================================================

function addCTEs(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	_plan: PlanReport,
	_model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	_kysely: Kysely<any>,
	_state: CompilerState,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	// For now, CTEs are informational in the plan
	// The actual CTE generation would require more complex query restructuring
	// This is a placeholder that adds a comment about CTEs

	// In a full implementation, we would:
	// 1. Extract the common subquery from plan.ctes
	// 2. Use Kysely's .with() to add CTEs
	// 3. Reference CTEs in the main query

	// For MVP, we'll handle simple cases where CTEs are detected but not extracted
	// The plan.ctes array tells us what SHOULD be extracted

	return query;
}

// ============================================================================
// Utilities
// ============================================================================

function getNextAlias(state: CompilerState): string {
	const alias = `t${state.aliasCounter}`;
	state.aliasCounter++;
	return alias;
}

function getTableFromAlias(
	state: CompilerState,
	alias: string,
): string | undefined {
	for (const [table, a] of state.tableAliases) {
		if (a === alias) {
			// Handle compound keys like "posts_t1"
			const parts = table.split('_');
			if (parts.length > 1 && parts[parts.length - 1]?.startsWith('t')) {
				return parts.slice(0, -1).join('_');
			}
			return table;
		}
	}
	return undefined;
}
