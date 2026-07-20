import { describe, expect, it } from 'vitest';
import type { ColumnDef, InferColumn, InferDB } from './schema.js';
import { ref, schema } from './schema.js';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: false
		: false;
type Expect<T extends true> = T;

type _DirectAbsent = Expect<Equal<InferColumn<'bigint'>, bigint>>;
type _DirectBigint = Expect<
	Equal<InferColumn<{ readonly type: 'bigint'; readonly js: 'bigint' }>, bigint>
>;
type _DirectNumber = Expect<
	Equal<InferColumn<{ readonly type: 'bigint'; readonly js: 'number' }>, number>
>;
type _DirectString = Expect<
	Equal<InferColumn<{ readonly type: 'bigint'; readonly js: 'string' }>, string>
>;
type _DirectNullable = Expect<
	Equal<
		InferColumn<{
			readonly type: 'bigint';
			readonly js: 'bigint';
			readonly nullable: true;
		}>,
		bigint | null
	>
>;

const satisfiesColumn = { type: 'bigint', js: 'number' } satisfies ColumnDef;
type _SatisfiesColumn = Expect<
	Equal<InferColumn<typeof satisfiesColumn>, number>
>;

const widenedColumn: ColumnDef = { type: 'bigint', js: 'number' };
type _WidenedColumn = Expect<
	Equal<InferColumn<typeof widenedColumn>, InferColumn<ColumnDef>>
>;

const jsSchema = schema({
	targets: {
		bigKey: { type: 'bigint', primaryKey: true },
	},
	samples: {
		absent: 'bigint',
		asBigint: { type: 'bigint', js: 'bigint' },
		asNumber: { type: 'bigint', js: 'number' },
		asString: { type: 'bigint', js: 'string' },
		nullableBigint: { type: 'bigint', js: 'bigint', nullable: true },
		refAbsent: ref('targets', {
			as: 'absentRef',
			references: ['bigKey'],
		}),
		refBigint: ref('targets', {
			as: 'bigintRef',
			references: ['bigKey'],
			js: 'bigint',
		}),
		refNumber: ref('targets', {
			as: 'numberRef',
			references: ['bigKey'],
			js: 'number',
		}),
		refString: ref('targets', {
			as: 'stringRef',
			references: ['bigKey'],
			js: 'string',
		}),
		refNullable: ref('targets', {
			as: 'nullableRef',
			references: ['bigKey'],
			js: 'bigint',
			nullable: true,
		}),
	},
});

type SampleRow = InferDB<typeof jsSchema.definition>['samples'];
type SampleTable = typeof jsSchema.tables.samples;

type _RowAbsent = Expect<Equal<SampleRow['absent'], bigint>>;
type _RowBigint = Expect<Equal<SampleRow['asBigint'], bigint>>;
type _RowNumber = Expect<Equal<SampleRow['asNumber'], number>>;
type _RowString = Expect<Equal<SampleRow['asString'], string>>;
type _RowNullable = Expect<Equal<SampleRow['nullableBigint'], bigint | null>>;

type _RowRefAbsent = Expect<Equal<SampleRow['refAbsent'], number | string>>;
type _RowRefBigint = Expect<Equal<SampleRow['refBigint'], bigint>>;
type _RowRefNumber = Expect<Equal<SampleRow['refNumber'], number>>;
type _RowRefString = Expect<Equal<SampleRow['refString'], string>>;
type _RowRefNullable = Expect<Equal<SampleRow['refNullable'], bigint | null>>;

type _TableAbsent = Expect<Equal<SampleTable['absent']['_type'], bigint>>;
type _TableBigint = Expect<Equal<SampleTable['asBigint']['_type'], bigint>>;
type _TableNumber = Expect<Equal<SampleTable['asNumber']['_type'], number>>;
type _TableString = Expect<Equal<SampleTable['asString']['_type'], string>>;
type _TableNullable = Expect<
	Equal<SampleTable['nullableBigint']['_type'], bigint | null>
>;

type _TableRefAbsent = Expect<
	Equal<SampleTable['refAbsent']['_type'], number | string>
>;
type _TableRefBigint = Expect<Equal<SampleTable['refBigint']['_type'], bigint>>;
type _TableRefNumber = Expect<Equal<SampleTable['refNumber']['_type'], number>>;
type _TableRefString = Expect<Equal<SampleTable['refString']['_type'], string>>;
type _TableRefNullable = Expect<
	Equal<SampleTable['refNullable']['_type'], bigint | null>
>;

describe('bigint js read type inference', () => {
	it('keeps exact compile-time inference assertions live', () => {
		expect(jsSchema.tableNames).toContain('samples');
	});
});
