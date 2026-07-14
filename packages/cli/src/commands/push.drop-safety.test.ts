/**
 * `dbsp push --drop` must never destroy dbsp's own migration history, and must
 * report accurately what it did drop.
 *
 * These import the production helpers. An earlier version of this file defined its
 * own copies of the pattern and the extractor and asserted against those, so it
 * stayed green no matter what `push.ts` actually did.
 */

import { describe, expect, it } from 'vitest';
import {
	buildMigrationsTableDropPattern,
	extractDroppedTableName,
} from './push.js';

const MIGRATIONS_TABLE = '_dbsp_migrations';

describe('push --drop protects the migrations table', () => {
	const pattern = buildMigrationsTableDropPattern(MIGRATIONS_TABLE);

	it('matches an unqualified drop of the migrations table', () => {
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_migrations"')).toBe(true);
	});

	it('matches a schema-qualified drop of the migrations table', () => {
		expect(
			pattern.test('DROP TABLE IF EXISTS "myschema"."_dbsp_migrations"'),
		).toBe(true);
	});

	it('leaves other tables alone', () => {
		expect(pattern.test('DROP TABLE IF EXISTS "users"')).toBe(false);
	});

	it('does not let a statement dropping another table shield the migrations table', () => {
		// generateDDL yields one statement per entry, so each is tested on its own.
		expect(pattern.test('DROP TABLE IF EXISTS "users"')).toBe(false);
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_migrations"')).toBe(true);
	});

	it('escapes a dot in the table name, so it cannot stand for any character', () => {
		const dotted = buildMigrationsTableDropPattern('_dbsp_mig.rations');
		// Unescaped, the dot would match any character here and spare a table it
		// has no business sparing.
		expect(dotted.test('DROP TABLE IF EXISTS "_dbsp_migXrations"')).toBe(false);
		expect(dotted.test('DROP TABLE IF EXISTS "_dbsp_mig.rations"')).toBe(true);
	});

	it('escapes a dollar sign in the table name', () => {
		const dollar = buildMigrationsTableDropPattern('_dbsp_$mig');
		expect(dollar.test('DROP TABLE IF EXISTS "_dbsp_Xmig"')).toBe(false);
		expect(dollar.test('DROP TABLE IF EXISTS "_dbsp_$mig"')).toBe(true);
	});
});

describe('push --drop --json names the tables it dropped', () => {
	it('reads an unqualified name', () => {
		expect(extractDroppedTableName('DROP TABLE IF EXISTS "users";')).toBe(
			'users',
		);
	});

	it('reads the table, not the schema, from a qualified name', () => {
		expect(
			extractDroppedTableName('DROP TABLE IF EXISTS "public"."users";'),
		).toBe('users');
	});

	it('reads past CASCADE', () => {
		expect(
			extractDroppedTableName('DROP TABLE IF EXISTS "users" CASCADE;'),
		).toBe('users');
	});

	it('reads a qualified name past CASCADE', () => {
		expect(
			extractDroppedTableName('DROP TABLE IF EXISTS "public"."users" CASCADE;'),
		).toBe('users');
	});

	it('reads a name with no trailing semicolon', () => {
		expect(
			extractDroppedTableName('DROP TABLE IF EXISTS "public"."orders" CASCADE'),
		).toBe('orders');
	});

	it('reports the whole statement rather than losing a table it cannot parse', () => {
		const unparseable = 'DROP TABLE users';
		expect(extractDroppedTableName(unparseable)).toBe(unparseable);
	});
});
