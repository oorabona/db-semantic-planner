/**
 * @fileoverview Branch coverage tests for planner.ts
 *
 * Targets uncovered branches in:
 * - processInclude: maxDepth exceeded, circular detection, unknown relation,
 *   ambiguous relation, recursive (non-self-ref warning), CTE dedup,
 *   nested includes, ancestor/descendant virtual relations, flat strategy,
 *   strategy=cte duplication guard
 * - determineJoinType: forceJoinType, joinDefault hint, required vs optional,
 *   optional+filter
 * - extractCTEs: threshold, json_agg skip, CTE already exists skip
 * - disambiguateRelation: ancestors/descendants virtual, via hint, disambiguate
 *   option, missing via hint → AmbiguousPlanError
 * - determineIncludeStrategy: UnsupportedStrategyError for lateral/json_agg/cte
 * - plan: enableCTEs=false, batchValuesSource skip root validation,
 *   ambiguousDecision in metadata
 */

import type { RelationIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	createDialectCapabilities,
	POSTGRESQL_CAPABILITIES,
	SQLITE_CAPABILITIES,
} from '../../dialects/index.js';
import type { QueryIntent } from '../../index.js';
import { ModelIRImpl } from '../../model-impl.js';
import { AmbiguousPlanError, plan } from '../../planner.js';
import { ref, schema } from '../schema.js';

/**
 * Minimal dialect with NO include strategy support.
 * Forces UnsupportedStrategyError for lateral / json_agg / cte.
 */
const NO_STRATEGY_CAPS = createDialectCapabilities({
	name: 'test-no-strategy',
	identifierQuote: '"',
	parameterStyle: 'dollar',
	limitStyle: 'limit-offset',
	booleanStyle: 'native',
	recursivePathStyle: 'string',
	stringConcatStyle: 'operator',
	supportsLateralJoin: false,
	supportsJsonAgg: false,
	supportsRecursiveCTE: false,
});

// ============================================================================
// Schemas
// ============================================================================

const simpleSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		editorId: ref('users', {
			as: 'editor',
			inverse: 'editedPosts',
			nullable: true,
		}),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'string',
		postId: ref('posts', { as: 'post', inverse: 'comments', nullable: true }),
	},
}).model;

const selfRefSchema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
}).model;

const ambiguousSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	tasks: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		createdById: ref('users', { as: 'createdBy', inverse: 'createdTasks' }),
		assignedToId: ref('users', {
			as: 'assignedTo',
			inverse: 'assignedTasks',
			nullable: true,
		}),
	},
}).model;

const deepSchema = schema({
	a: { id: { type: 'integer', primaryKey: true } },
	b: {
		id: { type: 'integer', primaryKey: true },
		aId: ref('a', { as: 'a', inverse: 'bs', nullable: true }),
	},
	c: {
		id: { type: 'integer', primaryKey: true },
		bId: ref('b', { as: 'b', inverse: 'cs', nullable: true }),
	},
	d: {
		id: { type: 'integer', primaryKey: true },
		cId: ref('c', { as: 'c', inverse: 'ds', nullable: true }),
	},
}).model;

// ============================================================================
// determineJoinType branch coverage
// ============================================================================

describe('planner: determineJoinType branches', () => {
	it('forceJoinType=left overrides required relation', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			forceJoinType: 'left',
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision?.choice).toBe('left');
	});

	it('forceJoinType=inner overrides optional relation', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'editor' }],
		};
		const report = plan(intent, simpleSchema, {
			forceJoinType: 'inner',
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision?.choice).toBe('inner');
	});

	it('required relation → INNER JOIN when no forceJoinType', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision?.choice).toBe('inner');
	});

	it('optional relation without filter → LEFT JOIN', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'editor' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision?.choice).toBe('left');
	});

	it('optional relation WITH where filter → INNER JOIN', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [
				{
					relation: 'editor',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Alice',
					},
				},
			],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision?.choice).toBe('inner');
	});

	it('explicit include.join=inner on optional relation forces INNER', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'editor', join: 'inner' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision?.choice).toBe('inner');
	});
});

// ============================================================================
// processInclude: depth exceeded warning
// ============================================================================

