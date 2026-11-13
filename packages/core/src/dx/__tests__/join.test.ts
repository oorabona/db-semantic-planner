/**
 * Tests for QueryBuilder.join() — FR-10 Block 1
 *
 * Tests verify:
 * 1. Relation mode: produces JoinIntent with `relation` field, no `table`/`on`
 * 2. Table mode: produces JoinIntent with `table` + `on` fields, no `relation`
 * 3. Join type defaults to 'inner'
 * 4. Left join type is preserved
 * 5. Alias is forwarded when provided
 * 6. Multiple joins accumulate correctly
 * 7. Immutability: original builder is unchanged after .join()
 */

import { describe, expect, it } from 'vitest';
import type { JoinIntent, QueryIntent } from '../../intent-ast.js';
import { InvalidOperationError } from '../errors.js';
import { eq } from '../filters.js';
import { createOrm } from '../orm.js';
import { ref, schema } from '../schema.js';
import { createMockAdapter } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------
const testSchema = schema({
	calls: {
		id: { type: 'integer', primaryKey: true },
		callerId: ref('users', { as: 'caller' }),
		calleeId: ref('users', { as: 'callee' }),
		callerFileId: ref('users', { as: 'callerFile' }),
		content: 'string',
	},
	users: { id: { type: 'integer', primaryKey: true } },
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		content: 'string',
		score: { type: 'decimal' },
	},
});

const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });

