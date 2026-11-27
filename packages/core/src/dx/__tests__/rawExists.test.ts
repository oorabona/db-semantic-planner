import { describe, expect, it } from 'vitest';
import type { QueryIntent } from '../../intent-ast.js';
import { InvalidOperationError } from '../errors.js';
import { eq, inSubquery, rawExists, rawNotExists } from '../filters.js';
import { createOrm } from '../orm.js';
import { schema } from '../schema.js';
import { SubqueryExpression, subquery } from '../subquery-builder.js';
import { createMockAdapter } from '../test-utils.js';

const NOT_A_SUBQUERY =
	'this builder is not a subquery; use orm.select(...), subquery(table) or a SubqueryExpression';
const sessionsIntent: QueryIntent = {
	type: 'select',
	from: 'sessions',
	select: { type: 'fields', fields: ['id'] },
};

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

	it('takes a SubqueryExpression as its body, unchanged (ADR 0011 delivery 5)', () => {
		const sq = new SubqueryExpression(sessionsIntent);
		expect(rawExists(sq).subquery).toBe(sessionsIntent);
	});

	it('R2 refuses a mutation builder by name (ADR 0011 delivery 5)', () => {
		const orm = createOrm({
			schema: schema({ posts: { id: 'integer', title: 'text' } }),
			adapter: createMockAdapter(),
		});
		expect(() =>
			rawExists(orm.update('posts').set({ title: 'x' }) as never),
		).toThrow(new InvalidOperationError('rawExists', NOT_A_SUBQUERY));
	});

	it('R2 inSubquery refuses any other value with the accepted forms', () => {
		expect(() => inSubquery('id', {} as never)).toThrow(
			new InvalidOperationError(
				'inSubquery',
				'expected orm.select(...), subquery(table) or a SubqueryExpression',
			),
		);
	});

	it('R2 refuses a structural { buildIntent } object by name, never compiling it (ADR 0011 delivery 5)', () => {
		expect(() =>
			rawExists({ buildIntent: () => sessionsIntent } as never),
		).toThrow(new InvalidOperationError('rawExists', NOT_A_SUBQUERY));
		expect(() =>
			rawExists({
				buildIntent: () => sessionsIntent,
				build: () => sessionsIntent,
			} as never),
		).toThrow(new InvalidOperationError('rawExists', NOT_A_SUBQUERY));
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

	it('takes a SubqueryExpression as its body, unchanged (ADR 0011 delivery 5)', () => {
		const sq = new SubqueryExpression(sessionsIntent);
		expect(rawNotExists(sq).subquery).toBe(sessionsIntent);
	});

	it('R2 refuses a structural { buildIntent } object by name (ADR 0011 delivery 5)', () => {
		expect(() =>
			rawNotExists({ buildIntent: () => sessionsIntent } as never),
		).toThrow(new InvalidOperationError('rawNotExists', NOT_A_SUBQUERY));
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
