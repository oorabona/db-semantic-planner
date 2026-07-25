/**
 * DDL Security Tests
 *
 * Covers SEC-* fixes applied to the DDL generation and migration paths:
 *   SEC-001: formatDefaultValue — sql escape hatch injection
 *   SEC-002: generateCreatePolicy — USING/WITH CHECK injection
 *   SEC-003: mapColumnType — originalDbType injection (type-mapping)
 *   SEC-004: quoteIdentifier — missing validateIdentifier call
 *   SEC-005: validateExtensionName — extension name injection (generateDDL path)
 *   SEC-005-migration: changeToUpSQL / changeToDownSQL — extension name injection (migration path, M-1)
 *   SEC-006: generateConstraintsPhase — check constraint expression injection (generateDDL path)
 *   SEC-006-migration: upAddCheckConstraint / changeToDownSQL — check constraint expression injection (migration path, F-001)
 *   SEC-007: formatDefaultValue — typeof guard on { sql } escape hatch
 */

import { describe, expect, it } from 'vitest';
import { generateDownSQL, generateMigrationSQL } from '../ddl/migration-sql.js';
import { generateCommentsPhase } from '../ddl/phases/comments.js';
import { generateEnumTypesPhase } from '../ddl/phases/enum-types.js';
import {
	formatSqlDefault,
	quoteCollation,
	quoteExtensionName,
	quoteRoleName,
} from '../ddl/phases/utils.js';
import type { SchemaChange, SchemaDiff } from '../ddl/schema-diff.js';
import { identityNaming } from '../naming-plugin.js';
import {
	InvalidIdentifierError,
	validateCollationName,
	validateDbTypeName,
	validateExtensionName,
	validateSqlExpression,
} from '../validate.js';

function forgedNonString(): string {
	return {
		toString: () => 'safe',
		replace: () => "injected'; DROP TABLE users; --",
	} as unknown as string;
}

// ---------------------------------------------------------------------------
// Shared validate.ts helpers
// ---------------------------------------------------------------------------

