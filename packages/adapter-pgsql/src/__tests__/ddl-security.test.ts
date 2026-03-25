/**
 * DDL Security Tests
 *
 * Covers the 5 SEC-* fixes applied to the DDL generation path:
 *   SEC-001: formatDefaultValue — sql escape hatch injection
 *   SEC-002: generateCreatePolicy — USING/WITH CHECK injection
 *   SEC-003: mapColumnType — originalDbType injection (type-mapping)
 *   SEC-004: quoteIdentifier — missing validateIdentifier call
 *   SEC-005: resolveColumnPgType — originalDbType injection (where/utils)
 */

import { describe, expect, it } from 'vitest';
import { validateDbTypeName, validateSqlExpression } from '../validate.js';

// ---------------------------------------------------------------------------
// Shared validate.ts helpers
// ---------------------------------------------------------------------------

describe('validateSqlExpression', () => {
	it('rejects expressions containing a semicolon', () => {
		expect(() =>
			validateSqlExpression('now(); DROP TABLE users', 'test'),
		).toThrow(/forbidden characters/);
	});

	it('rejects expressions containing a line-comment marker (--)', () => {
		expect(() => validateSqlExpression("'value' -- injected", 'test')).toThrow(
			/forbidden characters/,
		);
	});

	it('rejects expressions containing a block-comment opener (/*)', () => {
		expect(() => validateSqlExpression('now() /* comment', 'test')).toThrow(
			/forbidden characters/,
		);
	});

	it('includes the context label in the error message', () => {
		expect(() => validateSqlExpression('bad;', 'column default')).toThrow(
			/column default/,
		);
	});

	it('allows safe expression: now()', () => {
		expect(() => validateSqlExpression('now()', 'test')).not.toThrow();
	});

	it('allows safe expression: gen_random_uuid()', () => {
		expect(() =>
			validateSqlExpression('gen_random_uuid()', 'test'),
		).not.toThrow();
	});

	it('allows safe expression: CURRENT_TIMESTAMP', () => {
		expect(() =>
			validateSqlExpression('CURRENT_TIMESTAMP', 'test'),
		).not.toThrow();
	});

	it('allows safe expression: true', () => {
		expect(() => validateSqlExpression('true', 'test')).not.toThrow();
	});

	it('allows safe expression: false', () => {
		expect(() => validateSqlExpression('false', 'test')).not.toThrow();
	});

	it('allows single-quoted string in expression (valid for defaults/policies)', () => {
		expect(() =>
			validateSqlExpression(
				"current_setting('app.tenant_id')::integer",
				'test',
			),
		).not.toThrow();
	});

	it('rejects expressions containing dollar-quoting', () => {
		const dollarQuoted = '\x24\x24injected\x24\x24';
		expect(() => validateSqlExpression(dollarQuoted, 'test')).toThrow(
			/forbidden characters/,
		);
	});

	it('rejects expressions containing a backslash (escape sequence)', () => {
		expect(() => validateSqlExpression('value\\n', 'test')).toThrow(
			/forbidden characters/,
		);
	});
});

describe('validateDbTypeName', () => {
	it('rejects injection via semicolon after type name', () => {
		expect(() => validateDbTypeName('integer; DROP TABLE')).toThrow(
			/Unsafe database type name/,
		);
	});

	it('rejects injection via closing paren + statement', () => {
		expect(() => validateDbTypeName('text) NOT NULL; --')).toThrow(
			/Unsafe database type name/,
		);
	});

	it('rejects type names starting with a digit', () => {
		expect(() => validateDbTypeName('1nvalid')).toThrow(
			/Unsafe database type name/,
		);
	});

	it('allows: integer', () => {
		expect(validateDbTypeName('integer')).toBe('integer');
	});

	it('allows: VARCHAR(255)', () => {
		expect(validateDbTypeName('VARCHAR(255)')).toBe('VARCHAR(255)');
	});

	it('allows: NUMERIC(10,2)', () => {
		expect(validateDbTypeName('NUMERIC(10,2)')).toBe('NUMERIC(10,2)');
	});

	it('allows: integer[]', () => {
		expect(validateDbTypeName('integer[]')).toBe('integer[]');
	});

	it('allows: timestamp with time zone (multi-word PostgreSQL type)', () => {
		expect(validateDbTypeName('timestamp with time zone')).toBe(
			'timestamp with time zone',
		);
	});

	it('allows: CHARACTER VARYING(100)', () => {
		expect(validateDbTypeName('CHARACTER VARYING(100)')).toBe(
			'CHARACTER VARYING(100)',
		);
	});
});

