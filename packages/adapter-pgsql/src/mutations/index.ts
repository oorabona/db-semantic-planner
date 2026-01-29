/**
 * Mutation Compilers
 *
 * INSERT, UPDATE, DELETE, and UPSERT statement compilation.
 */

export {
	compileDelete,
	compileInsert,
	compileMutation,
	compileUpdate,
	type DeleteConfig,
	type InsertConfig,
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
