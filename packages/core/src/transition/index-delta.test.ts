import type { IndexIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { indexDelta } from './index-delta.js';

function idx(overrides: Partial<IndexIR> = {}): IndexIR {
	return {
		name: 'idx_users_email',
		columns: ['email'],
		unique: true,
		...overrides,
	};
}

describe('indexDelta', () => {
	it('recognizes exactly one plain unique btree index add', () => {
		const delta = indexDelta('users', [idx()], []);

		expect(delta).toMatchObject({
			kind: 'add-unique-index',
			index: {
				name: 'idx_users_email',
				columns: ['email'],
				unique: true,
			},
			expectedBefore: [],
		});
		if (delta.kind === 'add-unique-index') {
			expect(delta.expectedAfter).toHaveLength(1);
		}
	});

	it('treats omitted and explicit btree method as the supported shape', () => {
		expect(indexDelta('users', [idx({ method: 'btree' })], [])).toMatchObject({
			kind: 'add-unique-index',
		});
	});

	it('requires explicit current catalog validity for no-drift equivalence', () => {
		expect(indexDelta('users', [idx()], [idx()])).toEqual({
			kind: 'unsupported',
		});
		expect(
			indexDelta('users', [idx()], [idx({ valid: true, ready: true })]),
		).toEqual({ kind: 'none' });
	});

	it.each([
		['non-unique', idx({ unique: false })],
		['expression', idx({ expressions: ['lower(email)'] })],
		['partial predicate', idx({ where: 'email IS NOT NULL' })],
		['include columns', idx({ include: ['id'] })],
		['opclass', idx({ opclass: { email: 'text_pattern_ops' } })],
		['storage params', idx({ with: { fillfactor: '80' } })],
		['nulls not distinct', idx({ nullsNotDistinct: true })],
		['non-btree method', idx({ method: 'hash' })],
		['invalid desired index', idx({ valid: false })],
		['not-ready desired index', idx({ ready: false })],
		['no columns', idx({ columns: [] })],
	])('rejects unsupported shape: %s', (_label, desired) => {
		expect(indexDelta('users', [desired], [])).toEqual({
			kind: 'unsupported',
		});
	});

	it('rejects drops, replacements, renames and multi-index changes', () => {
		expect(indexDelta('users', [], [idx()])).toEqual({ kind: 'unsupported' });
		expect(indexDelta('users', [idx({ unique: false })], [idx()])).toEqual({
			kind: 'unsupported',
		});
		expect(
			indexDelta('users', [idx({ name: 'idx_users_email_new' })], [idx()]),
		).toEqual({ kind: 'unsupported' });
		expect(
			indexDelta(
				'users',
				[idx(), idx({ name: 'idx_users_tenant', columns: ['tenant_id'] })],
				[],
			),
		).toEqual({ kind: 'unsupported' });
	});

	it('rejects an existing invalid index with the target name', () => {
		expect(indexDelta('users', [idx()], [idx({ valid: false })])).toEqual({
			kind: 'unsupported',
		});
	});

	it('rejects an existing valid structurally equivalent unique index', () => {
		expect(
			indexDelta(
				'users',
				[idx({ name: 'idx_users_email_new' })],
				[idx({ name: 'idx_users_email_old' })],
			),
		).toEqual({ kind: 'unsupported' });
	});
});
