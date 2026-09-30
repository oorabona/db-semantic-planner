import { ModelIRImpl } from '@dbsp/core';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { convergePg } from './public-api.js';

describe('public convergePg', () => {
	it('refuses an undeclared external-index table before inventory resolution', () => {
		const physical = createPgPhysicalModel({
			mode: 'logical',
			schema: 'public',
			model: new ModelIRImpl(
				new Map([
					[
						'users',
						{
							name: 'users',
							columns: [],
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				new Map(),
			),
		});

		expect(() =>
			convergePg({} as Pool, physical, {
				externalIndexes: [{ table: 'missing_table', name: 'operator_index' }],
			}),
		).toThrow(
			'converge externalIndexes[0] names undeclared table missing_table',
		);
	});
});
