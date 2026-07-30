import { describe, expect, it } from 'vitest';
import {
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
} from './dialects/index.js';
import { ref, schema } from './dx/schema.js';
import type { QueryIntent } from './index.js';
import type { RecursiveIntent } from './intent-ast.js';
import type { ModelIR } from './model-ir.js';
import {
	AmbiguousPlanError,
	plan,
	planRecursive,
	RecursiveShapeMismatchError,
	validateRecursiveShape,
} from './planner.js';

// ============================================================================
// Test Schemas
// ============================================================================

/**
 * Q1 Schema: Products with images (for EXISTS filter test)
 */
const q1Schema = schema({
	products: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	productImages: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products', { as: 'product', inverse: 'images' }),
		locale: 'string',
		type: 'string',
		approved: 'boolean',
	},
}).model;

/**
 * Q2 Schema: Categories with products (for CTE extraction test)
 */
const q2Schema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		categoryId: ref('categories', {
			as: 'category',
			inverse: 'products',
			nullable: true,
		}),
		active: 'boolean',
	},
}).model;

/**
 * Q3 Schema: Users with multiple relations to posts (for ambiguity test)
 */
const q3Schema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		createdById: ref('users', { as: 'creator', inverse: 'createdPosts' }),
		editedById: ref('users', { as: 'editor', inverse: 'editedPosts' }),
	},
}).model;

/**
 * Q4 Schema: 4-level chain for LEFT JOIN cascade tests
 * roots → betas(nullable) → gammas(nullable) → deltas(nullable)
 */
const q4Schema = schema({
	roots: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	betas: {
		id: { type: 'integer', primaryKey: true },
		rootId: ref('roots', { as: 'root', inverse: 'betas', nullable: true }),
	},
	gammas: {
		id: { type: 'integer', primaryKey: true },
		betaId: ref('betas', { as: 'beta', inverse: 'gammas', nullable: true }),
	},
	deltas: {
		id: { type: 'integer', primaryKey: true },
		gammaId: ref('gammas', { as: 'gamma', inverse: 'deltas', nullable: true }),
	},
}).model;

// ============================================================================
// Basic Planning Tests
// ============================================================================

