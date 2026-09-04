/**
 * Mutation Compiler Tests
 */

import { exists, notExists } from '@dbsp/core';
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
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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

			expect(stmt.returningClause?.exprs).toBeDefined();
			expect(stmt.returningClause?.exprs).toHaveLength(2);
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

		it('should emit TypeCast for range type columns', () => {
			const ctx = createContext('priceTiers');
			const state = createState();

			const config: InsertConfig = {
				table: 'priceTiers',
				columns: ['name', 'quantityRange'],
				values: [['Tier 1', '[1,50)']],
				columnTypes: { quantityRange: 'int4range' },
			};

			const result = compileInsert(config, ctx, state);
			const stmt = (result as any).InsertStmt;
			const valuesRow = stmt.selectStmt.SelectStmt.valuesLists[0].List.items;

			// First column (name) should be a plain ParamRef
			expect(valuesRow[0]).toHaveProperty('ParamRef');
			expect(valuesRow[0].ParamRef.number).toBe(1);

			// Second column (quantityRange) should be a TypeCast wrapping ParamRef
			expect(valuesRow[1]).toHaveProperty('TypeCast');
			expect(valuesRow[1].TypeCast.arg).toHaveProperty('ParamRef');
			expect(valuesRow[1].TypeCast.arg.ParamRef.number).toBe(2);
			expect(valuesRow[1].TypeCast.typeName.names[0].String.sval).toBe(
				'int4range',
			);

			expect(state.parameters).toEqual(['Tier 1', '[1,50)']);
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
						operator: '=',
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

			expect(stmt.returningClause?.exprs).toBeDefined();
			expect(stmt.returningClause?.exprs).toHaveLength(3);
		});

		it('should emit TypeCast for range type columns in SET', () => {
			const ctx = createContext('priceTiers');
			const state = createState();

			const config: UpdateConfig = {
				table: 'priceTiers',
				set: [
					{ column: 'name', value: 'Updated Tier' },
					{ column: 'quantityRange', value: '[10,100)' },
				],
				columnTypes: { quantityRange: 'int4range' },
			};

			const result = compileUpdate(config, ctx, state);
			const stmt = (result as any).UpdateStmt;

			// First SET target (name) should have a plain ParamRef
			const nameTarget = stmt.targetList[0].ResTarget.val;
			expect(nameTarget).toHaveProperty('ParamRef');

			// Second SET target (quantityRange) should have a TypeCast
			const rangeTarget = stmt.targetList[1].ResTarget.val;
			expect(rangeTarget).toHaveProperty('TypeCast');
			expect(rangeTarget.TypeCast.arg.ParamRef.number).toBe(2);
			expect(rangeTarget.TypeCast.typeName.names[0].String.sval).toBe(
				'int4range',
			);

			expect(state.parameters).toEqual(['Updated Tier', '[10,100)']);
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
						operator: '=',
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
						operator: '=',
						column: 'published',
						value: false,
						table: 'posts',
					} as Decision,
					{
						type: '=',
						operator: '=',
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

			expect(stmt.returningClause?.exprs).toBeDefined();
			expect(stmt.returningClause?.exprs).toHaveLength(1);
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
				conditions: [
					{ type: '=', operator: '=', column: 'id', value: 1, table: 'users' },
				],
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
				conditions: [
					{
						type: '=',
						operator: '=',
						column: 'id',
						value: 999,
						table: 'posts',
					},
				],
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

		it('should build DO UPDATE WHERE separately from partial-index WHERE', () => {
			const ctx = createContext('users');
			const state = createState();

			const config: UpsertConfig = {
				table: 'users',
				columns: ['email', 'name', 'active', 'score'],
				values: [['test@example.com', 'Test', true, 10]],
				conflictTarget: {
					columns: ['email'],
					where: [
						{
							type: 'where',
							column: 'active',
							operator: '=',
							value: true,
						},
					],
				},
				conflictAction: 'update',
				updateColumns: ['name', 'score'],
				actionWhere: [
					{
						type: 'where',
						column: 'score',
						operator: '>',
						value: 0,
					},
				],
			};

			const result = buildOnConflictClause(config, ctx, state);

			expect(result.infer?.whereClause).toBeDefined();
			expect(result.whereClause).toBeDefined();
			expect(state.parameters).toEqual([true, 0]);
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

			expect(stmt.returningClause?.exprs).toBeDefined();
			expect(stmt.returningClause?.exprs).toHaveLength(2);
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

describe('Alias-aware mutation RETURNING intent emission (#217)', () => {
	const adapter = createPgsqlCompileOnlyAdapter({ dbCasing: 'preserve' });

	function expectReturningAlias(
		sql: string,
		table: string,
		source: string,
		output: string,
	): void {
		expect(sql).toContain(`RETURNING ${table}.${source} AS ${output}`);
	}

	it('threads returningItems through insert', () => {
		const { sql } = adapter.compileInsert({
			type: 'insert',
			table: 'users',
			values: [{ email: 'a@example.com' }],
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'users', 'email', 'contact');
	});

	it('threads returningItems through insert-from', () => {
		const { sql } = adapter.compileInsertFrom({
			type: 'insert_from',
			table: 'archived_users',
			source: 'users',
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'archived_users', 'email', 'contact');
	});

	it('threads returningItems through update', () => {
		const { sql } = adapter.compileUpdate({
			type: 'update',
			table: 'users',
			set: { name: 'Jane' },
			allowAll: true,
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'users', 'email', 'contact');
	});

	it('threads returningItems through batch update', () => {
		const { sql } = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'users',
			matchColumns: ['id'],
			updates: [{ id: 1, name: 'Jane' }],
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'users', 'email', 'contact');
	});

	it('threads returningItems through delete', () => {
		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'users',
			allowAll: true,
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'users', 'email', 'contact');
	});

	it('threads returningItems through upsert', () => {
		const { sql } = adapter.compileUpsert({
			type: 'upsert',
			table: 'users',
			values: [{ email: 'a@example.com', name: 'Alice' }],
			onConflict: { columns: ['email'] },
			action: { type: 'doNothing' },
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'users', 'email', 'contact');
	});

	it('threads returningItems through upsert-from', () => {
		const { sql } = adapter.compileUpsertFrom({
			type: 'upsert_from',
			table: 'users',
			source: 'import_users',
			conflictColumns: ['email'],
			columns: ['email', 'name'],
			returning: ['contact'],
			returningItems: [{ source: 'email', output: 'contact' }],
		});

		expectReturningAlias(sql, 'users', 'email', 'contact');
	});

	it('quotes hostile forged output aliases instead of concatenating raw SQL', () => {
		const output = 'bad"; DROP TABLE users; --';
		const { sql } = adapter.compileInsert({
			type: 'insert',
			table: 'users',
			values: [{ email: 'a@example.com' }],
			returning: [output],
			returningItems: [{ source: 'email', output }],
		});

		expect(sql).toContain('AS "bad""; DROP TABLE users; --"');
	});
});

// ============================================================================
// DELETE-NOT-EXISTS: notExists() / exists() on DELETE mutations (P1 hotfix)
// ============================================================================

describe('DELETE with notExists / exists WHERE (DELETE-NOT-EXISTS)', () => {
	const adapter = createPgsqlCompileOnlyAdapter();

	it('DELETE ... WHERE NOT EXISTS compiles correctly', () => {
		const intent = {
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbol'),
		};
		const { sql, parameters } = adapter.compileDelete(intent);
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expect(sql).toMatch(/SELECT 1 FROM/i);
		expect(sql).toMatch(/symbol/i);
		expect(parameters).toEqual([]);
	});

	it('DELETE ... WHERE NOT EXISTS with RETURNING compiles correctly', () => {
		const intent = {
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbol'),
			returning: ['id'] as readonly string[],
		};
		const { sql, parameters } = adapter.compileDelete(intent);
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expect(sql).toMatch(/RETURNING/i);
		expect(parameters).toEqual([]);
	});

	it('DELETE ... WHERE EXISTS compiles correctly', () => {
		const intent = {
			type: 'delete' as const,
			table: 'posts',
			where: exists('comments'),
		};
		const { sql } = adapter.compileDelete(intent);
		expect(sql).toMatch(/EXISTS/i);
		expect(sql).not.toMatch(/NOT EXISTS/i);
		expect(sql).toMatch(/comment/i);
	});

	it('normalizeToDecision: kind=notExists routes to NOT EXISTS handler (not "=" comparison)', () => {
		const state = {
			parameters: [] as unknown[],
			paramIndex: 0,
			joins: [] as import('@pgsql/types').Node[],
			ctes: new Map<string, import('@pgsql/types').Node>(),
			aliases: new Map<string, string>(),
		};
		const ctx: import('../handlers/types.js').CompilerContext = {
			naming: new CamelCaseNamingPlugin(),
			rootTable: 'embeddings',
			maxRecursiveDepth: 100,
		};
		const config: DeleteConfig = {
			table: 'embeddings',
			where: [{ kind: 'notExists', relation: 'symbol' } as unknown as Decision],
		};
		const result = compileDelete(config, ctx, state);
		const stmt = (result as any).DeleteStmt;
		expect(stmt.whereClause).toBeDefined();
		expect(stmt.whereClause).toHaveProperty('BoolExpr');
		expect(stmt.whereClause.BoolExpr.boolop).toBe('NOT_EXPR');
	});
});

// ============================================================================
// DELETE-NOTEXISTS-ALIAS: relation name resolved to actual table name via ModelIR
// ============================================================================

describe('DELETE-NOTEXISTS-ALIAS: notExists() resolves relation to real table name', () => {
	it('uses ModelIR to resolve relation "symbol" -> table "symbols" in NOT EXISTS subquery', async () => {
		// Build a minimal ModelIR with relation embeddings.symbol -> symbols table
		const relations = new Map([
			[
				'embeddings.symbol',
				{
					name: 'symbol',
					type: 'belongsTo' as const,
					source: 'embeddings',
					target: 'symbols',
					cardinality: 'many-to-one' as const,
					optionality: 'optional' as const,
					includeStrategy: 'auto' as const,
					filterStrategy: 'auto' as const,
					joinDefault: 'auto' as const,
					foreignKeys: [],
				},
			],
		]);
		const model = {
			tables: new Map(),
			relations,
			getTable: () => undefined,
			getRelation: (qname: string) => relations.get(qname),
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false }),
		} as unknown as import('@dbsp/types').ModelIR;

		const { createPgsqlCompileOnlyAdapter: createAdapter } = await import(
			'../pgsql-adapter.js'
		);
		const adapterWithModel = createAdapter({ model });

		const intent = {
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbol'),
		};
		const { sql } = adapterWithModel.compileDelete(intent);

		// Must reference "symbols" table (not just "symbol")
		expect(sql).toContain('symbols'); // table resolved via ModelIR
		expect(sql).not.toMatch(/\bsymbol\b(?!s)/); // not bare relation name
		expect(sql).toMatch(/NOT.*EXISTS/i);
	});

	it('falls back to relation name when no model is available (compile-only mode)', () => {
		// Without ModelIR, targetTable defaults to the relation name — safe fallback
		const adapterNoModel = createPgsqlCompileOnlyAdapter();

		const intent = {
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbols'), // caller passes actual table name directly
		};
		const { sql } = adapterNoModel.compileDelete(intent);
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expect(sql).toMatch(/symbols/i);
	});
});
