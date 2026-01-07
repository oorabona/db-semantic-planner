/**
 * @db-semantic-planner/dx
 * Developer Experience enhancements - strict mode, disambiguation, compat helpers.
 */

// Re-export types from adapter for dump()
export type { Dump, DumpMeta } from '@db-semantic-planner/adapter-kysely';

// Errors
export {
	AmbiguousRelationError,
	ExecutionError,
	NotFoundError,
} from './errors.js';
// Filter Helpers (Drizzle-like)
export {
	// Logical
	and,
	// Comparison
	eq,
	// Relation
	exists,
	gt,
	gte,
	// Array
	inArray,
	// Null
	isNotNull,
	isNull,
	// String
	like,
	lt,
	lte,
	neq,
	not,
	notExists,
	or,
} from './filters.js';

// Factory
export { createOrm } from './orm.js';
// Types
export type {
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptions,
	QueryBuilder,
	RelationHints,
} from './types.js';