describe('planner: processInclude depth exceeded warning', () => {
	it('emits DEEP_NESTING warning when depth > maxIncludeDepth', () => {
		// Root include is at depth=0. Child include is at depth=1.
		// maxIncludeDepth=0 → depth=1 > 0 → fires DEEP_NESTING warning.
		const intent: QueryIntent = {
			type: 'select',
			from: 'a',
			include: [
				{
					relation: 'bs',
					include: [{ relation: 'cs' }],
				},
			],
		};
		const report = plan(intent, deepSchema, { maxIncludeDepth: 0 });
		const warning = report.warnings.find((w) => w.code === 'DEEP_NESTING');
		expect(warning).toBeDefined();
		expect(warning?.code).toBe('DEEP_NESTING');
	});

	it('no DEEP_NESTING warning when within maxIncludeDepth', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'a',
			include: [{ relation: 'bs' }],
		};
		const report = plan(intent, deepSchema, { maxIncludeDepth: 5 });
		const warning = report.warnings.find((w) => w.code === 'DEEP_NESTING');
		expect(warning).toBeUndefined();
	});
});

// ============================================================================
// processInclude: circular detection
// ============================================================================

describe('planner: processInclude circular detection', () => {
	it('emits CIRCULAR_INCLUDE when same relation visited again in traversal path', () => {
		// posts → comments → post → comments (circular)
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [
				{
					relation: 'comments',
					include: [
						{
							relation: 'post',
							include: [{ relation: 'comments' }],
						},
					],
				},
			],
		};
		const report = plan(intent, simpleSchema);
		const circularWarning = report.warnings.find(
			(w) => w.code === 'CIRCULAR_INCLUDE',
		);
		expect(circularWarning).toBeDefined();
		expect(circularWarning?.code).toBe('CIRCULAR_INCLUDE');
	});
});

// ============================================================================
// processInclude: unknown relation
// ============================================================================

describe('planner: processInclude unknown relation', () => {
	it('emits AMBIGUOUS_RELATION warning for unknown relation name', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'nonExistentRelation' }],
		};
		const report = plan(intent, simpleSchema);
		const warning = report.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(warning).toBeDefined();
		expect(warning?.message).toContain('nonExistentRelation');
	});

	it('no include-strategy decision when relation not found', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'ghosts' }],
		};
		const report = plan(intent, simpleSchema);
		const includeDecision = report.decisions.find(
			(d) => d.type === 'include-strategy',
		);
		expect(includeDecision).toBeUndefined();
	});
});

// ============================================================================
// processInclude: via hint
// ============================================================================

describe('planner: processInclude via hint', () => {
	it('uses via hint to resolve ambiguous target-name lookup', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'tasks',
			include: [{ relation: 'users', via: 'createdBy' }],
		};
		const report = plan(intent, ambiguousSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const ambiguous = report.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(ambiguous).toBeUndefined();
		const includeDecision = report.decisions.find(
			(d) =>
				d.type === 'include-strategy' &&
				(d.context as Record<string, unknown>)?.relation === 'createdBy',
		);
		expect(includeDecision).toBeDefined();
	});
});

// ============================================================================
// AmbiguousPlanError
// ============================================================================

describe('planner: AmbiguousPlanError', () => {
	it('throws AmbiguousPlanError for ambiguous relation without via or disambiguate', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'tasks',
			include: [{ relation: 'users' }],
		};
		expect(() => plan(intent, ambiguousSchema)).toThrow(AmbiguousPlanError);
	});

	it('AmbiguousPlanError.sourceTable, .targetTable, .options are set', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'tasks',
			include: [{ relation: 'users' }],
		};
		try {
			plan(intent, ambiguousSchema);
			expect.fail('Should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AmbiguousPlanError);
			const e = err as AmbiguousPlanError;
			expect(e.sourceTable).toBe('tasks');
			expect(e.targetTable).toBe('users');
			expect(e.options.length).toBeGreaterThan(0);
		}
	});

	it('disambiguate option resolves without throwing', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'tasks',
			include: [{ relation: 'users' }],
		};
		const report = plan(intent, ambiguousSchema, {
			disambiguate: { 'tasks.users': 'createdBy' },
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		expect(
			report.warnings.find((w) => w.code === 'AMBIGUOUS_RELATION'),
		).toBeUndefined();
		expect(
			report.decisions.find((d) => d.type === 'include-strategy'),
		).toBeDefined();
	});
});

