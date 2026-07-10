import { describe, expect, it } from 'vitest';
import {
	dbTypeCastTarget,
	dbTypesEqual,
	enumReferenceKind,
	isPgBuiltInTypeName,
	quoteTypeIdentifier,
	renderColumnDbType,
	validateDbType,
} from './db-type.js';

type ValidationResult =
	| { ok: true; value: string }
	| { ok: false; message: string };

function validationResult(type: string): ValidationResult {
	try {
		return { ok: true, value: validateDbType(type) };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

describe('db-type utilities', () => {
	it('quotes only RAW catalog identifiers that are case-sensitive', () => {
		// quoteTypeIdentifier is the ONLY place quoting is added — it renders a bare
		// catalog typname SQL-safe. A safe lowercase name stays bare; a case-sensitive
		// name is quoted with inner quotes doubled.
		expect([
			quoteTypeIdentifier('status'),
			quoteTypeIdentifier('int4'),
			quoteTypeIdentifier('Money'),
			quoteTypeIdentifier('CamelType'),
			quoteTypeIdentifier('weird"name'),
			// Significant leading/trailing whitespace is part of the raw typname and
			// must be preserved (not trimmed away to a different type).
			quoteTypeIdentifier(' Money'),
		]).toEqual([
			'status',
			'int4',
			'"Money"',
			'"CamelType"',
			'"weird""name"',
			'" Money"',
		]);
	});

	it('classifies built-ins case-insensitively (builtin-first)', () => {
		expect([
			isPgBuiltInTypeName('varchar'),
			isPgBuiltInTypeName('VarChar'),
			isPgBuiltInTypeName('Numeric(10,2)'),
			isPgBuiltInTypeName('Money'),
			isPgBuiltInTypeName('timestamp with time zone'),
			isPgBuiltInTypeName('oid'),
			// Non-built-in custom identifiers:
			isPgBuiltInTypeName('Status'),
			isPgBuiltInTypeName('"Money"'),
			isPgBuiltInTypeName('audit.mood'),
		]).toEqual([true, true, true, true, true, true, false, false, false]);
	});

	it('emits cast targets as-is for custom types, truncation-safe for built-ins', () => {
		// A custom type is emitted verbatim (a bare name folds per PostgreSQL rules;
		// a case-sensitive type is already quoted upstream). A bounded built-in casts
		// to its unbounded base so the cast never truncates/rounds.
		expect([
			dbTypeCastTarget('"Money"'),
			dbTypeCastTarget('Money'),
			dbTypeCastTarget('Status'),
			dbTypeCastTarget('audit.Status'),
			dbTypeCastTarget('geometry(Point,4326)'),
			dbTypeCastTarget('vector(768)'),
			dbTypeCastTarget('varchar(120)'),
			dbTypeCastTarget('numeric(10,2)'),
			dbTypeCastTarget('interval day to second(3)'),
		]).toEqual([
			'"Money"',
			'Money',
			'Status',
			'audit.Status',
			'geometry(Point,4326)',
			'vector(768)',
			'varchar',
			'numeric',
			'interval day to second',
		]);
	});

	it('classifies scalar vs array enum references for drop-dependency', () => {
		// A reference reports its arity (scalar -> text, array -> text[]). Because
		// older hand-built ModelIRs may carry bare custom types, a BARE reference
		// matches by typname only (safe over-protection). A schema-QUALIFIED
		// reference matches only when its schema matches.
		expect([
			enumReferenceKind('status', 'status'), // bare, enum schema unknown -> scalar
			enumReferenceKind('"Status"', 'Status'), // bare quoted, unknown -> scalar
			enumReferenceKind('status[]', 'status', 'tenant_1'), // bare name-only match -> array
			enumReferenceKind('status[]', 'status', 'public'), // bare name-only match -> array
			enumReferenceKind('tenant_1.status[]', 'status', 'tenant_1'), // schema match -> array
			enumReferenceKind('public.status[]', 'status', 'tenant_1'), // schema mismatch -> null
			enumReferenceKind('tenant_1.status[]', 'status'), // qualified, enum schema unknown -> array
			enumReferenceKind('numeric(10,2)', 'status'), // different type -> null
		]).toEqual([
			'scalar',
			'scalar',
			'array',
			'array',
			'array',
			null,
			'array',
			null,
		]);
	});

	it('quotes reserved schema names when qualifying custom db types', () => {
		expect([
			renderColumnDbType(
				{
					name: 'state',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'tenant_1',
					originalDbTypeSchemaScope: 'target',
				},
				'tenant_1',
			),
			renderColumnDbType(
				{
					name: 'state',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'select',
					originalDbTypeSchemaScope: 'target',
				},
				'select',
			),
			renderColumnDbType(
				{
					name: 'state',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'copy',
					originalDbTypeSchemaScope: 'target',
				},
				'copy',
			),
		]).toEqual(['"tenant_1".status', '"select".status', '"copy".status']);
	});

	it('renders column db types from structural schema identity', () => {
		expect([
			{
				label: 'target scope retargets to explicit schema',
				dbType: renderColumnDbType(
					{
						name: 'state',
						type: 'string',
						originalDbType: 'status',
						originalDbTypeSchema: 'tenant_1',
						originalDbTypeSchemaScope: 'target',
					},
					'tenant_2',
				),
			},
			{
				label: 'target scope falls back to source schema',
				dbType: renderColumnDbType({
					name: 'state',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'tenant_1',
					originalDbTypeSchemaScope: 'target',
				}),
			},
			{
				label: 'absolute scope ignores target schema',
				dbType: renderColumnDbType(
					{
						name: 'state',
						type: 'string',
						originalDbType: 'status',
						originalDbTypeSchema: 'tenant_1',
						originalDbTypeSchemaScope: 'absolute',
					},
					'tenant_2',
				),
			},
			{
				label: 'absolute public qualifies',
				dbType: renderColumnDbType(
					{
						name: 'state',
						type: 'string',
						originalDbType: 'status',
						originalDbTypeSchema: 'public',
						originalDbTypeSchemaScope: 'absolute',
					},
					'tenant_2',
				),
			},
			{
				label: 'target public stays bare',
				dbType: renderColumnDbType({
					name: 'state',
					type: 'string',
					originalDbType: 'status',
					originalDbTypeSchema: 'public',
					originalDbTypeSchemaScope: 'target',
				}),
			},
			{
				label: 'built-in stays verbatim',
				dbType: renderColumnDbType(
					{
						name: 'amount',
						type: 'number',
						originalDbType: 'numeric(10,2)',
						originalDbTypeSchema: 'pg_catalog',
					},
					'tenant_2',
				),
			},
			{
				label: 'array and modifier are preserved',
				dbType: renderColumnDbType(
					{
						name: 'states',
						type: 'string',
						originalDbType: 'status(4)[]',
						originalDbTypeSchema: 'tenant_1',
						originalDbTypeSchemaScope: 'target',
					},
					'tenant_2',
				),
			},
			{
				label: 'legacy qualified string stays as-is',
				dbType: renderColumnDbType(
					{
						name: 'state',
						type: 'string',
						originalDbType: 'tenant_1.status',
					},
					'tenant_2',
				),
			},
			{
				label: 'legacy bare string stays as-is',
				dbType: renderColumnDbType(
					{
						name: 'state',
						type: 'string',
						originalDbType: 'status',
					},
					'target',
				),
			},
			{
				label: 'authored extension type stays verbatim under target schema',
				dbType: renderColumnDbType(
					{
						name: 'embedding',
						type: 'string',
						originalDbType: 'vector(768)',
					},
					'tenant_1',
				),
			},
		]).toEqual([
			{
				label: 'target scope retargets to explicit schema',
				dbType: '"tenant_2".status',
			},
			{
				label: 'target scope falls back to source schema',
				dbType: '"tenant_1".status',
			},
			{
				label: 'absolute scope ignores target schema',
				dbType: '"tenant_1".status',
			},
			{ label: 'absolute public qualifies', dbType: '"public".status' },
			{ label: 'target public stays bare', dbType: 'status' },
			{ label: 'built-in stays verbatim', dbType: 'numeric(10,2)' },
			{
				label: 'array and modifier are preserved',
				dbType: '"tenant_2".status(4)[]',
			},
			{
				label: 'legacy qualified string stays as-is',
				dbType: 'tenant_1.status',
			},
			{
				label: 'legacy bare string stays as-is',
				dbType: 'status',
			},
			{
				label: 'authored extension type stays verbatim under target schema',
				dbType: 'vector(768)',
			},
		]);
	});

	it('always quotes schemas when rendering schema-qualified custom db types', () => {
		expect(
			['copy', 'select', 'tenant-x', 'MixedCase'].map((schema) =>
				renderColumnDbType(
					{
						name: 'state',
						type: 'string',
						originalDbType: 'status',
						originalDbTypeSchema: schema,
						originalDbTypeSchemaScope: 'target',
					},
					schema,
				),
			),
		).toEqual([
			'"copy".status',
			'"select".status',
			'"tenant-x".status',
			'"MixedCase".status',
		]);
	});

	it('validates built-in modifiers with per-type arity', () => {
		expect([
			// Accepted: numeric precision(,scale) incl. PG15+ negative scale and a
			// space after the comma; single-integer length/precision; interval field
			// spec precision; opaque non-built-in modifier grammars.
			validationResult('numeric(10,2)').ok,
			validationResult('numeric(10, 2)').ok,
			validationResult('numeric(10,-2)').ok,
			validationResult('varchar(120)').ok,
			validationResult('timestamp(3) with time zone').ok,
			validationResult('interval day to second(3)').ok,
			validationResult('float(24)').ok,
			validationResult('geometry(Point,4326)').ok,
			validationResult('vector(768)').ok,
			// Rejected: bad content, wrong arity, internal whitespace, a modifier on
			// a built-in that takes none, and a non-numeric interval precision.
			validationResult('numeric(foo)').ok,
			validationResult("varchar('x')").ok,
			validationResult('varchar(10,-2)').ok,
			validationResult('bit(8,-1)').ok,
			validationResult('varchar(1 2)').ok,
			validationResult('integer(foo)').ok,
			validationResult('text(10)').ok,
			validationResult('double precision(5)').ok,
			validationResult('interval day to second(foo)').ok,
			// Rejected: an unbalanced/malformed string literal in an opaque modifier.
			validationResult("geometry('unterminated)").ok,
		]).toEqual([
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it('validates format_type corpus and maps cast targets', () => {
		const cases = [
			{
				type: 'timestamp(3) with time zone',
				castTarget: 'timestamp with time zone',
			},
			{ type: 'bit(8)', castTarget: 'bit varying' },
			{ type: 'bit varying(16)', castTarget: 'bit varying' },
			{ type: 'bit', castTarget: 'bit' },
			{ type: 'bit varying', castTarget: 'bit varying' },
			{ type: 'numeric(10,2)', castTarget: 'numeric' },
			{ type: 'character varying(120)', castTarget: 'varchar' },
			{ type: 'character(5)', castTarget: 'text' },
			{ type: 'vector(768)', castTarget: 'vector(768)' },
			{ type: 'interval(3)', castTarget: 'interval' },
			{ type: 'interval year to month', castTarget: 'interval year to month' },
			{
				type: 'interval day to second(3)',
				// Precision stripped so the cast never rounds fractional seconds.
				castTarget: 'interval day to second',
			},
			{
				type: 'interval hour to minute',
				castTarget: 'interval hour to minute',
			},
			{
				type: 'time(3) without time zone',
				castTarget: 'time without time zone',
			},
			{ type: 'integer[]', castTarget: 'integer[]' },
			{ type: 'geometry(Point,4326)', castTarget: 'geometry(Point,4326)' },
			{ type: '"MySchema"."my_enum"', castTarget: '"MySchema"."my_enum"' },
			{ type: '"order status"', castTarget: '"order status"' },
			{ type: '"a""b"', castTarget: '"a""b"' },
		];

		expect(
			cases.map(({ type }) => ({
				type,
				validation: validationResult(type),
				castTarget: dbTypeCastTarget(type),
			})),
		).toEqual([
			{
				type: 'timestamp(3) with time zone',
				validation: { ok: true, value: 'timestamp(3) with time zone' },
				castTarget: 'timestamp with time zone',
			},
			{
				type: 'bit(8)',
				validation: { ok: true, value: 'bit(8)' },
				castTarget: 'bit varying',
			},
			{
				type: 'bit varying(16)',
				validation: { ok: true, value: 'bit varying(16)' },
				castTarget: 'bit varying',
			},
			{
				type: 'bit',
				validation: { ok: true, value: 'bit' },
				castTarget: 'bit',
			},
			{
				type: 'bit varying',
				validation: { ok: true, value: 'bit varying' },
				castTarget: 'bit varying',
			},
			{
				type: 'numeric(10,2)',
				validation: { ok: true, value: 'numeric(10,2)' },
				castTarget: 'numeric',
			},
			{
				type: 'character varying(120)',
				validation: { ok: true, value: 'character varying(120)' },
				castTarget: 'varchar',
			},
			{
				type: 'character(5)',
				validation: { ok: true, value: 'character(5)' },
				castTarget: 'text',
			},
			{
				type: 'vector(768)',
				validation: { ok: true, value: 'vector(768)' },
				castTarget: 'vector(768)',
			},
			{
				type: 'interval(3)',
				validation: { ok: true, value: 'interval(3)' },
				castTarget: 'interval',
			},
			{
				type: 'interval year to month',
				validation: { ok: true, value: 'interval year to month' },
				castTarget: 'interval year to month',
			},
			{
				type: 'interval day to second(3)',
				validation: { ok: true, value: 'interval day to second(3)' },
				castTarget: 'interval day to second',
			},
			{
				type: 'interval hour to minute',
				validation: { ok: true, value: 'interval hour to minute' },
				castTarget: 'interval hour to minute',
			},
			{
				type: 'time(3) without time zone',
				validation: { ok: true, value: 'time(3) without time zone' },
				castTarget: 'time without time zone',
			},
			{
				type: 'integer[]',
				validation: { ok: true, value: 'integer[]' },
				castTarget: 'integer[]',
			},
			{
				type: 'geometry(Point,4326)',
				validation: { ok: true, value: 'geometry(Point,4326)' },
				castTarget: 'geometry(Point,4326)',
			},
			{
				type: '"MySchema"."my_enum"',
				validation: { ok: true, value: '"MySchema"."my_enum"' },
				castTarget: '"MySchema"."my_enum"',
			},
			{
				type: '"order status"',
				validation: { ok: true, value: '"order status"' },
				castTarget: '"order status"',
			},
			{
				type: '"a""b"',
				validation: { ok: true, value: '"a""b"' },
				castTarget: '"a""b"',
			},
		]);
	});

	it('rejects constraint and statement fragments', () => {
		const rejected = [
			'integer NOT NULL',
			"text DEFAULT 'x'",
			'int REFERENCES users',
			'varchar(10); DROP TABLE t',
			'text) CHECK (1=1',
			'bigint UNIQUE',
			'numeric(1=1)',
			'numeric(1|1)',
		];

		expect(
			rejected.map((type) => ({
				type,
				validation: validationResult(type),
			})),
		).toEqual([
			{
				type: 'integer NOT NULL',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "integer NOT NULL". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: "text DEFAULT 'x'",
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "text DEFAULT \'x\'". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: 'int REFERENCES users',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "int REFERENCES users". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: 'varchar(10); DROP TABLE t',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "varchar(10); DROP TABLE t". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: 'text) CHECK (1=1',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "text) CHECK (1=1". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: 'bigint UNIQUE',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "bigint UNIQUE". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: 'numeric(1=1)',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "numeric(1=1)". Must be a structurally valid PostgreSQL type name.',
				},
			},
			{
				type: 'numeric(1|1)',
				validation: {
					ok: false,
					message:
						'Unsafe database type name: "numeric(1|1)". Must be a structurally valid PostgreSQL type name.',
				},
			},
		]);
	});

	it('compares canonical aliases while preserving modifiers', () => {
		const comparisons = [
			{
				left: 'varchar',
				right: 'character varying',
				equal: dbTypesEqual('varchar', 'character varying'),
			},
			{
				left: 'int4',
				right: 'integer',
				equal: dbTypesEqual('int4', 'integer'),
			},
			{
				left: 'status',
				right: 'tenant_1.status',
				equal: dbTypesEqual('status', 'tenant_1.status'),
			},
			{
				left: 'status[]',
				right: 'tenant_1.status[]',
				equal: dbTypesEqual('status[]', 'tenant_1.status[]'),
			},
			{
				left: 'public.status',
				right: 'tenant_1.status',
				equal: dbTypesEqual('public.status', 'tenant_1.status'),
			},
			{
				left: 'vector(768)',
				right: 'tenant_1.vector(1024)',
				equal: dbTypesEqual('vector(768)', 'tenant_1.vector(1024)'),
			},
			{
				left: 'timestamptz',
				right: 'timestamp with time zone',
				equal: dbTypesEqual('timestamptz', 'timestamp with time zone'),
			},
			{
				left: 'timestamp(3) with time zone',
				right: 'timestamptz(3)',
				equal: dbTypesEqual('timestamp(3) with time zone', 'timestamptz(3)'),
			},
			{
				left: 'character varying(120)',
				right: 'varchar(120)',
				equal: dbTypesEqual('character varying(120)', 'varchar(120)'),
			},
			{
				left: 'character(5)',
				right: 'char(5)',
				equal: dbTypesEqual('character(5)', 'char(5)'),
			},
			{
				left: 'timestamp with time zone',
				right: 'timestamptz',
				equal: dbTypesEqual('timestamp with time zone', 'timestamptz'),
			},
			{
				left: 'timestamptz(3)',
				right: 'timestamptz(6)',
				equal: dbTypesEqual('timestamptz(3)', 'timestamptz(6)'),
			},
			{
				left: 'numeric(10,2)',
				right: 'numeric',
				equal: dbTypesEqual('numeric(10,2)', 'numeric'),
			},
			{
				left: '"Money"',
				right: '"money"',
				equal: dbTypesEqual('"Money"', '"money"'),
			},
			{
				left: '"Money"',
				right: '"Money"',
				equal: dbTypesEqual('"Money"', '"Money"'),
			},
		];

		expect(comparisons).toEqual([
			{ left: 'varchar', right: 'character varying', equal: true },
			{ left: 'int4', right: 'integer', equal: true },
			{ left: 'status', right: 'tenant_1.status', equal: false },
			{ left: 'status[]', right: 'tenant_1.status[]', equal: false },
			{ left: 'public.status', right: 'tenant_1.status', equal: false },
			{
				left: 'vector(768)',
				right: 'tenant_1.vector(1024)',
				equal: false,
			},
			{
				left: 'timestamptz',
				right: 'timestamp with time zone',
				equal: true,
			},
			{
				left: 'timestamp(3) with time zone',
				right: 'timestamptz(3)',
				equal: true,
			},
			{
				left: 'character varying(120)',
				right: 'varchar(120)',
				equal: true,
			},
			{ left: 'character(5)', right: 'char(5)', equal: true },
			{
				left: 'timestamp with time zone',
				right: 'timestamptz',
				equal: true,
			},
			{ left: 'timestamptz(3)', right: 'timestamptz(6)', equal: false },
			{ left: 'numeric(10,2)', right: 'numeric', equal: false },
			{ left: '"Money"', right: '"money"', equal: false },
			{ left: '"Money"', right: '"Money"', equal: true },
		]);
	});
});
