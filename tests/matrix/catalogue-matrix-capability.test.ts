import { describe, expect, it } from 'vitest';
import { requireCatalogueColumnCapability } from './catalogue-matrix-capability.js';

describe('catalogue matrix capability probe', () => {
	const malformedReads: readonly {
		readonly label: string;
		readonly rows: readonly unknown[];
	}[] = [
		{ label: 'empty', rows: [] },
		{ label: 'non-boolean exists', rows: [{ exists: 'false' }] },
		{ label: 'multiple rows', rows: [{ exists: true }, { exists: false }] },
	];

	it('accepts exactly one boolean exists row', () => {
		expect(requireCatalogueColumnCapability([{ exists: true }])).toBe(true);
		expect(requireCatalogueColumnCapability([{ exists: false }])).toBe(false);
	});

	it.each(
		malformedReads,
	)('throws instead of classifying malformed reads as an older version: $label', ({
		rows,
	}) => {
		expect(() => requireCatalogueColumnCapability(rows)).toThrow(
			'invalid catalogue capability read',
		);
	});
});
