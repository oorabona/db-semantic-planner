import { ModelIRImpl, POSTGRESQL_CAPABILITIES, schema } from '@dbsp/core';
import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { generateCreateIndexSQL } from './index-operations.js';
import { compareSchemata, generateDDL } from './public-api.js';
import { generateAlterColumnSQL } from './table-operations.js';

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
			'\n);',
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
			`CREATE POLICY "events_policy" ON "public"."events" FOR ALL AS PERMISSIVE${kind === 'using' ? ` USING (${expression})` : ` WITH CHECK (${expression})`};`,
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
			const expression = 'created_at > now()';
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

		it(`preserves model-spelled ${kind} text unchanged in complete public DDL`, () => {
			const expression = 'createdAt > now()';
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

	it('preserves schema DSL CHECK and partial-index predicate text', () => {
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

	it('preserves public index expression and predicate option text', () => {
		expect(
			generateCreateIndexSQL('events', 'public', {
				name: 'events_expression',
				columns: [{ expression: 'createdAt > now()' }],
				where: 'createdAt > now()',
			}),
		).toBe(
			'CREATE INDEX "events_expression" ON "public"."events" (createdAt > now()) WHERE createdAt > now()',
		);
	});

	it('preserves public ALTER COLUMN USING text', () => {
		expect(
			generateAlterColumnSQL('events', 'public', 'created_at', {
				type: 'TIMESTAMPTZ',
				using: 'createdAt > now()',
			}),
		).toBe(
			'ALTER TABLE "public"."events" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING createdAt > now()',
		);
	});

	it('compares policy expressions unchanged through the public RLS schema comparison path', () => {
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
