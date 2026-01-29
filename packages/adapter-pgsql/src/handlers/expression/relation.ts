/**
 * Relation Column Expansion Handlers
 *
 * Handles relation.* column expansion for includes.
 * When selecting from a relation (e.g., posts.* or author.name),
 * expands to the appropriate columns from the joined table.
 *
 * Produces: qualified column references from related tables.
 */

import type { Node, ResTarget } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Relation star handler
 *
 * Expands relation.* to qualified star for the relation's table alias.
 *
 * Produces: relation_alias.*
 */
export const relationStarHandler: ExpressionHandler = {
	types: ['relationStar', 'relation.*', 'expandStar'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const relation = decision.relation ?? decision.expandRelation;

		if (!relation) {
			throw new Error('Relation star handler requires relation name');
		}

		// Look up the alias for this relation from state
		const alias = state.aliases.get(relation) ?? relation;
		const dbAlias = ctx.naming.toDatabase(alias);

		// Return qualified star: alias.*
		return {
			ColumnRef: {
				fields: [{ String: { sval: dbAlias } }, { A_Star: {} }],
			},
		};
	},
};

/**
 * Relation column handler
 *
 * References a specific column from a relation.
 *
 * Produces: relation_alias.column
 */
export const relationColumnHandler: ExpressionHandler = {
	types: ['relationColumn', 'relation.column', 'relCol'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const relation = decision.relation ?? decision.expandRelation;
		const column = decision.column;

		if (!relation) {
			throw new Error('Relation column handler requires relation name');
		}
		if (!column) {
			throw new Error('Relation column handler requires column name');
		}

		// Look up the alias for this relation from state
		const alias = state.aliases.get(relation) ?? relation;

		return columnRef(column, alias, ctx.schema, ctx.naming);
	},
};

/**
 * Relation columns expansion handler
 *
 * Expands a list of columns from a relation into ResTarget nodes.
 * Used when selecting specific columns from a relation.
 *
 * Note: This handler returns an array wrapped in a special container node.
 * The caller must unwrap it appropriately.
 *
 * Produces: Array of ResTarget nodes
 */
export const relationColumnsHandler: ExpressionHandler = {
	types: ['relationColumns', 'expandColumns', 'relCols'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const relation = decision.relation ?? decision.expandRelation;
		const columns = decision.relationColumns ?? decision.columns;

		if (!relation) {
			throw new Error('Relation columns handler requires relation name');
		}
		if (!columns || columns.length === 0) {
			throw new Error('Relation columns handler requires columns array');
		}

		// Look up the alias for this relation from state
		const alias = state.aliases.get(relation) ?? relation;

		// Build the first column reference (handler must return a single node)
		// For multiple columns, the compiler should call this handler multiple times
		// or use a different approach
		const column = columns[0]!;
		const colRef = columnRef(column, alias, ctx.schema, ctx.naming);

		// If there's an alias specified, wrap in ResTarget
		const outputAlias = decision.alias;
		if (outputAlias) {
			const resTarget: ResTarget = {
				val: colRef,
				name: ctx.naming.toDatabase(outputAlias),
			};
			return { ResTarget: resTarget };
		}

		return colRef;
	},
};

/**
 * Relation alias handler
 *
 * References a column from a relation with an output alias.
 *
 * Produces: relation_alias.column AS output_alias
 */
export const relationAliasHandler: ExpressionHandler = {
	types: ['relationAlias', 'relation.column.as', 'relColAs'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const relation = decision.relation ?? decision.expandRelation;
		const column = decision.column;
		const outputAlias = decision.alias;

		if (!relation) {
			throw new Error('Relation alias handler requires relation name');
		}
		if (!column) {
			throw new Error('Relation alias handler requires column name');
		}

		// Look up the alias for this relation from state
		const tableAlias = state.aliases.get(relation) ?? relation;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

		// If no output alias, return just the column ref
		if (!outputAlias) {
			return colRef;
		}

		// Wrap in ResTarget with output alias
		const resTarget: ResTarget = {
			val: colRef,
			name: ctx.naming.toDatabase(outputAlias),
		};

		return { ResTarget: resTarget };
	},
};

/**
 * Prefixed relation column handler
 *
 * References a column from a relation with automatic prefixed alias.
 * Used to avoid column name conflicts when joining multiple tables.
 *
 * Produces: relation_alias.column AS relation_column
 */
export const prefixedRelationColumnHandler: ExpressionHandler = {
	types: ['prefixedRelationColumn', 'prefixedRelCol'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const relation = decision.relation ?? decision.expandRelation;
		const column = decision.column;

		if (!relation) {
			throw new Error(
				'Prefixed relation column handler requires relation name',
			);
		}
		if (!column) {
			throw new Error('Prefixed relation column handler requires column name');
		}

		// Look up the alias for this relation from state
		const tableAlias = state.aliases.get(relation) ?? relation;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

		// Create prefixed output alias: relation_column
		const prefixedAlias = `${relation}_${column}`;

		const resTarget: ResTarget = {
			val: colRef,
			name: ctx.naming.toDatabase(prefixedAlias),
		};

		return { ResTarget: resTarget };
	},
};
