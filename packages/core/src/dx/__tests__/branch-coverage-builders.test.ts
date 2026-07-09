/**
 * Branch coverage tests for core DX builders.
 *
 * Targets uncovered branches in:
 *   - orm-instance.ts  (buildTableDDL, buildIndexAPI, generateXxxSQL helpers, createOrmInstance)
 *   - batch-values.ts  (batchValues)
 *   - raw-cte-builder.ts (createRawCteBuilder, RawCteQueryBuilder)
 *   - cte-builder.ts   (CteBuilder)
 *
 * Rules:
 *   - NEVER .toContain() — always .toEqual() / .toBe()
 *   - Test edge cases and error paths only
 *   - Test names: "should [exact behavior] when [exact condition]"
 */

import { describe, expect, it, vi } from 'vitest';
import { batchValues } from '../batch-values.js';
import { CteBuilder } from '../cte-builder.js';
import { InvalidOperationError } from '../errors.js';
import { createOrm } from '../orm.js';
import { wrapTablesProxyWithDDL } from '../orm-instance.js';
import { createRawCteBuilder } from '../raw-cte-builder.js';
import { schema } from '../schema.js';
import { createMockAdapter } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Shared minimal schema + orm
// ---------------------------------------------------------------------------

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
	},
});

// orm with mock adapter (has validateIdentifier, withSchema, but no executeDDL/storageSize)
const mockAdapter = createMockAdapter();
const ormWithMock = createOrm({ schema: testSchema, adapter: mockAdapter });

// ---------------------------------------------------------------------------
// DDL-capable mock adapter factory
// ---------------------------------------------------------------------------

function makeDDLAdapter(overrides: Record<string, unknown> = {}) {
	const base = createMockAdapter();
	const ddlAdapter = {
		...base,
		executeDDL: vi.fn().mockResolvedValue(undefined),
		withSchema: (name: string) =>
			makeDDLAdapter({ ...overrides, _schema: name }),
		...overrides,
	};
	return ddlAdapter;
}

// ---------------------------------------------------------------------------
// 1. orm-instance.ts — buildTableDDL edge cases
// ---------------------------------------------------------------------------

