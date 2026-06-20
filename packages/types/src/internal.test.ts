import { describe, expect, it } from 'vitest';
import {
	explainUnsupportedNqlBindingIncludeHop,
	getTrustedNqlRelationFilterFields,
	hasNqlTrustedRelationFilterProof,
	markNqlTrustedRelationFilter,
} from './internal.js';

describe('NQL binding include hop allowlist', () => {
	const supportedRelation = {
		type: 'hasMany',
		foreignKey: 'authorId',
		source: 'users',
		target: 'posts',
	} as const;

	it('accepts only supported relation metadata and relation/include node keys', () => {
		expect(
			explainUnsupportedNqlBindingIncludeHop('posts', supportedRelation, {
				relation: 'posts',
				include: [{ relation: 'comments' }],
			}),
		).toBeUndefined();
	});

	it('rejects unknown include-node fields by default', () => {
		expect(
			explainUnsupportedNqlBindingIncludeHop('posts', supportedRelation, {
				relation: 'posts',
				select: { type: 'all' },
			}),
		).toContain("unsupported option 'select'");
	});

	it('rejects future relation kinds by default', () => {
		expect(
			explainUnsupportedNqlBindingIncludeHop('posts', {
				type: 'newRelationKind' as never,
				foreignKey: 'authorId',
				source: 'users',
				target: 'posts',
			}),
		).toContain('belongsTo/hasOne/hasMany');
	});

	it('rejects recursive self-referential relations', () => {
		expect(
			explainUnsupportedNqlBindingIncludeHop('children', {
				type: 'hasMany',
				foreignKey: 'parentId',
				source: 'categories',
				target: 'categories',
				recursive: { direction: 'descendants' },
			}),
		).toContain('ref-#193');
	});
});

