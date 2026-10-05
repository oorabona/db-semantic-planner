/** Main-code include oracle. Rewriting is explicit; normal runs never write shards. */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {
	and,
	createOrm,
	eq,
	exprRef,
	fn,
	outerRef,
	POSTGRESQL_CAPABILITIES,
	plan,
	ResultHydrator,
	ref,
	schema,
} from '@dbsp/core';
import type {
	IncludeIntent,
	IncludePayloadShape,
	PlanReport,
	QueryIntent,
} from '@dbsp/types';
import { isPlannedReport } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const strategies = ['join', 'lateral', 'json_agg', 'cte'] as const;
const directory = new URL('./include-matrix/', import.meta.url);
const inputsDirectory = new URL('./include-matrix-inputs/', import.meta.url);
const rewrite = process.env.REWRITE_INCLUDE_MATRIX === '1';
function makeModel(composite: boolean) {
	const fields = {
		id: { type: 'integer', primaryKey: true, unique: true },
		tenant: { type: 'integer', primaryKey: composite },
		name: 'text',
		amount: { type: 'bigint', js: 'number' },
	} as const;
	return schema(
		{
			roots: fields,
			children: {
				...fields,
				rootId: ref('roots', { inverse: 'children', unique: true }),
			},
			leaves: {
				...fields,
				childId: ref('children', { inverse: 'leaves', unique: true }),
			},
			tips: {
				...fields,
				leafId: ref('leaves', { inverse: 'tips', unique: true }),
			},
			categories: {
				...fields,
				parentId: ref('categories', {
					as: 'parent',
					inverse: 'descendants',
					roles: {
						parent: 'parent',
						children: 'children',
						ancestors: 'ancestors',
						descendants: 'descendants',
					},
				}),
			},
		},
		composite
			? {
					children: {
						foreignKeys: [
							ref('roots', {
								columns: ['rootId', 'tenant'],
								references: ['id', 'tenant'],
								as: 'compositeRoot',
								inverse: 'compositeChildren',
								unique: true,
							}),
						],
					},
					leaves: {
						foreignKeys: [
							ref('children', {
								columns: ['childId', 'tenant'],
								references: ['id', 'tenant'],
								as: 'compositeChild',
								inverse: 'compositeLeaves',
								unique: true,
							}),
						],
					},
					tips: {
						foreignKeys: [
							ref('leaves', {
								columns: ['leafId', 'tenant'],
								references: ['id', 'tenant'],
								as: 'compositeLeaf',
								inverse: 'compositeTips',
								unique: true,
							}),
						],
					},
				}
			: {},
	).model;
}
const models = [makeModel(false), makeModel(true)];
/** A fake driver returns the actual transport labels, including presence and conversions. */
function fakeRows(shapes: readonly IncludePayloadShape[]) {
	const row: Record<string, unknown> = { id: 1 };
	const value = (column: IncludePayloadShape['columns'][number]) =>
		column.logicalName === 'amount'
			? '42'
			: column.logicalName === 'name'
				? 'child'
				: 2;
	const json = (shape: IncludePayloadShape): Record<string, unknown> => {
		const object: Record<string, unknown> = Object.fromEntries(
			shape.columns.map((column) => [column.publicKey, value(column)]),
		);
		for (const field of shape.privateFields ?? [])
			object[field.jsonKey] =
				field.role === 'depth' ? 1 : field.role === 'parent' ? '1' : '2';
		for (const child of shape.children) object[child.publicKey] = [json(child)];
		return object;
	};
	const populate = (shape: IncludePayloadShape) => {
		if (shape.strategy === 'json_agg' || shape.recursive)
			row[shape.outputLabel] = JSON.stringify([json(shape)]);
		else {
			for (const column of shape.columns)
				row[column.outputLabel] = value(column);
			if (shape.presence) row[shape.presence.outputLabel] = 2;
			for (const child of shape.children) populate(child);
		}
	};
	for (const shape of shapes) populate(shape);
	return [row];
}
type Entry = {
	case: string;
	sql: string | null;
	params: readonly unknown[];
	error: { class: string; message: string } | null;
	payloads: readonly IncludePayloadShape[];
	rows: unknown[];
};
const entries: Entry[] = [];
const legacyInputs: Record<string, PlanReport> = rewrite
	? {}
	: Object.assign(
			{},
			...readdirSync(inputsDirectory)
				.sort()
				.map((name) =>
					JSON.parse(readFileSync(new URL(name, inputsDirectory), 'utf8')),
				),
		);