describe('buildTableDDL — requireAdapter guard', () => {
	it('should throw InvalidOperationError when adapter has no executeDDL and truncate is called', async () => {
		// createMockAdapter does not include executeDDL
		const ddl = ormWithMock.tables.users;
		await expect(() =>
			(ddl as unknown as { truncate(): Promise<void> }).truncate(),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw InvalidOperationError when adapter has no executeDDL and vacuum is called', async () => {
		const ddl = ormWithMock.tables.users;
		await expect(() =>
			(ddl as unknown as { vacuum(): Promise<void> }).vacuum(),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw InvalidOperationError when adapter has no executeDDL and alterColumn is called', async () => {
		const ddl = ormWithMock.tables.users;
		await expect(() =>
			(
				ddl as unknown as {
					alterColumn(col: string, opts: object): Promise<void>;
				}
			).alterColumn('name', {
				type: 'text',
			}),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw InvalidOperationError when vacuum is called inside a transaction', async () => {
		const ddlAdapter = makeDDLAdapter({ inTransaction: true });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		const ddl = orm.tables.users;
		await expect(() =>
			(ddl as unknown as { vacuum(): Promise<void> }).vacuum(),
		).rejects.toThrow(InvalidOperationError);
		await expect(() =>
			(ddl as unknown as { vacuum(): Promise<void> }).vacuum(),
		).rejects.toThrow('VACUUM cannot run inside a transaction block');
	});

	it('should throw InvalidOperationError when storageSize is called with adapter that lacks storageSize method', async () => {
		// createMockAdapter has no storageSize method
		const ddl = ormWithMock.tables.users;
		await expect(() =>
			(ddl as unknown as { storageSize(): Promise<number> }).storageSize(),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should call adapter-provided generateTruncate when available', async () => {
		const generateTruncate = vi.fn().mockReturnValue('CUSTOM TRUNCATE');
		const ddlAdapter = makeDDLAdapter({ generateTruncate });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		const ddl = orm.tables.users;
		await (ddl as unknown as { truncate(): Promise<void> }).truncate();
		expect(generateTruncate).toHaveBeenCalledOnce();
	});

	it('should call adapter-provided generateVacuum when available', async () => {
		const generateVacuum = vi.fn().mockReturnValue('CUSTOM VACUUM');
		const ddlAdapter = makeDDLAdapter({ generateVacuum });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		const ddl = orm.tables.users;
		await (ddl as unknown as { vacuum(): Promise<void> }).vacuum();
		expect(generateVacuum).toHaveBeenCalledOnce();
	});

	it('should call adapter-provided generateAlterColumn when available', async () => {
		const generateAlterColumn = vi.fn().mockReturnValue('CUSTOM ALTER');
		const ddlAdapter = makeDDLAdapter({ generateAlterColumn });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		const ddl = orm.tables.users;
		await (
			ddl as unknown as {
				alterColumn(col: string, opts: object): Promise<void>;
			}
		).alterColumn('name', {
			type: 'text',
		});
		expect(generateAlterColumn).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// 2. orm-instance.ts — generateTruncateSQL branches
// ---------------------------------------------------------------------------

describe('generateTruncateSQL — option branches', () => {
	it('should include RESTART IDENTITY when restartIdentity option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as { truncate(o: object): Promise<void> }
		).truncate({
			restartIdentity: true,
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('TRUNCATE "users" RESTART IDENTITY');
	});

	it('should include CASCADE when cascade option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as { truncate(o: object): Promise<void> }
		).truncate({ cascade: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('TRUNCATE "users" CASCADE');
	});

	it('should include both RESTART IDENTITY and CASCADE when both options are true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as { truncate(o: object): Promise<void> }
		).truncate({
			restartIdentity: true,
			cascade: true,
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('TRUNCATE "users" RESTART IDENTITY CASCADE');
	});

	it('should include schema prefix when schemaName is set', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		}).withSchema('myschema');
		await (
			orm.tables.users as unknown as { truncate(): Promise<void> }
		).truncate();
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('TRUNCATE "myschema"."users"');
	});
});

// ---------------------------------------------------------------------------
// 3. orm-instance.ts — generateVacuumSQL branches
// ---------------------------------------------------------------------------

describe('generateVacuumSQL — option branches', () => {
	it('should produce plain VACUUM with no options', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (orm.tables.users as unknown as { vacuum(): Promise<void> }).vacuum();
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('VACUUM "users"');
	});

	it('should include FULL modifier when full option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as { vacuum(o: object): Promise<void> }
		).vacuum({ full: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('VACUUM (FULL) "users"');
	});

	it('should include ANALYZE modifier when analyze option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as { vacuum(o: object): Promise<void> }
		).vacuum({ analyze: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('VACUUM (ANALYZE) "users"');
	});

	it('should include both FULL and ANALYZE when both options are true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as { vacuum(o: object): Promise<void> }
		).vacuum({
			full: true,
			analyze: true,
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('VACUUM (FULL, ANALYZE) "users"');
	});
});

// ---------------------------------------------------------------------------
// 4. orm-instance.ts — generateAlterColumnSQL branches
// ---------------------------------------------------------------------------

describe('generateAlterColumnSQL — option branches', () => {
	it('should throw InvalidOperationError when no alteration option is specified', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await expect(() =>
			(
				orm.tables.users as unknown as {
					alterColumn(col: string, opts: object): Promise<void>;
				}
			).alterColumn('name', {}),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include USING clause when type and using are both provided', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: object): Promise<void>;
			}
		).alterColumn('name', { type: 'integer', using: 'name::integer' });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'ALTER TABLE "users" ALTER COLUMN "name" TYPE integer USING name::integer',
		);
	});

	it('should generate SET NOT NULL clause when setNotNull is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: object): Promise<void>;
			}
		).alterColumn('name', { setNotNull: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL');
	});

	it('should generate DROP NOT NULL clause when setNotNull is false', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: object): Promise<void>;
			}
		).alterColumn('name', { setNotNull: false });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL');
	});

	it('should generate DROP DEFAULT when dropDefault is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: object): Promise<void>;
			}
		).alterColumn('name', { dropDefault: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('ALTER TABLE "users" ALTER COLUMN "name" DROP DEFAULT');
	});

	it('should generate SET DEFAULT when setDefault is provided', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: object): Promise<void>;
			}
		).alterColumn('name', { setDefault: "'unknown'" });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'ALTER TABLE "users" ALTER COLUMN "name" SET DEFAULT \'unknown\'',
		);
	});
});

