/**
 * Mutation Compilers
 *
 * INSERT, UPDATE, DELETE, and UPSERT statement compilation.
 */

export {
	compileDelete,
	compileInsert,
	compileInsertFrom,
	compileMutation,
	compileUnnestInsert,
	compileUpdate,
	compileUpsertFrom,
	type DeleteConfig,
	type InsertConfig,
	type InsertFromConfig,
	RANGE_TYPES,
	type UpdateConfig,
	type UpsertFromConfig,
} from './mutation-compiler.js';

export {
	buildOnConflictClause,
	type ConflictAction,
	type ConflictTarget,
	compileUpsert,
	conditionalUpdate,
	excludedRef,
	type UpsertConfig,
} from './upsert.js';