// ============================================================================
// Virtual ancestors/descendants
// ============================================================================

describe('planner: virtual ancestors/descendants relations', () => {
	it('resolves "ancestors" on self-referential table without AMBIGUOUS_RELATION warning', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'ancestors' }],
		};
		const report = plan(intent, selfRefSchema);
		expect(
			report.warnings.find((w) => w.code === 'AMBIGUOUS_RELATION'),
		).toBeUndefined();
		expect(
			report.decisions.find((d) => d.type === 'include-strategy'),
		).toBeDefined();
	});

	it('resolves "descendants" on self-referential table without AMBIGUOUS_RELATION warning', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'descendants' }],
		};
		const report = plan(intent, selfRefSchema);
		expect(
			report.warnings.find((w) => w.code === 'AMBIGUOUS_RELATION'),
		).toBeUndefined();
		expect(
			report.decisions.find((d) => d.type === 'include-strategy'),
		).toBeDefined();
	});

	it('emits AMBIGUOUS_RELATION for "ancestors" on non-self-referential table', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'ancestors' }],
		};
		const report = plan(intent, simpleSchema);
		expect(
			report.warnings.find((w) => w.code === 'AMBIGUOUS_RELATION'),
		).toBeDefined();
	});
});

// ============================================================================
// recursive flag on non-self-ref
// ============================================================================

describe('planner: recursive flag on non-self-referential relation', () => {
	it('emits INVALID_RECURSIVE_INCLUDE when recursive=true on cross-table relation', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author', recursive: {} }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		expect(
			report.warnings.find((w) => w.code === 'INVALID_RECURSIVE_INCLUDE'),
		).toBeDefined();
	});

	it('no INVALID_RECURSIVE_INCLUDE on actual self-referential relation', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: {} }],
		};
		const report = plan(intent, selfRefSchema);
		expect(
			report.warnings.find((w) => w.code === 'INVALID_RECURSIVE_INCLUDE'),
		).toBeUndefined();
	});
});

// ============================================================================
// CTE deduplication
// ============================================================================

describe('planner: CTE deduplication', () => {
	it('does not create duplicate CTEs for same recursive relation', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: {} }],
		};
		const report = plan(intent, selfRefSchema);
		const ctes = report.ctes.filter((c) =>
			c.name.startsWith('cte_categories_'),
		);
		const uniqueNames = new Set(ctes.map((c) => c.name));
		expect(ctes.length).toBe(uniqueNames.size);
	});
});

// ============================================================================
// flat strategy branches
// ============================================================================

describe('planner: flat strategy with nested limit', () => {
	it('selects lateral when flat + nested child has limit + PG dialect', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [
				{
					relation: 'posts',
					strategy: 'flat',
					include: [{ relation: 'comments', limit: 3 }],
				},
			],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const includeDecision = report.decisions.find(
			(d) =>
				d.type === 'include-strategy' &&
				(d.context as Record<string, unknown>)?.relation === 'posts',
		);
		expect(includeDecision?.choice).toBe('lateral');
	});

	it('selects join when flat + no limit + no json_agg support', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', strategy: 'flat' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const includeDecision = report.decisions.find(
			(d) =>
				d.type === 'include-strategy' &&
				(d.context as Record<string, unknown>)?.relation === 'posts',
		);
		expect(includeDecision?.choice).toBe('join');
	});

	it('selects join when flat + PG caps but excludeNested=true + no limit', () => {
		// flat → selectSmartStrategy(excludeNested=true, hasLimit=false)
		// caps.supportsJsonAgg && !excludeNested → false → hasLimit=false → join
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', strategy: 'flat' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const includeDecision = report.decisions.find(
			(d) =>
				d.type === 'include-strategy' &&
				(d.context as Record<string, unknown>)?.relation === 'posts',
		);
		expect(includeDecision?.choice).toBe('join');
	});
});

// ============================================================================
// LEFT JOIN cascade
// ============================================================================