// ---------------------------------------------------------------------------
// 5. orm-instance.ts — generateCreateIndexSQL branches
// ---------------------------------------------------------------------------

describe('generateCreateIndexSQL — option branches', () => {
	it('should include UNIQUE keyword when unique option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_users_name',
			columns: ['name'],
			unique: true,
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE UNIQUE INDEX "idx_users_name" ON "users" ("name")',
		);
	});

	it('should include CONCURRENTLY keyword when concurrently option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_users_name',
			columns: ['name'],
			concurrently: true,
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX CONCURRENTLY "idx_users_name" ON "users" ("name")',
		);
	});

	it('should throw InvalidOperationError when CONCURRENTLY is used inside a transaction', async () => {
		const ddlAdapter = makeDDLAdapter({ inTransaction: true });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await expect(() =>
			(
				orm.tables.users as unknown as {
					indexes: { create(opts: object): Promise<void> };
				}
			).indexes.create({ name: 'idx', columns: ['name'], concurrently: true }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include IF NOT EXISTS when ifNotExists option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_users_name',
			columns: ['name'],
			ifNotExists: true,
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX IF NOT EXISTS "idx_users_name" ON "users" ("name")',
		);
	});

	it('should include USING clause when method option is set', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_users_name',
			columns: ['name'],
			method: 'gin',
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX "idx_users_name" ON "users" USING gin ("name")',
		);
	});

	it('should include expression column when column is an expression object', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_lower',
			columns: [{ expression: 'lower(name)' }],
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('CREATE INDEX "idx_lower" ON "users" ((lower(name)))');
	});

	it('should include opclass in column expression when opclass is set on object column', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_expr_op',
			columns: [{ expression: 'lower(name)', opclass: 'text_ops' }],
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX "idx_expr_op" ON "users" ((lower(name)) text_ops)',
		);
	});

	it('should include opclass in string column when opclass map contains column name', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_name_op',
			columns: ['name'],
			opclass: { name: 'text_ops' },
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('CREATE INDEX "idx_name_op" ON "users" ("name" text_ops)');
	});

	it('should include INCLUDE clause when include option has columns', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_include',
			columns: ['name'],
			include: ['id'],
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX "idx_include" ON "users" ("name") INCLUDE ("id")',
		);
	});

	it('should place INCLUDE before NULLS NOT DISTINCT when both options are set', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_include_nulls',
			columns: ['name'],
			unique: true,
			nullsNotDistinct: true,
			include: ['id'],
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE UNIQUE INDEX "idx_include_nulls" ON "users" ("name") INCLUDE ("id") NULLS NOT DISTINCT',
		);
	});

	it('should include WITH clause when with option has storage parameters', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_with',
			columns: ['name'],
			with: { fillfactor: 80 },
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX "idx_with" ON "users" ("name") WITH (fillfactor = 80)',
		);
	});

	it('should include WHERE predicate when where option is set', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { create(opts: object): Promise<void> };
			}
		).indexes.create({
			name: 'idx_partial',
			columns: ['name'],
			where: 'name IS NOT NULL',
		});
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe(
			'CREATE INDEX "idx_partial" ON "users" ("name") WHERE name IS NOT NULL',
		);
	});
});

