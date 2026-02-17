import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from './uuid';

describe('uuidv7', () => {
	it('should return a valid UUID format (8-4-4-4-12)', () => {
		const id = uuidv7();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it('should have version 7 in the 13th character', () => {
		const id = uuidv7();
		expect(id[14]).toBe('7');
	});

	it('should have variant bits 10xx in the 17th-18th position', () => {
		const id = uuidv7();
		const variantChar = id[19]!;
		expect(['8', '9', 'a', 'b']).toContain(variantChar);
	});

	it('should be lexicographically sortable by time', () => {
		const ids: string[] = [];
		// Generate IDs across different timestamps
		for (let i = 0; i < 5; i++) {
			vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i * 1000);
			ids.push(uuidv7());
		}
		vi.restoreAllMocks();

		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids);
	});

	it('should produce unique IDs', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(uuidv7());
		}
		expect(ids.size).toBe(100);
	});

	it('should embed the current timestamp in the first 48 bits', () => {
		const mockNow = 1700000000000;
		vi.spyOn(Date, 'now').mockReturnValue(mockNow);

		const id = uuidv7();
		const timestampHex = id.replace(/-/g, '').slice(0, 12);
		const extracted = Number.parseInt(timestampHex, 16);

		expect(extracted).toBe(mockNow);

		vi.restoreAllMocks();
	});
});
