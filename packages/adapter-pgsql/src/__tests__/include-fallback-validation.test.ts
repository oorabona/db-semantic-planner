import {
	createOrm,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import type { IncludeIntent, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';

const model = schema({
	variable_defs: {
		id: { type: 'integer', primaryKey: true },
		enclosing_symbol_id: ref('symbols', { as: 'enclosing_symbol' }),
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: ref('files', { as: 'source_file' }),
	},
	files: { id: { type: 'integer', primaryKey: true } },
}).model;

function planned(extra: Partial<IncludeIntent> = {}) {
	return plan(
		{
			type: 'select',
			from: 'variable_defs',
			include: [{ relation: 'enclosingSymbol', join: 'left', ...extra }],
		},
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
}

describe('#911 fallback includes are planned and validated', () => {
	for (const [extra, message] of [
		[
			{ select: { type: 'fields', fields: ['*', 'name'] } },
			"Include enclosingSymbol select cannot mix '*' with other fields",
		],
		[
			{ limit: 2 },
			"Invalid include: Include include[0](enclosingSymbol) limit is not supported by 'join' strategy. Remove the explicit join or use a strategy that limits per parent (json_agg, lateral).",
		],
		[
			{ orderBy: [{ field: 'name', direction: 'asc' }] },
			"Invalid include: Include include[0](enclosingSymbol) orderBy is not supported by 'join' strategy.",
		],
		[
			{ select: { type: 'expressions', columns: [] } },
			"Invalid include: Include include[0](enclosingSymbol) select is not supported by 'join' strategy. Received select form: expressions.",
		],
		[
			{ select: { type: 'fields' } },
			'Include enclosingSymbol select fields must be an array',
		],
		[
			{ include: [{ relation: 'sourceFile', join: 'left', limit: 1 }] },
			"Invalid include: Include include[0].include[0](enclosingSymbol.sourceFile) limit is not supported by 'join' strategy. Remove the explicit join or use a strategy that limits per parent (json_agg, lateral).",
		],
		[
			{
				relation: 'display',
				via: 'enclosingSymbol',
				select: { type: 'fields', fields: ['*', 'name'] },
			},
			"Include enclosingSymbol select cannot mix '*' with other fields",
		],
		[
			{
				via: 'enclosingSymbol',
				include: [
					{
						relation: 'displayFile',
						via: 'sourceFile',
						select: { type: 'fields' },
					},
				],
			},
			'Include enclosingSymbol.sourceFile select fields must be an array',
		],
	] as const) {
		it(`refuses ${JSON.stringify(extra)} during planning`, () => {
			expect.assertions(1);
			try {
				planned(extra as unknown as Partial<IncludeIntent>);
			} catch (error) {
				expect(error).toHaveProperty('message', message);
			}
		});
	}
	it('plans both camelCase hops, compiles their joins, and needs no synthesis', () => {
		const report = planned({
			select: { type: 'fields', fields: ['name'] },
			include: [{ relation: 'sourceFile', join: 'left' }],
		});
		expect(
			[
				report.execution!.includes[0]!,
				...report.execution!.includes[0]!.children,
			].map((node) => [node.relationName, node.intentPath, node.strategy]),
		).toEqual([
			['enclosing_symbol', 'include[0]', 'join'],
			['source_file', 'include[0].include[0]', 'join'],
		]);

		const { sql } = compileSelect(report, undefined, {
			model,
			declaredNames: createDeclaredNameResolver(
				createPgPhysicalModel({
					mode: 'logical',
					model,
					schema: 'public',
					dbCasing: 'preserve',
				}),
			),
			schemaName: undefined,
			defaultPk: DEFAULT_PK_COLUMN,
			deriveFk: defaultFkDerivation,
		});
		expect(sql).toContain('LEFT JOIN symbols');
		expect(sql).toContain('LEFT JOIN files');
		expect(sql.match(/LEFT JOIN symbols/g)).toHaveLength(1);
	});
});

const precedenceModel = schema({
	accounts: {
		id: { type: 'integer', primaryKey: true },
		secret_id: ref('secrets', { as: 'billing_profile' }),
		public_id: ref('billingProfile', { as: 'public_link' }),
	},
	secrets: { id: { type: 'integer', primaryKey: true } },
	billingProfile: { id: { type: 'integer', primaryKey: true } },
}).model;

describe('#911 relation resolution precedence', () => {
	it('keeps target-table precedence through the authored ORM reproduction', () => {
		const orm = createOrm({
			model: precedenceModel,
			adapter: createPgCompileOnlyAdapter(),
		});
		const query = orm.select('accounts').include('billingProfile');
		expect(
			query
				.plan()
				.execution!.includes.map((node) => [
					node.relationName,
					node.targetRange.table,
					node.strategy,
				]),
		).toEqual([['public_link', 'billingProfile', 'json_agg']]);
		expect(query.dump().sql).toBe(
			"SELECT accounts.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id) ORDER BY __t__.id ASC NULLS LAST) FROM \"billingProfile\" AS __t__ WHERE __t__.id = accounts.public_id), '[]'::json) AS public_link_json FROM accounts",
		);
	});

	for (const [name, relation, target, plannedSql, legacySql] of [
		[
			'billingProfile',
			'public_link',
			'billingProfile',
			'SELECT accounts.*, public_link.id AS "billingProfile.id", public_link.id AS "__dbsp_presence_billingProfile" FROM accounts LEFT JOIN "billingProfile" AS public_link ON accounts.public_id = public_link.id',
			'SELECT accounts.*, "billingProfile".id AS "billingProfile.id", "billingProfile".id AS "__dbsp_presence_billingProfile" FROM accounts LEFT JOIN "billingProfile" AS "billingProfile" ON accounts.public_id = "billingProfile".id',
		],
		[
			'billing_profile',
			'billing_profile',
			'secrets',
			'SELECT accounts.*, billing_profile.id AS "billing_profile.id", billing_profile.id AS __dbsp_presence_billing_profile FROM accounts LEFT JOIN secrets AS billing_profile ON accounts.secret_id = billing_profile.id',
			'SELECT accounts.*, billing_profile.id AS "billing_profile.id", billing_profile.id AS __dbsp_presence_billing_profile FROM accounts LEFT JOIN secrets AS billing_profile ON accounts.secret_id = billing_profile.id',
		],
		[
			'publicLink',
			'public_link',
			'billingProfile',
			'SELECT accounts.*, public_link.id AS "publicLink.id", public_link.id AS "__dbsp_presence_publicLink" FROM accounts LEFT JOIN "billingProfile" AS public_link ON accounts.public_id = public_link.id',
			'SELECT accounts.*, "publicLink".id AS "publicLink.id", "publicLink".id AS "__dbsp_presence_publicLink" FROM accounts LEFT JOIN "billingProfile" AS "publicLink" ON accounts.public_id = "publicLink".id',
		],
	] as const) {
		it(`resolves ${name} in planner and legacy synthesis`, () => {
			const report = plan(
				{
					type: 'select',
					from: 'accounts',
					include: [{ relation: name, join: 'left' }],
				},
				precedenceModel,
			);
			expect(
				report.execution!.includes.map((node) => [
					node.relationName,
					node.targetRange.table,
					node.strategy,
				]),
			).toEqual([[relation, target, 'join']]);
			const wire = { ...report };
			delete wire.execution;
			delete wire.planningInputs;
			const legacy = { ...wire, decisions: [] };

			const adapter = createPgCompileOnlyAdapter({ model: precedenceModel });
			expect(adapter.compile(report, { model: precedenceModel }).sql).toBe(
				plannedSql,
			);
			expect(adapter.compile(legacy, { model: precedenceModel }).sql).toBe(
				legacySql,
			);
		});
	}
	for (const legacy of [false, true]) {
		it(`refuses malformed external select (legacy=${legacy}) by name`, () => {
			const report = planned();
			const external = {
				...report,
				...(legacy && { decisions: [] }),
				intent: {
					...report.intent,
					include: [
						{
							relation: 'enclosingSymbol',
							join: 'left',
							select: { type: 'fields' },
						},
					],
				},
			} as unknown as PlanReport;
			expect(() =>
				createPgCompileOnlyAdapter({ model }).compile(external, { model }),
			).toThrow('Include enclosingSymbol select fields must be an array');
		});
	}
});

for (const [strategy, expectedSql] of [
	[
		'json_agg',
		"SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC) FROM (SELECT jsonb_build_object('authorId', __t__.\"authorId\", 'rank', __t__.rank, 'title', __t__.title) AS __row, __t__.rank AS __key0 FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id ORDER BY __t__.rank DESC LIMIT 1) AS __lim), '[]'::json) AS posts_json FROM users",
	],
	[
		'lateral',
		'SELECT users.*, posts_lat_0."authorId" AS "posts.authorId", posts_lat_0.rank AS "posts.rank", posts_lat_0.title AS "posts.title", posts_lat_0.__dbsp_presence_posts AS __dbsp_presence_posts FROM users LEFT JOIN LATERAL (SELECT posts_inner_0."authorId", posts_inner_0.rank, posts_inner_0.title, 1 AS __dbsp_presence_posts FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.rank DESC LIMIT 1) AS posts_lat_0 ON true',
	],
] as const) {
	it(`#911 uses authored unique ordering without a PK for ${strategy}`, () => {
		const keyed = schema({
			users: { id: { type: 'integer', primaryKey: true } },
			posts: {
				authorId: ref('users', { inverse: 'posts' }),
				rank: { type: 'integer', unique: true },
				title: 'text',
			},
		}).model;
		const noKey: typeof keyed = Object.assign(Object.create(keyed), {
			getTable(name: string) {
				const table = keyed.getTable(name);
				return name === 'posts' && table ? { ...table, primaryKey: [] } : table;
			},
		});
		const report = plan(
			{
				type: 'select',
				from: 'users',
				include: [
					{
						relation: 'posts',
						limit: 1,
						orderBy: [{ field: 'rank', direction: 'desc' }],
					},
				],
			},
			noKey,
			{
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
				defaultIncludeStrategy: strategy,
			},
		);
		const decision = report.decisions.find(
			(d) => d.type === 'include-strategy',
		);
		expect(decision?.choice).toBe(strategy);
		expect(report.execution?.includes[0]?.ordering.fallback).toEqual(['rank']);
		expect(report.execution?.includes[0]?.ordering.usesFallback).toBe(false);
		expect(
			createPgCompileOnlyAdapter({ model: noKey }).compile(report, {
				model: noKey,
			}).sql,
		).toBe(expectedSql);
	});
}