describe('planner: LEFT JOIN ancestor cascade', () => {
	it('cascades LEFT JOIN to children when ancestor used optional LEFT JOIN', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [
				{
					relation: 'editor', // optional → LEFT
					include: [{ relation: 'posts' }],
				},
			],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecisions = report.decisions.filter(
			(d) => d.type === 'join-type',
		);
		expect(joinDecisions.length).toBeGreaterThan(0);
		for (const d of joinDecisions) {
			expect(d.choice).toBe('left');
		}
	});

	it('explicit include.join=inner on child resets cascade', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [
				{
					relation: 'editor',
					include: [{ relation: 'posts', join: 'inner' }],
				},
			],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		const joinDecisions = report.decisions.filter(
			(d) => d.type === 'join-type',
		);
		expect(joinDecisions.find((d) => d.choice === 'inner')).toBeDefined();
	});
});

// ============================================================================
// extractCTEs branches
// ============================================================================

describe('planner: extractCTEs branches', () => {
	it('does not extract CTE when enableCTEs=false', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			enableCTEs: false,
			cteThreshold: 1,
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		expect(
			report.decisions.filter((d) => d.type === 'cte-extraction').length,
		).toBe(0);
	});

	it('skips CTE creation for relation already in ctes list (no duplicate)', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: {} }],
		};
		const report = plan(intent, selfRefSchema, { cteThreshold: 1 });
		const ctes = report.ctes.filter((c) => c.name.includes('categories'));
		expect(ctes.length).toBe(new Set(ctes.map((c) => c.name)).size);
	});

	it('extracts CTE when relation accessed >= cteThreshold times', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			cteThreshold: 1,
			dialectCapabilities: SQLITE_CAPABILITIES,
			enableCTEs: true,
		});
		const cteDecision = report.decisions.find(
			(d) => d.type === 'cte-extraction',
		);
		expect(cteDecision).toBeDefined();
		expect(cteDecision?.choice).toBe('cte_posts_author');
	});

	it('skips CTE extraction for json_agg strategy (SPEC-002)', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			cteThreshold: 1,
			dialectCapabilities: POSTGRESQL_CAPABILITIES, // json_agg → skip extraction
			enableCTEs: true,
		});
		const cteDecision = report.decisions.find(
			(d) => d.type === 'cte-extraction',
		);
		expect(cteDecision).toBeUndefined();
	});
});

// ============================================================================
// UnsupportedStrategyError branches
// ============================================================================

describe('planner: UnsupportedStrategyError branches', () => {
	it('throws when lateral requested via defaultIncludeStrategy on dialect without lateral support', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts' }],
		};
		expect(() =>
			plan(intent, simpleSchema, {
				dialectCapabilities: NO_STRATEGY_CAPS,
				defaultIncludeStrategy: 'lateral',
			}),
		).toThrow(/lateral.*not supported/i);
	});

	it('throws when json_agg requested via defaultIncludeStrategy on dialect without json_agg support', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts' }],
		};
		expect(() =>
			plan(intent, simpleSchema, {
				dialectCapabilities: NO_STRATEGY_CAPS,
				defaultIncludeStrategy: 'json_agg',
			}),
		).toThrow(/json_agg.*not supported/i);
	});

	it('throws when cte requested via defaultIncludeStrategy on dialect without recursive CTE support', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts' }],
		};
		expect(() =>
			plan(intent, simpleSchema, {
				dialectCapabilities: NO_STRATEGY_CAPS,
				defaultIncludeStrategy: 'cte',
			}),
		).toThrow(/cte.*not supported/i);
	});

	it('strategy=auto does not throw', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', strategy: 'auto' }],
		};
		expect(() =>
			plan(intent, simpleSchema, { dialectCapabilities: SQLITE_CAPABILITIES }),
		).not.toThrow();
	});
});

// ============================================================================
// plan() top-level edge cases
// ============================================================================

