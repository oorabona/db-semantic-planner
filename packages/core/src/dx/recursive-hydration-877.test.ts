import type { IncludePayloadShape } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { hydrateResolvedIncludes } from './include-payload-hydration.js';

function shape(
	direction: 'ancestors' | 'descendants' = 'descendants',
	flat = false,
	publicKey = 'children',
): IncludePayloadShape {
	return {
		path: publicKey,
		publicKey,
		strategy: 'cte',
		outputMode: 'nested',
		table: 'nodes',
		isToOne: false,
		outputLabel: 'payload',
		columns: ['id', 'name'].map((name) => ({
			logicalName: name,
			physicalName: name,
			publicKey: name,
			outputLabel: name,
		})),
		children: [],
		privateFields: ['node', 'parent', 'depth'].map((role) => ({
			role: role as 'node' | 'parent' | 'depth',
			jsonKey: `_${role}`,
			physicalName: role,
		})),
		recursive: { direction, flat, omitSelf: true, includeDepth: false },
	};
}
const node = (id: number, parent: number | null, depth: number) => ({
	id,
	name: `n${id}`,
	_node: String(id),
	_parent: parent === null ? null : String(parent),
	_depth: depth,
});
function hydrate(payload: unknown, contract = shape()) {
	const rows: Record<string, unknown>[] = [{ id: 1, payload }];
	hydrateResolvedIncludes(rows, [contract], 'json_agg');
	return rows;
}
describe('#877 resolved recursive payload', () => {
	it('assembles descendants, leaves, isolated roots and removes private fields', () => {
		expect(hydrate([node(2, 1, 1), node(3, 2, 2), node(4, 1, 1)])).toEqual([
			{
				id: 1,
				children: [
					{
						id: 2,
						name: 'n2',
						children: [{ id: 3, name: 'n3', children: [] }],
					},
					{ id: 4, name: 'n4', children: [] },
				],
			},
		]);
		expect(hydrate([])).toEqual([{ id: 1, children: [] }]);
	});
	it('assembles ancestors ending in null', () => {
		expect(
			hydrate(
				[node(2, 3, 1), node(3, null, 2)],
				shape('ancestors', false, 'parent'),
			),
		).toEqual([
			{
				id: 1,
				parent: {
					id: 2,
					name: 'n2',
					parent: { id: 3, name: 'n3', parent: null },
				},
			},
		]);
		expect(hydrate([], shape('ancestors', false, 'parent'))).toEqual([
			{ id: 1, parent: null },
		]);
	});
	it('keeps the requested flat key and depth', () => {
		expect(
			hydrate([node(2, 1, 1)], shape('descendants', true, 'allReports')),
		).toEqual([{ id: 1, allReports: [{ id: 2, name: 'n2', depth: 1 }] }]);
	});
	it('includes self as the depth-zero tree node', () => {
		expect(hydrate([node(1, null, 0), node(2, 1, 1)])).toEqual([
			{
				id: 1,
				children: [
					{
						id: 1,
						name: 'n1',
						children: [{ id: 2, name: 'n2', children: [] }],
					},
				],
			},
		]);
	});
	it('assigns __proto__ at the root and every node as an own property', () => {
		const rows = hydrate(
			[node(2, 1, 1), node(3, 2, 2)],
			shape('descendants', false, '__proto__'),
		);
		expect(Object.hasOwn(rows[0]!, '__proto__')).toBe(true);
		expect(rows).toEqual([
			JSON.parse(
				'{"id":1,"__proto__":[{"id":2,"name":"n2","__proto__":[{"id":3,"name":"n3","__proto__":[]}]}]}',
			),
		]);
		expect(Object.getPrototypeOf(rows[0]!)).toBe(Object.prototype);
	});
	it('ignores public read policies for canonical private identity text', () => {
		const contract = shape();
		const privateFields = contract.privateFields!.map((field) =>
			field.role === 'node' || field.role === 'parent'
				? {
						...field,
						readHandling: {
							kind: 'nestedTransform' as const,
							table: 'nodes',
							column: field.role,
							outputKey: field.jsonKey,
							js:
								field.role === 'node'
									? ('string' as const)
									: ('bigint' as const),
						},
					}
				: field,
		);
		expect(
			hydrate(
				[
					{ ...node(2, 1, 1), _node: '2', _parent: '1' },
					{ ...node(3, 2, 2), _node: '3', _parent: '2' },
				],
				{ ...contract, privateFields },
			),
		).toEqual([
			{
				id: 1,
				children: [
					{
						id: 2,
						name: 'n2',
						children: [{ id: 3, name: 'n3', children: [] }],
					},
				],
			},
		]);
	});
	for (const payload of [
		null,
		{},
		[null],
		[2],
		[{ _node: 1, _parent: null, _depth: -1, _order: 1 }],
		[{ _node: 1 }],
	])
		it(`refuses malformed array ${JSON.stringify(payload)}`, () => {
			expect(() => hydrate(payload)).toThrow(
				'Invalid recursive include payload',
			);
		});
	it('parses JSON strings', () => {
		expect(hydrate(JSON.stringify([node(2, 1, 1)]))).toEqual([
			{ id: 1, children: [{ id: 2, name: 'n2', children: [] }] },
		]);
	});
});
