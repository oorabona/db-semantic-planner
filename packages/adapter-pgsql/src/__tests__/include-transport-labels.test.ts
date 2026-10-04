import {
	createOrm,
	ResultHydrator,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import type { IncludePayloadShape } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

for (const relation of ['r'.repeat(62)])
	for (const strategy of ['join', 'json_agg', 'lateral'] as const)
		for (const nested of [false, true])
			it(`907 transport labels ${strategy} nested=${nested} ${relation}`, async () => {
				const model = schema({
					roots: { id: { type: 'integer', primaryKey: true } },
					children: {
						id: { type: 'integer', primaryKey: true },
						rootId: ref('roots', { inverse: relation }),
					},
					leaves: {
						id: { type: 'integer', primaryKey: true },
						childId: ref('children', { inverse: 'leaves' }),
					},
				}).model;
				const adapter = createPgCompileOnlyAdapter({ model });
				const builder = createOrm({ model, adapter })
					.select('roots')
					.withPlanOptions({ defaultIncludeStrategy: strategy })
					.include(
						relation,
						nested ? { include: [{ relation: 'leaves' }] } : {},
					)
					.columns([
						relationColumn(relation, 'id', 'id'),
						...(nested
							? [
									relationColumn(relation, 'rootId', 'rootId'),
									relationColumn(`${relation}.leaves`, 'id', 'id'),
								]
							: []),
					]);
				const report = builder.plan();
				const compiled = adapter.compile(report, { model });
				const shape = compiled.hydrationPlan!.includePayloads![0]!;
				const labels: string[] = [];
				const raw: Record<string, unknown> = {};
				const populate = (payload: IncludePayloadShape) => {
					for (const column of payload.columns) {
						labels.push(column.outputLabel);
						raw[column.outputLabel] = column.logicalName === 'rootId' ? 1 : 2;
					}
					for (const child of payload.children) populate(child);
				};
				if (strategy === 'json_agg') {
					labels.push(shape.outputLabel);
					raw[shape.outputLabel] = JSON.stringify([
						{ id: 2, ...(nested && { rootId: 1, leaves: [{ id: 2 }] }) },
					]);
				} else populate(shape);
				for (const label of labels) {
					expect(Buffer.byteLength(label)).toBeLessThanOrEqual(63);
					const emitted = [
						...compiled.sql.matchAll(
							/\bAS (?:"([^"]+)"|([a-zA-Z_][a-zA-Z_0-9]*))/g,
						),
					].map((match) => match[1] ?? match[2]);
					expect(emitted).toContain(label);
				}
				expect(labels).toEqual(
					strategy === 'json_agg'
						? [`${relation}_`]
						: nested
							? [`${relation}.`, `${'r'.repeat(61)}_1`, `${'r'.repeat(61)}_2`]
							: [`${relation}.`],
				);
				expect(new Set(labels).size).toBe(labels.length);
				const expected = [
					{
						[relation]:
							strategy === 'json_agg'
								? [{ id: 2, ...(nested && { rootId: 1, leaves: [{ id: 2 }] }) }]
								: { id: 2, ...(nested && { rootId: 1, leaves: { id: 2 } }) },
					},
				];
				const rows = [structuredClone(raw)];
				const hydrator = new ResultHydrator(model, 'roots');
				hydrator.hydrateJoinIncludes(rows, report, compiled);
				hydrator.hydrateJsonAggIncludes(rows, report, compiled);
				expect(rows).toEqual(expected);
				// This hermetic adapter returns PostgreSQL-shaped rows without a connection.
				Object.defineProperty(adapter, 'connectionAvailability', {
					value: { status: 'available' },
				});
				adapter.execute = async <T>() => [structuredClone(raw) as T];
				expect(await builder.all()).toEqual(expected);
			});
