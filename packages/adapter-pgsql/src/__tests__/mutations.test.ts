/**
 * Mutation Compiler Tests
 */

import type { Node } from '@pgsql/types';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
	CompilerContext,
	CompilerState,
	Decision,
} from '../handlers/types.js';
import { registerAllWhereHandlers } from '../handlers/where/index.js';
import {
	buildOnConflictClause,
	compileDelete,
	compileInsert,
	compileMutation,
	compileUpdate,
	compileUpsert,
	conditionalUpdate,
	type DeleteConfig,
	excludedRef,
	type InsertConfig,
	type UpdateConfig,
	type UpsertConfig,
} from '../mutations/index.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';

// Register WHERE handlers before tests
beforeAll(() => {
	registerAllWhereHandlers();
});

describe('Mutation Compiler', () => {
	const naming = new CamelCaseNamingPlugin();

	const createContext = (table: string, schema?: string): CompilerContext => {
		const ctx: CompilerContext = {
			naming,
			rootTable: table,
			maxRecursiveDepth: 100,
		};
		if (schema) (ctx as any).schema = schema;
		return ctx;
	};

	const createState = (): CompilerState => ({
		parameters: [],
		paramIndex: 0,
		joins: [],
		ctes: new Map<string, Node>(),
		aliases: new Map<string, string>(),
	});

	describe('compileInsert', () => {
		it('should compile basic INSERT statement', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: InsertConfig = {
				table: 'users',
				columns: ['name', 'email'],
				values: [['John', 'john@example.com']],
			};

			const result = compileInsert(config, ctx, state);

			expect(result).toHaveProperty('InsertStmt');
			const stmt = (result as any).InsertStmt;
			expect(stmt.relation.relname).toBe('users');
			expect(stmt.cols).toHaveLength(2);
			expect(stmt.selectStmt).toBeDefined();
		});

		it('should handle parameters correctly', () => {
			const ctx = createContext('posts');
			const state = createState();

			const config: InsertConfig = {
				table: 'posts',
				columns: ['title', 'content'],
				values: [['Hello', 'World']],
			};

			compileInsert(config, ctx, state);

			expect(state.parameters).toEqual(['Hello', 'World']);
			expect(state.paramIndex).toBe(2);
		});

		it('should include RETURNING clause when specified', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: InsertConfig = {
				table: 'users',
				columns: ['name'],
				values: [['Jane']],
				returning: ['id', 'name'],
			};

			const result = compileInsert(config, ctx, state);
			const stmt = (result as any).InsertStmt;

			expect(stmt.returningList).toBeDefined();
			expect(stmt.returningList).toHaveLength(2);
		});

		it('should handle schema when provided', () => {
			const ctx = createContext('users', 'tenant_1');
			const state = createState();

			const config: InsertConfig = {
				table: 'users',
				columns: ['name'],
				values: [['Test']],
			};

			const result = compileInsert(config, ctx, state);
			const stmt = (result as any).InsertStmt;

			expect(stmt.relation.schemaname).toBe('tenant_1');
		});

		it('should handle multiple rows', () => {
			const ctx = createContext('tags');
			const state = createState();

			const config: InsertConfig = {
				table: 'tags',
				columns: ['name'],
				values: [['tag1'], ['tag2'], ['tag3']],
			};

			const result = compileInsert(config, ctx, state);
			const stmt = (result as any).InsertStmt;

			expect(stmt.selectStmt.SelectStmt.valuesLists).toHaveLength(3);
			expect(state.parameters).toEqual(['tag1', 'tag2', 'tag3']);
		});
	});

	describe('compileUpdate', () => {
		it('should compile basic UPDATE statement', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpdateConfig = {
				table: 'users',
				set: [
					{ column: 'name', value: 'Updated' },
					{ column: 'active', value: true },
				],
			};

			const result = compileUpdate(config, ctx, state);

			expect(result).toHaveProperty('UpdateStmt');
			const stmt = (result as any).UpdateStmt;
			expect(stmt.relation.relname).toBe('users');
			expect(stmt.targetList).toHaveLength(2);
		});

		it('should handle WHERE clause', () => {
			const ctx = createContext('posts');
			const state = createState();

			const config: UpdateConfig = {
				table: 'posts',
				set: [{ column: 'published', value: true }],
				where: [
					{
						type: '=',
						column: 'id',
						value: 123,
						table: 'posts',
					} as Decision,
				],
			};

			const result = compileUpdate(config, ctx, state);
			const stmt = (result as any).UpdateStmt;

			expect(stmt.whereClause).toBeDefined();
		});

		it('should handle null values', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpdateConfig = {
				table: 'users',
				set: [{ column: 'deletedAt', value: null }],
			};

			const result = compileUpdate(config, ctx, state);
			const stmt = (result as any).UpdateStmt;
			const target = stmt.targetList[0];

			// Null values should be A_Const with isnull: true
			expect(target.ResTarget.val).toHaveProperty('A_Const');
			expect(target.ResTarget.val.A_Const.isnull).toBe(true);
		});

		it('should include RETURNING clause when specified', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpdateConfig = {
				table: 'users',
				set: [{ column: 'name', value: 'Test' }],
				returning: ['id', 'name', 'updatedAt'],
			};

			const result = compileUpdate(config, ctx, state);
			const stmt = (result as any).UpdateStmt;

			expect(stmt.returningList).toBeDefined();
			expect(stmt.returningList).toHaveLength(3);
		});
	});

	describe('compileDelete', () => {
		it('should compile basic DELETE statement', () => {
			const ctx = createContext('posts');
			const state = createState();

			const config: DeleteConfig = {
				table: 'posts',
			};

			const result = compileDelete(config, ctx, state);

			expect(result).toHaveProperty('DeleteStmt');
			const stmt = (result as any).DeleteStmt;
			expect(stmt.relation.relname).toBe('posts');
		});

		it('should handle WHERE clause', () => {
			const ctx = createContext('posts');
			const state = createState();

			const config: DeleteConfig = {
				table: 'posts',
				where: [
					{
						type: '=',
						column: 'id',
						value: 456,
						table: 'posts',
					} as Decision,
				],
			};

			const result = compileDelete(config, ctx, state);
			const stmt = (result as any).DeleteStmt;

			expect(stmt.whereClause).toBeDefined();
		});

		it('should handle multiple WHERE conditions', () => {
			const ctx = createContext('posts');
			const state = createState();

			const config: DeleteConfig = {
				table: 'posts',
				where: [
					{
						type: '=',
						column: 'published',
						value: false,
						table: 'posts',
					} as Decision,
					{
						type: '=',
						column: 'archived',
						value: true,
						table: 'posts',
					} as Decision,
				],
			};

			const result = compileDelete(config, ctx, state);
			const stmt = (result as any).DeleteStmt;

			// Multiple conditions should be AND'd
			expect(stmt.whereClause).toHaveProperty('BoolExpr');
			expect(stmt.whereClause.BoolExpr.boolop).toBe('AND_EXPR');
		});

		it('should include RETURNING clause when specified', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: DeleteConfig = {
				table: 'users',
				returning: ['id'],
			};

			const result = compileDelete(config, ctx, state);
			const stmt = (result as any).DeleteStmt;

			expect(stmt.returningList).toBeDefined();
			expect(stmt.returningList).toHaveLength(1);
		});
	});

	describe('compileMutation', () => {
		it('should dispatch to compileInsert for insert decisions', () => {
			const ctx = createContext('users');
			const state = createState();

			const decision: Decision = {
				type: 'insert',
				table: 'users',
				columns: ['name', 'email'],
				values: ['Test', 'test@example.com'],
			};

			const result = compileMutation(decision, ctx, state);

			expect(result).toHaveProperty('InsertStmt');
		});

		it('should dispatch to compileUpdate for update decisions', () => {
			const ctx = createContext('users');
			const state = createState();

			const decision: Decision = {
				type: 'update',
				table: 'users',
				set: [{ column: 'name', value: 'Updated' }],
				conditions: [{ type: '=', column: 'id', value: 1, table: 'users' }],
			};

			const result = compileMutation(decision, ctx, state);

			expect(result).toHaveProperty('UpdateStmt');
		});

		it('should dispatch to compileDelete for delete decisions', () => {
			const ctx = createContext('posts');
			const state = createState();

			const decision: Decision = {
				type: 'delete',
				table: 'posts',
				conditions: [{ type: '=', column: 'id', value: 999, table: 'posts' }],
			};

			const result = compileMutation(decision, ctx, state);

			expect(result).toHaveProperty('DeleteStmt');
		});

		it('should throw for unknown mutation type', () => {
			const ctx = createContext('users');
			const state = createState();

			const decision = {
				type: 'upsert' as any, // Not supported via compileMutation
				table: 'users',
			};

			expect(() => compileMutation(decision, ctx, state)).toThrow(
				'Unknown mutation type',
			);
		});
	});
});