describe('planner: plan() top-level edge cases', () => {
	it('throws for unknown root table', () => {
		const intent: QueryIntent = { type: 'select', from: 'nonexistent' };
		expect(() => plan(intent, simpleSchema)).toThrow(
			'Unknown table: nonexistent',
		);
	});

	it('skips root table validation when batchValuesSource set', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'fake_table',
			batchValuesSource: {
				alias: 'fake_table',
				columns: ['id'],
				data: [[]],
				types: ['integer'],
				ordinality: false,
			},
		};
		expect(() => plan(intent, simpleSchema)).not.toThrow();
	});

	it('metadata.isAmbiguous=false when no unresolved decisions', () => {
		const intent: QueryIntent = { type: 'select', from: 'users' };
		expect(plan(intent, simpleSchema).metadata.isAmbiguous).toBe(false);
	});

	it('returns frozen report with frozen sub-arrays', () => {
		const intent: QueryIntent = { type: 'select', from: 'users' };
		const report = plan(intent, simpleSchema);
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.decisions)).toBe(true);
		expect(Object.isFrozen(report.warnings)).toBe(true);
		expect(Object.isFrozen(report.ctes)).toBe(true);
	});

	it('enableCTEs=false skips extraction even above threshold', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			enableCTEs: false,
			cteThreshold: 1,
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		expect(
			report.decisions.filter((d) => d.type === 'cte-extraction').length,
		).toBe(0);
	});

	it('metadata.planningTimeMs is a non-negative number', () => {
		const report = plan({ type: 'select', from: 'users' }, simpleSchema);
		expect(typeof report.metadata.planningTimeMs).toBe('number');
		expect(report.metadata.planningTimeMs).toBeGreaterThanOrEqual(0);
	});

	it('metadata.relationsAnalyzed counts processed includes', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }, { relation: 'editor' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: SQLITE_CAPABILITIES,
		});
		expect(report.metadata.relationsAnalyzed).toBe(2);
	});
});

// ============================================================================
// determineJoinType: relation.joinDefault !== 'auto' branch (L1392)
// ============================================================================

describe('planner: determineJoinType — relation.joinDefault hint (L1392)', () => {
	// Build a ModelIRImpl with a relation that has joinDefault: 'inner'
	// to exercise the `return relation.joinDefault` branch.
	const usersTable: TableIR = {
		name: 'users',
		columns: [{ name: 'id', type: 'integer', nullable: false }],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [],
	};
	const postsTable: TableIR = {
		name: 'posts',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{ name: 'authorId', type: 'integer', nullable: false },
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [],
	};
	const authorRelation: RelationIR = {
		name: 'author',
		type: 'belongsTo',
		source: 'posts',
		target: 'users',
		foreignKey: 'authorId',
		cardinality: 'one',
		optionality: 'optional',
		includeStrategy: 'auto',
		filterStrategy: 'auto',
		joinDefault: 'inner', // non-auto hint → L1392 branch
	};
	const modelWithJoinHint = new ModelIRImpl(
		new Map([
			['users', usersTable],
			['posts', postsTable],
		]),
		new Map([['posts.author', authorRelation]]),
	);

	it('uses relation.joinDefault when not auto (joinDefault: inner)', () => {
		// Force 'join' strategy so determineJoinType is called;
		// no forceJoinType so the joinDefault hint is used.
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author', strategy: 'flat' }],
		};
		const report = plan(intent, modelWithJoinHint, {
			dialectCapabilities: NO_STRATEGY_CAPS, // no json_agg/lateral → 'join'
		});
		const joinDecision = report.decisions.find((d) => d.type === 'join-type');
		expect(joinDecision).toBeDefined();
		expect(joinDecision?.choice).toBe('inner');
	});
});

// ============================================================================
// generateIncludeReasoning: case 'cte' branch (L1537)
// ============================================================================

describe('planner: generateIncludeReasoning — cte strategy (L1537)', () => {
	it('produces CTE reasoning string for non-recursive cte include strategy', () => {
		// defaultIncludeStrategy: 'cte' with a dialect that supports recursive CTE
		// → determineIncludeStrategy returns 'cte' via validateStrategy
		// → isRecursiveInclude=false (non-self-referential relation)
		// → generateIncludeReasoning called with 'cte' → hits case 'cte':
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author' }],
		};
		const report = plan(intent, simpleSchema, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
			defaultIncludeStrategy: 'cte',
		});
		const stratDecision = report.decisions.find(
			(d) => d.type === 'include-strategy',
		);
		expect(stratDecision?.choice).toBe('cte');
		expect(stratDecision?.reasoning).toMatch(
			/CTE for recursive\/hierarchical traversal/i,
		);
	});
});