/** Preserve insertion order within each strategy and bound serialized bytes. */
function inputShards(inputs: Record<string, PlanReport>) {
	const prefixes = [...strategies, 'recursive'];
	for (const key of Object.keys(inputs))
		if (!prefixes.some((strategy) => key.startsWith(`external/${strategy}/`)))
			throw new Error(`Unknown include input prefix: ${key}`);
	return prefixes.flatMap((strategy) => {
		const result: { name: string; bytes: string }[] = [];
		let parts: string[] = [];
		let size = 3; // Opening brace, closing brace and final newline.
		const flush = () => {
			if (parts.length === 0) return;
			result.push({
				name: `${strategy}.${String(result.length + 1).padStart(3, '0')}.json`,
				bytes: `{\n${parts.join(',\n')}\n}\n`,
			});
			parts = [];
			size = 3;
		};
		for (const [key, value] of Object.entries(inputs)) {
			if (!key.startsWith(`external/${strategy}/`)) continue;
			const part = JSON.stringify({ [key]: value }, null, 2).slice(2, -2);
			const bytes = Buffer.byteLength(part);
			if (bytes + 5 > 200_000)
				throw new Error(`Include input exceeds 200 KB: ${key}`);
			if (size + bytes + 2 > 200_000) flush();
			parts.push(part);
			size += bytes + 2;
		}
		flush();
		return result;
	});
}
const record = (
	key: string,
	model: (typeof models)[number],
	report: () => PlanReport,
) => {
	let sql: string | null = null;
	let params: readonly unknown[] = [];
	let payloads: readonly IncludePayloadShape[] = [];
	let rows: unknown[] = [];
	let error: Entry['error'] = null;
	try {
		const p =
			key.startsWith('external/') && !rewrite && legacyInputs[key]
				? legacyInputs[key]!
				: report();
		if (rewrite && key.startsWith('external/'))
			legacyInputs[key] = {
				...p,
				metadata: { ...p.metadata, planningTimeMs: 0 },
			};
		const poisoned = new Proxy(model, {
			get(target, property) {
				if (property === 'getRelation' || property === 'getRelationsFrom')
					return () => {
						throw new Error('include relation lookup after planning');
					};
				const member = Reflect.get(target, property);
				return typeof member === 'function' ? member.bind(target) : member;
			},
		});
		let compiled = createPgCompileOnlyAdapter({
			model:
				process.env.POISON_INCLUDE_RELATIONS === '1' && isPlannedReport(p)
					? poisoned
					: model,
		}).compile(p);
		if (process.env.POISON_INCLUDE_RELATIONS === '1' && isPlannedReport(p)) {
			const canonical = p.execution ? p : compiled.hydrationPlan;
			if (!canonical?.execution)
				throw new Error('canonical execution is unavailable');
			compiled = createPgCompileOnlyAdapter({ model: poisoned }).compile(
				canonical,
			);
		}
		sql = compiled.sql;
		params = compiled.parameters;
		payloads = compiled.hydrationPlan?.includePayloads ?? [];
		rows = fakeRows(payloads);
		const hydrator = new ResultHydrator(model, p.rootTable);
		hydrator.hydrateJsonAggIncludes(rows, p, compiled);
		hydrator.hydrateJoinIncludes(rows, p, compiled);
	} catch (e) {
		error = {
			class: (e as Error).constructor.name,
			message: (e as Error).message,
		};
	}
	entries.push({ case: key, sql, params, error, payloads, rows });
};
type OrmInclude = {
	relation: string;
	via?: string;
	select?: NonNullable<IncludeIntent['select']>;
	where?: NonNullable<IncludeIntent['where']>;
	orderBy?: NonNullable<IncludeIntent['orderBy']>;
	limit?: number;
	include?: readonly OrmInclude[];
};
function ormInclude(include: IncludeIntent): OrmInclude {
	return {
		relation: include.relation,
		// ORM has no flat authoring method; NQL/external IntentIR characterize flat output.
		...(include.via && { via: include.via }),
		...(include.select && { select: include.select }),
		...(include.where && { where: include.where }),
		...(include.orderBy && { orderBy: include.orderBy }),
		...(include.limit !== undefined && { limit: include.limit }),
		...(include.include && { include: include.include.map(ormInclude) }),
	};
}
const variants = [
	'all',
	'projection',
	'ordered-limit',
	'predicate',
	'expression',
	'outer',
] as const;
for (const strategy of strategies)
	for (const depth of [1, 2, 3])
		for (const alias of [false, true])
			for (const flat of [false, true])
				for (const composite of [false, true])
					for (const variant of variants) {
						const model = models[Number(composite)]!;
						const adapter = createPgCompileOnlyAdapter({ model });
						const orm = createOrm({ model, adapter });
						const names = composite
							? ['compositeChildren', 'compositeLeaves', 'compositeTips']
							: ['children', 'leaves', 'tips'];
						const build = (level: number): IncludeIntent => ({
							relation: alias ? `payload${level}` : names[level]!,
							...(alias && { via: names[level]! }),
							...(flat && { strategy: 'flat' }),
							...(variant === 'projection' && {
								select: { type: 'fields', fields: ['name', 'amount'] },
							}),
							...(variant === 'ordered-limit' && {
								orderBy: [{ field: 'name', direction: 'desc', nulls: 'last' }],
								limit: 2,
							}),
							...(variant === 'predicate' && { where: eq('name', 'child') }),
							...(variant === 'expression' && {
								where: fn('lower', exprRef('name')).eq('child'),
							}),
							...(variant === 'outer' && {
								where: and(eq('name', 'child'), eq('id', outerRef('id'))),
							}),
							...(level + 1 < depth && { include: [build(level + 1)] }),
						});
						const include = build(0);
						const intent: QueryIntent = {
							type: 'select',
							from: 'roots',
							include: [include],
						};
						const key = `${strategy}/${depth}/${alias ? 'via-alias' : 'direct'}/${flat ? 'flat' : 'nested'}/${composite ? 'composite' : 'single'}/${variant}`;
						record(`orm/${key}`, model, () =>
							orm
								.select('roots')
								.withPlanOptions({ defaultIncludeStrategy: strategy })
								.include(include.relation, ormInclude(include))
								.plan(),
						);
						record(`external/${key}`, model, () => {
							const p = plan(intent, model, {
								defaultIncludeStrategy: strategy,
								dialectCapabilities: POSTGRESQL_CAPABILITIES,
							});
							// Legacy wire report is characterized separately from native planner reports.
							return JSON.parse(JSON.stringify(p)) as PlanReport;
						});
						// NQL owns its representable projection/flat/limit syntax. Options NQL cannot author
						// are applied to its public IntentIR before invoking the same planner.
						record(`nql/${key}`, model, () => {
							const path = names.slice(0, depth).join('.');
							const source = `roots | select id, ${path}.${variant === 'projection' ? 'name' : '*'}${flat ? ' | flat' : ''}`;
							const nqlIntent = orm
								.nql(
									Object.assign([source], {
										raw: [source],
									}) as unknown as TemplateStringsArray,
								)
								.toIntentIR() as QueryIntent;
							return plan({ ...nqlIntent, include: [include] }, model, {
								defaultIncludeStrategy: strategy,
								dialectCapabilities: POSTGRESQL_CAPABILITIES,
							});
						});
					}
