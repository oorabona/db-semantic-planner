/**
 * Integration tests for migration-file metadata over real DOWN SQL generation.
 */

import type {
	CheckConstraintIR,
	ColumnIR,
	IndexIR,
	PolicyIR,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateMigrationFile, parseMigrationFile } from './migration-file.js';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';

function makeDiff(changes: readonly SchemaChange[]): SchemaDiff {
	return {
		changes,
		hasDestructive: changes.some((c) => c.destructive),
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function makeColumn(overrides: Partial<ColumnIR> & { name: string }): ColumnIR {
	return {
		type: 'string',
		nullable: false,
		...overrides,
	};
}

function makeTable(name: string, columns: readonly ColumnIR[]): TableIR {
	return {
		name,
		columns,
		foreignKeys: [],
		indexes: [],
	};
}

describe('generateMigrationFile metadata from real DOWN SQL', () => {
	it('stamps irreversible drop_column rollback warning as destructive', () => {
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'drop_column',
					table: 'users',
					column: 'email',
					destructive: true,
					details: 'Drop users.email',
				},
			]),
		);
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain('ALTER TABLE "users" DROP COLUMN "email"');
		expect(content).toContain('Cannot reverse drop_column');
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false && !force).toBe(true);
	});

	it('stamps add_column rollback DROP COLUMN as destructive', () => {
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'add_column',
					table: 'users',
					column: 'email',
					destructive: false,
					details: 'Add users.email',
					meta: { column: makeColumn({ name: 'email' }) },
				},
			]),
		);
		const parsed = parseMigrationFile(content);

		expect(content).toContain('ALTER TABLE "users" ADD COLUMN "email"');
		expect(content).toContain('ALTER TABLE "users" DROP COLUMN "email"');
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false).toBe(true);
	});

	it('stamps create_table rollback DROP TABLE as destructive', () => {
		const users = makeTable('users', [
			makeColumn({ name: 'id', type: 'integer', autoIncrement: true }),
		]);
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'create_table',
					table: 'users',
					destructive: false,
					details: 'Create users',
					meta: { table: users },
				},
			]),
		);
		const parsed = parseMigrationFile(content);

		expect(content).toContain('CREATE TABLE "users"');
		expect(content).toContain('DROP TABLE IF EXISTS "users" CASCADE');
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false).toBe(true);
	});

	it.each([
		{
			name: 'create_enum',
			change: {
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create enum status',
				meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
			},
			downSql: 'DROP TYPE IF EXISTS "status" CASCADE',
		},
		{
			name: 'create_extension',
			change: {
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: 'Create extension pgcrypto',
				meta: { extension: 'pgcrypto' },
			},
			downSql: 'DROP EXTENSION IF EXISTS "pgcrypto" CASCADE',
		},
		{
			name: 'create_sequence',
			change: {
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: 'Create sequence order_seq',
				meta: { sequence: { name: 'order_seq' } },
			},
			downSql: 'DROP SEQUENCE IF EXISTS "order_seq" CASCADE',
		},
	] satisfies Array<{
		name: string;
		change: SchemaChange;
		downSql: string;
	}>)('stamps $name rollback object drop as destructive', ({
		change,
		downSql,
	}) => {
		const content = generateMigrationFile(makeDiff([change]));
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain(downSql);
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false && !force).toBe(true);
	});

	it('stamps add_comment rollback comment removal as destructive', () => {
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'add_comment',
					table: 'users',
					destructive: false,
					details: 'Add users table comment',
					meta: { target: 'table', comment: 'User accounts' },
				},
			]),
		);
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain('COMMENT ON TABLE "users" IS \'User accounts\'');
		expect(content).toContain('COMMENT ON TABLE "users" IS NULL');
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false && !force).toBe(true);
	});

	it('stamps restore-only drop_comment rollback as safe when prior text is recorded', () => {
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'drop_comment',
					table: 'users',
					destructive: false,
					details: 'Drop users table comment',
					meta: { target: 'table', comment: 'User accounts' },
				},
			]),
		);
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain('COMMENT ON TABLE "users" IS NULL');
		expect(content).toContain('COMMENT ON TABLE "users" IS \'User accounts\'');
		expect(content).toContain('-- dbsp:destructive: false');
		expect(parsed.destructive).toBe(false);
		expect(parsed.destructive !== false && !force).toBe(false);
	});

	it('stamps create_index rollback index removal as destructive', () => {
		const idx: IndexIR = {
			name: 'idx_users_email',
			columns: ['email'],
			unique: false,
		};
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'create_index',
					table: 'users',
					destructive: false,
					details: 'Create users email index',
					meta: { index: idx },
				},
			]),
		);
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain('CREATE INDEX "idx_users_email"');
		expect(content).toContain('DROP INDEX IF EXISTS "idx_users_email"');
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false && !force).toBe(true);
	});

	it('stamps a non-destructive DOWN that re-adds a constraint as safe', () => {
		const check: CheckConstraintIR = {
			name: 'users_age_check',
			expression: 'CHECK ((age > 0))',
		};
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'drop_check_constraint',
					table: 'users',
					destructive: true,
					details: 'Drop users age check',
					meta: { check },
				},
			]),
		);
		const parsed = parseMigrationFile(content);

		expect(content).toContain('DROP CONSTRAINT IF EXISTS "users_age_check"');
		expect(content).toContain('ADD CONSTRAINT "users_age_check"');
		expect(content).toContain('-- dbsp:destructive: false');
		expect(parsed.destructive).toBe(false);
		expect(parsed.destructive !== false).toBe(false);
	});

	it('stamps enable_rls rollback security-control removal as destructive', () => {
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'enable_rls',
					table: 'documents',
					destructive: false,
					details: 'Enable RLS on documents',
				},
			]),
		);
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain(
			'ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY',
		);
		expect(content).toContain(
			'ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY',
		);
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false && !force).toBe(true);
	});

	it('stamps create_policy rollback policy removal as destructive', () => {
		const policy: PolicyIR = {
			name: 'tenant_isolation',
			using: 'tenant_id = current_tenant_id()',
		};
		const content = generateMigrationFile(
			makeDiff([
				{
					kind: 'create_policy',
					table: 'documents',
					destructive: false,
					details: 'Create tenant policy',
					meta: { policy },
				},
			]),
		);
		const parsed = parseMigrationFile(content);
		const force = false;

		expect(content).toContain('CREATE POLICY "tenant_isolation"');
		expect(content).toContain(
			'DROP POLICY IF EXISTS "tenant_isolation" ON "documents"',
		);
		expect(content).toContain('-- dbsp:destructive: true');
		expect(parsed.destructive).toBe(true);
		expect(parsed.destructive !== false && !force).toBe(true);
	});
});
