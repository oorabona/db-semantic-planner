import type {
	Adapter,
	CompileOnlyAdapter,
	CompilingAdapter,
	DDLGeneratingAdapter,
	ExecutingAdapter,
	TableDDLGeneratorAdapter,
} from './adapter.js';

declare const compilingAdapter: CompilingAdapter;
declare const ddlGeneratingAdapter: DDLGeneratingAdapter;
declare const fullAdapter: Adapter;
declare const reducedThirdPartyAdapter: CompilingAdapter &
	DDLGeneratingAdapter &
	TableDDLGeneratorAdapter & {
		readonly dbCasing: 'snake_case';
		withSchema(schemaName: string): CompileOnlyAdapter;
	};

// @ts-expect-error Compile-only adapters must expose the required CREATE INDEX renderer.
const compileOnlyWithoutCreateIndex: CompileOnlyAdapter = {
	...compilingAdapter,
	...ddlGeneratingAdapter,
	dbCasing: 'snake_case',
	withSchema: () => compileOnlyWithoutCreateIndex,
};

// @ts-expect-error Table DDL adapters must expose the required CREATE INDEX renderer.
const tableDDLWithoutCreateIndex: TableDDLGeneratorAdapter = {};

// Existing annotations accept a full adapter and a reduced third-party
// compile-and-DDL implementation without requiring an execution surface.
const compileOnlyFromFullAdapter: CompileOnlyAdapter = fullAdapter;
const compileOnlyFromReducedThirdParty: CompileOnlyAdapter =
	reducedThirdPartyAdapter;

const metadataAdapterWithDriverRows: Pick<ExecutingAdapter, 'executeWithMeta'> =
	{
		executeWithMeta: async () => ({
			rows: [{ arbitraryDriverField: true }],
			rowCount: 1,
		}),
	};

void compileOnlyWithoutCreateIndex;
void compileOnlyFromFullAdapter;
void compileOnlyFromReducedThirdParty;
void metadataAdapterWithDriverRows;
void tableDDLWithoutCreateIndex;
