/**
 * Mutation Compilers
 *
 * INSERT, UPDATE, DELETE, and UPSERT statement compilation.
 */

export {
	type BatchUpdateConfig,
	compileDelete,
	compileInsert,
	compileInsertFrom,
	compileMutation,
	compileUnnestInsert,
	compileUnnestUpdate,
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
	compileUnnestUpsert,
	compileUpsert,
	conditionalUpdate,
	excludedRef,
	type UpsertConfig,
} from './upsert.js';