// ---------------------------------------------------------------------------
// SEC-004: quoteIdentifier validates identifiers before quoting
// ---------------------------------------------------------------------------

describe('SEC-004: quoteIdentifier (via DDL generator behaviour)', () => {
	// quoteIdentifier is not exported; test indirectly via generateCreatePolicy
	// which calls quoteIdentifier(policy.name).

	it('rejects a policy name containing invalid characters', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildMinimalModel([{ name: 'ok_policy', command: 'SELECT' }]);
		// Bypass TypeScript to inject an invalid name at runtime
		// model.tables is a Map — use .get() to access the table, then .policies[]
		(model.tables.get('users').policies[0] as Record<string, unknown>).name =
			'bad"policy';
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/invalid characters/);
	});

	it('rejects an empty identifier', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildMinimalModel([{ name: 'ok_policy', command: 'SELECT' }]);
		(model.tables.get('users').policies[0] as Record<string, unknown>).name =
			'';
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/cannot be empty/);
	});
});

// ---------------------------------------------------------------------------
// SEC-002: generateCreatePolicy rejects injection in USING/WITH CHECK
// ---------------------------------------------------------------------------

describe('SEC-002: generateCreatePolicy USING/WITH CHECK injection', () => {
	it('rejects policy.using with ; DROP TABLE', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildMinimalModel([
			{
				name: 'safe_policy',
				command: 'SELECT',
				using: 'user_id = current_user_id(); DROP TABLE users',
			},
		]);
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/forbidden characters/);
	});

	it('rejects policy.withCheck with -- comment injection', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildMinimalModel([
			{
				name: 'safe_policy',
				command: 'INSERT',
				withCheck: 'tenant_id = 1 -- bypass',
			},
		]);
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/forbidden characters/);
	});

	it('allows safe USING expression', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildMinimalModel([
			{
				name: 'tenant_isolation',
				command: 'ALL',
				using: "tenant_id = current_setting('app.tenant_id')::integer",
			},
		]);
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// SEC-001: formatDefaultValue rejects injection via { sql: ... }
// ---------------------------------------------------------------------------

describe('SEC-001: formatDefaultValue sql escape hatch injection', () => {
	it('rejects { sql: "now(); DROP TABLE" }', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: 'now(); DROP TABLE users' });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/forbidden characters/);
	});

	it('rejects { sql: "now() -- comment" }', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: 'now() -- injected' });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/forbidden characters/);
	});

	it('allows safe { sql: "now()" }', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: 'now()' });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it('allows safe { sql: "gen_random_uuid()" }', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: 'gen_random_uuid()' });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PolicySpec = {
	name: string;
	command?: string;
	using?: string;
	withCheck?: string;
};

function buildMinimalModel(policies: PolicySpec[]): any {
	const table = {
		name: 'users',
		columns: [
			{ name: 'id', type: 'integer' },
			{ name: 'name', type: 'string' },
		],
		primaryKey: ['id'],
		foreignKeys: [],
		indexes: [],
		rlsEnabled: true,
		policies: policies.map((p) => ({
			name: p.name,
			command: p.command ?? 'ALL',
			permissive: true,
			roles: [],
			using: p.using,
			withCheck: p.withCheck,
		})),
	};
	return {
		tables: new Map([['users', table]]),
		enums: new Map(),
		extensions: [],
		getTable: (n: string) => (n === 'users' ? table : undefined),
		getRelation: () => undefined,
	};
}

function buildModelWithDefault(defaultValue: unknown): any {
	const table = {
		name: 'events',
		columns: [
			{ name: 'id', type: 'integer' },
			{
				name: 'created_at',
				type: 'timestamp',
				default: defaultValue,
			},
		],
		primaryKey: ['id'],
		foreignKeys: [],
		indexes: [],
	};
	return {
		tables: new Map([['events', table]]),
		enums: new Map(),
		extensions: [],
		getTable: (n: string) => (n === 'events' ? table : undefined),
		getRelation: () => undefined,
	};
}

function buildCaps(): any {
	return {
		supportsDDL: true,
		supportsDDLRowLevelSecurity: true,
		supportsDDLEnums: true,
		supportsDDLExtensions: true,
		supportsDDLIndexes: true,
		supportsDDLForeignKeys: true,
		supportsDDLComments: true,
		supportsDDLSequences: true,
		supportsDDLCheckConstraints: true,
		supportsStreaming: false,
		supportsCursors: false,
		supportsReturning: true,
		supportsSchemas: true,
		supportsUpsert: true,
	};
}
