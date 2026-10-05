// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for plan-decision-extractor.ts
 * Focus: Branch coverage for decision extraction, WHERE conversion, include tree building
 */

import { describe, expect, it } from 'vitest';
import {
	convertDottedFieldsToExists,
	convertWhereToDecisions,
	extractExistsDecisions,
	findExistsIntents,
	mapComparisonOperator,
	resolveRelation,
	valueToNode,
} from './plan-decision-extractor.js';

describe('plan-decision-extractor - coverage', () => {
	describe('findExistsIntents', () => {
		it('finds exists intent', () => {
			const where = { kind: 'exists', relation: 'posts' };
			expect(findExistsIntents(where)).toEqual([where]);
		});

		it('finds notExists intent', () => {
			const where = { kind: 'notExists', relation: 'orders' };
			expect(findExistsIntents(where)).toEqual([where]);
		});

		it('finds relationFilter intent', () => {
			const where = {
				kind: 'relationFilter',
				relation: 'comments',
				mode: 'some',
			};
			expect(findExistsIntents(where)).toEqual([where]);
		});

		it('finds nested intents in conditions array', () => {
			const where = {
				kind: 'and',
				conditions: [
					{ kind: 'exists', relation: 'posts' },
					{ kind: 'notExists', relation: 'orders' },
				],
			};
			expect(findExistsIntents(where)).toHaveLength(2);
		});

		it('finds nested intents in condition field', () => {
			const where = {
				kind: 'not',
				condition: { kind: 'exists', relation: 'likes' },
			};
			expect(findExistsIntents(where)).toHaveLength(1);
		});

		it('returns empty for non-object where', () => {
			expect(findExistsIntents(null)).toEqual([]);
			expect(findExistsIntents(undefined)).toEqual([]);
			expect(findExistsIntents('string')).toEqual([]);
			expect(findExistsIntents(42)).toEqual([]);
		});

		it('returns empty for unrecognized kind', () => {
			const where = {
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: 1,
			};
			expect(findExistsIntents(where)).toEqual([]);
		});
	});

	describe('resolveRelation', () => {
		it('resolves relation with string foreign key', () => {
			const model = {
				getRelation: (key: string) =>
					key === 'users.posts'
						? {
								name: 'posts',
								sourceKey: 'id',
								target: 'posts',
								foreignKey: 'user_id',
								type: 'hasMany',
							}
						: undefined,
			};
			const result = resolveRelation(model, 'users', 'posts');
			expect(result).toEqual({
				target: 'posts',
				foreignKey: ['user_id'],
				relationType: 'hasMany',
			});
		});

		it('resolves relation with array foreign key', () => {
			const model = {
				getRelation: (key: string) =>
					key === 'posts.author'
						? {
								name: 'author',
								targetKey: ['id', 'tenant_id'],
								target: 'users',
								foreignKey: ['user_id', 'tenant_id'],
								type: 'belongsTo',
							}
						: undefined,
			};
			const result = resolveRelation(model, 'posts', 'author');
			expect(result).toEqual({
				target: 'users',
				foreignKey: ['user_id', 'tenant_id'],
				relationType: 'belongsTo',
			});
		});

		it('returns undefined for missing relation', () => {
			const model = { getRelation: () => undefined };
			expect(resolveRelation(model, 'users', 'unknown')).toBeUndefined();
		});
	});

	describe('mapComparisonOperator', () => {
		it('maps all known operators', () => {
			expect(mapComparisonOperator('eq')).toBe('=');
			expect(mapComparisonOperator('neq')).toBe('!=');
			expect(mapComparisonOperator('gt')).toBe('>');
			expect(mapComparisonOperator('gte')).toBe('>=');
			expect(mapComparisonOperator('lt')).toBe('<');
			expect(mapComparisonOperator('lte')).toBe('<=');
			expect(mapComparisonOperator('like')).toBe('LIKE');
			expect(mapComparisonOperator('ilike')).toBe('ILIKE');
			expect(mapComparisonOperator('isDistinctFrom')).toBe('IS DISTINCT FROM');
		});

		it('refuses unknown operators', () => {
			expect(() => mapComparisonOperator('unknownOp')).toThrow(
				'No WHERE handler registered for operator: unknownOp',
			);
		});
	});

	describe('valueToNode', () => {
		it('converts string to A_Const sval', () => {
			expect(valueToNode('hello')).toEqual({
				A_Const: { sval: { sval: 'hello' } },
			});
		});

		it('converts integer to A_Const ival', () => {
			expect(valueToNode(42)).toEqual({
				A_Const: { ival: { ival: 42 } },
			});
		});

		it('converts float to A_Const fval', () => {
			expect(valueToNode(3.14)).toEqual({
				A_Const: { fval: { fval: '3.14' } },
			});
		});

		it('converts boolean to A_Const boolval', () => {
			expect(valueToNode(true)).toEqual({
				A_Const: { boolval: { boolval: true } },
			});
			expect(valueToNode(false)).toEqual({
				A_Const: { boolval: { boolval: false } },
			});
		});

		it('converts null to A_Const isnull', () => {
			expect(valueToNode(null)).toEqual({
				A_Const: { isnull: true },
			});
		});

		it('converts other types to string sval', () => {
			expect(valueToNode(undefined)).toEqual({
				A_Const: { sval: { sval: 'undefined' } },
			});
			expect(valueToNode({ key: 'value' })).toEqual({
				A_Const: { sval: { sval: '[object Object]' } },
			});
		});
	});

	describe('convertWhereToDecisions', () => {
		it('converts comparison condition', () => {
			const where = {
				kind: 'comparison',
				field: 'age',
				operator: 'gte',
				value: 18,
			};
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{
					type: 'where',
					column: 'age',
					operator: 'gte',
					value: 18,
					table: 'users',
				},
			]);
		});

		it('converts like condition', () => {
			const where = { kind: 'like', field: 'name', pattern: '%John%' };
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{
					type: 'where',
					column: 'name',
					operator: 'like',
					value: '%John%',
					table: 'users',
				},
			]);
		});

		it('converts in condition with values', () => {
			const where = { kind: 'in', field: 'id', values: [1, 2, 3] };
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{
					type: 'where',
					column: 'id',
					operator: 'in',
					value: [1, 2, 3],
					table: 'users',
				},
			]);
		});

		it('converts in condition with subquery (delegates to convertWhereCondition for correct inSubquery shape)', () => {
			// OLD behavior (locked a bug): passed the subquery object as a raw `value`
			// producing operator:'in' with value:{from,select,...} — never a valid Decision.
			// NEW correct behavior: delegates to convertIn which builds operator:'inSubquery'
			// with targetTable, selectColumn, and conditions, matching the decisions path.
			const subquery = {
				type: 'select',
				from: 'active',
				select: { fields: ['id'] },
			};
			const where = { kind: 'in', field: 'id', subquery };
			const result = convertWhereToDecisions(where, 'users');
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				type: 'where',
				column: 'id',
				operator: 'inSubquery',
				targetTable: 'active',
				selectColumn: 'id',
			});
		});

		it('converts range condition with explicit operator', () => {
			const where = {
				kind: 'range',
				field: 'price',
				operator: 'gte',
				value: 100,
			};
			expect(convertWhereToDecisions(where, 'products')).toEqual([
				{
					type: 'where',
					column: 'price',
					operator: 'gte',
					value: 100,
					table: 'products',
				},
			]);
		});

		it('converts range condition without operator (defaults to between)', () => {
			const where = { kind: 'range', field: 'age', value: [18, 65] };
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{
					type: 'where',
					column: 'age',
					operator: 'between',
					value: [18, 65],
					table: 'users',
				},
			]);
		});

		it('converts null condition', () => {
			const where = { kind: 'null', field: 'deleted_at', operator: 'isNull' };
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{
					type: 'where',
					column: 'deleted_at',
					operator: 'isNull',
					value: null,
					table: 'users',
				},
			]);
		});

		it('converts AND with multiple conditions', () => {
			const where = {
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'age', operator: 'gte', value: 18 },
					{ kind: 'comparison', field: 'active', operator: 'eq', value: true },
				],
			};
			const result = convertWhereToDecisions(where, 'users');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('whereAnd');
			expect(result[0].conditions).toHaveLength(2);
		});

		it('converts AND with single condition (unwraps)', () => {
			const where = {
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
				],
			};
			const result = convertWhereToDecisions(where, 'users');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('where');
		});

		it('converts AND with empty conditions', () => {
			const where = { kind: 'and', conditions: [] };
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{ type: 'whereAnd', conditions: [] },
			]);
		});

		it('converts OR with multiple conditions', () => {
			const where = {
				kind: 'or',
				conditions: [
					{ kind: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
					{ kind: 'comparison', field: 'role', operator: 'eq', value: 'owner' },
				],
			};
			const result = convertWhereToDecisions(where, 'users');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('whereOr');
			expect(result[0].conditions).toHaveLength(2);
		});

		it('converts OR with single condition (unwraps)', () => {
			const where = {
				kind: 'or',
				conditions: [
					{ kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
				],
			};
			const result = convertWhereToDecisions(where, 'users');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('where');
		});

		it('converts OR with empty conditions', () => {
			const where = { kind: 'or', conditions: [] };
			expect(convertWhereToDecisions(where, 'users')).toEqual([
				{ type: 'whereOr', conditions: [] },
			]);
		});

		it('converts NOT with condition', () => {
			const where = {
				kind: 'not',
				condition: {
					kind: 'comparison',
					field: 'deleted',
					operator: 'eq',
					value: true,
				},
			};
			const result = convertWhereToDecisions(where, 'users');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('whereNot');
			expect(result[0].conditions).toHaveLength(1);
		});

		it('converts NOT with unknown inner kind — now throws (was silent-drop, locked the broadening bug)', () => {
			// OLD behavior (locked the silent-drop bug): unknown kind inside 'not' silently
			// returned [] causing the not to collapse — predicate vanished from SQL.
			// NEW behavior: exhaustive default throws, preventing silent filter broadening.
			const where = { kind: 'not', condition: { kind: 'unknown' } };
			expect(() => convertWhereToDecisions(where, 'users')).toThrow(
				/unhandled predicate kind 'unknown'/,
			);
		});

		it('unknown top-level kind — now throws (was silent-drop, locked the broadening bug)', () => {
			// OLD behavior (locked the silent-drop bug): unknown top-level kind returned []
			// — predicate vanished from SQL of any nested exists that used it.
			// NEW behavior: exhaustive default throws, preventing silent filter broadening.
			const where = { kind: 'unknownType', field: 'x' };
			expect(() => convertWhereToDecisions(where, 'users')).toThrow(
				/unhandled predicate kind 'unknownType'/,
			);
		});

		it('returns empty for null/undefined where', () => {
			expect(convertWhereToDecisions(null, 'users')).toEqual([]);
			expect(convertWhereToDecisions(undefined, 'users')).toEqual([]);
			expect(convertWhereToDecisions('string', 'users')).toEqual([]);
		});
	});

	describe('convertDottedFieldsToExists', () => {
		const mockModel = {
			getRelation: (key: string) => {
				if (key === 'users.posts')
					return {
						name: 'posts',
						sourceKey: 'id',
						target: 'posts',
						foreignKey: 'user_id',
						type: 'hasMany',
					};
				if (key === 'posts.author')
					return {
						name: 'author',
						targetKey: 'id',
						target: 'users',
						foreignKey: 'user_id',
						type: 'belongsTo',
					};
				return undefined;
			},
		};

		it('converts dotted field to EXISTS subquery', () => {
			const decisions = [
				{
					type: 'where',
					column: 'posts.title',
					operator: 'like',
					value: '%test%',
					table: 'users',
				},
			];
			const result = convertDottedFieldsToExists(decisions, 'users', mockModel);
			expect(result[0].operator).toBe('exists');
			expect(result[0].targetTable).toBe('posts');
			expect(result[0].conditions).toHaveLength(1);
			expect(result[0].conditions[0].column).toBe('title');
		});

		it('preserves non-dotted fields', () => {
			const decisions = [
				{
					type: 'where',
					column: 'name',
					operator: 'eq',
					value: 'John',
					table: 'users',
				},
			];
			const result = convertDottedFieldsToExists(decisions, 'users', mockModel);
			expect(result).toEqual(decisions);
		});

		it('preserves decision if relation not found', () => {
			const decisions = [
				{
					type: 'where',
					column: 'unknown.field',
					operator: 'eq',
					value: 1,
					table: 'users',
				},
			];
			const result = convertDottedFieldsToExists(decisions, 'users', mockModel);
			expect(result).toEqual(decisions);
		});

		it('recurses into whereAnd conditions', () => {
			const decisions = [
				{
					type: 'whereAnd',
					conditions: [
						{
							type: 'where',
							column: 'posts.published',
							operator: 'eq',
							value: true,
							table: 'users',
						},
					],
				},
			];
			const result = convertDottedFieldsToExists(decisions, 'users', mockModel);
			expect(result[0].conditions[0].operator).toBe('exists');
		});

		it('recurses into whereOr conditions', () => {
			const decisions = [
				{
					type: 'whereOr',
					conditions: [
						{
							type: 'where',
							column: 'author.verified',
							operator: 'eq',
							value: true,
							table: 'posts',
						},
					],
				},
			];
			const result = convertDottedFieldsToExists(decisions, 'posts', mockModel);
			expect(result[0].conditions[0].operator).toBe('exists');
		});

		it('recurses into whereNot conditions', () => {
			const decisions = [
				{
					type: 'whereNot',
					conditions: [
						{
							type: 'where',
							column: 'posts.draft',
							operator: 'eq',
							value: true,
							table: 'users',
						},
					],
				},
			];
			const result = convertDottedFieldsToExists(decisions, 'users', mockModel);
			expect(result[0].conditions[0].operator).toBe('exists');
		});

		it('skips non-where decisions', () => {
			const decisions = [
				{ type: 'select', column: 'id', table: 'users' },
				{ type: 'orderBy', column: 'name', direction: 'ASC', table: 'users' },
			];
			const result = convertDottedFieldsToExists(decisions, 'users', mockModel);
			expect(result).toEqual(decisions);
		});
	});

	describe('extractExistsDecisions', () => {
		it('extracts exists decision from plan', () => {
			const plan = {
				rootTable: 'users',
				intent: {
					where: {
						kind: 'exists',
						relation: 'posts',
						where: {
							kind: 'comparison',
							field: 'published',
							operator: 'eq',
							value: true,
						},
					},
				},
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: { target: 'posts', relation: 'posts' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].operator).toBe('exists');
			expect(result[0].targetTable).toBe('posts');
			expect(result[0].conditions).toHaveLength(1);
		});

		it('extracts notExists decision', () => {
			const plan = {
				rootTable: 'users',
				intent: { where: { kind: 'notExists', relation: 'orders' } },
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'notExists',
						context: { target: 'orders', relation: 'orders' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].operator).toBe('notExists');
		});

		it('extracts relationFilter mode=none as notExists', () => {
			const plan = {
				rootTable: 'users',
				intent: {
					where: { kind: 'relationFilter', relation: 'posts', mode: 'none' },
				},
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: { target: 'posts', relation: 'posts' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result[0].operator).toBe('notExists');
		});

		it('extracts relationFilter mode=every', () => {
			const plan = {
				rootTable: 'users',
				intent: {
					where: { kind: 'relationFilter', relation: 'posts', mode: 'every' },
				},
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: { target: 'posts', relation: 'posts' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result[0].operator).toBe('every');
		});

		it('matches intent by includeAlias', () => {
			const plan = {
				rootTable: 'users',
				intent: { where: { kind: 'exists', relation: 'articles' } },
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: { target: 'posts', includeAlias: 'articles' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result).toHaveLength(1);
		});

		it('matches intent with array relation', () => {
			const plan = {
				rootTable: 'users',
				intent: { where: { kind: 'relationFilter', relation: ['posts'] } },
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: { target: 'posts', relation: 'posts' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result).toHaveLength(1);
		});

		it('skips decision without target', () => {
			const plan = {
				rootTable: 'users',
				intent: { where: { kind: 'exists', relation: 'posts' } },
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: { relation: 'posts' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result).toEqual([]);
		});

		it('propagates join choice to decision', () => {
			const plan = {
				rootTable: 'users',
				intent: { where: { kind: 'exists', relation: 'posts' } },
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'join',
						context: { target: 'posts', relation: 'posts' },
					},
				],
			};
			const result = extractExistsDecisions(plan);
			expect(result[0].choice).toBe('join');
		});

		it('returns empty if no filter-strategy decisions', () => {
			const plan = {
				rootTable: 'users',
				intent: {},
				decisions: [{ type: 'select', column: 'id' }],
			};
			expect(extractExistsDecisions(plan)).toEqual([]);
		});

		it('resolves FK from model if provided', () => {
			const model = {
				getRelation: (key: string) =>
					key === 'users.posts'
						? {
								name: 'posts',
								sourceKey: 'id',
								target: 'posts',
								foreignKey: 'user_id',
								type: 'hasMany',
							}
						: undefined,
			};
			const plan = {
				rootTable: 'users',
				intent: { where: { kind: 'exists', relation: 'posts' } },
				decisions: [
					{
						type: 'filter-strategy',
						choice: 'exists',
						context: {
							target: 'posts',
							relation: 'posts',
							sourceTable: 'users',
						},
					},
				],
			};
			const result = extractExistsDecisions(plan, model);
			expect(result[0].foreignKey).toEqual(['user_id']);
		});
	});
});
