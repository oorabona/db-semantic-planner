import { describe, expect, it } from 'vitest';
import {
	getTrustedNqlRelationFilterFields,
	hasNqlTrustedRelationFilterProof,
	markNqlTrustedRelationFilter,
} from './internal.js';

describe('NQL trusted relation-filter proof', () => {
	it('freezes and validates relationType in the trusted payload', () => {
		const proof = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'posts',
				targetTable: 'posts',
				sourceColumn: 'id',
				targetColumn: 'authorId',
				selectedColumn: 'title',
				cardinality: 'many',
				relationType: 'hasMany',
			},
		);

		const payload = getTrustedNqlRelationFilterFields(proof);

		expect(hasNqlTrustedRelationFilterProof(proof)).toBe(true);
		expect(payload).toEqual({
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: 'id',
			targetColumn: 'authorId',
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'hasMany',
		});
		expect(Object.isFrozen(payload)).toBe(true);

		try {
			if (payload) {
				(payload as { relationType: string }).relationType = 'belongsToMany';
			}
		} catch {
			// Frozen payloads throw in strict mode; either way, mutation must not stick.
		}
		expect(payload?.relationType).toBe('hasMany');
	});

	it('does not trust forged plain objects or invalid relationType payloads', () => {
		const forged = {
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: 'id',
			targetColumn: 'authorId',
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'hasMany',
		};
		Object.defineProperty(
			forged,
			Symbol.for('@dbsp/nql/trustedRelationFilter'),
			{
				value: true,
				enumerable: false,
			},
		);

		const invalid = markNqlTrustedRelationFilter({ kind: 'relationColumn' }, {
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: 'id',
			targetColumn: 'authorId',
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'madeUp',
		} as unknown as Parameters<typeof markNqlTrustedRelationFilter>[1]);

		expect(hasNqlTrustedRelationFilterProof(forged)).toBe(false);
		expect(getTrustedNqlRelationFilterFields(forged)).toBeUndefined();
		expect(hasNqlTrustedRelationFilterProof(invalid)).toBe(false);
		expect(getTrustedNqlRelationFilterFields(invalid)).toBeUndefined();
	});
});
