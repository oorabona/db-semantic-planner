// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage test for planner.ts - targets uncovered branches.
 */

import { describe, expect, it } from 'vitest';
import { ref, schema } from './dx/schema.js';
import type { QueryIntent } from './intent-ast.js';
import { plan, UnsupportedStrategyError } from './planner.js';

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'text',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
}).model;

describe('planner coverage', () => {
	it('should select json_agg for hasMany when supported', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts' }],
		};

		const report = plan(intent, testSchema, {
			dialectCapabilities: {
				name: 'PostgreSQL',
				supportsJsonAgg: true,
				supportsLateralJoin: true,
				supportsRecursiveCTE: true,
			},
		});

		const includeDecision = report.decisions.find((d) => d.type === 'include-strategy');
		expect(includeDecision?.choice).toBe('json_agg');
	});

	it('should fall back to join when json_agg not supported', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts' }],
		};

		const report = plan(intent, testSchema, {
			dialectCapabilities: {
				name: 'MySQL',
				supportsJsonAgg: false,
				supportsLateralJoin: false,
				supportsRecursiveCTE: false,
			},
		});

		const includeDecision = report.decisions.find((d) => d.type === 'include-strategy');
		expect(includeDecision?.choice).toBe('join');
	});

	it('should use lateral for flat includes with limit', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', limit: 5, strategy: 'flat' }],
		};

		const report = plan(intent, testSchema, {
			dialectCapabilities: {
				name: 'PostgreSQL',
				supportsJsonAgg: true,
				supportsLateralJoin: true,
				supportsRecursiveCTE: true,
			},
		});

		const includeDecision = report.decisions.find((d) => d.type === 'include-strategy');
		expect(includeDecision?.choice).toBe('lateral');
	});

	it('should warn on raw SQL usage', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			select: {
				type: 'expressions',
				columns: [
					{ kind: 'column', column: 'id' },
					{ kind: 'raw', sql: 'UPPER(name)', as: 'upper_name' },
				],
			},
		};

		const report = plan(intent, testSchema);

		const rawSqlWarning = report.warnings.find((w) => w.code === 'RAW_SQL_USAGE');
		expect(rawSqlWarning).toBeDefined();
	});

	it('should warn on row explosion with join strategy on hasMany', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'relationFilter',
				relation: 'posts',
				where: { kind: 'comparison', field: 'title', operator: 'like', value: '%test%' },
			},
		};

		const report = plan(intent, testSchema, { forceFilterStrategy: 'join' });

		const explosionWarning = report.warnings.find(
			(w) => w.code === 'POTENTIAL_ROW_EXPLOSION',
		);
		expect(explosionWarning).toBeDefined();
	});

	it('should skip CTE extraction when enableCTEs is false', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			where: {
				kind: 'and',
				conditions: [
					{ kind: 'exists', relation: 'author' },
					{ kind: 'exists', relation: 'author' },
				],
			},
		};

		const report = plan(intent, testSchema, { enableCTEs: false });

		expect(report.ctes.length).toBe(0);
	});

	it('should optimize IN subquery to EXISTS', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['authorId'] },
				},
			},
		};

		const report = plan(intent, testSchema);

		const filterDecision = report.decisions.find((d) => d.type === 'filter-strategy');
		expect(filterDecision).toBeDefined();
	});

	it('should handle nested includes and detect deep nesting', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [
				{
					relation: 'posts',
					include: [
						{
							relation: 'comments',
							include: [{ relation: 'post', include: [{ relation: 'comments' }] }],
						},
					],
				},
			],
		};

		const report = plan(intent, testSchema, { maxIncludeDepth: 2 });

		const deepNestingWarning = report.warnings.find((w) => w.code === 'DEEP_NESTING');
		expect(deepNestingWarning).toBeDefined();
	});
});
