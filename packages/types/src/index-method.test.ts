import { describe, expect, it } from 'vitest';
import type { CreateIndexOptions } from './adapter.js';

describe('IndexMethod', () => {
	it('accepts PostgreSQL index access methods in the type union', () => {
		const spgistIndexOptions: CreateIndexOptions = {
			name: 'users_location_spgist_idx',
			columns: ['location'],
			method: 'spgist',
		};
		const bloomIndexOptions: CreateIndexOptions = {
			name: 'events_attributes_bloom_idx',
			columns: ['attributes'],
			method: 'bloom',
		};
		const inventedIndexOptions: CreateIndexOptions = {
			name: 'users_invented_idx',
			columns: ['id'],
			// @ts-expect-error IndexMethod is a closed PostgreSQL access-method allowlist.
			method: 'invented',
		};

		expect([spgistIndexOptions.method, bloomIndexOptions.method]).toEqual([
			'spgist',
			'bloom',
		]);
		void inventedIndexOptions;
	});
});
