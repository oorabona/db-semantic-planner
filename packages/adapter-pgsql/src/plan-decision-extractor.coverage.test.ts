// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for plan-decision-extractor.ts
 * Focus: Branch coverage for decision extraction, WHERE conversion, include tree building
 */

import { describe, expect, it } from 'vitest';
import {
	convertDottedFieldsToExists,
	deriveForeignKey,
	extractAllIncludeDecisions,
	extractExistsDecisions,
	extractJsonAggDecisions,
	extractLeftJoinIncludeDecisions,
	findExistsIntents,
	mapComparisonOperator,
	resolveIncludeAlias,
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
								target: 'posts',
								foreignKey: 'user_id',
								type: 'hasMany',
							}
						: undefined,
			};
			const result = resolveRelation(model, 'users', 'posts');
			expect(result).toEqual({
				target: 'posts',
				foreignKey: 'user_id',
				relationType: 'hasMany',
			});
		});

		it('resolves relation with array foreign key', () => {
			const model = {
				getRelation: (key: string) =>
					key === 'posts.author'
						? {
								target: 'users',
								foreignKey: ['user_id', 'tenant_id'],
								type: 'belongsTo',
							}
						: undefined,
			};
			const result = resolveRelation(model, 'posts', 'author');
			expect(result).toEqual({
				target: 'users',
				foreignKey: 'user_id',
				relationType: 'belongsTo',
			});
		});

		it('returns undefined for missing relation', () => {
			const model = { getRelation: () => undefined };
			expect(resolveRelation(model, 'users', 'unknown')).toBeUndefined();
		});
	});

	describe('resolveIncludeAlias', () => {
		it('returns relation if available', () => {
			expect(
				resolveIncludeAlias({ relation: 'posts', includeAlias: 'articles' }),
			).toBe('posts');
		});

		it('returns includeAlias if relation undefined', () => {
			expect(resolveIncludeAlias({ includeAlias: 'author' })).toBe('author');
		});

		it('returns undefined if both missing', () => {
			expect(resolveIncludeAlias({})).toBeUndefined();
		});
	});

	describe('deriveForeignKey', () => {
		const deriveFk = (table: string, pk: string) => `${table}_${pk}`;

		it('returns explicit foreignKey', () => {
			expect(
				deriveForeignKey({ foreignKey: 'custom_fk' }, deriveFk, 'id'),
			).toBe('custom_fk');
		});

		it('returns sourceFK if foreignKey missing', () => {
			expect(deriveForeignKey({ sourceFK: 'src_fk' }, deriveFk, 'id')).toBe(
				'src_fk',
			);
		});

		it('derives FK for belongsTo relation', () => {
			expect(
				deriveForeignKey(
					{ relationType: 'belongsTo', target: 'users' },
					deriveFk,
					'id',
				),
			).toBe('users_id');
		});

		it('derives FK for hasMany relation', () => {
			expect(
				deriveForeignKey(
					{ relationType: 'hasMany', sourceTable: 'posts' },
					deriveFk,
					'id',
				),
			).toBe('posts_id');
		});

		it('returns undefined for unknown relationType', () => {
			expect(
				deriveForeignKey({ relationType: 'unknown' }, deriveFk, 'id'),
			).toBeUndefined();
		});

		it('returns undefined if no FK and no relationType', () => {
			expect(deriveForeignKey({}, deriveFk, 'id')).toBeUndefined();
		});

		it('returns undefined for belongsTo without target', () => {
			expect(
				deriveForeignKey({ relationType: 'belongsTo' }, deriveFk, 'id'),
			).toBeUndefined();
		});

		it('returns undefined for hasMany without sourceTable', () => {
			expect(
				deriveForeignKey({ relationType: 'hasMany' }, deriveFk, 'id'),
			).toBeUndefined();
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
		});

		it('defaults to = for unknown operator', () => {
			expect(mapComparisonOperator('unknownOp')).toBe('=');
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

	describe('convertDottedFieldsToExists', () => {
		const mockModel = {
			getRelation: (key: string) => {
				if (key === 'users.posts')
					return { target: 'posts', foreignKey: 'user_id', type: 'hasMany' };
				if (key === 'posts.author')
					return { target: 'users', foreignKey: 'user_id', type: 'belongsTo' };
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
						? { target: 'posts', foreignKey: 'user_id' }
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
			expect(result[0].foreignKey).toBe('user_id');
		});
	});

	describe('extractAllIncludeDecisions', () => {
		it('extracts json_agg strategy with tree structure', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'posts' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('includeStrategy');
			expect(result[0].choice).toBe('json_agg');
		});

		it('extracts lateral strategy', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'posts' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'lateral',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].choice).toBe('lateral');
		});

		it('extracts subquery strategy (mapped to json_agg)', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'posts' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].choice).toBe('json_agg');
		});

		it('extracts join strategy as flat decision', () => {
			const plan = {
				rootTable: 'users',
				intent: {
					include: [
						{
							relation: 'profile',
							select: { type: 'fields', fields: ['bio'] },
						},
					],
				},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: { target: 'profiles', relation: 'profile' },
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].choice).toBe('join');
			expect(result[0].columns).toContain('id');
			expect(result[0].columns).toContain('bio');
		});

		it('extracts cte strategy as flat decision', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'posts' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'cte',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].choice).toBe('cte');
		});

		it('builds nested tree for nested includes', () => {
			const plan = {
				rootTable: 'users',
				intent: {
					include: [
						{
							relation: 'posts',
							include: [{ relation: 'comments' }],
						},
					],
				},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'comments',
							relation: 'comments',
							intentPath: 'include[0].include[0]',
						},
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].children).toHaveLength(1);
			expect(result[0].children[0].relationName).toBe('comments');
		});

		it('extracts per-include limit from intent', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'posts', limit: 5 }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].limit).toBe(5);
		});

		it('returns empty if no include-strategy decisions', () => {
			const plan = {
				rootTable: 'users',
				intent: {},
				decisions: [{ type: 'select', column: 'id' }],
			};
			expect(extractAllIncludeDecisions(plan)).toEqual([]);
		});

		it('skips decision without target or relationName', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'posts' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: { intentPath: 'include[0]' },
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result).toEqual([]);
		});
	});

	describe('extractJsonAggDecisions (legacy)', () => {
		it('extracts json_agg include decisions', () => {
			const plan = {
				rootTable: 'users',
				intent: {},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
				],
			};
			const result = extractJsonAggDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('selectJsonAgg');
		});

		it('builds nested tree structure', () => {
			const plan = {
				rootTable: 'users',
				intent: {},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'posts',
							relation: 'posts',
							intentPath: 'include[0]',
						},
					},
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							target: 'comments',
							relation: 'comments',
							intentPath: 'include[0].include[0]',
						},
					},
				],
			};
			const result = extractJsonAggDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].children).toHaveLength(1);
		});

		it('returns empty if no json_agg decisions', () => {
			const plan = {
				rootTable: 'users',
				intent: {},
				decisions: [{ type: 'select', column: 'id' }],
			};
			expect(extractJsonAggDecisions(plan)).toEqual([]);
		});
	});

	describe('extractLeftJoinIncludeDecisions (legacy)', () => {
		it('extracts join include decisions', () => {
			const plan = {
				rootTable: 'users',
				intent: {
					include: [
						{
							relation: 'profile',
							select: { type: 'fields', fields: ['bio', 'avatar'] },
						},
					],
				},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: { target: 'profiles', relation: 'profile' },
					},
				],
			};
			const result = extractLeftJoinIncludeDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('selectLeftJoinInclude');
			expect(result[0].columns).toEqual(['id', 'bio', 'avatar']);
		});

		it('defaults to [id] if no select fields', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'profile' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: { target: 'profiles', relation: 'profile' },
					},
				],
			};
			const result = extractLeftJoinIncludeDecisions(plan);
			expect(result[0].columns).toEqual(['id']);
		});

		it('skips decision without target or relationName', () => {
			const plan = {
				rootTable: 'users',
				intent: { include: [{ relation: 'profile' }] },
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: {},
					},
				],
			};
			const result = extractLeftJoinIncludeDecisions(plan);
			expect(result).toEqual([]);
		});

		it('returns empty if no join decisions', () => {
			const plan = {
				rootTable: 'users',
				intent: {},
				decisions: [{ type: 'select', column: 'id' }],
			};
			expect(extractLeftJoinIncludeDecisions(plan)).toEqual([]);
		});
	});

	// INCLUDE-WHERE-SCOPE regression: extractAllIncludeDecisions must propagate
	// WHERE conditions from the include intent into the join decision's conditions.
	describe('extractAllIncludeDecisions — join where conditions (INCLUDE-WHERE-SCOPE)', () => {
		it('populates conditions when include intent has a where clause', () => {
			const plan = {
				rootTable: 'symbols',
				intent: {
					include: [
						{
							relation: 'file',
							where: {
								kind: 'comparison',
								field: 'project_id',
								operator: 'eq',
								value: 42,
							},
						},
					],
				},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: { target: 'files', relation: 'file' },
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result).toHaveLength(1);
			expect(result[0].conditions).toBeDefined();
			expect(result[0].conditions).toHaveLength(1);
			const cond = result[0].conditions[0];
			expect(cond.type).toBe('where');
			expect(cond.column).toBe('project_id');
			expect(cond.value).toBe(42);
			// Condition table should be the joined alias (relationName)
			expect(cond.table).toBe('file');
		});

		it('leaves conditions undefined when include has no where clause', () => {
			const plan = {
				rootTable: 'symbols',
				intent: {
					include: [{ relation: 'file' }],
				},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: { target: 'files', relation: 'file' },
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].conditions).toBeUndefined();
		});

		it('populates conditions from AND where clause', () => {
			const plan = {
				rootTable: 'symbols',
				intent: {
					include: [
						{
							relation: 'file',
							where: {
								kind: 'and',
								conditions: [
									{
										kind: 'comparison',
										field: 'project_id',
										operator: 'eq',
										value: 5,
									},
									{
										kind: 'comparison',
										field: 'deleted',
										operator: 'eq',
										value: false,
									},
								],
							},
						},
					],
				},
				decisions: [
					{
						type: 'include-strategy',
						choice: 'join',
						context: { target: 'files', relation: 'file' },
					},
				],
			};
			const result = extractAllIncludeDecisions(plan);
			expect(result[0].conditions).toBeDefined();
			// AND with 2 conditions → single whereAnd decision
			expect(result[0].conditions).toHaveLength(1);
			expect(result[0].conditions[0].type).toBe('whereAnd');
			expect(result[0].conditions[0].conditions).toHaveLength(2);
		});
	});
});