// ---------------------------------------------------------------------------
// 6. orm-instance.ts — generateDropIndexSQL branches
// ---------------------------------------------------------------------------

describe('generateDropIndexSQL — option branches', () => {
	it('should produce plain DROP INDEX with no options', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { drop(name: string): Promise<void> };
			}
		).indexes.drop('my_index');
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX "my_index"');
	});

	it('should include CONCURRENTLY keyword when concurrently option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { drop(name: string, opts: object): Promise<void> };
			}
		).indexes.drop('my_index', { concurrently: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX CONCURRENTLY "my_index"');
	});

	it('should throw InvalidOperationError when CONCURRENTLY is used inside a transaction during drop', async () => {
		const ddlAdapter = makeDDLAdapter({ inTransaction: true });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await expect(() =>
			(
				orm.tables.users as unknown as {
					indexes: { drop(name: string, opts: object): Promise<void> };
				}
			).indexes.drop('my_index', { concurrently: true }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include IF EXISTS when ifExists option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { drop(name: string, opts: object): Promise<void> };
			}
		).indexes.drop('my_index', { ifExists: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX IF EXISTS "my_index"');
	});

	it('should include schema prefix when schema option is provided', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { drop(name: string, opts: object): Promise<void> };
			}
		).indexes.drop('my_index', { schema: 'myns' });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX "myns"."my_index"');
	});

	it('should include CASCADE when cascade option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { drop(name: string, opts: object): Promise<void> };
			}
		).indexes.drop('my_index', { cascade: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX "my_index" CASCADE');
	});

	it('should use adapter-provided generateDropIndex when available', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const generateDropIndex = vi.fn().mockReturnValue('CUSTOM DROP INDEX');
		const ddlAdapter = makeDDLAdapter({ executeDDL, generateDropIndex });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await (
			orm.tables.users as unknown as {
				indexes: { drop(name: string): Promise<void> };
			}
		).indexes.drop('my_index');
		expect(generateDropIndex).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// 7. orm-instance.ts — buildIndexAPI list/exists branches
// ---------------------------------------------------------------------------

describe('buildIndexAPI — list and exists error branches', () => {
	it('should throw when list is called on adapter that has executeRaw but no listIndexes', async () => {
		// no listIndexes → fail loud (InvalidOperationError); core must not emit
		// database-specific catalog SQL as a fallback.
		const ddl = ormWithMock.tables.users;
		await expect(() =>
			(
				ddl as unknown as { indexes: { list(): Promise<unknown[]> } }
			).indexes.list(),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw InvalidOperationError when exists is called on adapter without indexExists method', async () => {
		// mockAdapter has no indexExists method
		const ddl = ormWithMock.tables.users;
		await expect(() =>
			(
				ddl as unknown as {
					indexes: { exists(name: string): Promise<boolean> };
				}
			).indexes.exists('idx'),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should delegate to adapter.listIndexes when available', async () => {
		const listIndexes = vi.fn().mockResolvedValue([{ name: 'idx_users_name' }]);
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL, listIndexes });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		const result = await (
			orm.tables.users as unknown as { indexes: { list(): Promise<unknown[]> } }
		).indexes.list();
		expect(listIndexes).toHaveBeenCalledOnce();
		expect(result).toEqual([{ name: 'idx_users_name' }]);
	});

	it('should delegate to adapter.indexExists when available', async () => {
		const indexExists = vi.fn().mockResolvedValue(true);
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL, indexExists });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		const result = await (
			orm.tables.users as unknown as {
				indexes: { exists(name: string): Promise<boolean> };
			}
		).indexes.exists('my_index');
		expect(indexExists).toHaveBeenCalledOnce();
		expect(result).toBe(true);
	});

	it('should throw (no executeRaw fallback) when list has no listIndexes but has executeRaw', async () => {
		const executeRaw = vi.fn().mockResolvedValue([]);
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL, executeRaw });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await expect(() =>
			(
				orm.tables.users as unknown as {
					indexes: { list(): Promise<unknown[]> };
				}
			).indexes.list(),
		).rejects.toThrow(InvalidOperationError);
		expect(executeRaw).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 8. orm-instance.ts — createOrmInstance transaction/raw errors
// ---------------------------------------------------------------------------

describe('createOrmInstance — transaction and raw error branches', () => {
	it('should throw when transaction is called with adapter that throws not-implemented', async () => {
		await expect(() =>
			ormWithMock.transaction(async () => 'result'),
		).rejects.toThrow('Not implemented in mock adapter');
	});

	it('should throw when raw is called with adapter that throws not-implemented', async () => {
		await expect(() => ormWithMock.raw('SELECT 1')).rejects.toThrow(
			'Not implemented in mock adapter',
		);
	});

	it('should throw when selectExpression is called with adapter that throws not-implemented', () => {
		const expr = {
			intent: { kind: 'column', column: 'id' },
		} as unknown as Parameters<typeof ormWithMock.selectExpression>[0];
		expect(() => ormWithMock.selectExpression(expr)).toThrow(
			'Not implemented in mock adapter',
		);
	});

	it('should throw when listAncestors is called on a table with no self-referential relation', async () => {
		await expect(() =>
			ormWithMock.listAncestors('users', 1, {}),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw when listDescendants is called on a table with no self-referential relation', async () => {
		await expect(() =>
			ormWithMock.listDescendants('users', 1, {}),
		).rejects.toThrow(InvalidOperationError);
	});
});

// ---------------------------------------------------------------------------
// 9. orm-instance.ts — withSchema branches
// ---------------------------------------------------------------------------

describe('createOrmInstance — withSchema branches', () => {
	it('should not throw when withSchema is called with a valid identifier', () => {
		expect(() => ormWithMock.withSchema('any_schema')).not.toThrow();
	});

	it('should call validateIdentifier with schema name and kind when adapter is present', () => {
		const validateIdentifier = vi.fn();
		const adapter = {
			...createMockAdapter(),
			validateIdentifier,
			withSchema: () => adapter,
		};
		const orm = createOrm({ schema: testSchema, adapter });
		orm.withSchema('tenant_1');
		expect(validateIdentifier).toHaveBeenCalledWith('tenant_1', 'schema');
	});
});

// ---------------------------------------------------------------------------
// 10. orm-instance.ts — ddl.dropIndex branches
// ---------------------------------------------------------------------------

describe('createOrmInstance — ddl.dropIndex branches', () => {
	it('should throw InvalidOperationError when ddl.dropIndex is called with adapter that has no executeDDL', async () => {
		// ormWithMock uses createMockAdapter which has no executeDDL
		await expect(() => ormWithMock.ddl.dropIndex('my_idx')).rejects.toThrow(
			InvalidOperationError,
		);
	});

	it('should include schema prefix in ddl.dropIndex when schemaName is set on orm', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		}).withSchema('myschema');
		await (orm as typeof ormWithMock).ddl.dropIndex('my_idx');
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX "myschema"."my_idx"');
	});

	it('should include CONCURRENTLY in ddl.dropIndex when concurrently option is true', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const ddlAdapter = makeDDLAdapter({ executeDDL });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await orm.ddl.dropIndex('my_idx', { concurrently: true });
		const sql: string = executeDDL.mock.calls[0][0] as string;
		expect(sql).toBe('DROP INDEX CONCURRENTLY "my_idx"');
	});

	it('should use adapter-provided generateDropIndex in ddl.dropIndex when available', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const generateDropIndex = vi.fn().mockReturnValue('CUSTOM DROP');
		const ddlAdapter = makeDDLAdapter({ executeDDL, generateDropIndex });
		const orm = createOrm({
			schema: testSchema,
			adapter: ddlAdapter as ReturnType<typeof createMockAdapter>,
		});
		await orm.ddl.dropIndex('my_idx');
		expect(generateDropIndex).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// 11. orm-instance.ts — wrapTablesProxyWithDDL proxy edge cases
// ---------------------------------------------------------------------------

describe('wrapTablesProxyWithDDL — proxy edge cases', () => {
	it('should return undefined for non-existent table key', () => {
		const proxy = wrapTablesProxyWithDDL({}, undefined, undefined);
		expect((proxy as Record<string, unknown>).nonexistent).toBeUndefined();
	});

	it('should pass through Symbol properties unchanged', () => {
		const sym = Symbol('test');
		const target = { [sym]: 'symbolValue' };
		const proxy = wrapTablesProxyWithDDL(
			target,
			undefined,
			undefined,
		) as Record<symbol, unknown>;
		expect(proxy[sym]).toBe('symbolValue');
	});

	it('should return the same augmented object on repeated access (cache hit)', () => {
		const tableRef = { __brand: 'users' };
		const target = { users: tableRef };
		const proxy = wrapTablesProxyWithDDL(
			target,
			undefined,
			undefined,
		) as Record<string, unknown>;
		const first = proxy.users;
		const second = proxy.users;
		expect(first).toBe(second);
	});

	it('should pass through null table entry unchanged', () => {
		const target = { users: null };
		const proxy = wrapTablesProxyWithDDL(
			target,
			undefined,
			undefined,
		) as Record<string, null>;
		expect(proxy.users).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 12. batch-values.ts — all error branches
// ---------------------------------------------------------------------------

describe('batchValues — error branches', () => {
	it('should throw when data length does not match columns length', () => {
		expect(() =>
			batchValues(
				[
					[1, 2],
					[3, 4],
				],
				['a'],
				['integer', 'integer'],
			),
		).toThrow(
			'batchValues: data, columns, and types must have the same length',
		);
	});

	it('should throw when data length does not match types length', () => {
		expect(() => batchValues([[1, 2]], ['a', 'b'], ['integer'])).toThrow(
			'batchValues: data, columns, and types must have the same length',
		);
	});

	it('should throw when columns array is empty', () => {
		expect(() => batchValues([], [], [])).toThrow(
			'batchValues: at least one column is required',
		);
	});

	it('should throw when a type name contains a backslash', () => {
		// Spaces are allowed (e.g. 'timestamp with time zone') but backslashes are not.
		expect(() => batchValues([[1]], ['id'], ['int4\\injection'])).toThrow(
			/invalid type name/,
		);
	});

	it('should throw when a type name contains a hyphen', () => {
		expect(() => batchValues([[1]], ['id'], ['my-type'])).toThrow(
			"batchValues: invalid type name 'my-type'",
		);
	});

	it('should throw when a type name contains a semicolon', () => {
		expect(() =>
			batchValues([[1]], ['id'], ['integer; DROP TABLE users']),
		).toThrow("batchValues: invalid type name 'integer; DROP TABLE users'");
	});

	it('should set default alias to batch when opts is omitted', () => {
		const result = batchValues([[1]], ['id'], ['integer']);
		expect(result.alias).toBe('batch');
	});

	it('should set default ordinality to false when opts is omitted', () => {
		const result = batchValues([[1]], ['id'], ['integer']);
		expect(result.ordinality).toBe(false);
	});

	it('should use provided alias when opts.alias is set', () => {
		const result = batchValues([[1]], ['id'], ['integer'], {
			alias: 'myalias',
		});
		expect(result.alias).toBe('myalias');
	});

	it('should use provided ordinality when opts.ordinality is set', () => {
		const result = batchValues([[1]], ['id'], ['integer'], {
			ordinality: true,
		});
		expect(result.ordinality).toBe(true);
	});

	it('should set __kind to batchValues sentinel string', () => {
		const result = batchValues([[1]], ['id'], ['integer']);
		expect(result.__kind).toBe('batchValues');
	});

	it('should pass through valid alphanumeric type names without error', () => {
		expect(() => batchValues([[1]], ['id'], ['int4'])).not.toThrow();
		expect(() => batchValues([[1]], ['val'], ['varchar2'])).not.toThrow();
		expect(() => batchValues([[1]], ['val'], ['my_type'])).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 13. raw-cte-builder.ts — createRawCteBuilder and RawCteQueryBuilder branches
// ---------------------------------------------------------------------------

describe('createRawCteBuilder — intent building branches', () => {
	function makeBaseStep() {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const base = orm.select('users');
		const step = orm.select('users');
		return { adapter, base, step };
	}

	it('should set unionAll to true by default when unionAll option is not specified', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter);
		const intent = builder.buildIntent();
		expect(intent.ctes[0]).toMatchObject({ unionAll: true });
	});

	it('should set unionAll to false when unionAll option is explicitly false', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder(
			'tree',
			{ base, step, unionAll: false },
			adapter,
		);
		const intent = builder.buildIntent();
		expect(intent.ctes[0]).toMatchObject({ unionAll: false });
	});

	it('should include maxDepth in CTE intent when maxDepth option is specified', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder(
			'tree',
			{ base, step, maxDepth: 5 },
			adapter,
		);
		const intent = builder.buildIntent();
		expect((intent.ctes[0] as Record<string, unknown>).maxDepth).toBe(5);
	});

	it('should omit maxDepth from CTE intent when maxDepth option is not specified', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter);
		const intent = builder.buildIntent();
		expect(
			(intent.ctes[0] as Record<string, unknown>).maxDepth,
		).toBeUndefined();
	});

	it('should include depthColumn in CTE intent when depthColumn option is specified', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder(
			'tree',
			{ base, step, depthColumn: 'lvl' },
			adapter,
		);
		const intent = builder.buildIntent();
		expect((intent.ctes[0] as Record<string, unknown>).depthColumn).toBe('lvl');
	});

	it('should omit depthColumn from CTE intent when depthColumn option is not specified', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter);
		const intent = builder.buildIntent();
		expect(
			(intent.ctes[0] as Record<string, unknown>).depthColumn,
		).toBeUndefined();
	});

	it('should include outer select columns in intent when .columns() is called', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder(
			'tree',
			{ base, step },
			adapter,
		).columns(['id', 'name']);
		const intent = builder.buildIntent();
		expect(intent.query.select).toEqual({
			type: 'expressions',
			columns: [
				{ kind: 'column', column: 'id' },
				{ kind: 'column', column: 'name' },
			],
		});
	});

	it('should include outer where in intent when .where() is called', () => {
		const { adapter, base, step } = makeBaseStep();
		const whereIntent = { kind: 'eq', field: 'id', value: 1 } as Parameters<
			ReturnType<typeof createRawCteBuilder>['where']
		>[0];
		const builder = createRawCteBuilder('tree', { base, step }, adapter).where(
			whereIntent,
		);
		const intent = builder.buildIntent();
		expect(intent.query.where).toEqual(whereIntent);
	});

	it('should include outer orderBy in intent when .orderBy() is called', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder(
			'tree',
			{ base, step },
			adapter,
		).orderBy('id', 'desc');
		const intent = builder.buildIntent();
		expect(intent.query.orderBy).toEqual([{ field: 'id', direction: 'desc' }]);
	});

	it('should default orderBy direction to asc when direction is not specified', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder(
			'tree',
			{ base, step },
			adapter,
		).orderBy('id');
		const intent = builder.buildIntent();
		expect(intent.query.orderBy).toEqual([{ field: 'id', direction: 'asc' }]);
	});

	it('should accumulate multiple orderBy clauses when .orderBy() is called multiple times', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter)
			.orderBy('id', 'asc')
			.orderBy('name', 'desc');
		const intent = builder.buildIntent();
		expect(intent.query.orderBy).toEqual([
			{ field: 'id', direction: 'asc' },
			{ field: 'name', direction: 'desc' },
		]);
	});

	it('should include limit in intent when .limit() is called', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter).limit(
			10,
		);
		const intent = builder.buildIntent();
		expect(intent.query.limit).toBe(10);
	});

	it('should include offset in intent when .offset() is called', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter).offset(
			20,
		);
		const intent = builder.buildIntent();
		expect(intent.query.offset).toBe(20);
	});

	it('should omit limit from intent when .limit() is not called', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter);
		const intent = builder.buildIntent();
		expect(intent.query.limit).toBeUndefined();
	});

	it('should omit offset from intent when .offset() is not called', () => {
		const { adapter, base, step } = makeBaseStep();
		const builder = createRawCteBuilder('tree', { base, step }, adapter);
		const intent = builder.buildIntent();
		expect(intent.query.offset).toBeUndefined();
	});

	it('should throw when dump() is called without an adapter', () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const base = orm.select('users');
		const step = orm.select('users');
		// Create builder without adapter
		const builder = createRawCteBuilder('tree', { base, step });
		expect(() => builder.dump()).toThrow('recursive');
	});

	it('should throw when all() is called without an adapter', async () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const base = orm.select('users');
		const step = orm.select('users');
		const builder = createRawCteBuilder('tree', { base, step });
		await expect(() => builder.all()).rejects.toThrow('recursive');
	});
});

