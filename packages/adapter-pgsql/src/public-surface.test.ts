import * as root from '@dbsp/adapter-pgsql';
import * as internal from '@dbsp/adapter-pgsql/internal';
import { describe, expect, it } from 'vitest';

// Split retired spellings so repository searches distinguish regressions from fixtures.
const renamedExports = [
	{ old: 'Pg' + 'sqlAdapter', name: 'PgAdapter', root: true, internal: false },
	{
		old: 'Pg' + 'sqlAdvisoryLockOptionsError',
		name: 'PgAdvisoryLockOptionsError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlPinnedConnectionAbortSignalError',
		name: 'PgPinnedConnectionAbortSignalError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlPreparedStatementReplayError',
		name: 'PgPreparedStatementReplayError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlRawSqlTransactionControlError',
		name: 'PgRawSqlTransactionControlError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlTransactionAbortSignalError',
		name: 'PgTransactionAbortSignalError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlTransactionAbortedCommitError',
		name: 'PgTransactionAbortedCommitError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlTransactionAbortedError',
		name: 'PgTransactionAbortedError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlTransactionOptionsError',
		name: 'PgTransactionOptionsError',
		root: true,
		internal: false,
	},
	{
		old: 'Pg' + 'sqlTransactionTimeoutError',
		name: 'PgTransactionTimeoutError',
		root: true,
		internal: false,
	},
	{
		old: 'comparePg' + 'sqlDatabaseSchema',
		name: 'comparePgDatabaseSchema',
		root: true,
		internal: true,
	},
	{
		old: 'comparePg' + 'sqlDeclaredAdoptionSchema',
		name: 'comparePgDeclaredAdoptionSchema',
		root: false,
		internal: true,
	},
	{
		old: 'createPg' + 'sqlAdapter',
		name: 'createPgAdapter',
		root: true,
		internal: false,
	},
	{
		old: 'createPg' + 'sqlCompileOnlyAdapter',
		name: 'createPgCompileOnlyAdapter',
		root: true,
		internal: false,
	},
	{
		old: 'createPg' + 'sqlDeclaredAdoptionStep',
		name: 'createPgDeclaredAdoptionStep',
		root: false,
		internal: true,
	},
	{
		old: 'createPg' + 'sqlDeclaredSequenceAdoptionStep',
		name: 'createPgDeclaredSequenceAdoptionStep',
		root: false,
		internal: true,
	},
	{
		old: 'createPg' + 'sqlGeneratedManagedStep',
		name: 'createPgGeneratedManagedStep',
		root: true,
		internal: false,
	},
	{
		old: 'derivePost' + 'gresqlCapabilitiesForVersion',
		name: 'derivePgCapabilitiesForVersion',
		root: true,
		internal: false,
	},
	{
		old: 'pg' + 'sqlDeclaredAdoptionDeclaration',
		name: 'pgDeclaredAdoptionDeclaration',
		root: false,
		internal: true,
	},
	{
		old: 'pg' + 'sqlDeclaredSequenceAdoptionDeclaration',
		name: 'pgDeclaredSequenceAdoptionDeclaration',
		root: false,
		internal: true,
	},
] as const;

describe('renamed package exports', () => {
	for (const row of renamedExports) {
		it(row.name, () => {
			for (const [entry, present] of [
				[root, row.root],
				[internal, row.internal],
			] as const) {
				expect(Object.hasOwn(entry, row.old)).toBe(false);
				expect(Object.hasOwn(entry, row.name)).toBe(present);
			}
		});
	}
});