// ---------------------------------------------------------------------------
// Helper: extract the QueryIntent from a QueryBuilder
// ---------------------------------------------------------------------------
function getIntent(builder: ReturnType<typeof orm.select>): QueryIntent {
	return builder.plan().intent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryBuilder.join() — FR-10', () => {
	describe('relation mode (FK auto-resolved)', () => {
		it('produces JoinIntent with relation field and inner type by default', () => {
			const intent = getIntent(orm.select('calls').join('caller'));
			expect(intent.joins).toHaveLength(1);
			const join = intent.joins![0] as JoinIntent;
			expect(join).toMatchObject({ relation: 'caller', type: 'inner' });
			expect((join as { table?: unknown }).table).toBeUndefined();
			expect((join as { on?: unknown }).on).toBeUndefined();
		});

		it('respects left join type', () => {
			const intent = getIntent(
				orm.select('calls').join('callerFile', { type: 'left' }),
			);
			const join = intent.joins![0] as JoinIntent;
			expect(join).toMatchObject({ relation: 'callerFile', type: 'left' });
		});

		it('forwards alias when provided', () => {
			const intent = getIntent(orm.select('calls').join('caller', { as: 'c' }));
			const join = intent.joins![0] as JoinIntent;
			expect(join).toMatchObject({
				relation: 'caller',
				type: 'inner',
				alias: 'c',
			});
		});

		it('omits alias property when not provided', () => {
			const intent = getIntent(orm.select('calls').join('caller'));
			const join = intent.joins![0] as JoinIntent;
			expect('alias' in join).toBe(false);
		});
	});

	describe('table mode (explicit ON condition)', () => {
		it('produces JoinIntent with table + on fields', () => {
			const onCondition = eq('embeddings.id', 42);
			const intent = getIntent(
				orm
					.select('embeddings')
					.join('embeddings', { on: onCondition, as: 'e2' }),
			);
			expect(intent.joins).toHaveLength(1);
			const join = intent.joins![0] as JoinIntent;
			expect(join).toMatchObject({
				table: 'embeddings',
				on: onCondition,
				alias: 'e2',
				type: 'inner',
			});
			expect((join as { relation?: unknown }).relation).toBeUndefined();
		});

		it('respects left join type in table mode', () => {
			const onCondition = eq('embeddings.id', 1);
			const intent = getIntent(
				orm
					.select('embeddings')
					.join('embeddings', { on: onCondition, type: 'left', as: 'e2' }),
			);
			const join = intent.joins![0] as JoinIntent;
			expect(join).toMatchObject({ table: 'embeddings', type: 'left' });
		});
	});

	describe('multiple joins', () => {
		it('accumulates joins in order', () => {
			const intent = getIntent(
				orm.select('calls').join('caller').join('callee', { type: 'left' }),
			);
			expect(intent.joins).toHaveLength(2);
			expect((intent.joins![0] as JoinIntent).relation).toBe('caller');
			expect((intent.joins![1] as JoinIntent).relation).toBe('callee');
			expect((intent.joins![1] as JoinIntent).type).toBe('left');
		});
	});

	describe('immutability', () => {
		it('does not mutate the original builder', () => {
			const base = orm.select('calls');
			const withJoin = base.join('caller');
			const baseIntent = getIntent(base);
			const withJoinIntent = getIntent(withJoin);

			expect(baseIntent.joins).toBeUndefined();
			expect(withJoinIntent.joins).toHaveLength(1);
		});

		it('branched builders do not share join state', () => {
			const base = orm.select('calls').join('caller');
			const branch1 = base.join('callee');
			const branch2 = base.join('callerFile', { type: 'left' });

			expect(getIntent(base).joins).toHaveLength(1);
			expect(getIntent(branch1).joins).toHaveLength(2);
			expect(getIntent(branch2).joins).toHaveLength(2);
			expect((getIntent(branch1).joins![1] as JoinIntent).relation).toBe(
				'callee',
			);
			expect((getIntent(branch2).joins![1] as JoinIntent).relation).toBe(
				'callerFile',
			);
		});
	});

	describe('intent shape without joins', () => {
		it('does not set joins field when no join() calls made', () => {
			const intent = getIntent(orm.select('calls'));
			expect(intent.joins).toBeUndefined();
		});
	});

	describe('alias validation', () => {
		it('should reject invalid as alias identifier (SQL injection attempt)', () => {
			// FIND-008: validateIdentifier now applied to join() as alias
			expect(() =>
				orm.select('calls').join('caller', { as: 'a"; DROP TABLE users; --' }),
			).toThrow('alias name contains invalid characters');
			// #982: every alias of a list is an identifier, not only its length.
			expect(() =>
				orm.select('calls').join('callee.file', { as: ['c', 'c f'] }),
			).toThrow(
				new InvalidOperationError(
					'alias',
					'alias name contains invalid characters',
				),
			);
		});
	});

	describe('#982: relation paths', () => {
		it('accepts a readonly alias list and refuses one outside relation mode in its types', () => {
			const aliases: readonly string[] = ['c', 'cf'];
			// The interface orm.select() returns must accept it; the builder records it unplanned.
			const builder = orm.select('calls').join('callee.file', { as: aliases });
			const intent = (
				builder as unknown as { buildIntent(): QueryIntent }
			).buildIntent();
			expect(intent.joins).toEqual([
				{ relation: 'callee.file', type: 'inner', alias: ['c', 'cf'] },
			]);
			const batch = orm.batchValues([[1]], ['id'], ['int4'], { alias: 'bv' });
			expect(() =>
				orm
					.select('calls')
					// @ts-expect-error an alias list requires a relation path
					.join('files', { on: eq('files.id', 1), as: ['f'] }),
			).toThrow(
				new Error("join('files'): an alias list requires a relation path."),
			);
			expect(() =>
				orm
					.select('calls')
					// @ts-expect-error an alias list requires a relation path
					.join(batch, { on: eq('bv.id', 1), as: ['b'] }),
			).toThrow(
				new Error("join('bv'): an alias list requires a relation path."),
			);
		});

		it('refuses an alias list whose length differs from the hop count', () => {
			expect(() =>
				orm.select('calls').join('callee.file', { as: ['c'] }),
			).toThrow(
				new Error("join('callee.file'): 'as' lists 1 aliases for 2 hops."),
			);
		});

		it('validates every relation segment', () => {
			for (const path of ['callee..file', '.callee', 'callee.'])
				expect(() => orm.select('calls').join(path)).toThrow(
					new InvalidOperationError(
						'relation',
						'relation name must not be empty',
					),
				);
			expect(() => orm.select('calls').join('callee.fi le')).toThrow(
				new InvalidOperationError(
					'relation',
					'relation name contains invalid characters',
				),
			);
		});

		it('refuses a default hop alias longer than an identifier', () => {
			expect(() =>
				orm.select('calls').join(`${'a'.repeat(40)}.${'b'.repeat(30)}`),
			).toThrow(
				new InvalidOperationError(
					'alias',
					'alias name must not exceed 63 characters',
				),
			);
		});
	});
});