describe('UPSERT Compiler', () => {
	const naming = new CamelCaseNamingPlugin();

	const createContext = (table: string): CompilerContext => ({
		naming,
		rootTable: table,
		maxRecursiveDepth: 100,
	});

	const createState = (): CompilerState => ({
		parameters: [],
		paramIndex: 0,
		joins: [],
		ctes: new Map<string, Node>(),
		aliases: new Map<string, string>(),
	});

	describe('buildOnConflictClause', () => {
		it('should build DO NOTHING clause', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email', 'name'],
				values: [['test@example.com', 'Test']],
				conflictTarget: { columns: ['email'] },
				conflictAction: 'nothing',
			};

			const result = buildOnConflictClause(config, ctx, state);

			expect(result.action).toBe('ONCONFLICT_NOTHING');
			expect(result.infer).toBeDefined();
			expect(result.infer?.indexElems).toHaveLength(1);
		});

		it('should build DO UPDATE clause', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email', 'name'],
				values: [['test@example.com', 'Test']],
				conflictTarget: { columns: ['email'] },
				conflictAction: 'update',
				updateColumns: ['name'],
			};

			const result = buildOnConflictClause(config, ctx, state);

			expect(result.action).toBe('ONCONFLICT_UPDATE');
			expect(result.targetList).toBeDefined();
			expect(result.targetList).toHaveLength(1);
		});

		it('should use EXCLUDED references for update values', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email', 'name', 'lastLogin'],
				values: [['a@b.com', 'A', new Date()]],
				conflictTarget: { columns: ['email'] },
				conflictAction: 'update',
				updateColumns: ['name', 'lastLogin'],
				useExcluded: true,
			};

			const result = buildOnConflictClause(config, ctx, state);
			const target = result.targetList![0] as any;

			// Should reference EXCLUDED.column
			expect(target.ResTarget.val.ColumnRef.fields[0].String.sval).toBe(
				'excluded',
			);
		});

		it('should handle constraint-based conflict target', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email'],
				values: [['test@example.com']],
				conflictTarget: { constraint: 'users_email_unique' },
				conflictAction: 'nothing',
			};

			const result = buildOnConflictClause(config, ctx, state);

			expect(result.infer?.conname).toBe('users_email_unique');
		});
	});

	describe('compileUpsert', () => {
		it('should compile complete UPSERT statement', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email', 'name'],
				values: [['a@b.com', 'A']],
				conflictTarget: { columns: ['email'] },
				conflictAction: 'update',
				updateColumns: ['name'],
			};

			const result = compileUpsert(config, ctx, state);

			expect(result).toHaveProperty('InsertStmt');
			const stmt = (result as any).InsertStmt;
			expect(stmt.onConflictClause).toBeDefined();
			expect(stmt.onConflictClause.action).toBe('ONCONFLICT_UPDATE');
		});

		it('should include RETURNING clause', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email'],
				values: [['test@example.com']],
				conflictTarget: { columns: ['email'] },
				conflictAction: 'nothing',
				returning: ['id', 'email'],
			};

			const result = compileUpsert(config, ctx, state);
			const stmt = (result as any).InsertStmt;

			expect(stmt.returningList).toBeDefined();
			expect(stmt.returningList).toHaveLength(2);
		});

		it('should handle multiple rows', () => {
			const ctx = createContext('tags');
			const state = createState();

			const config: UpsertConfig = {
				table: 'tags',
				columns: ['name'],
				values: [['tag1'], ['tag2']],
				conflictTarget: { columns: ['name'] },
				conflictAction: 'nothing',
			};

			const result = compileUpsert(config, ctx, state);
			const stmt = (result as any).InsertStmt;

			expect(stmt.selectStmt.SelectStmt.valuesLists).toHaveLength(2);
		});
	});

	describe('excludedRef', () => {
		it('should create EXCLUDED.column reference', () => {
			const result = excludedRef('name', naming) as any;

			expect(result).toHaveProperty('ColumnRef');
			expect(result.ColumnRef.fields).toHaveLength(2);
			expect(result.ColumnRef.fields[0].String.sval).toBe('excluded');
			expect(result.ColumnRef.fields[1].String.sval).toBe('name');
		});
	});

	describe('conditionalUpdate', () => {
		it('should build COALESCE(EXCLUDED.col, table.col)', () => {
			const ctx = createContext('users');

			const result = conditionalUpdate('name', 'users', ctx) as any;

			expect(result).toHaveProperty('FuncCall');
			expect(result.FuncCall.funcname[0].String.sval).toBe('coalesce');
			expect(result.FuncCall.args).toHaveLength(2);
		});
	});
});