describe('NQL trusted relation-filter proof', () => {
	it('freezes and validates relationType in the trusted payload', () => {
		const proof = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'posts',
				targetTable: 'posts',
				sourceColumn: ['id'],
				targetColumn: ['authorId'],
				hops: [],
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
			sourceColumn: ['id'],
			targetColumn: ['authorId'],
			hops: [],
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'hasMany',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.sourceColumn)).toBe(true);
		expect(Object.isFrozen(payload?.targetColumn)).toBe(true);

		try {
			if (payload) {
				(payload as { relationType: string }).relationType = 'belongsToMany';
			}
		} catch {
			// Frozen payloads throw in strict mode; either way, mutation must not stick.
		}
		expect(payload?.relationType).toBe('hasMany');
	});

	it('deep-freezes and validates scalar multi-hop trusted payloads', () => {
		const proof = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'author.company',
				targetTable: 'authors',
				sourceColumn: ['authorId'],
				targetColumn: ['id'],
				hops: [
					{ target: 'companies', fkColumn: ['companyId'], joinColumn: ['id'] },
				],
				selectedColumn: 'name',
				cardinality: 'one',
				relationType: 'belongsTo',
			},
		);

		const payload = getTrustedNqlRelationFilterFields(proof);

		expect(payload).toEqual({
			relation: 'author.company',
			targetTable: 'authors',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
			hops: [
				{ target: 'companies', fkColumn: ['companyId'], joinColumn: ['id'] },
			],
			selectedColumn: 'name',
			cardinality: 'one',
			relationType: 'belongsTo',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.hops)).toBe(true);
		expect(Object.isFrozen(payload?.hops[0])).toBe(true);
		expect(Object.isFrozen(payload?.hops[0]?.fkColumn)).toBe(true);
		expect(Object.isFrozen(payload?.hops[0]?.joinColumn)).toBe(true);
		try {
			if (payload) {
				(payload.hops[0] as { target: string }).target = 'forged';
			}
		} catch {
			// Frozen payloads throw in strict mode; either way, mutation must not stick.
		}
		expect(payload?.hops[0]?.target).toBe('companies');
	});

	it('carries and freezes many-to-many junction proof fields', () => {
		const proof = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'tags',
				targetTable: 'tags',
				sourceColumn: ['id'],
				targetColumn: ['id'],
				hops: [],
				through: 'post_tags',
				throughSourceColumn: 'post_id',
				throughTargetColumn: 'tag_id',
				selectedColumn: 'name',
				cardinality: 'many',
				relationType: 'manyToMany',
			},
		);

		const payload = getTrustedNqlRelationFilterFields(proof);

		expect(payload).toEqual({
			relation: 'tags',
			targetTable: 'tags',
			sourceColumn: ['id'],
			targetColumn: ['id'],
			hops: [],
			through: 'post_tags',
			throughSourceColumn: 'post_id',
			throughTargetColumn: 'tag_id',
			selectedColumn: 'name',
			cardinality: 'many',
			relationType: 'manyToMany',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.through)).toBe(true);
		expect(Object.isFrozen(payload?.throughSourceColumn)).toBe(true);
		expect(Object.isFrozen(payload?.throughTargetColumn)).toBe(true);
	});

	it('carries and deep-freezes recursive trusted payload fields', () => {
		const proof = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'ascendant',
				targetTable: 'categories',
				sourceColumn: ['parentId'],
				targetColumn: ['id'],
				hops: [],
				selectedColumn: 'name',
				cardinality: 'many',
				relationType: 'hasMany',
				recursive: {
					direction: 'up',
					maxDepth: 10,
					selfRefColumn: 'parentId',
					targetKeyColumn: 'id',
				},
			},
		);

		const payload = getTrustedNqlRelationFilterFields(proof);

		expect(payload).toEqual({
			relation: 'ascendant',
			targetTable: 'categories',
			sourceColumn: ['parentId'],
			targetColumn: ['id'],
			hops: [],
			selectedColumn: 'name',
			cardinality: 'many',
			relationType: 'hasMany',
			recursive: {
				direction: 'up',
				maxDepth: 10,
				selfRefColumn: 'parentId',
				targetKeyColumn: 'id',
			},
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.recursive)).toBe(true);
		try {
			if (payload?.recursive) {
				(payload.recursive as { selfRefColumn: string }).selfRefColumn =
					'forged';
			}
		} catch {
			// Frozen payloads throw in strict mode; either way, mutation must not stick.
		}
		expect(payload?.recursive?.selfRefColumn).toBe('parentId');
	});

	it('does not trust forged plain objects or invalid relationType payloads', () => {
		const forged = {
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: ['id'],
			targetColumn: ['authorId'],
			hops: [],
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
			sourceColumn: ['id'],
			targetColumn: ['authorId'],
			hops: [],
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'madeUp',
		} as unknown as Parameters<typeof markNqlTrustedRelationFilter>[1]);

		expect(hasNqlTrustedRelationFilterProof(forged)).toBe(false);
		expect(getTrustedNqlRelationFilterFields(forged)).toBeUndefined();
		expect(hasNqlTrustedRelationFilterProof(invalid)).toBe(false);
		expect(getTrustedNqlRelationFilterFields(invalid)).toBeUndefined();
	});

	it('does not trust malformed or incomplete hop chains', () => {
		const dottedWithoutHops = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'author.company',
				targetTable: 'authors',
				sourceColumn: ['authorId'],
				targetColumn: ['id'],
				hops: [],
				selectedColumn: 'name',
				cardinality: 'one',
				relationType: 'belongsTo',
			},
		);
		const malformedHop = markNqlTrustedRelationFilter(
			{ kind: 'relationColumn' },
			{
				relation: 'author.company',
				targetTable: 'authors',
				sourceColumn: ['authorId'],
				targetColumn: ['id'],
				hops: [{ target: '', fkColumn: ['companyId'], joinColumn: ['id'] }],
				selectedColumn: 'name',
				cardinality: 'one',
				relationType: 'belongsTo',
			} as unknown as Parameters<typeof markNqlTrustedRelationFilter>[1],
		);

		expect(
			getTrustedNqlRelationFilterFields(dottedWithoutHops),
		).toBeUndefined();
		expect(hasNqlTrustedRelationFilterProof(dottedWithoutHops)).toBe(false);
		expect(getTrustedNqlRelationFilterFields(malformedHop)).toBeUndefined();
		expect(hasNqlTrustedRelationFilterProof(malformedHop)).toBe(false);
	});
});
