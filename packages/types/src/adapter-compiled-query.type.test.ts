import { describe, expect, it } from 'vitest';
import type { CompiledColumnMetadata, CompiledQuery } from './adapter.js';
import {
	assertCompiledQuery,
	compiledQueryFromProjection,
	isCompiledQuery,
	projectionlessCompiledQuery,
	rebuildCompiledQuery,
} from './adapter-sdk.js';

type _PublicCompiledQuery = import('@dbsp/types').CompiledQuery;
type AdapterSdkModule = typeof import('@dbsp/types/adapter-sdk');
type PublicModule = typeof import('@dbsp/types');
type _AdapterSdkProjectionlessCompiledQuery =
	AdapterSdkModule['projectionlessCompiledQuery'];
type ExpectRootExport<K extends keyof PublicModule> = K;
// @ts-expect-error CompiledQuery constructors are not exported from the consumer surface.
type _NoPublic = ExpectRootExport<'projectionlessCompiledQuery'>;

// @ts-expect-error CompiledQuery must be built through an intent-named constructor.
const bareQuery: CompiledQuery = { sql: '', parameters: [] };
void bareQuery;

const metadata = new Map<string, CompiledColumnMetadata>([
	['id', { table: 'users', column: 'id', js: 'bigint' }],
]);

const fromProjection: CompiledQuery = compiledQueryFromProjection({
	sql: 'select id from users',
	parameters: [],
	columnMetadata: metadata,
});

const projectionless: CompiledQuery = projectionlessCompiledQuery(
	{ sql: 'select 1', parameters: [] },
	'adapter-compiled-query-type-test',
);

const rebuilt: CompiledQuery = rebuildCompiledQuery(fromProjection, {
	sql: 'select id from users where id = $1',
	parameters: [1n],
});

void projectionless;
void rebuilt;

describe('CompiledQuery constructors', () => {
	it('checks runtime WeakSet branding and validation', () => {
		const raw = { sql: '', parameters: [] };
		expect(isCompiledQuery(raw)).toBe(false);
		expect(() => assertCompiledQuery(raw)).toThrow(
			'CompiledQuery must be produced by an adapter constructor — use executeRaw() or streamRaw() for raw SQL. If this query WAS produced by an adapter, check for duplicate or version-mismatched @dbsp/types in your dependency tree: the runtime brand is scoped to one installed copy of @dbsp/types.',
		);

		const query = projectionlessCompiledQuery(
			{ sql: 'select 1', parameters: [] },
			'adapter-sdk-runtime-test',
		);
		expect(isCompiledQuery(query)).toBe(true);
		expect(() => assertCompiledQuery(query)).not.toThrow();
		expect(Object.getOwnPropertySymbols(query)).toEqual([]);
	});

	it('rebuildCompiledQuery preserves columnMetadata identity and contents', () => {
		const rebuiltQuery = rebuildCompiledQuery(fromProjection, {
			sql: 'select id from users where id = $1',
			parameters: [1n],
		});

		expect(rebuiltQuery.columnMetadata).toBe(metadata);
		expect(rebuiltQuery.columnMetadata?.get('id')).toEqual({
			table: 'users',
			column: 'id',
			js: 'bigint',
		});
	});

	it('freezes compiled query objects and parameter arrays before branding', () => {
		const sourceParams: unknown[] = [1n];
		const queries = [
			compiledQueryFromProjection({
				sql: 'select id from users where id = $1',
				parameters: sourceParams,
				columnMetadata: metadata,
			}),
			projectionlessCompiledQuery(
				{ sql: 'select 1 where $1 = $1', parameters: sourceParams },
				'adapter-sdk-freeze-test',
			),
			rebuildCompiledQuery(fromProjection, {
				sql: 'select id from users where id = $1',
				parameters: sourceParams,
			}),
		];

		sourceParams.push(2n);

		for (const query of queries) {
			expect(Object.isFrozen(query)).toBe(true);
			expect(Object.isFrozen(query.parameters)).toBe(true);
			expect(query.parameters).toEqual([1n]);
			expect(isCompiledQuery(query)).toBe(true);

			const mutable = query as unknown as {
				sql: string;
				parameters: unknown[];
			};
			expect(() => {
				mutable.sql = 'select 2';
			}).toThrow(TypeError);
			expect(() => {
				mutable.parameters.push(2n);
			}).toThrow(TypeError);
		}
	});
});
