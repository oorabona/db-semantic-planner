import { describe, expect, it } from 'vitest';
import { canonicalizeDbType, resolveRuntimeDbTypeCastName } from './db-type.js';

describe('canonicalizeDbType', () => {
	it.each([
		['int4', undefined, 'integer'],
		['bool', undefined, 'boolean'],
		['float8', undefined, 'double precision'],
		['varchar', { charLength: 120 }, 'varchar(120)'],
		['numeric', { numericPrecision: 10, numericScale: 2 }, 'numeric(10,2)'],
		['character varying', { charLength: 120 }, 'varchar(120)'],
		['character varying(120)', undefined, 'varchar(120)'],
		['vector(1024)', undefined, 'vector(1024)'],
		['uuid', undefined, 'uuid'],
		['jsonb', undefined, 'jsonb'],
		['int4range', undefined, 'int4range'],
		['varchar(120)', { charLength: 200 }, 'varchar(120)'],
		[
			'numeric(10,2)',
			{ numericPrecision: 12, numericScale: 4 },
			'numeric(10,2)',
		],
		['numeric(10, 2)', undefined, 'numeric(10,2)'],
		['decimal(10, 2)', undefined, 'numeric(10,2)'],
		['numeric(10,0)', undefined, 'numeric(10)'],
		['decimal(10,0)', undefined, 'numeric(10)'],
		['timestamp(3) with time zone', undefined, 'timestamptz(3)'],
		['timestamp with time zone', undefined, 'timestamptz'],
		['time(6) without time zone', undefined, 'time(6)'],
		['"Status"', undefined, '"Status"'],
		['MyEnum', undefined, 'myenum'],
	] as const)('canonicalizes %s to %s', (rawType, opts, expected) => {
		expect(canonicalizeDbType(rawType, opts)).toBe(expected);
	});

	it('treats timestamp with time zone as equivalent to timestamptz', () => {
		expect(canonicalizeDbType('timestamp with time zone')).toBe(
			canonicalizeDbType('timestamptz'),
		);
	});

	it('folds unquoted type spellings for comparison', () => {
		expect(canonicalizeDbType('VARCHAR(120)')).toBe(
			canonicalizeDbType('varchar(120)'),
		);
		expect(canonicalizeDbType('INTEGER')).toBe(canonicalizeDbType('int4'));
		expect(canonicalizeDbType('int4')).toBe(canonicalizeDbType('integer'));
		expect(canonicalizeDbType('UUID')).toBe(canonicalizeDbType('uuid'));
		expect(canonicalizeDbType('TIMESTAMPTZ')).toBe(
			canonicalizeDbType('timestamptz'),
		);
		expect(canonicalizeDbType('VECTOR(768)')).toBe(
			canonicalizeDbType('vector(768)'),
		);
	});

	it('preserves quoted type identifier case for comparison', () => {
		expect(canonicalizeDbType('"Status"')).toBe('"Status"');
		expect(canonicalizeDbType('"Status"')).not.toBe(
			canonicalizeDbType('status'),
		);
	});

	it('treats explicit numeric zero scale as equivalent to omitted scale', () => {
		expect(canonicalizeDbType('numeric(10,0)')).toBe(
			canonicalizeDbType('numeric(10)'),
		);
		expect(canonicalizeDbType('decimal(10,0)')).toBe(
			canonicalizeDbType('numeric(10)'),
		);
	});

	it('canonicalizes array element aliases and modifiers', () => {
		expect(canonicalizeDbType('int4[]')).toBe(canonicalizeDbType('integer[]'));
		expect(canonicalizeDbType('bool[]')).toBe(canonicalizeDbType('boolean[]'));
		expect(canonicalizeDbType('numeric(10,0)[]')).toBe(
			canonicalizeDbType('numeric(10)[]'),
		);
		expect(canonicalizeDbType('int4[][]')).toBe('integer[][]');
	});
});

describe('resolveRuntimeDbTypeCastName', () => {
	it('does not rewrite opaque schema-qualified custom types', () => {
		expect(resolveRuntimeDbTypeCastName('tenant.varchar(8)')).toBe(
			'tenant.varchar(8)',
		);
		expect(resolveRuntimeDbTypeCastName('tenant.numeric(10,2)')).toBe(
			'tenant.numeric(10,2)',
		);
		expect(resolveRuntimeDbTypeCastName('tenant.char(4)')).toBe(
			'tenant.char(4)',
		);
	});

	it('treats pg_catalog-qualified built-ins as built-ins', () => {
		expect(resolveRuntimeDbTypeCastName('pg_catalog.varchar(8)')).toBe(
			'pg_catalog.varchar',
		);
		expect(resolveRuntimeDbTypeCastName('pg_catalog.char(4)')).toBe('text');
		expect(resolveRuntimeDbTypeCastName('pg_catalog.bit(4)')).toBe(
			'bit varying',
		);
	});
});
