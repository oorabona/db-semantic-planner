// @ts-nocheck — coverage test: runtime assertions on mutation compiler
/**
 * Coverage tests for mutation-compiler.ts
 * Focus: Branch coverage for INSERT, UPDATE, DELETE, UPSERT compilation with all variants
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import {
	buildReturningExprs,
	compileDelete,
	compileInsert,
	compileInsertFrom,
	compileMutation,
	compileUpdate,
	compileUpsertFrom,
	RANGE_TYPES,
} from './mutation-compiler.js';

describe('mutation-compiler - coverage', () => {
	const naming = new CamelCaseNamingPlugin();
	const ctx = { naming, rootTable: 'users', schema: undefined };
	const state = { parameters: [], paramIndex: 0 };

	beforeEach(() => {
		state.parameters = [];
		state.paramIndex = 0;
	});

	describe('RANGE_TYPES', () => {
		it('includes all PostgreSQL range types', () => {
			expect(RANGE_TYPES.has('daterange')).toBe(true);
			expect(RANGE_TYPES.has('tsrange')).toBe(true);
			expect(RANGE_TYPES.has('tstzrange')).toBe(true);
			expect(RANGE_TYPES.has('int4range')).toBe(true);
			expect(RANGE_TYPES.has('int8range')).toBe(true);
			expect(RANGE_TYPES.has('numrange')).toBe(true);
		});

		it('does not include non-range types', () => {
			expect(RANGE_TYPES.has('integer')).toBe(false);
			expect(RANGE_TYPES.has('text')).toBe(false);
		});
	});

	describe('buildReturningExprs', () => {
		it('returns undefined for empty columns', () => {
			expect(buildReturningExprs([], 'users', ctx)).toBeUndefined();
		});

		it('returns undefined for undefined columns', () => {
			expect(buildReturningExprs(undefined, 'users', ctx)).toBeUndefined();
		});

		it('builds returning list for single column', () => {
			const result = buildReturningExprs(['id'], 'users', ctx);
			expect(result).toHaveLength(1);
			expect(result[0].ResTarget).toBeDefined();
		});

		it('builds RETURNING * as a bare star target', () => {
			const result = buildReturningExprs(['*'], 'users', ctx);
			expect(result).toHaveLength(1);
			const target = result![0]!.ResTarget;
			expect(target.name).toBeUndefined();
			expect(target.val.ColumnRef.fields).toEqual([{ A_Star: {} }]);
		});

		it('builds returning list for multiple columns', () => {
			const result = buildReturningExprs(['id', 'name', 'email'], 'users', ctx);
			expect(result).toHaveLength(3);
		});

		it('rejects star RETURNING carrying alias-aware returning items', () => {
			expect(() =>
				buildReturningExprs(['*'], 'users', ctx, [
					{ source: 'id', output: '*' },
				]),
			).toThrow(/star RETURNING cannot carry alias-aware returningItems/);
		});

		it('uses source for alias-aware returning items and output for aliases', () => {
			const result = buildReturningExprs(['contact'], 'users', ctx, [
				{ source: 'email', output: 'contact' },
			]);
			expect(result).toHaveLength(1);
			const target = result![0]!.ResTarget;
			expect(target.name).toBe('contact');
			expect(target.val.ColumnRef.fields).toEqual([
				{ String: { sval: 'users' } },
				{ String: { sval: 'email' } },
			]);
		});

		it('rejects desynced returningItems length', () => {
			expect(() =>
				buildReturningExprs(['contact'], 'users', ctx, [
					{ source: 'email', output: 'contact' },
					{ source: 'name', output: 'display' },
				]),
			).toThrow(/returningItems length/);
		});

		it('rejects desynced returningItems output order', () => {
			expect(() =>
				buildReturningExprs(['contact'], 'users', ctx, [
					{ source: 'email', output: 'who' },
				]),
			).toThrow(/returningItems\[0\]\.output/);
		});

		it('rejects post-naming duplicate output aliases', () => {
			expect(() =>
				buildReturningExprs(['userId', 'user_id'], 'users', ctx, [
					{ source: 'id', output: 'userId' },
					{ source: 'email', output: 'user_id' },
				]),
			).toThrow(/Duplicate mutation RETURNING output after database naming/);
		});
	});

	describe('compileInsert', () => {
		it('compiles INSERT with single row', () => {
			const config = {
				table: 'users',
				columns: ['name', 'email'],
				values: [['John', 'john@example.com']],
			};
			const node = compileInsert(config, ctx, state);
			expect(node.InsertStmt).toBeDefined();
			expect(node.InsertStmt.relation.relname).toBe('users');
			expect(state.parameters).toHaveLength(2);
		});

		it('compiles INSERT with multiple rows', () => {
			const config = {
				table: 'users',
				columns: ['name'],
				values: [['Alice'], ['Bob'], ['Charlie']],
			};
			const node = compileInsert(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.valuesLists).toHaveLength(3);
			expect(state.parameters).toHaveLength(3);
		});

		it('compiles INSERT with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'public' };
			const config = {
				table: 'users',
				columns: ['name'],
				values: [['John']],
			};
			const node = compileInsert(config, ctxWithSchema, state);
			expect(node.InsertStmt.relation.schemaname).toBe('public');
		});

		it('compiles INSERT with RETURNING clause', () => {
			const config = {
				table: 'users',
				columns: ['name'],
				values: [['John']],
				returning: ['id', 'name'],
			};
			const node = compileInsert(config, ctx, state);
			expect(node.InsertStmt.returningClause?.exprs).toBeDefined();
			expect(node.InsertStmt.returningClause?.exprs).toHaveLength(2);
		});

		it('compiles INSERT with NULL values', () => {
			const config = {
				table: 'users',
				columns: ['name', 'email'],
				values: [['John', null]],
			};
			const node = compileInsert(config, ctx, state);
			// NULL should not add to parameters
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles INSERT with range type column', () => {
			const config = {
				table: 'events',
				columns: ['name', 'period'],
				values: [['Meeting', '[2024-01-01,2024-01-02)']],
				columnTypes: { period: 'daterange' },
			};
			const node = compileInsert(config, ctx, state);
			expect(state.parameters).toHaveLength(2);
			// TypeCast node should be created for range types
		});

		it('compiles INSERT with non-range type column', () => {
			const config = {
				table: 'products',
				columns: ['name', 'price'],
				values: [['Widget', 19.99]],
				columnTypes: { price: 'numeric' },
			};
			const node = compileInsert(config, ctx, state);
			expect(state.parameters).toHaveLength(2);
		});
	});

	describe('compileUpdate', () => {
		it('compiles UPDATE with SET clause', () => {
			const config = {
				table: 'users',
				set: [{ column: 'name', value: 'Jane' }],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt).toBeDefined();
			expect(node.UpdateStmt.relation.relname).toBe('users');
			expect(node.UpdateStmt.targetList).toHaveLength(1);
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles UPDATE with multiple SET clauses', () => {
			const config = {
				table: 'users',
				set: [
					{ column: 'name', value: 'Jane' },
					{ column: 'email', value: 'jane@example.com' },
					{ column: 'age', value: 30 },
				],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.targetList).toHaveLength(3);
			expect(state.parameters).toHaveLength(3);
		});

		it('compiles UPDATE with single WHERE condition', () => {
			const config = {
				table: 'users',
				set: [{ column: 'name', value: 'Jane' }],
				where: [
					{
						type: 'where',
						column: 'id',
						operator: 'eq',
						value: 1,
						table: 'users',
					},
				],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.whereClause).toBeDefined();
		});

		it('compiles UPDATE with multiple WHERE conditions (AND)', () => {
			const config = {
				table: 'users',
				set: [{ column: 'active', value: false }],
				where: [
					{
						type: 'where',
						column: 'role',
						operator: 'eq',
						value: 'guest',
						table: 'users',
					},
					{
						type: 'where',
						column: 'last_login',
						operator: 'lt',
						value: '2020-01-01',
						table: 'users',
					},
				],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.whereClause.BoolExpr.boolop).toBe('AND_EXPR');
			expect(node.UpdateStmt.whereClause.BoolExpr.args).toHaveLength(2);
		});

		it('compiles UPDATE with RETURNING clause', () => {
			const config = {
				table: 'users',
				set: [{ column: 'name', value: 'Jane' }],
				returning: ['id', 'name', 'updated_at'],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.returningClause?.exprs).toBeDefined();
			expect(node.UpdateStmt.returningClause?.exprs).toHaveLength(3);
		});

		it('compiles UPDATE with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'public' };
			const config = {
				table: 'users',
				set: [{ column: 'name', value: 'Jane' }],
			};
			const node = compileUpdate(config, ctxWithSchema, state);
			expect(node.UpdateStmt.relation.schemaname).toBe('public');
		});

		it('compiles UPDATE with NULL value', () => {
			const config = {
				table: 'users',
				set: [{ column: 'deleted_at', value: null }],
			};
			const node = compileUpdate(config, ctx, state);
			expect(state.parameters).toHaveLength(0); // NULL doesn't add parameter
		});

		it('compiles UPDATE with range type value', () => {
			const config = {
				table: 'events',
				set: [{ column: 'period', value: '[2024-06-01,2024-06-30)' }],
				columnTypes: { period: 'tsrange' },
			};
			const node = compileUpdate(config, ctx, state);
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles UPDATE without WHERE (affects all rows)', () => {
			const config = {
				table: 'settings',
				set: [{ column: 'maintenance_mode', value: true }],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.whereClause).toBeUndefined();
		});
	});

	describe('compileDelete', () => {
		it('compiles DELETE without WHERE', () => {
			const config = { table: 'temp_logs' };
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt).toBeDefined();
			expect(node.DeleteStmt.relation.relname).toBe('temp_logs');
			expect(node.DeleteStmt.whereClause).toBeUndefined();
		});

		it('compiles DELETE with single WHERE condition', () => {
			const config = {
				table: 'users',
				where: [
					{
						type: 'where',
						column: 'id',
						operator: 'eq',
						value: 42,
						table: 'users',
					},
				],
			};
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt.whereClause).toBeDefined();
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles DELETE with multiple WHERE conditions (AND)', () => {
			const config = {
				table: 'sessions',
				where: [
					{
						type: 'where',
						column: 'expired',
						operator: 'eq',
						value: true,
						table: 'sessions',
					},
					{
						type: 'where',
						column: 'created_at',
						operator: 'lt',
						value: '2020-01-01',
						table: 'sessions',
					},
				],
			};
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt.whereClause.BoolExpr.boolop).toBe('AND_EXPR');
		});

		it('compiles DELETE with RETURNING clause', () => {
			const config = {
				table: 'users',
				where: [
					{
						type: 'where',
						column: 'id',
						operator: 'eq',
						value: 1,
						table: 'users',
					},
				],
				returning: ['id', 'name'],
			};
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt.returningClause?.exprs).toBeDefined();
			expect(node.DeleteStmt.returningClause?.exprs).toHaveLength(2);
		});

		it('compiles DELETE with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'archive' };
			const config = {
				table: 'old_records',
				where: [
					{
						type: 'where',
						column: 'year',
						operator: 'lt',
						value: 2010,
						table: 'old_records',
					},
				],
			};
			const node = compileDelete(config, ctxWithSchema, state);
			expect(node.DeleteStmt.relation.schemaname).toBe('archive');
		});
	});

	describe('compileInsertFrom', () => {
		it('compiles INSERT FROM with all columns', () => {
			const config = {
				targetTable: 'users_backup',
				sourceTable: 'users',
				columns: ['id', 'name', 'email'],
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.relation.relname).toBe('users_backup');
			expect(node.InsertStmt.selectStmt.SelectStmt.targetList).toHaveLength(3);
		});

		it('compiles INSERT FROM with SELECT *', () => {
			const config = {
				targetTable: 'users_backup',
				sourceTable: 'users',
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.targetList).toHaveLength(1);
			expect(
				node.InsertStmt.selectStmt.SelectStmt.targetList[0].ResTarget.val
					.ColumnRef.fields[0],
			).toHaveProperty('A_Star');
		});

		it('compiles INSERT FROM with WHERE clause', () => {
			const config = {
				targetTable: 'active_users',
				sourceTable: 'users',
				columns: ['id', 'name'],
				where: [
					{
						type: 'where',
						column: 'active',
						operator: 'eq',
						value: true,
						table: 'users',
					},
				],
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.whereClause).toBeDefined();
		});

		it('compiles INSERT FROM with multiple WHERE conditions', () => {
			const config = {
				targetTable: 'premium_users',
				sourceTable: 'users',
				where: [
					{
						type: 'where',
						column: 'plan',
						operator: 'eq',
						value: 'premium',
						table: 'users',
					},
					{
						type: 'where',
						column: 'active',
						operator: 'eq',
						value: true,
						table: 'users',
					},
				],
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(
				node.InsertStmt.selectStmt.SelectStmt.whereClause.BoolExpr.boolop,
			).toBe('AND_EXPR');
		});

		it('compiles INSERT FROM with LIMIT', () => {
			const config = {
				targetTable: 'sample_users',
				sourceTable: 'users',
				limit: 100,
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.limitCount).toBeDefined();
		});

		it('compiles INSERT FROM with RETURNING', () => {
			const config = {
				targetTable: 'users_backup',
				sourceTable: 'users',
				returning: ['id'],
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.returningClause?.exprs).toBeDefined();
		});

		it('compiles INSERT FROM with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'archive' };
			const config = {
				targetTable: 'old_users',
				sourceTable: 'users',
			};
			const node = compileInsertFrom(config, ctxWithSchema, state);
			expect(node.InsertStmt.relation.schemaname).toBe('archive');
		});
	});

	describe('compileUpsertFrom', () => {
		it('compiles UPSERT FROM with conflict columns', () => {
			const config = {
				targetTable: 'users',
				sourceTable: 'temp_users',
				conflictColumns: ['email'],
				columns: ['email', 'name', 'role'],
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.onConflictClause).toBeDefined();
			expect(node.InsertStmt.onConflictClause.action).toBe('ONCONFLICT_UPDATE');
		});

		it('compiles UPSERT FROM with multiple conflict columns', () => {
			const config = {
				targetTable: 'products',
				sourceTable: 'import_products',
				conflictColumns: ['sku', 'vendor_id'],
				columns: ['sku', 'vendor_id', 'name', 'price'],
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.onConflictClause.infer.indexElems).toHaveLength(2);
		});

		it('compiles UPSERT FROM excludes conflict columns from UPDATE', () => {
			const config = {
				targetTable: 'users',
				sourceTable: 'new_users',
				conflictColumns: ['id'],
				columns: ['id', 'name', 'email'],
			};
			const node = compileUpsertFrom(config, ctx, state);
			// UPDATE should only include name and email, not id
			expect(node.InsertStmt.onConflictClause.targetList).toHaveLength(2);
		});

		it('compiles UPSERT FROM with WHERE clause', () => {
			const config = {
				targetTable: 'cache',
				sourceTable: 'temp_cache',
				conflictColumns: ['key'],
				columns: ['key', 'value'],
				where: [
					{
						type: 'where',
						column: 'valid',
						operator: 'eq',
						value: true,
						table: 'temp_cache',
					},
				],
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.whereClause).toBeDefined();
		});

		it('compiles UPSERT FROM with LIMIT', () => {
			const config = {
				targetTable: 'sync_data',
				sourceTable: 'staging',
				conflictColumns: ['external_id'],
				columns: ['external_id', 'data'],
				limit: 1000,
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.limitCount).toBeDefined();
		});

		it('compiles UPSERT FROM with RETURNING', () => {
			const config = {
				targetTable: 'users',
				sourceTable: 'import_users',
				conflictColumns: ['email'],
				columns: ['email', 'name'],
				returning: ['id', 'email'],
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.returningClause?.exprs).toBeDefined();
		});

		it('compiles UPSERT FROM with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'staging' };
			const config = {
				targetTable: 'products',
				sourceTable: 'import_products',
				conflictColumns: ['sku'],
				columns: ['sku', 'name'],
			};
			const node = compileUpsertFrom(config, ctxWithSchema, state);
			expect(node.InsertStmt.relation.schemaname).toBe('staging');
		});
	});

	describe('compileMutation', () => {
		it('compiles INSERT mutation decision', () => {
			const decision = {
				type: 'insert',
				table: 'users',
				columns: ['name'],
				values: ['John'],
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.InsertStmt).toBeDefined();
		});

		it('compiles UPDATE mutation decision', () => {
			const decision = {
				type: 'update',
				table: 'users',
				set: [{ column: 'name', value: 'Jane' }],
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.UpdateStmt).toBeDefined();
		});

		it('compiles DELETE mutation decision', () => {
			const decision = {
				type: 'delete',
				table: 'users',
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.DeleteStmt).toBeDefined();
		});

		it('throws error for unknown mutation type', () => {
			const decision = {
				type: 'merge',
				table: 'users',
			};
			expect(() => compileMutation(decision, ctx, state)).toThrow(
				'Unknown mutation type: merge',
			);
		});

		it('uses rootTable from context if decision.table undefined', () => {
			const decision = {
				type: 'delete',
				columns: ['id'],
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.DeleteStmt.relation.relname).toBe('users');
		});
	});
});
