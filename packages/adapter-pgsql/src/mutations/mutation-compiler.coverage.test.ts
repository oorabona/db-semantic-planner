// @ts-nocheck — coverage test: runtime assertions on mutation compiler
/**
 * Coverage tests for mutation-compiler.ts
 * Focus: Branch coverage for INSERT, UPDATE, DELETE, UPSERT compilation with all variants
 */

import { schema } from '@dbsp/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { relationBinding } from '../binding-registry.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { queryLocal } from '../sql-identifier.js';
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
	const mutationModel = schema({
		users: {
			id: 'integer',
			name: 'text',
			email: 'text',
			role: 'text',
			last_login: 'timestamp',
			active: 'boolean',
			plan: 'text',
		},
		sessions: { expired: 'boolean', created_at: 'timestamp' },
		old_records: { year: 'integer' },
		temp_cache: { valid: 'boolean' },
	}).model;
	const ctx = {
		rootTable: 'users',
		schema: undefined,
		declaredNames: createDeclaredNameResolver(
			createPgPhysicalModel({
				mode: 'logical',
				model: mutationModel,
				schema: 'public',
				dbCasing: 'preserve',
			}),
		),
	};
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
			expect(
				buildReturningExprs([], queryLocal('users'), undefined),
			).toBeUndefined();
		});

		it('returns undefined for undefined columns', () => {
			expect(
				buildReturningExprs(undefined, queryLocal('users'), undefined),
			).toBeUndefined();
		});

		it('builds returning list for single column', () => {
			const result = buildReturningExprs(
				['id'],
				queryLocal('users'),
				['id'].map(queryLocal),
			);
			expect(result).toHaveLength(1);
			expect(result[0].ResTarget).toBeDefined();
		});

		it('builds RETURNING * as a bare star target', () => {
			const result = buildReturningExprs(['*'], queryLocal('users'), undefined);
			expect(result).toHaveLength(1);
			const target = result![0]!.ResTarget;
			expect(target.name).toBeUndefined();
			expect(target.val.ColumnRef.fields).toEqual([{ A_Star: {} }]);
		});

		it('builds returning list for multiple columns', () => {
			const result = buildReturningExprs(
				['id', 'name', 'email'],
				queryLocal('users'),
				['id', 'name', 'email'].map(queryLocal),
			);
			expect(result).toHaveLength(3);
		});

		it('rejects star RETURNING carrying alias-aware returning items', () => {
			expect(() =>
				buildReturningExprs(['*'], queryLocal('users'), undefined, [
					{ source: 'id', output: '*' },
				]),
			).toThrow(/star RETURNING cannot carry alias-aware returningItems/);
		});

		it('uses source for alias-aware returning items and output for aliases', () => {
			const result = buildReturningExprs(
				['contact'],
				queryLocal('users'),
				['email'].map(queryLocal),
				[{ source: 'email', output: 'contact' }],
			);
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
				buildReturningExprs(
					['contact'],
					queryLocal('users'),
					['email'].map(queryLocal),
					[
						{ source: 'email', output: 'contact' },
						{ source: 'name', output: 'display' },
					],
				),
			).toThrow(/returningItems length/);
		});

		it('rejects desynced returningItems output order', () => {
			expect(() =>
				buildReturningExprs(
					['contact'],
					queryLocal('users'),
					['email'].map(queryLocal),
					[{ source: 'email', output: 'who' }],
				),
			).toThrow(/returningItems\[0\]\.output/);
		});

		it('keeps distinct local RETURNING output aliases distinct', () => {
			const result = buildReturningExprs(
				['userId', 'user_id'],
				queryLocal('users'),
				['id', 'email'].map(queryLocal),
				[
					{ source: 'id', output: 'userId' },
					{ source: 'email', output: 'user_id' },
				],
			);
			expect(result).toHaveLength(2);
		});
	});

	describe('compileInsert', () => {
		it('compiles INSERT with single row', () => {
			const config = {
				table: queryLocal('users'),
				columns: ['name', 'email'].map(queryLocal),
				values: [['John', 'john@example.com']],
			};
			const node = compileInsert(config, ctx, state);
			expect(node.InsertStmt).toBeDefined();
			expect(node.InsertStmt.relation.relname).toBe('users');
			expect(state.parameters).toHaveLength(2);
		});

		it('compiles INSERT with multiple rows', () => {
			const config = {
				table: queryLocal('users'),
				columns: ['name'].map(queryLocal),
				values: [['Alice'], ['Bob'], ['Charlie']],
			};
			const node = compileInsert(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.valuesLists).toHaveLength(3);
			expect(state.parameters).toHaveLength(3);
		});

		it('compiles INSERT with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'public' };
			const config = {
				table: queryLocal('users'),
				columns: ['name'].map(queryLocal),
				values: [['John']],
			};
			const node = compileInsert(config, ctxWithSchema, state);
			expect(node.InsertStmt.relation.schemaname).toBe('public');
		});

		it('compiles INSERT with RETURNING clause', () => {
			const config = {
				table: queryLocal('users'),
				columns: ['name'].map(queryLocal),
				values: [['John']],
				returning: ['id', 'name'],
				returningSources: ['id', 'name'].map(queryLocal),
			};
			const node = compileInsert(config, ctx, state);
			expect(node.InsertStmt.returningClause?.exprs).toBeDefined();
			expect(node.InsertStmt.returningClause?.exprs).toHaveLength(2);
		});

		it('compiles INSERT with NULL values', () => {
			const config = {
				table: queryLocal('users'),
				columns: ['name', 'email'].map(queryLocal),
				values: [['John', null]],
			};
			const node = compileInsert(config, ctx, state);
			// NULL should not add to parameters
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles INSERT with range type column', () => {
			const config = {
				table: queryLocal('events'),
				columns: ['name', 'period'].map(queryLocal),
				values: [['Meeting', '[2024-01-01,2024-01-02)']],
				columnTypes: { period: 'daterange' },
			};
			const node = compileInsert(config, ctx, state);
			expect(state.parameters).toHaveLength(2);
			// TypeCast node should be created for range types
		});

		it('compiles INSERT with non-range type column', () => {
			const config = {
				table: queryLocal('products'),
				columns: ['name', 'price'].map(queryLocal),
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
				table: queryLocal('users'),
				set: [{ column: queryLocal('name'), value: 'Jane' }],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt).toBeDefined();
			expect(node.UpdateStmt.relation.relname).toBe('users');
			expect(node.UpdateStmt.targetList).toHaveLength(1);
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles UPDATE with multiple SET clauses', () => {
			const config = {
				table: queryLocal('users'),
				set: [
					{ column: queryLocal('name'), value: 'Jane' },
					{ column: queryLocal('email'), value: 'jane@example.com' },
					{ column: queryLocal('age'), value: 30 },
				],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.targetList).toHaveLength(3);
			expect(state.parameters).toHaveLength(3);
		});

		it('compiles UPDATE with single WHERE condition', () => {
			const config = {
				table: queryLocal('users'),
				set: [{ column: queryLocal('name'), value: 'Jane' }],
				where: [
					{
						type: 'where',
						column: 'id',
						operator: 'eq',
						value: 1,
						table: queryLocal('users'),
					},
				],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.whereClause).toBeDefined();
		});

		it('compiles UPDATE with multiple WHERE conditions (AND)', () => {
			const config = {
				table: queryLocal('users'),
				set: [{ column: queryLocal('active'), value: false }],
				where: [
					{
						type: 'where',
						column: 'role',
						operator: 'eq',
						value: 'guest',
						table: queryLocal('users'),
					},
					{
						type: 'where',
						column: 'last_login',
						operator: 'lt',
						value: '2020-01-01',
						table: queryLocal('users'),
					},
				],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.whereClause.BoolExpr.boolop).toBe('AND_EXPR');
			expect(node.UpdateStmt.whereClause.BoolExpr.args).toHaveLength(2);
		});

		it('compiles UPDATE with RETURNING clause', () => {
			const config = {
				table: queryLocal('users'),
				set: [{ column: queryLocal('name'), value: 'Jane' }],
				returning: ['id', 'name', 'updated_at'],
				returningSources: ['id', 'name', 'updated_at'].map(queryLocal),
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.returningClause?.exprs).toBeDefined();
			expect(node.UpdateStmt.returningClause?.exprs).toHaveLength(3);
		});

		it('compiles UPDATE with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'public' };
			const config = {
				table: queryLocal('users'),
				set: [{ column: queryLocal('name'), value: 'Jane' }],
			};
			const node = compileUpdate(config, ctxWithSchema, state);
			expect(node.UpdateStmt.relation.schemaname).toBe('public');
		});

		it('compiles UPDATE with NULL value', () => {
			const config = {
				table: queryLocal('users'),
				set: [{ column: queryLocal('deleted_at'), value: null }],
			};
			const node = compileUpdate(config, ctx, state);
			expect(state.parameters).toHaveLength(0); // NULL doesn't add parameter
		});

		it('compiles UPDATE with range type value', () => {
			const config = {
				table: queryLocal('events'),
				set: [
					{ column: queryLocal('period'), value: '[2024-06-01,2024-06-30)' },
				],
				columnTypes: { period: 'tsrange' },
			};
			const node = compileUpdate(config, ctx, state);
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles UPDATE without WHERE (affects all rows)', () => {
			const config = {
				table: queryLocal('settings'),
				set: [{ column: queryLocal('maintenance_mode'), value: true }],
			};
			const node = compileUpdate(config, ctx, state);
			expect(node.UpdateStmt.whereClause).toBeUndefined();
		});
	});

	describe('compileDelete', () => {
		it('compiles DELETE without WHERE', () => {
			const config = { table: queryLocal('temp_logs') };
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt).toBeDefined();
			expect(node.DeleteStmt.relation.relname).toBe('temp_logs');
			expect(node.DeleteStmt.whereClause).toBeUndefined();
		});

		it('compiles DELETE with single WHERE condition', () => {
			const config = {
				table: queryLocal('users'),
				where: [
					{
						type: 'where',
						column: 'id',
						operator: 'eq',
						value: 42,
						table: queryLocal('users'),
					},
				],
			};
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt.whereClause).toBeDefined();
			expect(state.parameters).toHaveLength(1);
		});

		it('compiles DELETE with multiple WHERE conditions (AND)', () => {
			const config = {
				table: queryLocal('sessions'),
				where: [
					{
						type: 'where',
						column: 'expired',
						operator: 'eq',
						value: true,
						table: queryLocal('sessions'),
					},
					{
						type: 'where',
						column: 'created_at',
						operator: 'lt',
						value: '2020-01-01',
						table: queryLocal('sessions'),
					},
				],
			};
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt.whereClause.BoolExpr.boolop).toBe('AND_EXPR');
		});

		it('compiles DELETE with RETURNING clause', () => {
			const config = {
				table: queryLocal('users'),
				where: [
					{
						type: 'where',
						column: 'id',
						operator: 'eq',
						value: 1,
						table: queryLocal('users'),
					},
				],
				returning: ['id', 'name'],
				returningSources: ['id', 'name'].map(queryLocal),
			};
			const node = compileDelete(config, ctx, state);
			expect(node.DeleteStmt.returningClause?.exprs).toBeDefined();
			expect(node.DeleteStmt.returningClause?.exprs).toHaveLength(2);
		});

		it('compiles DELETE with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'archive' };
			const config = {
				table: queryLocal('old_records'),
				where: [
					{
						type: 'where',
						column: 'year',
						operator: 'lt',
						value: 2010,
						table: queryLocal('old_records'),
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
				targetTable: queryLocal('users_backup'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
				columns: ['id', 'name', 'email'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.relation.relname).toBe('users_backup');
			expect(node.InsertStmt.selectStmt.SelectStmt.targetList).toHaveLength(3);
		});

		it('compiles INSERT FROM with SELECT *', () => {
			const config = {
				targetTable: queryLocal('users_backup'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
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
				targetTable: queryLocal('active_users'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
				columns: ['id', 'name'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
				where: [
					{
						type: 'where',
						column: 'active',
						operator: 'eq',
						value: true,
						table: queryLocal('users'),
					},
				],
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.whereClause).toBeDefined();
		});

		it('compiles INSERT FROM with multiple WHERE conditions', () => {
			const config = {
				targetTable: queryLocal('premium_users'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
				where: [
					{
						type: 'where',
						column: 'plan',
						operator: 'eq',
						value: 'premium',
						table: queryLocal('users'),
					},
					{
						type: 'where',
						column: 'active',
						operator: 'eq',
						value: true,
						table: queryLocal('users'),
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
				targetTable: queryLocal('sample_users'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
				limit: 100,
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.limitCount).toBeDefined();
		});

		it('compiles INSERT FROM with RETURNING', () => {
			const config = {
				targetTable: queryLocal('users_backup'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
				returning: ['id'],
				returningSources: ['id'].map(queryLocal),
			};
			const node = compileInsertFrom(config, ctx, state);
			expect(node.InsertStmt.returningClause?.exprs).toBeDefined();
		});

		it('compiles INSERT FROM with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'archive' };
			const config = {
				targetTable: queryLocal('old_users'),
				source: relationBinding({
					qualifier: queryLocal('users'),
					kind: 'cte-bind',
				}),
			};
			const node = compileInsertFrom(config, ctxWithSchema, state);
			expect(node.InsertStmt.relation.schemaname).toBe('archive');
		});
	});

	describe('compileUpsertFrom', () => {
		it('compiles UPSERT FROM with conflict columns', () => {
			const config = {
				targetTable: queryLocal('users'),
				source: relationBinding({
					qualifier: queryLocal('temp_users'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['email'].map(queryLocal),
				columns: ['email', 'name', 'role'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.onConflictClause).toBeDefined();
			expect(node.InsertStmt.onConflictClause.action).toBe('ONCONFLICT_UPDATE');
		});

		it('compiles UPSERT FROM with multiple conflict columns', () => {
			const config = {
				targetTable: queryLocal('products'),
				source: relationBinding({
					qualifier: queryLocal('import_products'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['sku', 'vendor_id'].map(queryLocal),
				columns: ['sku', 'vendor_id', 'name', 'price'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.onConflictClause.infer.indexElems).toHaveLength(2);
		});

		it('compiles UPSERT FROM excludes conflict columns from UPDATE', () => {
			const config = {
				targetTable: queryLocal('users'),
				source: relationBinding({
					qualifier: queryLocal('new_users'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['id'].map(queryLocal),
				columns: ['id', 'name', 'email'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
			};
			const node = compileUpsertFrom(config, ctx, state);
			// UPDATE should only include name and email, not id
			expect(node.InsertStmt.onConflictClause.targetList).toHaveLength(2);
		});

		it('compiles UPSERT FROM with WHERE clause', () => {
			const config = {
				targetTable: queryLocal('cache'),
				source: relationBinding({
					qualifier: queryLocal('temp_cache'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['key'].map(queryLocal),
				columns: ['key', 'value'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
				where: [
					{
						type: 'where',
						column: 'valid',
						operator: 'eq',
						value: true,
						table: queryLocal('temp_cache'),
					},
				],
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.whereClause).toBeDefined();
		});

		it('compiles UPSERT FROM with LIMIT', () => {
			const config = {
				targetTable: queryLocal('sync_data'),
				source: relationBinding({
					qualifier: queryLocal('staging'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['external_id'].map(queryLocal),
				columns: ['external_id', 'data'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
				limit: 1000,
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.selectStmt.SelectStmt.limitCount).toBeDefined();
		});

		it('compiles UPSERT FROM with RETURNING', () => {
			const config = {
				targetTable: queryLocal('users'),
				source: relationBinding({
					qualifier: queryLocal('import_users'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['email'].map(queryLocal),
				columns: ['email', 'name'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
				returning: ['id', 'email'],
				returningSources: ['id', 'email'].map(queryLocal),
			};
			const node = compileUpsertFrom(config, ctx, state);
			expect(node.InsertStmt.returningClause?.exprs).toBeDefined();
		});

		it('compiles UPSERT FROM with schema', () => {
			const ctxWithSchema = { ...ctx, schema: 'staging' };
			const config = {
				targetTable: queryLocal('products'),
				source: relationBinding({
					qualifier: queryLocal('import_products'),
					kind: 'cte-bind',
				}),
				conflictColumns: ['sku'].map(queryLocal),
				columns: ['sku', 'name'].map((column) => ({
					target: queryLocal(column),
					source: queryLocal(column),
				})),
			};
			const node = compileUpsertFrom(config, ctxWithSchema, state);
			expect(node.InsertStmt.relation.schemaname).toBe('staging');
		});
	});

	describe('compileMutation', () => {
		it('compiles INSERT mutation decision', () => {
			const decision = {
				type: 'insert',
				table: queryLocal('users'),
				columns: ['name'].map(queryLocal),
				values: ['John'],
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.InsertStmt).toBeDefined();
		});

		it('compiles UPDATE mutation decision', () => {
			const decision = {
				type: 'update',
				table: queryLocal('users'),
				set: [{ column: queryLocal('name'), value: 'Jane' }],
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.UpdateStmt).toBeDefined();
		});

		it('compiles DELETE mutation decision', () => {
			const decision = {
				type: 'delete',
				table: queryLocal('users'),
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.DeleteStmt).toBeDefined();
		});

		it('throws error for unknown mutation type', () => {
			const decision = {
				type: 'merge',
				table: queryLocal('users'),
			};
			expect(() => compileMutation(decision, ctx, state)).toThrow(
				'Unknown mutation type: merge',
			);
		});

		it('uses rootTable from context if decision.table undefined', () => {
			const decision = {
				type: 'delete',
				columns: ['id'].map(queryLocal),
			};
			const node = compileMutation(decision, ctx, state);
			expect(node.DeleteStmt.relation.relname).toBe('users');
		});
	});
});
