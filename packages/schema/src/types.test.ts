import { describe, expect, it } from 'vitest';
import {
	type BelongsToRelation,
	type HasManyRelation,
	isBelongsTo,
	isHasMany,
	isManyToMany,
	type ManyToManyRelation,
	type RelationDefinition,
} from './types.js';

describe('types', () => {
	describe('type guards', () => {
		const belongsTo: BelongsToRelation = {
			kind: 'belongsTo',
			target: 'users',
			foreignKey: 'authorId',
		};

		const hasMany: HasManyRelation = {
			kind: 'hasMany',
			target: 'posts',
			foreignKey: 'authorId',
		};

		const manyToMany: ManyToManyRelation = {
			kind: 'manyToMany',
			target: 'categories',
			through: 'post_categories',
			sourceFk: 'postId',
			targetFk: 'categoryId',
		};

		describe('isBelongsTo', () => {
			it('returns true for belongsTo relation', () => {
				expect(isBelongsTo(belongsTo)).toBe(true);
			});

			it('returns false for hasMany relation', () => {
				expect(isBelongsTo(hasMany)).toBe(false);
			});

			it('returns false for manyToMany relation', () => {
				expect(isBelongsTo(manyToMany)).toBe(false);
			});

			it('narrows type correctly', () => {
				const rel: RelationDefinition = belongsTo;
				if (isBelongsTo(rel)) {
					// TypeScript should allow accessing foreignKey
					expect(rel.foreignKey).toBe('authorId');
				}
			});
		});

		describe('isHasMany', () => {
			it('returns true for hasMany relation', () => {
				expect(isHasMany(hasMany)).toBe(true);
			});

			it('returns false for belongsTo relation', () => {
				expect(isHasMany(belongsTo)).toBe(false);
			});

			it('returns false for manyToMany relation', () => {
				expect(isHasMany(manyToMany)).toBe(false);
			});

			it('narrows type correctly', () => {
				const rel: RelationDefinition = hasMany;
				if (isHasMany(rel)) {
					// TypeScript should allow accessing foreignKey
					expect(rel.foreignKey).toBe('authorId');
				}
			});
		});

		describe('isManyToMany', () => {
			it('returns true for manyToMany relation', () => {
				expect(isManyToMany(manyToMany)).toBe(true);
			});

			it('returns false for belongsTo relation', () => {
				expect(isManyToMany(belongsTo)).toBe(false);
			});

			it('returns false for hasMany relation', () => {
				expect(isManyToMany(hasMany)).toBe(false);
			});

			it('narrows type correctly', () => {
				const rel: RelationDefinition = manyToMany;
				if (isManyToMany(rel)) {
					// TypeScript should allow accessing through, sourceFk, targetFk
					expect(rel.through).toBe('post_categories');
					expect(rel.sourceFk).toBe('postId');
					expect(rel.targetFk).toBe('categoryId');
				}
			});
		});
	});
});
