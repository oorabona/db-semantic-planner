import { ModelIRImpl } from '@dbsp/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { PgConvergeRefusalError } from './converge.js';
import { convergePg } from './public-api.js';

function physicalWithUsers() {
	return createPgPhysicalModel({
		mode: 'logical',
		schema: 'public',
		model: new ModelIRImpl(
			new Map([
				[
					'users',
					{
						name: 'users',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{ name: 'users_id_positive', expression: 'id > 0' },
						],
					},
				],
			]),
			new Map(),
		),
	});
}

function poolThatMustNotConnect(): Pool {
	return {
		connect: vi.fn(() => {
			throw new Error('converge must refuse before connecting');
		}),
	} as unknown as Pool;
}

function expectInvalidOptionsBeforeConnection(
	pool: Pool,
	physical: ReturnType<typeof physicalWithUsers>,
	options: unknown,
): void {
	let caught: unknown;
	try {
		Reflect.apply(convergePg, undefined, [pool, physical, options]);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PgConvergeRefusalError);
	expect((caught as PgConvergeRefusalError).refusal).toBe('invalid-options');
	expect(pool.connect).not.toHaveBeenCalled();
}

function assertStep(owns: unknown): unknown {
	return {
		kind: 'assert',
		id: 'assertion',
		digest: 'v1',
		phase: 'after-generated-ddl',
		owns,
		inspect: async () => 'healthy',
		apply: async () => undefined,
	};
}

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

	it.each([
		['a null entry', [null]],
		[
			'an assert entry without its required fields',
			[
				{
					kind: 'assert',
					owns: { checks: [{ table: 'users', name: 'missing_check' }] },
				},
			],
		],
	])('refuses steps containing %s before inventory resolution', (_, steps) => {
		const pool = poolThatMustNotConnect();
		expectInvalidOptionsBeforeConnection(pool, physicalWithUsers(), { steps });
	});

	it('refuses an assert owning a table the model does not declare before inventory resolution', () => {
		const pool = poolThatMustNotConnect();
		expectInvalidOptionsBeforeConnection(pool, physicalWithUsers(), {
			steps: [
				assertStep({
					checks: [{ table: 'missing_table', name: 'missing_check' }],
				}),
			],
		});
	});

	it('refuses an assert owning an undeclared column before inventory resolution', () => {
		const pool = poolThatMustNotConnect();
		expectInvalidOptionsBeforeConnection(pool, physicalWithUsers(), {
			steps: [
				assertStep({
					columnTypes: [{ table: 'users', column: 'missing_column' }],
				}),
			],
		});
	});

	it('refuses an assert owning an undeclared CHECK before inventory resolution', () => {
		const pool = poolThatMustNotConnect();
		expectInvalidOptionsBeforeConnection(pool, physicalWithUsers(), {
			steps: [
				assertStep({ checks: [{ table: 'users', name: 'missing_check' }] }),
			],
		});
	});
});