for (const direction of ['ancestors', 'descendants'] as const)
	for (const flat of [false, true])
		for (const omitSelf of [false, true]) {
			const model = models[0]!;
			const orm = createOrm({
				model,
				adapter: createPgCompileOnlyAdapter({ model }),
			});
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [
					{
						relation: direction,
						recursive: {
							direction,
							maxDepth: 3,
							flat,
							omitSelf,
							track: { depth: true },
						},
					},
				],
			};
			for (const entry of ['orm', 'external', 'nql'])
				record(
					`${entry}/recursive/${direction}/${flat}/${omitSelf}`,
					model,
					() =>
						entry === 'orm'
							? orm
									.select('categories')
									.include(direction, {
										recursive: true,
										direction,
										maxDepth: 3,
										flat,
										omitSelf,
										includeDepth: true,
									})
									.plan()
							: (() => {
									const source = `categories | select ${direction}.*`;
									const parsed =
										entry === 'nql'
											? (orm
													.nql(
														Object.assign([source], {
															raw: [source],
														}) as unknown as TemplateStringsArray,
													)
													.toIntentIR() as QueryIntent)
											: intent;
									// Parse the NQL recursive path, then apply traversal options through public IntentIR.
									const includes = intent.include!.map((include) => ({
										...include,
										relation: parsed.include![0]!.relation,
									}));
									return plan(
										{ ...parsed, select: { type: 'all' }, include: includes },
										model,
										{
											dialectCapabilities: POSTGRESQL_CAPABILITIES,
										},
									);
								})(),
				);
		}
