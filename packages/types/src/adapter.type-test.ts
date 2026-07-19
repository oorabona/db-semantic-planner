import type {
	CompilingAdapter,
	CompileOnlyAdapter,
	DDLGeneratingAdapter,
	TableDDLGeneratorAdapter,
} from './adapter.js';

declare const compilingAdapter: CompilingAdapter;
declare const ddlGeneratingAdapter: DDLGeneratingAdapter;

// @ts-expect-error Compile-only adapters must expose the required CREATE INDEX renderer.
const compileOnlyWithoutCreateIndex: CompileOnlyAdapter = {
	...compilingAdapter,
	...ddlGeneratingAdapter,
	dbCasing: 'snake_case',
	withSchema: () => compileOnlyWithoutCreateIndex,
};

// @ts-expect-error Table DDL adapters must expose the required CREATE INDEX renderer.
const tableDDLWithoutCreateIndex: TableDDLGeneratorAdapter = {};

void compileOnlyWithoutCreateIndex;
void tableDDLWithoutCreateIndex;
