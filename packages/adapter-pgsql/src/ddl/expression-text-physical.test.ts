import { ModelIRImpl, POSTGRESQL_CAPABILITIES, schema } from '@dbsp/core';
import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { compareSchemata, generateDDL } from './public-api.js';

type ExpressionKind =
	| 'check'
	| 'predicate'
	| 'index-expression'
	| 'using'
	| 'with-check'
	| 'default';

function modelWith(kind: ExpressionKind, expression: string): ModelIR {
	const table: TableIR = {
		name: 'events',
		columns: [
			{
				name: 'createdAt',
				type: 'timestamp',
				nullable: false,
				...(kind === 'default' ? { default: { sql: expression } } : {}),
			},
			{ name: 'userEmail', type: 'string', nullable: true },
			{ name: 'deletedAt', type: 'timestamp', nullable: true },
		],
		foreignKeys: [],
		indexes:
			kind === 'predicate'
				? [
						{
							name: 'events_partial',
							columns: ['createdAt'],
							where: expression,
						},
					]
				: kind === 'index-expression'
					? [
							{
								name: 'events_expression',
								columns: [],
								expressions: [expression],
							},
						]
					: [],
		...(kind === 'check'
			? { checkConstraints: [{ name: 'events_created_at_check', expression }] }
			: {}),
		...(kind === 'using' || kind === 'with-check'
			? {
					rlsEnabled: true,
					policies: [
						{
							name: 'events_policy',
							command: 'ALL',
							...(kind === 'using'
								? { using: expression }
								: { withCheck: expression }),
						},
					],
				}
			: {}),
	};
	return new ModelIRImpl(new Map([['events', table]]), new Map());
}

function expectedDDL(kind: ExpressionKind, expression: string): string[] {
	const statements = [
		'CREATE TABLE "public"."events" (\n  "created_at" TIMESTAMPTZ NOT NULL' +
			(kind === 'default' ? ` DEFAULT ${expression}` : '') +
			',\n  "user_email" VARCHAR(255),\n  "deleted_at" TIMESTAMPTZ\n);',
	];
	if (kind === 'check')
		statements.push(
			`ALTER TABLE "public"."events" ADD CONSTRAINT "events_created_at_check" CHECK (${expression});`,
		);
	if (kind === 'predicate')
		statements.push(
			`CREATE INDEX "events_partial" ON "public"."events" ("created_at") WHERE ${expression};`,
		);
	if (kind === 'index-expression')
		statements.push(
			`CREATE INDEX "events_expression" ON "public"."events" (${expression});`,
		);
	if (kind === 'using' || kind === 'with-check') {
		statements.push('ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;');
		statements.push(
			`CREATE POLICY "events_policy" ON "public"."events" AS PERMISSIVE FOR ALL${kind === 'using' ? ` USING (${expression})` : ` WITH CHECK (${expression})`};`,
		);
	}
	return statements;
}

const kinds: readonly ExpressionKind[] = [
	'check',
	'predicate',
	'index-expression',
	'using',
	'with-check',
	'default',
];

describe('physical SQL expression text', () => {
	for (const kind of kinds) {
		it(`preserves database-spelled ${kind} text in complete public DDL`, () => {
			const expression =
				kind === 'predicate'
					? 'deleted_at IS NULL'
					: kind === 'index-expression'
						? 'lower(user_email)'
						: 'created_at > now()';
			const physical = createPgPhysicalModel({
				mode: 'logical',
				model: modelWith(kind, expression),
				schema: 'public',
				dbCasing: 'snake_case',
			});
			expect(
				generateDDL(physical, { dialectCapabilities: POSTGRESQL_CAPABILITIES }),
			).toEqual(expectedDDL(kind, expression));
			expect(
				compareSchemata(
					physical,
					createPgPhysicalModel({
						mode: 'physical',
						model: physical.model,
						schema: 'public',
					}),
				).changes,
			).toEqual([]);
		});

		it(`does not rewrite model-spelled identifiers inside ${kind} text`, () => {
			const expression =
				kind === 'predicate'
					? 'deletedAt IS NULL'
					: kind === 'index-expression'
						? 'lower(userEmail)'
						: 'createdAt > now()';
			const physical = createPgPhysicalModel({
				mode: 'logical',
				model: modelWith(kind, expression),
				schema: 'public',
				dbCasing: 'snake_case',
			});
			expect(
				generateDDL(physical, { dialectCapabilities: POSTGRESQL_CAPABILITIES }),
			).toEqual(expectedDDL(kind, expression));
			expect(
				compareSchemata(
					physical,
					createPgPhysicalModel({
						mode: 'physical',
						model: physical.model,
						schema: 'public',
					}),
				).changes,
			).toEqual([]);
		});
	}

	it('does not rewrite identifiers in schema DSL CHECK and partial-index predicate text', () => {
		const declared = schema(
			{ events: { createdAt: 'timestamp' } },
			{
				events: {
					checkConstraints: [
						{
							name: 'events_created_at_check',
							expression: 'createdAt > now()',
						},
					],
					indexes: [
						{
							name: 'events_partial',
							columns: ['createdAt'],
							where: 'createdAt > now()',
						},
					],
				},
			},
		);
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model: declared.model,
			schema: 'public',
			dbCasing: 'snake_case',
		});
		expect(
			generateDDL(physical, { dialectCapabilities: POSTGRESQL_CAPABILITIES }),
		).toEqual([
			'CREATE TABLE "public"."events" (\n  "created_at" TIMESTAMPTZ NOT NULL\n);',
			'ALTER TABLE "public"."events" ADD CONSTRAINT "events_created_at_check" CHECK (createdAt > now());',
			'CREATE INDEX "events_partial" ON "public"."events" ("created_at") WHERE createdAt > now();',
		]);
	});

	it('does not rewrite public index expression and predicate text', () => {
		const adapter = createPgsqlCompileOnlyAdapter({
			model: modelWith('index-expression', 'lower(userEmail)'),
			dbCasing: 'snake_case',
		});
		expect(
			adapter.generateCreateIndex('events', 'public', {
				name: 'events_expression',
				columns: ['userEmail', { expression: 'lower(userEmail)' }],
				where: 'deletedAt IS NULL',
			}),
		).toBe(
			'CREATE INDEX "events_expression" ON "public"."events" ("user_email", lower(userEmail)) WHERE deletedAt IS NULL',
		);
	});

	it('does not rewrite public ALTER COLUMN USING text', () => {
		const adapter = createPgsqlCompileOnlyAdapter({
			model: modelWith('check', 'createdAt > now()'),
			dbCasing: 'snake_case',
		});
		expect(
			adapter.generateAlterColumn('events', 'public', 'createdAt', {
				type: 'TIMESTAMPTZ',
				using: 'createdAt::timestamptz',
			}),
		).toBe(
			'ALTER TABLE "public"."events" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING createdAt::timestamptz',
		);
	});

	it('does not report policy expressions as changed after physical schema comparison', () => {
		const expression = 'createdAt > now()';
		const desired = createPgPhysicalModel({
			mode: 'logical',
			model: modelWith('using', expression),
			schema: 'public',
			dbCasing: 'snake_case',
		});
		const database = createPgPhysicalModel({
			mode: 'physical',
			model: desired.model,
			schema: 'public',
		});
		expect(compareSchemata(desired, database).changes).toEqual([]);
	});
});