describe('FIX-12: non-string type-confusion guards for SQL-splice helpers', () => {
	function emptySummary(): SchemaDiff['summary'] {
		return {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		};
	}

	function makeCreateEnumDiff(value: string): SchemaDiff {
		return {
			changes: [
				{
					kind: 'create_enum',
					table: '',
					destructive: false,
					details: '',
					meta: { enum: { name: 'status', values: [value] } },
				},
			],
			hasDestructive: false,
			summary: emptySummary(),
		};
	}

	function makeAlterEnumAddValueDiff(value: string): SchemaDiff {
		return {
			changes: [
				{
					kind: 'alter_enum_add_value',
					table: '',
					destructive: false,
					details: '',
					meta: { enum: { name: 'status', values: ['active'] }, value },
				},
			],
			hasDestructive: false,
			summary: emptySummary(),
		};
	}

	function makeAddCommentDiff(comment: string): SchemaDiff {
		return {
			changes: [
				{
					kind: 'add_comment',
					table: 'users',
					destructive: false,
					details: '',
					meta: { target: 'table', comment },
				},
			],
			hasDestructive: false,
			summary: emptySummary(),
		};
	}

	it('validateSqlExpression rejects a forged non-string object', () => {
		expect(() =>
			validateSqlExpression(forgedNonString(), 'raw index expression'),
		).toThrow(
			/Unsafe SQL expression in raw index expression: expected a string, received object/,
		);
	});

	it('extension and collation validators reject a forged non-string object', () => {
		expect(() => validateExtensionName(forgedNonString())).toThrow(
			/Invalid extension identifier: expected a string, received object/,
		);
		expect(() => validateCollationName(forgedNonString())).toThrow(
			/Invalid collation identifier: expected a string, received object/,
		);
	});

	it('extension, collation, and role quote helpers reject a forged non-string object', () => {
		expect(() => quoteExtensionName(forgedNonString())).toThrow(
			/Invalid extension identifier: expected a string, received object/,
		);
		expect(() => quoteCollation(forgedNonString())).toThrow(
			/Invalid collation identifier: expected a string, received object/,
		);
		expect(() => quoteRoleName(forgedNonString())).toThrow(
			/quoteRoleName: role name: expected a string, received object/,
		);
	});

	it('validateDbTypeName rejects a forged non-string object', () => {
		expect(() => validateDbTypeName(forgedNonString())).toThrow(
			/Unsafe database type name: expected a string, received object/,
		);
	});

	it('migration enum literal escaping rejects a forged non-string value', () => {
		expect(() =>
			generateMigrationSQL(makeCreateEnumDiff(forgedNonString())),
		).toThrow(/enum value must be a primitive string, got object/);
		expect(() =>
			generateMigrationSQL(makeAlterEnumAddValueDiff(forgedNonString())),
		).toThrow(/enum added value must be a primitive string, got object/);
	});

	it('DDL enum phase literal escaping rejects a forged non-string value', () => {
		expect(() =>
			generateEnumTypesPhase({
				schema: {
					enums: new Map([
						['status', { name: 'status', values: [forgedNonString()] }],
					]),
				},
				schemaName: undefined,
				naming: identityNaming,
				caps: { supportsDDLEnumTypes: true, supportsDDL: true },
			} as any),
		).toThrow(/Invalid enum value: expected a string, received object/);
	});

	it('comment literal escaping rejects a forged non-string value', () => {
		expect(() =>
			generateMigrationSQL(makeAddCommentDiff(forgedNonString())),
		).toThrow(/migration comment: expected a string, received object/);
		expect(() =>
			generateCommentsPhase({
				tables: [{ name: 'users', columns: [], comment: forgedNonString() }],
				schemaName: undefined,
				naming: identityNaming,
				caps: { supportsDDLComments: true, supportsDDL: true },
			} as any),
		).toThrow(/table comment: expected a string, received object/);
	});
});

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

	// M-1 regression: block-comment closer must be rejected (defense-in-depth —
	// a partial payload that closes an enclosing comment could inject SQL).
	it('rejects expressions containing a block-comment closer (*/)', () => {
		expect(() => validateSqlExpression('1 */ 2', 'test')).toThrow(
			/Unsafe SQL expression/,
		);
	});

	// Positive regression: confirm existing vectors still rejected after regex change.
	it('still rejects semicolons after regex change (positive regression)', () => {
		expect(() => validateSqlExpression('now(); DROP TABLE t', 'test')).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('still rejects block-comment opener (/\\*) after regex change (positive regression)', () => {
		expect(() => validateSqlExpression('now() /* comment', 'test')).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('still rejects line-comment (--) after regex change (positive regression)', () => {
		expect(() => validateSqlExpression('val -- injected', 'test')).toThrow(
			/Unsafe SQL expression/,
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
// SEC-004 (phases): quoteIdent in phase modules validates before quoting
// Regression guard: A1 refactor introduced local quoteId() helpers in 5 phase
// modules that skipped validateIdentifier(). This test block ensures each
// affected path now throws on invalid identifiers.
// ---------------------------------------------------------------------------

describe('SEC-004 (phases): identifier validation in DDL phase modules', () => {
	// Caps that enable all DDL features including the ones with specific
	// capability flag names used by each phase.
	function buildFullCaps(): any {
		return {
			...buildCaps(),
			// enum-types phase checks supportsDDLEnumTypes (not supportsDDLEnums)
			supportsDDLEnumTypes: true,
		};
	}

	it('enum-types phase: rejects enum name with invalid characters', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		// enumDef.name is what the phase passes to quoteId — must be in the value
		const enumDef = { name: 'bad"enum', values: ['a', 'b'] };
		const model: any = {
			tables: new Map(),
			enums: new Map([['bad_enum', enumDef]]),
			sequences: new Map(),
			extensions: [],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildFullCaps() }),
		).toThrow(/Invalid.*identifier/);
	});

	it('sequences phase: rejects sequence name with invalid characters', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		// seq.name is what the phase passes to quoteId — must be in the value object
		const seqDef = { name: 'bad;seq', start: 1, increment: 1 };
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map([['seq1', seqDef]]),
			extensions: [],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildFullCaps() }),
		).toThrow(/Invalid.*identifier/);
	});

	it('comments phase: rejects table name with invalid characters', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		// table.name reaches qualifyTable() in the comments phase when table.comment is set
		const table: any = {
			name: 'bad"table',
			columns: [{ name: 'id', type: 'integer' }],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [],
			policies: [],
			rlsEnabled: false,
			comment: 'has a comment',
		};
		const model: any = {
			tables: new Map([['t1', table]]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: () => table,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildFullCaps() }),
		).toThrow(/Invalid.*identifier/);
	});

	it('rls phase: rejects table name with control character reaching RLS', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		// table.name reaches qualifyTable() in the rls phase when rlsEnabled=true
		const table: any = {
			name: 'bad\x00table',
			columns: [{ name: 'id', type: 'integer' }],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [],
			policies: [
				{ name: 'ok_policy', command: 'ALL', permissive: true, roles: [] },
			],
			rlsEnabled: true,
		};
		const model: any = {
			tables: new Map([['t1', table]]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: () => table,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildFullCaps() }),
		).toThrow(/Invalid.*identifier/);
	});

	it('constraints phase: rejects table name with invalid characters', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		// table.name reaches qualifyTable() in the constraints phase via generateAlterTableAddFK
		const refTable: any = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer' }],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [],
			policies: [],
			rlsEnabled: false,
		};
		const table: any = {
			name: 'bad;table',
			columns: [{ name: 'user_id', type: 'integer' }],
			primaryKey: ['user_id'],
			foreignKeys: [
				{
					columns: ['user_id'],
					referencedTable: 'users',
					referencedColumns: ['id'],
					onDelete: 'CASCADE',
				},
			],
			indexes: [],
			policies: [],
			rlsEnabled: false,
		};
		const model: any = {
			tables: new Map([
				['users', refTable],
				['t2', table],
			]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: (n: string) => model.tables.get(n),
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildFullCaps() }),
		).toThrow(/Invalid.*identifier/);
	});
});

