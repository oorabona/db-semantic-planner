/**
 * Physical-name ownership tests replacing the deleted inverse naming lookup.
 *
 * Query compilation resolves logical addresses through this complete physical
 * inventory; it never guesses a logical name from a returned SQL spelling.
 */
import { schema } from '@dbsp/core';
import type { DbCasing } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgPhysicalModel } from '../physical-model/index.js';

function resolverFor(table: string, dbCasing: DbCasing) {
	const model = schema({ [table]: { id: 'integer' } } as Record<
		string,
		{ id: 'integer' }
	>).model;
	return createDeclaredNameResolver(
		createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing,
		}),
	);
}

describe('physical-model table names', () => {
	it('maps camelCase logical tables to snake_case physical tables', () => {
		expect(
			resolverFor('postComments', 'snake_case').table('postComments'),
		).toBe('post_comments');
	});
	it('preserves simple snake_case table names', () => {
		expect(resolverFor('posts', 'snake_case').table('posts')).toBe('posts');
	});
	it('has no physical address for an unknown logical table', () => {
		expect(resolverFor('posts', 'snake_case').table('fooBar')).toBeUndefined();
	});
	it('maps multi-segment logical tables', () => {
		expect(
			resolverFor('userProfileSettings', 'snake_case').table(
				'userProfileSettings',
			),
		).toBe('user_profile_settings');
	});
	it('preserves declared names in preserve mode', () => {
		expect(
			resolverFor('post_comments', 'preserve').table('post_comments'),
		).toBe('post_comments');
	});
	it('has no preserve-mode fallback for unknown logical tables', () => {
		expect(resolverFor('posts', 'preserve').table('unknown')).toBeUndefined();
	});
	it('preserves camelCase physical names in camelCase mode', () => {
		expect(resolverFor('postComments', 'camelCase').table('postComments')).toBe(
			'postComments',
		);
	});
	it('has no camelCase fallback for unknown logical tables', () => {
		expect(resolverFor('posts', 'camelCase').table('unknown')).toBeUndefined();
	});
	it('keeps declared snake_case names when snake_case requires no transform', () => {
		expect(resolverFor('some_table', 'snake_case').table('some_table')).toBe(
			'some_table',
		);
	});
	it('has no address in a complete empty schema', () => {
		const model = schema({}).model;
		const resolver = createDeclaredNameResolver(
			createPgPhysicalModel({
				mode: 'logical',
				model,
				schema: 'public',
				dbCasing: 'snake_case',
			}),
		);
		expect(resolver.table('anything')).toBeUndefined();
	});
	it('keeps single-word names', () => {
		expect(resolverFor('users', 'snake_case').table('users')).toBe('users');
	});
});
