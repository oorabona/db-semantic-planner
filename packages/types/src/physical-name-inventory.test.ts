import { describe, expect, it } from 'vitest';
import {
	createPhysicalNameInventory,
	PhysicalNameInventoryDuplicateError,
	PhysicalNameInventoryMissingError,
} from './physical-name-inventory.js';

describe('createPhysicalNameInventory', () => {
	it('copies, sorts, freezes, and resolves entries', () => {
		const inventory = createPhysicalNameInventory([
			{
				logical: { kind: 'table', schema: 'app', name: 'zebra' },
				physical: 'zebra',
			},
			{
				logical: { kind: 'column', schema: 'app', table: 'zebra', name: 'id' },
				physical: 'id',
			},
		]);
		expect(Object.isFrozen(inventory)).toBe(true);
		expect(Object.isFrozen(inventory.entries)).toBe(true);
		expect(Object.isFrozen(inventory.entries[0])).toBe(true);
		expect(inventory.has({ kind: 'table', schema: 'app', name: 'zebra' })).toBe(
			true,
		);
		expect(inventory.get({ kind: 'table', schema: 'app', name: 'zebra' })).toBe(
			'zebra',
		);
		expect(() =>
			inventory.get({ kind: 'enum', schema: 'app', name: 'missing' }),
		).toThrow(PhysicalNameInventoryMissingError);
	});

	it.each([
		[
			'logical-address',
			[
				{
					logical: { kind: 'table', schema: 'app', name: 'one' },
					physical: 'one',
				},
				{
					logical: { kind: 'table', schema: 'app', name: 'one' },
					physical: 'two',
				},
			],
		],
		[
			'table',
			[
				{
					logical: { kind: 'table', schema: 'app', name: 'one' },
					physical: 'same',
				},
				{
					logical: { kind: 'table', schema: 'app', name: 'two' },
					physical: 'same',
				},
			],
		],
		[
			'column',
			[
				{
					logical: {
						kind: 'column',
						schema: 'app',
						table: 'one',
						name: 'first',
					},
					physical: 'same',
				},
				{
					logical: {
						kind: 'column',
						schema: 'app',
						table: 'one',
						name: 'second',
					},
					physical: 'same',
				},
			],
		],
	] as const)('refuses a duplicate %s', (scope, entries) => {
		try {
			createPhysicalNameInventory(entries);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PhysicalNameInventoryDuplicateError);
			expect((error as PhysicalNameInventoryDuplicateError).scope).toBe(scope);
		}
	});
});
