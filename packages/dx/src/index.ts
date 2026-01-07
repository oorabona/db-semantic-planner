/**
 * @db-semantic-planner/dx
 * Developer Experience enhancements - strict mode, disambiguation, compat helpers.
 */

// Errors
export { AmbiguousRelationError } from './errors.js';

// Types
export type {
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptions,
	QueryBuilder,
	RelationHints,
} from './types.js';

// Factory
export { createOrm } from './orm.js';
