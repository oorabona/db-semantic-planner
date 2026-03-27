import { describe, expect, it } from 'vitest';
import type { QueryIntent } from '../../intent-ast.js';
import { eq, rawExists, rawNotExists } from '../filters.js';
import { subquery } from '../subquery-builder.js';

describe('rawExists', () => {
	it('creates WhereRawExistsIntent from SubqueryBuilder', () => {
		const sub = subquery('audit_log').select('id').where(eq('entityId', 42));
		const result = rawExists(sub);

		expect(result.kind).toBe('rawExists');
		expect(result.subquery).toBeDefined();
		expect(result.subquery.from).toBe('audit_log');
	});

	it('preserves WHERE condition from subquery', () => {
		const sub = subquery('bans').select('id').where(eq('userId', 1));
		const result = rawExists(sub);

		expect(result.subquery.where).toBeDefined();
		expect(result.subquery.where).toEqual({
			kind: 'comparison',
			field: 'userId',
			operator: 'eq',
			value: 1,
		});
	});

	it('creates WhereRawExistsIntent from buildIntent() duck-type', () => {
		const fakeBuilder = {
			buildIntent(): QueryIntent {
				return {
					type: 'select',
					from: 'sessions',
					select: { type: 'fields', fields: ['id'] },
				};
			},
		};

		const result = rawExists(fakeBuilder);

		expect(result.kind).toBe('rawExists');
		expect(result.subquery.from).toBe('sessions');
	});

	it('uses buildIntent() when both build and buildIntent are present', () => {
		// An object that has both — buildIntent() should win (checked first)
		const fakeBuilder = {
			buildIntent(): QueryIntent {
				return {
					type: 'select',
					from: 'winner',
					select: { type: 'fields', fields: ['id'] },
				};
			},
			build() {
				throw new Error('build() should not be called');
			},
		};

		const result = rawExists(fakeBuilder as Parameters<typeof rawExists>[0]);

		expect(result.subquery.from).toBe('winner');
	});
});

describe('rawNotExists', () => {
	it('creates WhereRawNotExistsIntent from SubqueryBuilder', () => {
		const sub = subquery('bans').select('id').where(eq('userId', 99));
		const result = rawNotExists(sub);

		expect(result.kind).toBe('rawNotExists');
		expect(result.subquery).toBeDefined();
		expect(result.subquery.from).toBe('bans');
	});

	it('preserves WHERE condition from subquery', () => {
		const sub = subquery('blocks').select('id').where(eq('targetId', 7));
		const result = rawNotExists(sub);

		expect(result.subquery.where).toEqual({
			kind: 'comparison',
			field: 'targetId',
			operator: 'eq',
			value: 7,
		});
	});

	it('creates WhereRawNotExistsIntent from buildIntent() duck-type', () => {
		const fakeBuilder = {
			buildIntent(): QueryIntent {
				return {
					type: 'select',
					from: 'deleted_records',
					select: { type: 'fields', fields: ['id'] },
				};
			},
		};

		const result = rawNotExists(fakeBuilder);

		expect(result.kind).toBe('rawNotExists');
		expect(result.subquery.from).toBe('deleted_records');
	});
});

describe('rawExists / rawNotExists — structural contract', () => {
	it('rawExists result is structurally equal to hand-crafted WhereRawExistsIntent', () => {
		const sub = subquery('posts').select('id').where(eq('published', true));
		const result = rawExists(sub);

		expect(result).toEqual({
			kind: 'rawExists',
			subquery: {
				type: 'select',
				from: 'posts',
				select: { type: 'fields', fields: ['id'] },
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			},
		});
	});

	it('rawNotExists result is structurally equal to hand-crafted WhereRawNotExistsIntent', () => {
		const sub = subquery('comments').select('id').where(eq('spam', true));
		const result = rawNotExists(sub);

		expect(result).toEqual({
			kind: 'rawNotExists',
			subquery: {
				type: 'select',
				from: 'comments',
				select: { type: 'fields', fields: ['id'] },
				where: {
					kind: 'comparison',
					field: 'spam',
					operator: 'eq',
					value: true,
				},
			},
		});
	});
});
