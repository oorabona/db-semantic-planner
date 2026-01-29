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
	compileUpdate,
	type DeleteConfig,
	type InsertConfig,
	type InsertFromConfig,
	type UpdateConfig,
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