// ---------------------------------------------------------------------------
// SEC-005: Extension names must be validated before DDL emission
// ---------------------------------------------------------------------------

describe('SEC-005: extension name injection via generateExtensionsPhase', () => {
	// Extension names are validated by validateExtensionName(), NOT validateIdentifier().
	// This allows hyphenated names like uuid-ossp and postgis-raster while still
	// blocking injection vectors (quotes, semicolons, comments, whitespace, control chars).

	// ------------------------------------------------------------------
	// Unit tests on validateExtensionName() directly
	// ------------------------------------------------------------------

	it('validateExtensionName: allows uuid-ossp (hyphen)', () => {
		expect(() => validateExtensionName('uuid-ossp')).not.toThrow();
	});

	it('validateExtensionName: allows postgis-raster (hyphen)', () => {
		expect(() => validateExtensionName('postgis-raster')).not.toThrow();
	});

	it('validateExtensionName: allows postgis (plain)', () => {
		expect(() => validateExtensionName('postgis')).not.toThrow();
	});

	it('validateExtensionName: allows pg_trgm (underscore)', () => {
		expect(() => validateExtensionName('pg_trgm')).not.toThrow();
	});

	it('validateExtensionName: allows vector (plain)', () => {
		expect(() => validateExtensionName('vector')).not.toThrow();
	});

	it('validateExtensionName: rejects name with double-quote', () => {
		expect(() => validateExtensionName('bad"ext')).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName('bad"ext')).toThrow(/double-quote/);
	});

	it('validateExtensionName: rejects name with semicolon', () => {
		expect(() => validateExtensionName('evil; DROP')).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName('evil; DROP')).toThrow(/semicolon/);
	});

	it('validateExtensionName: rejects name with NUL byte', () => {
		expect(() => validateExtensionName('ext\x00name')).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName('ext\x00name')).toThrow(
			/control characters/,
		);
	});

	it('validateExtensionName: rejects name with newline', () => {
		expect(() => validateExtensionName('ext\nnewline')).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName('ext\nnewline')).toThrow(
			/control characters/,
		);
	});

	it('validateExtensionName: rejects name with line-comment marker', () => {
		expect(() => validateExtensionName('ext--comment')).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName('ext--comment')).toThrow(/line-comment/);
	});

	it('validateExtensionName: rejects name with whitespace', () => {
		expect(() => validateExtensionName('bad ext')).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName('bad ext')).toThrow(/whitespace/);
	});

	it('validateExtensionName: rejects empty string', () => {
		expect(() => validateExtensionName('')).toThrow(InvalidIdentifierError);
		expect(() => validateExtensionName('')).toThrow(/cannot be empty/);
	});

	it('validateExtensionName: rejects name exceeding 63 characters (NAMEDATALEN limit)', () => {
		const longName = 'a'.repeat(64);
		expect(() => validateExtensionName(longName)).toThrow(
			InvalidIdentifierError,
		);
		expect(() => validateExtensionName(longName)).toThrow(
			/exceeds maximum length of 63/,
		);
	});

	it('validateExtensionName: allows dotted extension name (foo.bar)', () => {
		expect(() => validateExtensionName('foo.bar')).not.toThrow();
	});

	// ------------------------------------------------------------------
	// Integration tests via generateDDL
	// ------------------------------------------------------------------

	it('rejects extension name containing double-quote (identifier injection)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['pgcrypto"; DROP TABLE users --'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/Invalid.*identifier/);
	});

	it('rejects extension name containing space and injection payload', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['bad ext; DROP TABLE users'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/Invalid.*identifier/);
	});

	it('allows legitimate extension name: pgcrypto', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['pgcrypto'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it('allows legitimate extension name: pg_trgm', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['pg_trgm'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it('allows legitimate extension name: vector', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['vector'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it('allows legitimate extension name: uuid-ossp (hyphenated)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['uuid-ossp'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it('produces correct DDL for uuid-ossp: CREATE EXTENSION IF NOT EXISTS "uuid-ossp"', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['uuid-ossp'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		const ddl = generateDDL(model, { dialectCapabilities: buildCaps() });
		expect(ddl).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
	});

	it('allows legitimate extension name: postgis-raster (hyphenated)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model: any = {
			tables: new Map(),
			enums: new Map(),
			sequences: new Map(),
			extensions: ['postgis-raster'],
			getTable: () => undefined,
			getRelation: () => undefined,
		};
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// SEC-005-migration: Extension name injection via changeToUpSQL / changeToDownSQL
// ---------------------------------------------------------------------------

describe('SEC-005-migration: extension name injection via migration path (changeToUpSQL / changeToDownSQL)', () => {
	// Covers M-1: the migration SQL path (generateMigrationSQL / generateDownSQL)
	// must validate extension names before emitting CREATE/DROP EXTENSION statements.

	function makeCreateExtensionDiff(extension: string): SchemaDiff {
		const change: SchemaChange = {
			kind: 'create_extension',
			table: '',
			destructive: false,
			details: '',
			meta: { extension },
		};
		return {
			changes: [change],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		};
	}

	function makeDropExtensionDiff(extension: string): SchemaDiff {
		const change: SchemaChange = {
			kind: 'drop_extension',
			table: '',
			destructive: true,
			details: '',
			meta: { extension },
		};
		return {
			changes: [change],
			hasDestructive: true,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		};
	}

	// -- UP: create_extension ------------------------------------------------

	it('rejects malicious extension name in create_extension (UP)', () => {
		expect(() =>
			generateMigrationSQL(
				makeCreateExtensionDiff('pgcrypto"; DROP TABLE users --'),
				{},
			),
		).toThrow(InvalidIdentifierError);
	});

	it('rejects extension name with semicolon in create_extension (UP)', () => {
		expect(() =>
			generateMigrationSQL(makeCreateExtensionDiff('evil; DROP'), {}),
		).toThrow(InvalidIdentifierError);
	});

	it('allows legitimate extension name in create_extension (UP): uuid-ossp', () => {
		const sql = generateMigrationSQL(makeCreateExtensionDiff('uuid-ossp'), {});
		expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
	});

	it('allows legitimate extension name in create_extension (UP): pgcrypto', () => {
		const sql = generateMigrationSQL(makeCreateExtensionDiff('pgcrypto'), {});
		expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
	});

	// -- UP: drop_extension --------------------------------------------------

	it('rejects malicious extension name in drop_extension (UP)', () => {
		expect(() =>
			generateMigrationSQL(
				makeDropExtensionDiff('pgcrypto"; DROP TABLE users --'),
				{},
			),
		).toThrow(InvalidIdentifierError);
	});

	it('allows legitimate extension name in drop_extension (UP): pgcrypto', () => {
		const sql = generateMigrationSQL(makeDropExtensionDiff('pgcrypto'), {});
		expect(sql).toContain('DROP EXTENSION IF EXISTS "pgcrypto" CASCADE;');
	});

	// -- DOWN: create_extension (reversal = DROP) ----------------------------

	it('rejects malicious extension name in create_extension DOWN (reversal = DROP)', () => {
		expect(() =>
			generateDownSQL(
				makeCreateExtensionDiff('pgcrypto"; DROP TABLE users --'),
			),
		).toThrow(InvalidIdentifierError);
	});

	it('allows legitimate extension name in create_extension DOWN: uuid-ossp', () => {
		const sql = generateDownSQL(makeCreateExtensionDiff('uuid-ossp'));
		expect(sql).toContain('DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;');
	});

	// -- DOWN: drop_extension (reversal = CREATE) ----------------------------

	it('rejects malicious extension name in drop_extension DOWN (reversal = CREATE)', () => {
		expect(() =>
			generateDownSQL(makeDropExtensionDiff('pgcrypto"; DROP TABLE users --')),
		).toThrow(InvalidIdentifierError);
	});

	it('allows legitimate extension name in drop_extension DOWN: pgcrypto', () => {
		const sql = generateDownSQL(makeDropExtensionDiff('pgcrypto'));
		expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
	});

	// -- Empty-string regression (M-1 / M-2): empty '' must reach validateExtensionName ---

	it('rejects empty string extension name in create_extension (UP) — throws via validateExtensionName', () => {
		// Previously: truthy check `ext ?` would short-circuit on '' → undefined silently.
		// Now: nullish check `ext == null` lets '' fall through to quoteExtensionName()
		// which calls validateExtensionName() and throws InvalidIdentifierError.
		expect(() => generateMigrationSQL(makeCreateExtensionDiff(''), {})).toThrow(
			InvalidIdentifierError,
		);
		expect(() => generateMigrationSQL(makeCreateExtensionDiff(''), {})).toThrow(
			/cannot be empty/,
		);
	});

	it('rejects empty string extension name in drop_extension (UP) — throws via validateExtensionName', () => {
		expect(() => generateMigrationSQL(makeDropExtensionDiff(''), {})).toThrow(
			InvalidIdentifierError,
		);
		expect(() => generateMigrationSQL(makeDropExtensionDiff(''), {})).toThrow(
			/cannot be empty/,
		);
	});

	it('rejects empty string extension name in create_extension DOWN (reversal = DROP) — throws via validateExtensionName', () => {
		expect(() => generateDownSQL(makeCreateExtensionDiff(''))).toThrow(
			InvalidIdentifierError,
		);
		expect(() => generateDownSQL(makeCreateExtensionDiff(''))).toThrow(
			/cannot be empty/,
		);
	});

	it('rejects empty string extension name in drop_extension DOWN (reversal = CREATE) — throws via validateExtensionName', () => {
		expect(() => generateDownSQL(makeDropExtensionDiff(''))).toThrow(
			InvalidIdentifierError,
		);
		expect(() => generateDownSQL(makeDropExtensionDiff(''))).toThrow(
			/cannot be empty/,
		);
	});
});

// ---------------------------------------------------------------------------
// SEC-006: Check constraint expressions must be validated before DDL emission
// ---------------------------------------------------------------------------

describe('SEC-006: check constraint expression injection via generateConstraintsPhase', () => {
	function buildModelWithCheck(expression: string): any {
		const table: any = {
			name: 'orders',
			columns: [
				{ name: 'id', type: 'integer' },
				{ name: 'amount', type: 'numeric' },
			],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [],
			policies: [],
			rlsEnabled: false,
			checkConstraints: [{ name: 'chk_amount', expression }],
		};
		return {
			tables: new Map([['orders', table]]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: (n: string) => (n === 'orders' ? table : undefined),
			getRelation: () => undefined,
		};
	}

	it('rejects check expression containing semicolon (statement injection)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithCheck('CHECK (1 = 1); DROP TABLE users --');
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects check expression containing line-comment marker (--)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithCheck('CHECK (amount > 0) -- bypass');
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects check expression containing block-comment opener (/*)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithCheck('CHECK (amount > 0) /* injected');
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows legitimate check expression: CHECK (amount > 0)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithCheck('CHECK (amount > 0)');
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it("allows legitimate check expression: CHECK (status IN ('a','b'))", async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithCheck("CHECK (status IN ('a','b'))");
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});

	it('allows legitimate check expression: CHECK (amount >= 0 AND amount <= 1000)', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithCheck('CHECK (amount >= 0 AND amount <= 1000)');
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// SEC-007: {sql} escape hatch typeof guard
// F-S1: formatDefaultValue (ddl-generator.ts) and normalizeDefault (schema-diff.ts)
// ---------------------------------------------------------------------------

describe('SEC-007: typeof guard on { sql } escape hatch', () => {
	it('formatDefaultValue: throws when { sql } value is a number', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: 42 });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/expected string, got number/);
	});

	it('formatDefaultValue: throws when { sql } value is null', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: null });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/expected string, got object/);
	});

	it('formatDefaultValue: throws when { sql } value is an object', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');
		const model = buildModelWithDefault({ sql: { nested: 'bad' } });
		expect(() =>
			generateDDL(model, { dialectCapabilities: buildCaps() }),
		).toThrow(/expected string, got object/);
	});

	it('normalizeDefault: throws when { sql } value is a number', async () => {
		const { compareSchemata } = await import('../ddl/schema-diff.js');
		const colWithBadDefault = {
			name: 'val',
			type: 'integer',
			default: { sql: 42 },
		};
		const model: any = {
			tables: new Map([
				[
					'orders',
					{
						name: 'orders',
						columns: [colWithBadDefault],
						primaryKey: [],
						foreignKeys: [],
						indexes: [],
						policies: [],
						rlsEnabled: false,
					},
				],
			]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: (n: string) => model.tables.get(n),
			getRelation: () => undefined,
		};
		expect(() => compareSchemata(model, model, {})).toThrow(
			/expected string, got number/,
		);
	});

	it('normalizeDefault: throws when { sql } value is null', async () => {
		const { compareSchemata } = await import('../ddl/schema-diff.js');
		const colWithBadDefault = {
			name: 'val',
			type: 'integer',
			default: { sql: null },
		};
		const model: any = {
			tables: new Map([
				[
					'orders',
					{
						name: 'orders',
						columns: [colWithBadDefault],
						primaryKey: [],
						foreignKeys: [],
						indexes: [],
						policies: [],
						rlsEnabled: false,
					},
				],
			]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: (n: string) => model.tables.get(n),
			getRelation: () => undefined,
		};
		expect(() => compareSchemata(model, model, {})).toThrow(
			/expected string, got object/,
		);
	});

	it('normalizeDefault: throws when { sql } value is a plain object', async () => {
		const { compareSchemata } = await import('../ddl/schema-diff.js');
		const colWithBadDefault = {
			name: 'val',
			type: 'integer',
			default: { sql: { nested: 'oops' } },
		};
		const model: any = {
			tables: new Map([
				[
					'orders',
					{
						name: 'orders',
						columns: [colWithBadDefault],
						primaryKey: [],
						foreignKeys: [],
						indexes: [],
						policies: [],
						rlsEnabled: false,
					},
				],
			]),
			enums: new Map(),
			sequences: new Map(),
			extensions: [],
			getTable: (n: string) => model.tables.get(n),
			getRelation: () => undefined,
		};
		expect(() => compareSchemata(model, model, {})).toThrow(
			/expected string, got object/,
		);
	});
});

// ---------------------------------------------------------------------------
// SEC-006-migration: Check constraint expressions on the MIGRATION path
// Regression guard: upAddCheckConstraint (UP) and drop_check_constraint in
// changeToDownSQL (DOWN) were missing validateSqlExpression calls fixed in F-001.
// ---------------------------------------------------------------------------

describe('SEC-006-migration: check constraint injection via migration-sql (UP path)', () => {
	function makeCheckConstraintDiff(expression: string): SchemaDiff {
		const change: SchemaChange = {
			kind: 'add_check_constraint',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { check: { name: 'chk_amount', expression } },
		};
		return {
			changes: [change],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 1, dropped: 0, altered: 0 },
			},
		};
	}

	it('rejects check expression containing semicolon (statement injection)', () => {
		expect(() =>
			generateMigrationSQL(
				makeCheckConstraintDiff('amount > 0; DROP TABLE orders --'),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects check expression containing line-comment marker (--)', () => {
		expect(() =>
			generateMigrationSQL(makeCheckConstraintDiff('amount > 0 -- bypass')),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects check expression containing block-comment opener (/*)', () => {
		expect(() =>
			generateMigrationSQL(makeCheckConstraintDiff('amount > 0 /* injected')),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows legitimate check expression: CHECK (amount > 0)', () => {
		expect(() =>
			generateMigrationSQL(makeCheckConstraintDiff('CHECK (amount > 0)')),
		).not.toThrow();
	});

	it("allows legitimate check expression: CHECK (status IN ('a','b'))", () => {
		expect(() =>
			generateMigrationSQL(
				makeCheckConstraintDiff("CHECK (status IN ('a','b'))"),
			),
		).not.toThrow();
	});
});

describe('SEC-006-migration: check constraint injection via migration-sql (DOWN path)', () => {
	function makeDropCheckConstraintDiff(expression: string): SchemaDiff {
		const change: SchemaChange = {
			kind: 'drop_check_constraint',
			table: 'orders',
			destructive: true,
			details: '',
			meta: { check: { name: 'chk_amount', expression } },
		};
		return {
			changes: [change],
			hasDestructive: true,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 1, altered: 0 },
			},
		};
	}

	it('rejects check expression containing semicolon (statement injection)', () => {
		expect(() =>
			generateDownSQL(
				makeDropCheckConstraintDiff('amount > 0; DROP TABLE orders --'),
			),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects check expression containing line-comment marker (--)', () => {
		expect(() =>
			generateDownSQL(makeDropCheckConstraintDiff('amount > 0 -- bypass')),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects check expression containing block-comment opener (/*)', () => {
		expect(() =>
			generateDownSQL(makeDropCheckConstraintDiff('amount > 0 /* injected')),
		).toThrow(/Unsafe SQL expression/);
	});

	it('allows legitimate check expression: CHECK (amount > 0)', () => {
		expect(() =>
			generateDownSQL(makeDropCheckConstraintDiff('CHECK (amount > 0)')),
		).not.toThrow();
	});

	it("allows legitimate check expression: CHECK (status IN ('a','b'))", () => {
		expect(() =>
			generateDownSQL(
				makeDropCheckConstraintDiff("CHECK (status IN ('a','b'))"),
			),
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

// ---------------------------------------------------------------------------
// M-1: quoteRoleName — NUL bytes, control chars, NAMEDATALEN (63 bytes)
// ---------------------------------------------------------------------------

describe('M-1 quoteRoleName — defense-in-depth (NUL, control chars, NAMEDATALEN)', () => {
	it('accepts a normal role name', () => {
		expect(quoteRoleName('app admin')).toBe('"app admin"');
	});

	it('rejects a role name containing a NUL byte', () => {
		expect(() => quoteRoleName('app\x00admin')).toThrow(/NUL byte/);
	});

	it('rejects a role name containing a control character (0x01)', () => {
		expect(() => quoteRoleName('app\x01admin')).toThrow(/control characters/);
	});

	it('rejects a role name containing DEL (0x7F)', () => {
		expect(() => quoteRoleName('role\x7f')).toThrow(/control characters/);
	});

	it('rejects a role name exceeding 63 bytes (NAMEDATALEN)', () => {
		// 64 ASCII chars — each is 1 byte in UTF-8
		const longName = 'a'.repeat(64);
		expect(() => quoteRoleName(longName)).toThrow(/NAMEDATALEN/);
	});

	it('accepts a role name of exactly 63 bytes', () => {
		const exactName = 'a'.repeat(63);
		expect(() => quoteRoleName(exactName)).not.toThrow();
	});

	it('counts bytes not chars: rejects multibyte role name > 63 bytes', () => {
		// Each '€' is 3 bytes in UTF-8; 22 × 3 = 66 bytes > 63
		const multibyteOverlimit = '€'.repeat(22);
		expect(() => quoteRoleName(multibyteOverlimit)).toThrow(/NAMEDATALEN/);
	});

	it('counts bytes not chars: accepts multibyte role name ≤ 63 bytes', () => {
		// 21 × 3 = 63 bytes exactly
		const multibyteExact = '€'.repeat(21);
		expect(() => quoteRoleName(multibyteExact)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// M-2: upCreateEnum — enum label NUL/control-char injection (migration-sql path)
// ---------------------------------------------------------------------------

describe('M-2 migration-sql upCreateEnum — enum label injection', () => {
	function makeCreateEnumDiff(values: string[]): SchemaDiff {
		return {
			changes: [
				{
					kind: 'create_enum',
					table: '',
					destructive: false,
					details: '',
					meta: {
						enum: { name: 'status', values },
					},
				},
			],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		};
	}

	it('accepts valid enum values', () => {
		expect(() =>
			generateMigrationSQL(
				makeCreateEnumDiff(['active', 'inactive', 'pending']),
			),
		).not.toThrow();
	});

	it('rejects enum value containing NUL byte', () => {
		expect(() =>
			generateMigrationSQL(makeCreateEnumDiff(['active', 'bad\x00value'])),
		).toThrow(/NUL byte/);
	});

	it('rejects enum value containing control character (0x01)', () => {
		expect(() =>
			generateMigrationSQL(makeCreateEnumDiff(['bad\x01value'])),
		).toThrow(/control characters/);
	});
});

// ---------------------------------------------------------------------------
// M-3: generateEnumTypesPhase — enum label NUL/control-char injection (DDL phase path)
// ---------------------------------------------------------------------------

describe('M-3 generateEnumTypesPhase — enum label injection', () => {
	function makePhaseCtx(values: string[]): any {
		return {
			schema: {
				enums: new Map([['status', { name: 'status', values }]]),
			},
			schemaName: undefined,
			naming: identityNaming,
			caps: {
				supportsDDLEnumTypes: true,
				supportsDDL: true,
			},
		};
	}

	it('accepts valid enum values', () => {
		expect(() =>
			generateEnumTypesPhase(makePhaseCtx(['active', 'inactive', 'pending'])),
		).not.toThrow();
	});

	it('rejects enum value containing NUL byte', () => {
		expect(() =>
			generateEnumTypesPhase(makePhaseCtx(['active', 'bad\x00value'])),
		).toThrow(/NUL byte/);
	});

	it('rejects enum value containing control character (0x01)', () => {
		expect(() =>
			generateEnumTypesPhase(makePhaseCtx(['bad\x01value'])),
		).toThrow(/control characters/);
	});

	it('generates correct SQL for valid enum (sanity check)', () => {
		const result = generateEnumTypesPhase(makePhaseCtx(['active', 'pending']));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatch(
			/CREATE TYPE "status" AS ENUM \('active', 'pending'\)/,
		);
	});
});

// ---------------------------------------------------------------------------
// M-5: formatSqlDefault — bare function-call path injection defense
// ---------------------------------------------------------------------------

describe('formatSqlDefault — bare function-call path injection (M-5)', () => {
	// Positive: legitimate PG default function calls must pass through unchanged
	it('allows now()', () => {
		expect(formatSqlDefault('now()')).toBe('now()');
	});

	it('allows CURRENT_TIMESTAMP()', () => {
		expect(formatSqlDefault('CURRENT_TIMESTAMP()')).toBe('CURRENT_TIMESTAMP()');
	});

	it('allows uuid_generate_v4()', () => {
		expect(formatSqlDefault('uuid_generate_v4()')).toBe('uuid_generate_v4()');
	});

	// Negative: injection attempts that end with `()` and thus trigger the
	// bare-function-call branch must be rejected by validateSqlExpression.
	it('throws on semicolon injection in bare function call (ends with ())', () => {
		// Crafted to end with () so the endsWith('()') branch fires
		expect(() => formatSqlDefault('now(); DROP TABLE users; --x()')).toThrow(
			/forbidden characters/,
		);
	});

	it('throws on line-comment injection in bare function call (ends with ())', () => {
		expect(() => formatSqlDefault('now()-- injected()')).toThrow(
			/forbidden characters/,
		);
	});

	it('throws on block-comment injection in bare function call (ends with ())', () => {
		expect(() => formatSqlDefault('now()/*injected*/()')).toThrow(
			/forbidden characters/,
		);
	});
});
