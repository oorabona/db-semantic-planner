import {
	createOrm,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import { validateIncludeOrdering } from '@dbsp/core/internal';
import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { asExternalReport } from './external-include-report.js';

const model = schema(
	{
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			title: 'text',
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
		categories: {
			id: { type: 'integer', primaryKey: true },
			parentId: ref('categories', {
				nullable: true,
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	},
	undefined,
	{ defaultPkColumnName: null },
).model;
const adapter = createPgCompileOnlyAdapter({ model });

describe('#915 include validation', () => {
	it('trusts recorded ordering without a compile model', () => {
		expect(
			validateIncludeOrdering(
				{
					relation: 'posts',
					orderBy: [{ field: 'title', direction: 'asc' }],
					limit: 1,
				},
				undefined,
				'posts',
				'posts',
				['title'],
			),
		).toEqual({ columns: ['title'], fallback: false });
	});
	it('refuses circular includes in strict and lenient planning', () => {
		for (const strictMode of [true, false]) {
			const orm = createOrm({ model, adapter, strictMode });
			expect(() =>
				asExternalReport(
					orm.select('users').include('posts.author.posts').plan(),
				),
			).toThrowError('Invalid include: Circular include detected: users.posts');
		}
	});
	it('refuses recorded non-unique ordering on a modeled keyless target', () => {
		const keyless = new Proxy(model, {
			get(target, property) {
				if (property === 'getTable')
					return (name: string) => {
						const table = target.getTable(name);
						return name === 'posts' && table
							? { ...table, primaryKey: undefined }
							: table;
					};
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const keylessAdapter = createPgCompileOnlyAdapter({ model: keyless });
		const original = asExternalReport(
			plan(
				{ type: 'select', from: 'users', include: [{ relation: 'posts' }] },
				keyless,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		);
		const external = {
			...original,
			intent: {
				...original.intent!,
				include: [
					{
						relation: 'posts',
						orderBy: [{ field: 'title', direction: 'asc' }],
						limit: 1,
					},
				],
			},
			decisions: original.decisions.map((d) =>
				d.type === 'include-strategy'
					? {
							...d,
							context: {
								...d.context,
								targetOrderKey: ['title'],
								orderByFallback: false,
							},
						}
					: d,
			),
		} as PlanReport;
		expect(() => keylessAdapter.compile(external)).toThrowError(
			new Error(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
	});
	it('refuses nonexistent recorded key columns even with a primary key', () => {
		const original = asExternalReport(
			plan(
				{ type: 'select', from: 'posts', include: [{ relation: 'author' }] },
				model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		);
		const external = {
			...original,
			decisions: original.decisions.map((d) =>
				d.type === 'include-strategy'
					? {
							...d,
							context: {
								...d.context,
								targetOrderKey: ['missing'],
								orderByFallback: false,
							},
						}
					: d,
			),
		} as PlanReport;
		expect(() => adapter.compile(external)).toThrowError(
			new Error(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
	});
	it('refuses external recursive json_agg decisions', () => {
		const original = asExternalReport(
			plan(
				{
					type: 'select',
					from: 'categories',
					include: [{ relation: 'ancestors' }],
				},
				model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		);
		expect(() => adapter.compile(original)).toThrow(
			new Error(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
		const external = {
			...original,
			decisions: original.decisions.map((d) =>
				d.type === 'include-strategy' ? { ...d, choice: 'json_agg' } : d,
			),
		} as PlanReport;
		expect(() => adapter.compile(external)).toThrowError(
			new Error(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
	});
});
