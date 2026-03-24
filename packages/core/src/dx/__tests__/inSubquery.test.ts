import { describe, expect, it } from 'vitest';
import { eq, inSubquery, not } from '../filters.js';
import { subquery } from '../subquery-builder.js';

describe('inSubquery', () => {
	it('creates WhereInIntent with empty values and subquery field', () => {
		const sub = subquery('posts').select('userId').where(eq('status', 'published'));
		const result = inSubquery('id', sub);

		expect(result.kind).toBe('in');
		expect(result.field).toBe('id');
		expect(result.values).toEqual([]);
		expect(result.subquery).toBeDefined();
		expect(result.subquery!.from).toBe('posts');
	});

	it('supports negation via not() wrapper', () => {
		const sub = subquery('posts').select('userId');
		const result = not(inSubquery('id', sub));
		expect(result.kind).toBe('not');
	});

	it('preserves subquery intent table name', () => {
		const sub = subquery('orders').select('customerId');
		const result = inSubquery('customerId', sub);

		expect(result.subquery).toBeDefined();
		expect(result.subquery!.from).toBe('orders');
	});

	it('accepts string as field argument', () => {
		const sub = subquery('posts').select('userId');
		const result = inSubquery('userId', sub);

		expect(result.field).toBe('userId');
	});
});