describe('Semantic Planner', () => {
	describe('basic planning', () => {
		it('should plan a simple select query', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
			};

			const report = plan(intent, q1Schema);

			expect(report.rootTable).toBe('products');
			expect(report.decisions).toHaveLength(0); // No relations to analyze
			expect(report.warnings).toHaveLength(0);
			expect(report.ctes).toHaveLength(0);
			expect(report.metadata.isAmbiguous).toBe(false);
		});

		it('should throw for unknown table', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'nonexistent',
			};

			expect(() => plan(intent, q1Schema)).toThrow(
				'Unknown table: nonexistent',
			);
		});

		it('should include planning metadata', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
			};

			const report = plan(intent, q1Schema);

			expect(report.metadata.planningTimeMs).toBeGreaterThanOrEqual(0);
			expect(report.metadata.relationsAnalyzed).toBe(0);
			expect(report.intent).toBe(intent);
		});
	});

	// ============================================================================
	// Q1: EXISTS Filter Strategy Tests
	// ============================================================================

	describe('Q1: EXISTS filter for to-many relations', () => {
		it('should choose EXISTS strategy for hasMany filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'exists',
					relation: 'images',
					where: {
						kind: 'and',
						conditions: [
							{
								kind: 'comparison',
								field: 'locale',
								operator: 'eq',
								value: 'en',
							},
							{
								kind: 'comparison',
								field: 'type',
								operator: 'eq',
								value: 'thumbnail',
							},
							{
								kind: 'comparison',
								field: 'approved',
								operator: 'eq',
								value: true,
							},
						],
					},
				},
			};

			const report = plan(intent, q1Schema);

			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeDefined();
			expect(filterDecision?.choice).toBe('exists');
			expect(filterDecision?.context.relation).toBe('images');
			expect(filterDecision?.reasoning).toContain('cardinality "many"');
			expect(filterDecision?.alternatives).toContain('join');
		});

		it('should choose JOIN strategy for belongsTo filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'productImages',
				where: {
					kind: 'exists',
					relation: 'product',
				},
			};

			const report = plan(intent, q1Schema);

			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeDefined();
			expect(filterDecision?.choice).toBe('join');
			expect(filterDecision?.reasoning).toContain('cardinality "one"');
		});

		it('should not warn about row explosion when using EXISTS', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'exists',
					relation: 'images',
				},
			};

			const report = plan(intent, q1Schema);

			const rowExplosionWarning = report.warnings.find(
				(w) => w.code === 'POTENTIAL_ROW_EXPLOSION',
			);
			expect(rowExplosionWarning).toBeUndefined();
		});

		it('should warn about row explosion when forcing JOIN on to-many', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'exists',
					relation: 'images',
				},
			};

			const report = plan(intent, q1Schema, { forceFilterStrategy: 'join' });

			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('join');

			const rowExplosionWarning = report.warnings.find(
				(w) => w.code === 'POTENTIAL_ROW_EXPLOSION',
			);
			expect(rowExplosionWarning).toBeDefined();
			expect(rowExplosionWarning?.message).toContain('images');
		});

		it('should handle relationFilter with mode some', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'relationFilter',
					relation: 'images',
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
					mode: 'some',
				},
			};

			const report = plan(intent, q1Schema);

			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('exists');
		});

		it('should handle notExists filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'notExists',
					relation: 'images',
				},
			};

			const report = plan(intent, q1Schema);

			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('exists');
		});
	});

	// ============================================================================
	// IN → EXISTS Optimization
	// ============================================================================

	describe('IN → EXISTS optimization', () => {
		it('should rewrite IN-subquery to EXISTS when FK relation is known', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'productImages',
						select: { type: 'fields', fields: ['productId'] },
						where: {
							kind: 'comparison',
							field: 'approved',
							operator: 'eq',
							value: true,
						},
					},
				},
			};

			const report = plan(intent, q1Schema);

			// Should have an EXISTS filter decision (not an IN)
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('exists');
		});

		it('should rewrite NOT IN-subquery to notExists', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'not',
					condition: {
						kind: 'in',
						field: 'id',
						subquery: {
							type: 'select',
							from: 'productImages',
							select: { type: 'fields', fields: ['productId'] },
							where: {
								kind: 'comparison',
								field: 'approved',
								operator: 'eq',
								value: true,
							},
						},
					},
				},
			};

			const report = plan(intent, q1Schema);

			// Should produce a notExists decision
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('exists');
		});

		it('should NOT optimize IN-subquery when relation is unknown', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'unknownTable',
						select: { type: 'fields', fields: ['productId'] },
					},
				},
			};

			// Unknown table — optimization should not apply, plan should still work
			// (the IN subquery just passes through as-is)
			expect(() => plan(intent, q1Schema)).not.toThrow();
		});

		it('should NOT optimize IN with literal values (no subquery)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'in',
					field: 'id',
					values: [1, 2, 3],
				},
			};

			const report = plan(intent, q1Schema);

			// No filter-strategy decision — IN with values goes through as simple where
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeUndefined();
		});

		it('should NOT optimize when subquery selects multiple fields', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'productImages',
						select: { type: 'fields', fields: ['productId', 'locale'] },
					},
				},
			};

			const report = plan(intent, q1Schema);

			// Multi-column subquery — no optimization, no filter-strategy
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeUndefined();
		});

		it('should optimize IN-subquery within AND conditions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'Widget',
						},
						{
							kind: 'in',
							field: 'id',
							subquery: {
								type: 'select',
								from: 'productImages',
								select: { type: 'fields', fields: ['productId'] },
								where: {
									kind: 'comparison',
									field: 'approved',
									operator: 'eq',
									value: true,
								},
							},
						},
					],
				},
			};

			const report = plan(intent, q1Schema);

			// Should have both a regular where and an EXISTS filter
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('exists');
		});
	});

	// ============================================================================
	// Self-referential relation detection in filter-strategy decisions
	// ============================================================================

	describe('Self-ref detection in filter-strategy decisions', () => {
		const selfRefSchema = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				parentId: ref('categories', {
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		}).model;

		it('should set isSelfRef=true for self-referential relation filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				where: {
					kind: 'relationFilter',
					relation: ['children'],
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Electronics',
					},
				},
			};

			const report = plan(intent, selfRefSchema);
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);

			expect(filterDecision).toBeDefined();
			expect(filterDecision?.context.isSelfRef).toBe(true);
			expect(filterDecision?.reasoning).toContain('[self-referential]');
		});

		it('should not set isSelfRef for non-self-referential relation filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'relationFilter',
					relation: ['images'],
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
				},
			};

			const report = plan(intent, q1Schema);
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);

			expect(filterDecision).toBeDefined();
			expect(filterDecision?.context.isSelfRef).toBeUndefined();
			expect(filterDecision?.reasoning).not.toContain('[self-referential]');
		});

		it('should preserve existing filter-strategy decisions for non-self-ref', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'exists',
					relation: 'images',
				},
			};

			const report = plan(intent, q1Schema);
			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);

			expect(filterDecision).toBeDefined();
			expect(filterDecision?.choice).toBe('exists');
			expect(filterDecision?.context.isSelfRef).toBeUndefined();
		});
	});

	// ============================================================================
	// Q2: CTE Extraction Tests
	// ============================================================================

	describe('Q2: CTE extraction for ratio calculations', () => {
		it('should extract CTE when same relation accessed multiple times', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				select: { type: 'fields', fields: ['name'] },
				include: [
					{
						relation: 'products',
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
					{ relation: 'products' },
				],
			};

			const report = plan(intent, q2Schema, { enableCTEs: true });

			expect(report.ctes.length).toBeGreaterThanOrEqual(1);
			expect(report.ctes[0]?.name).toContain('products');
			expect(report.ctes[0]?.referencedBy.length).toBe(2);
		});

		it('should not extract CTE when below threshold', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }],
			};

			const report = plan(intent, q2Schema, {
				enableCTEs: true,
				cteThreshold: 2,
			});

			expect(report.ctes).toHaveLength(0);
		});

		it('should not extract CTE when disabled', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }, { relation: 'products' }],
			};

			const report = plan(intent, q2Schema, { enableCTEs: false });

			expect(report.ctes).toHaveLength(0);
		});

		it('should create CTE extraction decision', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }, { relation: 'products' }],
			};

			const report = plan(intent, q2Schema, { enableCTEs: true });

			const cteDecision = report.decisions.find(
				(d) => d.type === 'cte-extraction',
			);
			expect(cteDecision).toBeDefined();
			expect(cteDecision?.reasoning).toContain('accessed 2 times');
		});
	});

	// ============================================================================
	// Q3: Ambiguity Detection Tests
	// ============================================================================

	describe('Q3: Ambiguity detection', () => {
		it('should throw AmbiguousPlanError when multiple relations exist to same target', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }], // Ambiguous: createdPosts or editedPosts?
			};

			expect(() => plan(intent, q3Schema)).toThrow(AmbiguousPlanError);
		});

		it('should return options in error', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			try {
				plan(intent, q3Schema);
				expect.fail('Should have thrown AmbiguousPlanError');
			} catch (e) {
				expect(e).toBeInstanceOf(AmbiguousPlanError);
				const error = e as AmbiguousPlanError;
				expect(error.sourceTable).toBe('users');
				expect(error.targetTable).toBe('posts');
				expect(error.options).toContain('createdPosts');
				expect(error.options).toContain('editedPosts');
			}
		});

		it('should resolve with via hint', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', via: 'createdPosts' }],
			};

			const report = plan(intent, q3Schema);
			expect(report.metadata.isAmbiguous).toBe(false);
		});

		it('should resolve with disambiguate option', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const report = plan(intent, q3Schema, {
				disambiguate: { 'users.posts': 'editedPosts' },
			});

			expect(report.metadata.isAmbiguous).toBe(false);
		});

		it('should not be ambiguous when using direct relation name', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'createdPosts' }],
			};

			const report = plan(intent, q3Schema);
			expect(report.metadata.isAmbiguous).toBe(false);
		});
	});

	// ============================================================================
	// Include Strategy Tests
	// ============================================================================

	describe('include strategy', () => {
		it('should choose JOIN for to-one includes', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				include: [{ relation: 'category' }],
			};

			const report = plan(intent, q2Schema);

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			expect(includeDecision?.choice).toBe('join');
		});

		it('should choose JOIN for to-many includes (default)', () => {
			// Default behavior: use JOIN and let the database optimizer handle it
			// This avoids N+1 queries and leverages database's query planning
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }],
			};

			const report = plan(intent, q2Schema);

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			expect(includeDecision?.choice).toBe('join');
		});

		it('should choose json_agg when dialect supports it (auto strategy)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }],
			};

			const report = plan(intent, q2Schema, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			expect(includeDecision?.choice).toBe('json_agg');
		});

		it('marks no-primary-key json_agg fallback ordering with neutral metadata', () => {
			const users = {
				name: 'users',
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'name', type: 'text', nullable: false },
				],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			};
			const auditEvents = {
				name: 'audit_events',
				columns: [
					{ name: 'user_id', type: 'integer', nullable: false },
					{ name: 'event_time', type: 'timestamp', nullable: false },
					{ name: 'message', type: 'text', nullable: false },
				],
				foreignKeys: [],
				indexes: [],
			};
			const relation = {
				name: 'auditEvents',
				type: 'hasMany',
				source: 'users',
				target: 'audit_events',
				foreignKey: 'user_id',
				sourceKey: 'id',
				cardinality: 'many',
				optionality: 'optional',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			};
			const tables = new Map([
				['users', users],
				['audit_events', auditEvents],
			]);
			const relations = new Map([['users.auditEvents', relation]]);
			const noPkModel = {
				tables,
				relations,
				getTable: (name: string) => tables.get(name),
				getRelation: (name: string) => relations.get(name),
				getRelationsFrom: (sourceTable: string) =>
					[...relations.values()].filter((rel) => rel.source === sourceTable),
				getRelationsTo: (targetTable: string) =>
					[...relations.values()].filter((rel) => rel.target === targetTable),
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			} as unknown as ModelIR;
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'auditEvents' }],
			};

			const report = plan(intent, noPkModel, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision?.choice).toBe('json_agg');
			expect(includeDecision?.context.targetOrderKey).toEqual([
				'user_id',
				'event_time',
				'message',
			]);
			expect(includeDecision?.context.orderByFallback).toBe(true);
			expect(
				includeDecision?.context.targetOrderKey?.every(
					(entry) => typeof entry === 'string',
				),
			).toBe(true);
		});

		it('should use join when flat strategy is used without limit', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products', strategy: 'flat' }],
			};

			const report = plan(intent, q2Schema, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			// flat without limit → join (simpler, better optimized by DB)
			expect(includeDecision?.choice).toBe('join');
		});

		it('should use lateral when flat strategy is used with limit', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products', strategy: 'flat', limit: 3 }],
			};

			const report = plan(intent, q2Schema, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			// flat + limit → lateral (per-row LIMIT requires correlated subquery)
			expect(includeDecision?.choice).toBe('lateral');
		});

		it('should fallback to join when flat is used and no lateral support', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products', strategy: 'flat' }],
			};

			const report = plan(intent, q2Schema, {
				dialectCapabilities: MYSQL_CAPABILITIES,
			});

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			// flat excludes json_agg, no lateral → falls back to join
			expect(includeDecision?.choice).toBe('join');
		});

		it('should use SEPARATE when explicitly requested via defaultIncludeStrategy', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }],
			};

			const report = plan(intent, q2Schema, {
				defaultIncludeStrategy: 'subquery',
			});

			const includeDecision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision).toBeDefined();
			expect(includeDecision?.choice).toBe('subquery');
		});
	});

	// ============================================================================
	// Join Type Tests
	// ============================================================================

	describe('join type', () => {
		it('should choose LEFT JOIN for optional without filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				include: [{ relation: 'category' }],
			};

			const report = plan(intent, q2Schema);

			const joinDecision = report.decisions.find((d) => d.type === 'join-type');
			expect(joinDecision).toBeDefined();
			expect(joinDecision?.choice).toBe('left');
		});

		it('should choose INNER JOIN for optional with filter', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				include: [
					{
						relation: 'category',
						where: {
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'Electronics',
						},
					},
				],
			};

			const report = plan(intent, q2Schema);

			const joinDecision = report.decisions.find((d) => d.type === 'join-type');
			expect(joinDecision).toBeDefined();
			expect(joinDecision?.choice).toBe('inner');
		});

		it('should respect forceJoinType option', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				include: [{ relation: 'category' }],
			};

			const report = plan(intent, q2Schema, { forceJoinType: 'inner' });

			const joinDecision = report.decisions.find((d) => d.type === 'join-type');
			expect(joinDecision?.choice).toBe('inner');
		});

		it('should cascade LEFT JOIN to required children of optional parent', () => {
			// roots → betas(optional/LEFT) → gammas(optional/LEFT, required child)
			// gammas is nullable (optional), so it gets LEFT; its required child
			// deltas would normally get INNER but should be forced LEFT by ancestor cascade
			const intent: QueryIntent = {
				type: 'select',
				from: 'roots',
				include: [
					{
						relation: 'betas',
						include: [
							{
								relation: 'gammas',
								include: [{ relation: 'deltas' }],
							},
						],
					},
				],
			};

			const report = plan(intent, q4Schema);

			const joinDecisions = report.decisions.filter(
				(d) => d.type === 'join-type',
			);
			const betasDecision = joinDecisions.find(
				(d) => d.context.relation === 'betas',
			);
			const gammasDecision = joinDecisions.find(
				(d) => d.context.relation === 'gammas',
			);
			const deltasDecision = joinDecisions.find(
				(d) => d.context.relation === 'deltas',
			);

			expect(betasDecision?.choice).toBe('left');
			expect(gammasDecision?.choice).toBe('left');
			// deltas is also nullable/optional, so it's LEFT regardless of cascade
			expect(deltasDecision?.choice).toBe('left');
		});

		it('should reset LEFT JOIN cascade after explicit join: inner override', () => {
			// roots → betas(optional/LEFT) → gammas(explicit inner) → deltas(optional)
			// Bug: before fix, deltas got LEFT because betas' ancestorIsLeftJoin=true
			//      propagated through gammas' explicit inner override.
			// Fix: gammas' explicit inner resets the cascade, so deltas gets its
			//      natural join type (LEFT for optional, INNER for required).
			const intent: QueryIntent = {
				type: 'select',
				from: 'roots',
				include: [
					{
						relation: 'betas',
						include: [
							{
								relation: 'gammas',
								join: 'inner',
								include: [{ relation: 'deltas' }],
							},
						],
					},
				],
			};

			const report = plan(intent, q4Schema);

			const joinDecisions = report.decisions.filter(
				(d) => d.type === 'join-type',
			);
			const betasDecision = joinDecisions.find(
				(d) => d.context.relation === 'betas',
			);
			const gammasDecision = joinDecisions.find(
				(d) => d.context.relation === 'gammas',
			);
			const deltasDecision = joinDecisions.find(
				(d) => d.context.relation === 'deltas',
			);

			// betas: optional, no filter → LEFT
			expect(betasDecision?.choice).toBe('left');
			// gammas: explicit join:'inner' override → INNER
			expect(gammasDecision?.choice).toBe('inner');
			// deltas: optional, but cascade was RESET by gammas' explicit inner
			// → natural join type applies: LEFT (optional, no filter)
			expect(deltasDecision?.choice).toBe('left');
		});
	});

	// ============================================================================
	// Nested Processing Tests
	// ============================================================================

	describe('nested processing', () => {
		it('should process nested includes', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [
					{
						relation: 'products',
						include: [{ relation: 'category' }],
					},
				],
			};

			const report = plan(intent, q2Schema);

			// Should have decisions for both levels
			expect(report.decisions.length).toBeGreaterThanOrEqual(2);
			expect(report.metadata.relationsAnalyzed).toBeGreaterThanOrEqual(2);
		});

		it('should process nested where conditions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'exists',
							relation: 'images',
						},
						{
							kind: 'or',
							conditions: [
								{
									kind: 'comparison',
									field: 'name',
									operator: 'eq',
									value: 'A',
								},
								{
									kind: 'comparison',
									field: 'name',
									operator: 'eq',
									value: 'B',
								},
							],
						},
					],
				},
			};

			const report = plan(intent, q1Schema);

			const filterDecision = report.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeDefined();
		});

		it('should warn about deep nesting', () => {
			// Create a deeply nested intent that exceeds maxIncludeDepth
			// With maxIncludeDepth: 0, any include at depth 1 should trigger warning
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [
					{
						relation: 'products', // depth 0 - this is fine
						include: [
							{
								relation: 'category', // depth 1 - exceeds maxIncludeDepth: 0
							},
						],
					},
				],
			};

			const report = plan(intent, q2Schema, { maxIncludeDepth: 0 });

			const deepNestingWarning = report.warnings.find(
				(w) => w.code === 'DEEP_NESTING',
			);
			expect(deepNestingWarning).toBeDefined();
			expect(deepNestingWarning?.message).toContain('depth');
		});

		it('should detect circular includes', () => {
			// This would be: categories -> products -> category -> products...
			// But in our test, we manually create a potential circular path
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [
					{
						relation: 'products',
						include: [
							{
								relation: 'category',
								include: [{ relation: 'products' }],
							},
						],
					},
				],
			};

			const report = plan(intent, q2Schema);

			// Should have completed without infinite loop
			expect(report.decisions.length).toBeGreaterThan(0);
		});
	});

	// ============================================================================
	// Decision ID Generation Tests
	// ============================================================================

	describe('decision ID generation', () => {
		it('should generate unique IDs for each decision', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }, { relation: 'products' }],
			};

			const report = plan(intent, q2Schema);

			const ids = report.decisions.map((d) => d.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it('should use correct ID format', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'products' }],
			};

			const report = plan(intent, q2Schema);

			for (const decision of report.decisions) {
				// Should match pattern like 'includestrategy-001' or 'filterstrategy-001'
				expect(decision.id).toMatch(/^[a-z]+-\d{3}$/);
			}
		});
	});

	// ============================================================================
	// RFC-001: Recursive CTE Planning Tests
	// ============================================================================

	describe('RFC-001: Recursive CTE Planning', () => {
		/**
		 * Recursive schema: Categories with parent (for hierarchical traversal)
		 */
		const recursiveSchema = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				parentId: ref('categories', {
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		}).model;

		/**
		 * Edge-table schema: Roles with edges (for role hierarchy)
		 */
		const edgeTableSchema = schema({
			roles: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
			},
			roleEdges: {
				id: { type: 'integer', primaryKey: true },
				parentRoleId: ref('roles', { as: 'parentRole', inverse: 'childEdges' }),
				childRoleId: ref('roles', { as: 'childRole', inverse: 'parentEdges' }),
			},
		}).model;

		describe('validateRecursiveShape', () => {
			it('should pass for valid adjacency-list intent', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'id',
							operator: 'eq',
							value: 1,
						},
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
				};

				expect(() => validateRecursiveShape(intent)).not.toThrow();
			});

			it('should pass for valid edge-table intent', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'admin',
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'out',
					},
					maxDepth: 10,
				};

				expect(() => validateRecursiveShape(intent)).not.toThrow();
			});

			it('should pass for intent with additional select fields', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
						select: ['name'],
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
				};

				expect(() => validateRecursiveShape(intent)).not.toThrow();
			});
		});

		describe('planRecursive', () => {
			it('should create recursive-cte decision for adjacency traversal', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'id',
							operator: 'eq',
							value: 1,
						},
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);

				expect(report.metadata.isRecursive).toBe(true);
				expect(report.metadata.traversalKind).toBe('adjacency');

				const recursiveDecision = report.decisions.find(
					(d) => d.type === 'recursive-cte',
				);
				expect(recursiveDecision).toBeDefined();
				expect(recursiveDecision?.choice).toBe('with-recursive');
			});

			it('should create recursive-cte decision for edge-table traversal', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'admin',
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'out',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);

				expect(report.metadata.isRecursive).toBe(true);
				expect(report.metadata.traversalKind).toBe('edge-table');
			});

			it('should detect bidirectional traversal and create decision', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'both',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);

				expect(report.metadata.usesBidirectional).toBe(true);

				const bidirDecision = report.decisions.find(
					(d) => d.type === 'bidirectional-edges',
				);
				expect(bidirDecision).toBeDefined();
				// Default edgeStorageHint is 'unknown', so should use UNION
				expect(bidirDecision?.choice).toBe('union');
			});

			it('should use UNION ALL when edgeStorageHint is directed-only', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'both',
						edgeStorageHint: 'directed-only',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);

				const bidirDecision = report.decisions.find(
					(d) => d.type === 'bidirectional-edges',
				);
				expect(bidirDecision).toBeDefined();
				expect(bidirDecision?.choice).toBe('union-all');
			});

			it('should include dedupe strategy in metadata', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
					dedupe: 'final',
				};

				const report = planRecursive(intent, recursiveSchema);

				expect(report.metadata.dedupeStrategy).toBe('final');
			});

			it('should default dedupe to none', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);

				expect(report.metadata.dedupeStrategy).toBe('none');
			});

			it('should preserve original intent in report', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'my_cte',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'ancestors',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);

				expect(report.intent).toBe(intent);
				expect(report.intent.cteName).toBe('my_cte');
			});

			it('should generate unique decision IDs', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'both',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);

				const ids = report.decisions.map((d) => d.id);
				const uniqueIds = new Set(ids);
				expect(uniqueIds.size).toBe(ids.length);
			});
		});

		describe('RecursiveShapeMismatchError', () => {
			it('should contain CTE name and column details', () => {
				const error = new RecursiveShapeMismatchError(
					'test_cte',
					['id', 'name'],
					['id', 'name', 'depth'],
					'Recursive step has extra column: depth',
				);

				expect(error.cteName).toBe('test_cte');
				expect(error.baseColumns).toEqual(['id', 'name']);
				expect(error.recursiveColumns).toEqual(['id', 'name', 'depth']);
				expect(error.mismatchDetails).toContain('depth');
				expect(error.message).toContain('test_cte');
			});

			it('should be an instance of Error', () => {
				const error = new RecursiveShapeMismatchError(
					'cte',
					['a'],
					['a', 'b'],
					'mismatch',
				);

				expect(error).toBeInstanceOf(Error);
				expect(error.name).toBe('RecursiveShapeMismatchError');
			});
		});
	});

	describe('RAW_SQL_USAGE warning', () => {
		const simpleSchema = schema({
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				email: 'string',
			},
		}).model;

		it('should warn when raw SQL expression is used in select', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'expressions',
					columns: [
						{ kind: 'column', column: 'id' },
						{ kind: 'column', column: 'name' },
						{
							kind: 'raw',
							sql: 'NOW()',
							as: 'current_time',
						},
					],
				},
			};

			const report = plan(intent, simpleSchema);

			const rawWarning = report.warnings.find(
				(w) => w.code === 'RAW_SQL_USAGE',
			);
			expect(rawWarning).toBeDefined();
			expect(rawWarning?.message).toContain('NOW()');
			expect(rawWarning?.message).toContain('current_time');
			expect(rawWarning?.suggestion).toContain('bypasses type safety');
		});

		it('should warn for multiple raw SQL expressions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'expressions',
					columns: [
						{ kind: 'column', column: 'id' },
						{ kind: 'raw', sql: 'NOW()', as: 'time1' },
						{ kind: 'raw', sql: 'CURRENT_USER', as: 'user' },
					],
				},
			};

			const report = plan(intent, simpleSchema);

			const rawWarnings = report.warnings.filter(
				(w) => w.code === 'RAW_SQL_USAGE',
			);
			expect(rawWarnings).toHaveLength(2);
		});

		it('should not warn when no raw SQL is used', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'expressions',
					columns: [
						{ kind: 'column', column: 'id' },
						{ kind: 'column', column: 'name' },
						{
							kind: 'coalesce',
							fields: ['name', 'email'],
							as: 'display',
						},
					],
				},
			};

			const report = plan(intent, simpleSchema);

			const rawWarning = report.warnings.find(
				(w) => w.code === 'RAW_SQL_USAGE',
			);
			expect(rawWarning).toBeUndefined();
		});

		it('should not warn for simple select without expressions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const report = plan(intent, simpleSchema);

			const rawWarning = report.warnings.find(
				(w) => w.code === 'RAW_SQL_USAGE',
			);
			expect(rawWarning).toBeUndefined();
		});
	});
});