const shards = [...strategies, 'recursive'].flatMap((strategy) => {
	const outcomes = entries.filter((entry) =>
		entry.case.includes(`/${strategy}/`),
	);
	return Array.from(
		{ length: Math.ceil(outcomes.length / 24) },
		(_, index) => ({
			name: `${strategy}.${String(index + 1).padStart(3, '0')}.json`,
			entries: outcomes.slice(index * 24, (index + 1) * 24),
		}),
	);
});
if (rewrite) {
	mkdirSync(directory, { recursive: true });
	mkdirSync(inputsDirectory, { recursive: true });
	const inputs = inputShards(legacyInputs);
	for (const shard of inputs)
		writeFileSync(new URL(shard.name, inputsDirectory), shard.bytes);
	for (const name of readdirSync(inputsDirectory))
		if (!inputs.some((shard) => shard.name === name))
			unlinkSync(new URL(name, inputsDirectory));
	for (const shard of shards)
		writeFileSync(
			new URL(shard.name, directory),
			`${JSON.stringify(shard.entries, null, 2)}\n`,
		);
}
describe('include differential matrix (#891 PR 2)', () => {
	it('pins the input shard layout and size', () => {
		const inputs = inputShards(legacyInputs);
		expect(readdirSync(inputsDirectory).sort()).toEqual(
			inputs.map((shard) => shard.name).sort(),
		);
		for (const shard of inputs) {
			expect(Buffer.byteLength(shard.bytes)).toBeLessThanOrEqual(200_000);
			expect(readFileSync(new URL(shard.name, inputsDirectory), 'utf8')).toBe(
				shard.bytes,
			);
		}
	});
	it('pins the ordered shard inventory', () =>
		expect(readdirSync(directory).sort()).toEqual(
			shards.map((shard) => shard.name).sort(),
		));
	for (const shard of shards)
		it(`preserves exact ${shard.name} SQL, parameters, errors, payloads and fake-driver hydration`, () => {
			const bytes = readFileSync(new URL(shard.name, directory), 'utf8');
			expect(Buffer.byteLength(bytes)).toBeLessThan(200_000);
			expect(`${JSON.stringify(shard.entries, null, 2)}\n`).toBe(bytes);
		});
});