// ---------------------------------------------------------------------------
// 14. cte-builder.ts — CteBuilder error branches
// ---------------------------------------------------------------------------

describe('CteBuilder — error branches', () => {
	it('should throw InvalidOperationError when query() is called before fromUnnest()', () => {
		const builder = new CteBuilder('my_cte');
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const select = orm.select('users');
		expect(() => builder.query(select)).toThrow(InvalidOperationError);
		expect(() => builder.query(select)).toThrow('CTE requires a data source');
	});

	it('should throw InvalidOperationError when fromUnnest receives arrays of unequal length', () => {
		const builder = new CteBuilder('my_cte');
		expect(() =>
			builder.fromUnnest({
				id: [1, 2, 3],
				name: ['a', 'b'], // shorter
			}),
		).toThrow(InvalidOperationError);
		expect(() =>
			builder.fromUnnest({
				id: [1, 2, 3],
				name: ['a', 'b'],
			}),
		).toThrow('Array length mismatch');
	});

	it('should not throw when fromUnnest receives a single column (length check skipped)', () => {
		const builder = new CteBuilder('my_cte');
		expect(() => builder.fromUnnest({ id: [1, 2, 3] })).not.toThrow();
	});

	it('should include indexColumn in CTE intent when withIndex is called', () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = new CteBuilder('my_cte')
			.fromUnnest({ id: [1, 2] })
			.withIndex('idx');
		const cteQueryBuilder = builder.query(orm.select('users'));
		const intent = cteQueryBuilder.buildIntent();
		expect((intent.ctes[0] as Record<string, unknown>).indexColumn).toBe('idx');
	});

	it('should omit indexColumn from CTE intent when withIndex is not called', () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = new CteBuilder('my_cte').fromUnnest({ id: [1, 2] });
		const cteQueryBuilder = builder.query(orm.select('users'));
		const intent = cteQueryBuilder.buildIntent();
		expect(
			(intent.ctes[0] as Record<string, unknown>).indexColumn,
		).toBeUndefined();
	});

	it('should include correct CTE name in the intent', () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = new CteBuilder('batch_data').fromUnnest({ id: [1] });
		const cteQueryBuilder = builder.query(orm.select('users'));
		const intent = cteQueryBuilder.buildIntent();
		expect((intent.ctes[0] as Record<string, unknown>).name).toBe('batch_data');
	});

	it('should include column data in the CTE intent after fromUnnest', () => {
		const adapter = createMockAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const data = { id: [1, 2], name: ['Alice', 'Bob'] };
		const builder = new CteBuilder('my_cte').fromUnnest(data);
		const cteQueryBuilder = builder.query(orm.select('users'));
		const intent = cteQueryBuilder.buildIntent();
		expect((intent.ctes[0] as Record<string, unknown>).columns).toEqual(data);
	});
});
