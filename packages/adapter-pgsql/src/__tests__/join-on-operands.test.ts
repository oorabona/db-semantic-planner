import {
	batchValues,
	createOrm,
	eq,
	exprRef,
	fn,
	inSubquery,
	outerRef,
	schema,
	subquery,
} from '@dbsp/core';
import type { CompileOptions, PlanReport } from '@dbsp/types';
import { createPhysicalNameInventory } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { compileSelect } from '../adapter-compiler-select.js';
import { defaultFkDerivation } from '../assert-field.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';

const db = schema({
	userProfiles: { id: 'integer' },
	otherThings: { id: 'integer' },
	users: { id: 'integer' },
});

describe('join ON root qualifiers', () => {
	for (const declared of [false, true]) {
		const adapter = createPgCompileOnlyAdapter({
			model: db.model,
			dbCasing: 'snake_case',
		});
		const physical = declared ? 'account_profiles' : 'user_profiles';
		if (declared) {
			const original = createPgPhysicalModel({
				mode: 'logical',
				model: db.model,
				schema: 'public',
				dbCasing: 'snake_case',
			});
			const physicalModel = {
				...original,
				inventory: createPhysicalNameInventory(
					original.inventory.entries.map((entry) =>
						entry.logical.kind === 'table' &&
						entry.logical.name === 'userProfiles'
							? { ...entry, physical }
							: entry,
					),
				),
			};
			adapter.compile = <T>(plan: PlanReport, options?: CompileOptions) =>
				compileSelect<T>(plan, options, {
					model: db.model,
					schemaName: undefined,
					defaultPk: 'id',
					deriveFk: defaultFkDerivation,
					physicalModel,
					declaredNames: createDeclaredNameResolver(physicalModel),
					dbCasing: 'snake_case',
				});
		}
		const orm = createOrm({ schema: db, adapter });
		for (const field of ['id', 'userProfiles.id']) {
			it(`emits the ${declared ? 'declared' : 'snake_case'} root qualifier for ${field} in a table ON`, () => {
				expect(
					orm
						.select('userProfiles')
						.join('otherThings', { as: 'o', on: eq(field, exprRef('o.id')) })
						.dump().sql,
				).toBe(
					`SELECT ${physical}.* FROM ${physical} JOIN other_things AS o ON ${physical}.id = o.id`,
				);
			});
			it(`emits the ${declared ? 'declared' : 'snake_case'} root qualifier for ${field} in a values ON`, () => {
				const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
				expect(
					orm
						.select('userProfiles')
						.join(values, { on: eq(field, exprRef('v.id')) })
						.dump().sql,
				).toBe(
					`SELECT ${physical}.* FROM ${physical} JOIN unnest(CAST($1 AS integer[])) AS v(id) ON ${physical}.id = v.id`,
				);
			});
		}
	}
});

describe('join ON operand visibility', () => {
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	for (const [name, on] of [
		['predicate field', eq('users.id', exprRef('u.id'))],
		['reference operand', eq('u.id', exprRef('users.id'))],
		['function operand', eq('u.id', fn('abs', exprRef('users.id')))],
	] as const) {
		it(`refuses a later qualifier shadowing a visible logical table in a ${name}`, () => {
			expect(() =>
				orm
					.select('otherThings')
					.join('users', { as: 'u', on })
					.join('users', { on: eq('u.id', exprRef('users.id')) })
					.plan(),
			).toThrow("WHERE qualifier 'users' is not visible in this query.");
		});
	}
	it('keeps the root and earlier alias visible in every join ON', () => {
		expect(
			orm
				.select('otherThings')
				.join('users', { as: 'u', on: eq('id', exprRef('u.id')) })
				.join('users', { on: eq('u.id', exprRef('otherThings.id')) })
				.dump().sql,
		).toBe(
			'SELECT "otherThings".* FROM "otherThings" JOIN users AS u ON "otherThings".id = u.id JOIN users AS users ON u.id = "otherThings".id',
		);
	});
});

describe('join ON qualified outer reference visibility', () => {
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	for (const values of [false, true]) {
		const source = batchValues([[1]], ['id'], ['integer'], { alias: 'u' });
		for (const nested of [false, true]) {
			for (const field of [false, true]) {
				const on = (qualifier: string) => {
					const ref = field
						? {
								kind: 'fieldRef' as const,
								column: `${qualifier}.id`,
								scope: 'outer' as const,
							}
						: outerRef(`${qualifier}.id`);
					return nested
						? inSubquery(
								'u.id',
								subquery('users').select('id').where(eq('id', ref)),
							)
						: eq('id', ref);
				};
				const query = (qualifier: string) => {
					const root = orm.select('otherThings');
					const options = { as: 'u', on: on(qualifier) };
					return (
						values ? root.join(source, options) : root.join('users', options)
					).join('users', { on: eq('u.id', exprRef('users.id')) });
				};
				const shape = `${values ? 'values' : 'table'} ON ${nested ? 'subquery' : 'operand'} ${field ? 'outer fieldRef' : 'outerRef'}`;
				it(`refuses a later qualifier in a ${shape}`, () => {
					expect(() => query('users').plan()).toThrow(
						"WHERE qualifier 'users' is not visible in this query.",
					);
				});
				for (const qualifier of nested ? ['u', 'otherThings'] : ['u']) {
					it(`compiles the visible ${qualifier} qualifier in a ${shape}`, () => {
						const join = values
							? 'unnest(CAST($1 AS integer[])) AS u(id)'
							: 'users AS u';
						const predicate = nested
							? `u.id = ANY (SELECT users_subq_0.id FROM users AS users_subq_0 WHERE users_subq_0.id = ${qualifier === 'otherThings' ? '"otherThings"' : qualifier}.id)`
							: '"otherThings".id = u.id';
						expect(query(qualifier).dump().sql).toBe(
							`SELECT "otherThings".* FROM "otherThings" JOIN ${join} ON ${predicate} JOIN users AS users ON u.id = users.id`,
						);
					});
				}
			}
		}
	}
});
