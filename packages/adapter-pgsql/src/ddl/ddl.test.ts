/**
 * DDL Generator Tests
 */

import type {
	DialectCapabilities,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	PartitionIR,
	SequenceIR,
	TableIR,
} from '@dbsp/core';
import { ModelIRImpl, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { camelCaseNaming } from '../naming-plugin.js';
import { generateDDL } from './ddl-generator.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

describe('DDL Generator', () => {
	describe('Type Mapping', () => {
		it('should map basic types correctly', () => {
			expect(
				mapColumnType({ name: 'name', type: 'string', nullable: false }),
			).toBe('VARCHAR(255)');
			expect(
				mapColumnType({ name: 'bio', type: 'text', nullable: false }),
			).toBe('TEXT');
			expect(
				mapColumnType({ name: 'age', type: 'integer', nullable: false }),
			).toBe('INTEGER');
			expect(
				mapColumnType({ name: 'count', type: 'bigint', nullable: false }),
			).toBe('BIGINT');
			expect(
				mapColumnType({ name: 'price', type: 'decimal', nullable: false }),
			).toBe('NUMERIC');
			expect(
				mapColumnType({ name: 'active', type: 'boolean', nullable: false }),
			).toBe('BOOLEAN');
		});

		it('should map date/time types correctly', () => {
			expect(
				mapColumnType({ name: 'birthdate', type: 'date', nullable: false }),
			).toBe('DATE');
			expect(
				mapColumnType({
					name: 'created_at',
					type: 'timestamp',
					nullable: false,
				}),
			).toBe('TIMESTAMPTZ');
			expect(
				mapColumnType({
					name: 'updated_at',
					type: 'datetime',
					nullable: false,
				}),
			).toBe('TIMESTAMPTZ');
		});

		it('should map special types correctly', () => {
			expect(mapColumnType({ name: 'id', type: 'uuid', nullable: false })).toBe(
				'UUID',
			);
			expect(
				mapColumnType({ name: 'data', type: 'jsonb', nullable: false }),
			).toBe('JSONB');
			expect(
				mapColumnType({ name: 'meta', type: 'json', nullable: false }),
			).toBe('JSONB');
		});

		it('should map range types correctly', () => {
			expect(
				mapColumnType({ name: 'period', type: 'daterange', nullable: false }),
			).toBe('DATERANGE');
			expect(
				mapColumnType({ name: 'duration', type: 'tstzrange', nullable: false }),
			).toBe('TSTZRANGE');
			expect(
				mapColumnType({ name: 'range', type: 'int4range', nullable: false }),
			).toBe('INT4RANGE');
		});

		it('should handle auto-increment columns', () => {
			expect(
				mapColumnType({
					name: 'id',
					type: 'integer',
					nullable: false,
					autoIncrement: true,
				}),
			).toBe('SERIAL');
			expect(
				mapColumnType({
					name: 'id',
					type: 'bigint',
					nullable: false,
					autoIncrement: true,
				}),
			).toBe('BIGSERIAL');
		});

		it('should prefer originalDbType when available', () => {
			expect(
				mapColumnType({
					name: 'price',
					type: 'decimal',
					nullable: false,
					originalDbType: 'numeric(10,2)',
				}),
			).toBe('NUMERIC(10,2)');
		});

		it('should map ON DELETE actions correctly', () => {
			expect(mapOnDeleteAction('CASCADE')).toBe('CASCADE');
			expect(mapOnDeleteAction('SET NULL')).toBe('SET NULL');
			expect(mapOnDeleteAction('SET DEFAULT')).toBe('SET DEFAULT');
			expect(mapOnDeleteAction('RESTRICT')).toBe('RESTRICT');
			expect(mapOnDeleteAction('NO ACTION')).toBe('NO ACTION');
			expect(mapOnDeleteAction(undefined)).toBe('NO ACTION');
		});
	});

	describe('CREATE TABLE', () => {
		it('should generate CREATE TABLE with simple columns', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'name', type: 'string', nullable: false },
								{
									name: 'email',
									type: 'string',
									nullable: false,
									unique: true,
								},
								{ name: 'age', type: 'integer', nullable: true },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			expect(ddl).toHaveLength(1);
			expect(ddl[0]).toContain('CREATE TABLE "users"');
			expect(ddl[0]).toContain('"id" SERIAL');
			expect(ddl[0]).toContain('"name" VARCHAR(255) NOT NULL');
			expect(ddl[0]).toContain('"email" VARCHAR(255) NOT NULL UNIQUE');
			expect(ddl[0]).toContain('"age" INTEGER');
			expect(ddl[0]).toContain('CONSTRAINT "pk_users" PRIMARY KEY ("id")');
		});

		it('should preserve custom type identity in generated CREATE TABLE DDL', () => {
			const schema = {
				tables: new Map([
					[
						'payments',
						{
							name: 'payments',
							columns: [
								{
									name: 'amount',
									type: 'decimal',
									nullable: false,
									// Introspection stores a case-sensitive custom type quoted.
									originalDbType: '"Money"',
								},
								{
									name: 'status',
									type: 'string',
									nullable: false,
									originalDbType: 'status',
								},
							],
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			expect(ddl).toEqual([
				'CREATE TABLE "payments" (\n  "amount" "Money" NOT NULL,\n  "status" status NOT NULL\n);',
			]);
		});

		it('should generate CREATE TABLE with composite primary key', () => {
			const schema = {
				tables: new Map([
					[
						'post_tags',
						{
							name: 'post_tags',
							columns: [
								{ name: 'post_id', type: 'integer', nullable: false },
								{ name: 'tag_id', type: 'integer', nullable: false },
							],
							primaryKey: ['post_id', 'tag_id'],
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			expect(ddl).toHaveLength(1);
			expect(ddl[0]).toContain(
				'CONSTRAINT "pk_post_tags" PRIMARY KEY ("post_id", "tag_id")',
			);
		});

		it('should handle default values', () => {
			const schema = {
				tables: new Map([
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'title', type: 'string', nullable: false },
								{ name: 'views', type: 'integer', nullable: false, default: 0 },
								{
									name: 'active',
									type: 'boolean',
									nullable: false,
									default: true,
								},
								{
									name: 'created_at',
									type: 'timestamp',
									nullable: false,
									default: { sql: 'now()' },
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			expect(ddl[0]).toContain('"views" INTEGER NOT NULL DEFAULT 0');
			expect(ddl[0]).toContain('"active" BOOLEAN NOT NULL DEFAULT true');
			expect(ddl[0]).toContain(
				'"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()',
			);
		});

		it('should support schema scoping', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema, { schemaName: 'tenant_123' });

			expect(ddl[0]).toContain('CREATE TABLE "tenant_123"."users"');
		});
	});

	describe('FOREIGN KEY', () => {
		it('should generate ALTER TABLE ADD CONSTRAINT for foreign keys', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'user_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['user_id'],
									references: { table: 'users', columns: ['id'] },
									onDelete: 'CASCADE',
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			// Should have 2 CREATE TABLE + 1 ALTER TABLE + 1 auto-index
			expect(ddl.length).toBeGreaterThanOrEqual(3);

			const alterStmt = ddl.find((stmt) => stmt.includes('ALTER TABLE'));
			expect(alterStmt).toBeDefined();
			expect(alterStmt).toContain('ALTER TABLE "posts"');
			expect(alterStmt).toContain('ADD CONSTRAINT "fk_posts_user_id"');
			expect(alterStmt).toContain('FOREIGN KEY ("user_id")');
			expect(alterStmt).toContain('REFERENCES "users" ("id")');
			expect(alterStmt).toContain('ON DELETE CASCADE');
		});

		it('should qualify a declared referenced schema for foreign keys', () => {
			const schema = {
				tables: new Map([
					[
						'orders',
						{
							name: 'orders',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'ext_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['ext_id'],
									references: {
										schema: 'other',
										table: 'ext',
										columns: ['id'],
									},
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema, {
				schemaName: 'app',
				fkAutoIndex: false,
			});
			const alterStmt = ddl.find((stmt) => stmt.startsWith('ALTER TABLE'));

			expect(alterStmt).toBe(
				'ALTER TABLE "app"."orders" ADD CONSTRAINT "fk_orders_ext_id" FOREIGN KEY ("ext_id") REFERENCES "other"."ext" ("id");',
			);
		});

		it('should reject an invalid declared referenced schema for foreign keys', () => {
			const schema = {
				tables: new Map([
					[
						'orders',
						{
							name: 'orders',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'ext_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['ext_id'],
									references: {
										schema: 'a"; DROP TABLE x',
										table: 'ext',
										columns: ['id'],
									},
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			expect(() =>
				generateDDL(schema, { schemaName: 'app', fkAutoIndex: false }),
			).toThrow();
		});

		it('should support composite foreign keys', () => {
			const schema = {
				tables: new Map([
					[
						'post_tags',
						{
							name: 'post_tags',
							columns: [
								{ name: 'post_id', type: 'integer', nullable: false },
								{ name: 'tag_id', type: 'integer', nullable: false },
							],
							primaryKey: ['post_id', 'tag_id'],
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
					[
						'comments',
						{
							name: 'comments',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'post_id', type: 'integer', nullable: false },
								{ name: 'tag_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['post_id', 'tag_id'],
									references: {
										table: 'post_tags',
										columns: ['post_id', 'tag_id'],
									},
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			const alterStmt = ddl.find((stmt) => stmt.includes('ALTER TABLE'));
			expect(alterStmt).toBeDefined();
			expect(alterStmt).toContain('FOREIGN KEY ("post_id", "tag_id")');
			expect(alterStmt).toContain(
				'REFERENCES "post_tags" ("post_id", "tag_id")',
			);
		});
	});

	describe('CREATE INDEX', () => {
		it('should generate CREATE INDEX statements', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'email', type: 'string', nullable: false },
								{ name: 'created_at', type: 'timestamp', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [
								{
									name: 'idx_users_email',
									columns: ['email'],
									unique: true,
								} satisfies IndexIR,
								{
									columns: ['created_at'],
								} satisfies IndexIR,
							],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			const indexStmts = ddl.filter((stmt) => stmt.includes('CREATE'));
			expect(indexStmts.length).toBeGreaterThanOrEqual(2);

			const uniqueIndex = ddl.find((stmt) => stmt.includes('idx_users_email'));
			expect(uniqueIndex).toBeDefined();
			expect(uniqueIndex).toContain('CREATE UNIQUE INDEX');
			expect(uniqueIndex).toContain('ON "users" ("email")');

			const regularIndex = ddl.find((stmt) =>
				stmt.includes('idx_users_created_at'),
			);
			expect(regularIndex).toBeDefined();
			expect(regularIndex).toContain('CREATE INDEX');
			expect(regularIndex).toContain('ON "users" ("created_at")');
		});

		it('should auto-generate indexes for FK columns', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'user_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['user_id'],
									references: { table: 'users', columns: ['id'] },
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema, { fkAutoIndex: true });

			const autoIndex = ddl.find((stmt) => stmt.includes('idx_posts_user_id'));
			expect(autoIndex).toBeDefined();
			expect(autoIndex).toContain('CREATE INDEX "idx_posts_user_id"');
			expect(autoIndex).toContain('ON "posts" ("user_id")');
		});

		it('should skip auto-index if fkAutoIndex is false', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'user_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['user_id'],
									references: { table: 'users', columns: ['id'] },
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema, { fkAutoIndex: false });

			const autoIndex = ddl.find((stmt) => stmt.includes('idx_posts_user_id'));
			expect(autoIndex).toBeUndefined();
		});

		describe('Index enhancements in DDL', () => {
			it('should generate CREATE INDEX USING gin with opclass', () => {
				const schema = {
					tables: new Map([
						[
							'posts',
							{
								name: 'posts',
								columns: [{ name: 'body', type: 'text', nullable: false }],
								primaryKey: undefined,
								foreignKeys: [],
								indexes: [
									{
										name: 'idx_posts_body_gin',
										columns: ['body'],
										method: 'gin',
										opclass: { body: 'gin_trgm_ops' },
									} satisfies IndexIR,
								],
							} satisfies TableIR,
						],
					]),
					relations: new Map(),
				} as unknown as ModelIR;

				const ddl = generateDDL(schema);
				const idx = ddl.find((s) => s.includes('idx_posts_body_gin'));
				expect(idx).toBeDefined();
				expect(idx).toBe(
					'CREATE INDEX "idx_posts_body_gin" ON "posts" USING gin ("body" gin_trgm_ops);',
				);
			});

			it('should generate partial index with WHERE clause', () => {
				const schema = {
					tables: new Map([
						[
							'users',
							{
								name: 'users',
								columns: [{ name: 'email', type: 'string', nullable: false }],
								primaryKey: undefined,
								foreignKeys: [],
								indexes: [
									{
										name: 'idx_users_active_email',
										columns: ['email'],
										where: 'active = true',
									} satisfies IndexIR,
								],
							} satisfies TableIR,
						],
					]),
					relations: new Map(),
				} as unknown as ModelIR;

				const ddl = generateDDL(schema);
				const idx = ddl.find((s) => s.includes('idx_users_active_email'));
				expect(idx).toBeDefined();
				expect(idx).toBe(
					'CREATE INDEX "idx_users_active_email" ON "users" ("email") WHERE active = true;',
				);
			});

			it('should generate unique index with NULLS NOT DISTINCT', () => {
				const schema = {
					tables: new Map([
						[
							'users',
							{
								name: 'users',
								columns: [{ name: 'email', type: 'string', nullable: false }],
								primaryKey: undefined,
								foreignKeys: [],
								indexes: [
									{
										name: 'idx_users_email_unique',
										columns: ['email'],
										unique: true,
										nullsNotDistinct: true,
										where: 'deleted_at IS NULL',
									} satisfies IndexIR,
								],
							} satisfies TableIR,
						],
					]),
					relations: new Map(),
				} as unknown as ModelIR;

				const ddl = generateDDL(schema);
				const idx = ddl.find((s) => s.includes('idx_users_email_unique'));
				expect(idx).toBeDefined();
				expect(idx).toBe(
					'CREATE UNIQUE INDEX "idx_users_email_unique" ON "users" ("email") NULLS NOT DISTINCT WHERE deleted_at IS NULL;',
				);
			});
		});
	});

	describe('DROP TABLE', () => {
		it('should generate DROP TABLE IF EXISTS with CASCADE', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema, { includeDropStatements: true });

			expect(ddl[0]).toBe('DROP TABLE IF EXISTS "users" CASCADE;');
		});

		it('should drop tables in reverse order', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						} satisfies TableIR,
					],
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'user_id', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['user_id'],
									references: { table: 'users', columns: ['id'] },
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema, { includeDropStatements: true });

			// Should drop posts before users (reverse order)
			const postsDropIndex = ddl.findIndex((stmt) =>
				stmt.includes('DROP TABLE IF EXISTS "posts"'),
			);
			const usersDropIndex = ddl.findIndex((stmt) =>
				stmt.includes('DROP TABLE IF EXISTS "users"'),
			);

			expect(postsDropIndex).toBeLessThan(usersDropIndex);
		});
	});

	describe('Full Schema DDL', () => {
		it('should generate complete DDL for a multi-table schema', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{
									name: 'email',
									type: 'string',
									nullable: false,
									unique: true,
								},
								{
									name: 'created_at',
									type: 'timestamp',
									nullable: false,
									default: { sql: 'now()' },
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [{ columns: ['created_at'] } satisfies IndexIR],
						} satisfies TableIR,
					],
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{
									name: 'id',
									type: 'integer',
									nullable: false,
									autoIncrement: true,
								},
								{ name: 'user_id', type: 'integer', nullable: false },
								{ name: 'title', type: 'string', nullable: false },
								{
									name: 'published',
									type: 'boolean',
									nullable: false,
									default: false,
								},
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['user_id'],
									references: { table: 'users', columns: ['id'] },
									onDelete: 'CASCADE',
								} satisfies ForeignKeyIR,
							],
							indexes: [],
						} satisfies TableIR,
					],
				]),
				relations: new Map(),
			} as unknown as ModelIR;

			const ddl = generateDDL(schema);

			// Should contain:
			// - 2 CREATE TABLE statements
			// - 1 ALTER TABLE for FK
			// - 2 CREATE INDEX (1 explicit + 1 auto-generated for FK)
			expect(ddl.length).toBeGreaterThanOrEqual(5);

			// Verify order: CREATE TABLE -> ALTER TABLE -> CREATE INDEX
			const createTableCount = ddl.filter((stmt) =>
				stmt.includes('CREATE TABLE'),
			).length;
			const alterTableCount = ddl.filter((stmt) =>
				stmt.includes('ALTER TABLE'),
			).length;
			const createIndexCount =
				ddl.filter((stmt) => stmt.includes('CREATE')).length - createTableCount;

			expect(createTableCount).toBe(2);
			expect(alterTableCount).toBe(1);
			expect(createIndexCount).toBe(2);
		});
	});
});

describe('CHECK constraints in DDL', () => {
	it('should emit CHECK constraints after table creation', () => {
		const schema = {
			tables: new Map([
				[
					'users',
					{
						name: 'users',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								autoIncrement: true,
							},
							{ name: 'age', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
						],
					} satisfies TableIR,
				],
			]),
			relations: new Map(),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		// CREATE TABLE comes first
		expect(stmts[0]).toContain('CREATE TABLE');
		// CHECK constraint statement comes after
		const checkStmt = stmts.find((s) => s.includes('CHECK'));
		expect(checkStmt).toBe(
			'ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0));',
		);
	});

	it('should emit no CHECK statements when table has no checkConstraints', () => {
		const schema = {
			tables: new Map([
				[
					'users',
					{
						name: 'users',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								autoIncrement: true,
							},
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					} satisfies TableIR,
				],
			]),
			relations: new Map(),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		const checkStmt = stmts.find((s) => s.includes('CHECK'));
		expect(checkStmt).toBeUndefined();
	});

	it('should emit CHECK constraints after FK constraints and before indexes', () => {
		const schema = {
			tables: new Map([
				[
					'orders',
					{
						name: 'orders',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								autoIncrement: true,
							},
							{ name: 'amount', type: 'decimal', nullable: false },
							{ name: 'user_id', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['user_id'],
								references: { table: 'users', columns: ['id'] },
							} satisfies ForeignKeyIR,
						],
						indexes: [
							{
								name: 'idx_orders_amount',
								columns: ['amount'],
								unique: false,
							} satisfies IndexIR,
						],
						checkConstraints: [
							{
								name: 'orders_amount_check',
								expression: 'CHECK ((amount > 0))',
							},
						],
					} satisfies TableIR,
				],
				[
					'users',
					{
						name: 'users',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								autoIncrement: true,
							},
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					} satisfies TableIR,
				],
			]),
			relations: new Map(),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		const createIdx = stmts.findIndex((s) =>
			s.includes('CREATE TABLE "orders"'),
		);
		const fkIdx = stmts.findIndex(
			(s) => s.includes('ADD CONSTRAINT') && s.includes('FOREIGN KEY'),
		);
		const checkIdx = stmts.findIndex((s) => s.includes('orders_amount_check'));
		const indexIdx = stmts.findIndex(
			(s) => s.includes('CREATE') && s.includes('INDEX'),
		);

		expect(createIdx).toBeGreaterThanOrEqual(0);
		expect(fkIdx).toBeGreaterThan(createIdx);
		expect(checkIdx).toBeGreaterThan(fkIdx);
		expect(indexIdx).toBeGreaterThan(fkIdx);
	});
});

describe('ENUM types in DDL', () => {
	it('should emit CREATE TYPE before CREATE TABLE', () => {
		const schema = {
			tables: new Map([
				[
					'users',
					{
						name: 'users',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						foreignKeys: [],
						indexes: [],
					} satisfies import('@dbsp/types').TableIR,
				],
			]),
			relations: new Map(),
			enums: new Map([
				['status', { name: 'status', values: ['active', 'inactive'] }],
			]),
			getTable: () => undefined,
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		const typeIdx = stmts.findIndex((s) => s.includes('CREATE TYPE'));
		const tableIdx = stmts.findIndex((s) => s.includes('CREATE TABLE'));
		expect(typeIdx).toBeGreaterThanOrEqual(0);
		expect(typeIdx).toBeLessThan(tableIdx);
	});

	it('should emit correct CREATE TYPE SQL', () => {
		const schema = {
			tables: new Map(),
			relations: new Map(),
			enums: new Map([
				[
					'status',
					{ name: 'status', values: ['active', 'inactive', 'pending'] },
				],
			]),
			getTable: () => undefined,
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		expect(stmts).toContain(
			"CREATE TYPE \"status\" AS ENUM ('active', 'inactive', 'pending');",
		);
	});

	it('should let schemaName override EnumIR.schema for CREATE TYPE', () => {
		const schema = {
			tables: new Map(),
			relations: new Map(),
			enums: new Map([
				[
					'role',
					{
						name: 'role',
						schema: 'ignored',
						values: ['admin', 'user'],
					},
				],
			]),
			getTable: () => undefined,
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;

		expect(generateDDL(schema, { schemaName: 'tenant_1' })).toEqual([
			'CREATE TYPE "tenant_1"."role" AS ENUM (\'admin\', \'user\');',
		]);
	});

	it('should use EnumIR.schema for introspected enum DDL without schemaName', () => {
		const schema = {
			tables: new Map([
				[
					'users',
					{
						name: 'users',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{
								name: 'status',
								type: 'string',
								nullable: false,
								originalDbType: 'status',
								originalDbTypeSchema: 'tenant_1',
								originalDbTypeSchemaScope: 'target',
							},
						],
						foreignKeys: [],
						indexes: [],
					} satisfies import('@dbsp/types').TableIR,
				],
			]),
			relations: new Map(),
			enums: new Map([
				[
					'status',
					{
						name: 'status',
						schema: 'tenant_1',
						values: ['active', 'inactive'],
					},
				],
			]),
			getTable: () => undefined,
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		expect(stmts).toEqual([
			'CREATE TYPE "tenant_1"."status" AS ENUM (\'active\', \'inactive\');',
			`CREATE TABLE "users" (
  "id" INTEGER NOT NULL,
  "status" "tenant_1".status NOT NULL
);`,
		]);
	});

	it('should skip ENUM pass when schema has no enums', () => {
		const schema = {
			tables: new Map([
				[
					'users',
					{
						name: 'users',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						foreignKeys: [],
						indexes: [],
					} satisfies import('@dbsp/types').TableIR,
				],
			]),
			relations: new Map(),
			getTable: () => undefined,
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema);
		expect(stmts.some((s) => s.includes('CREATE TYPE'))).toBe(false);
	});
});

// ============================================================================
// FK Enhancements: onUpdate + deferred in DDL
// ============================================================================

describe('FK enhancements in DDL', () => {
	function makeSimpleSchema(fk: ForeignKeyIR): ModelIR {
		const usersTable: TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		const ordersTable: TableIR = {
			name: 'orders',
			columns: [{ name: 'user_id', type: 'integer', nullable: false }],
			foreignKeys: [fk],
			indexes: [],
		};
		return {
			tables: new Map([
				['users', usersTable],
				['orders', ordersTable],
			]),
			relations: new Map(),
			enums: new Map(),
			getTable: (name) =>
				[usersTable, ordersTable].find((t) => t.name === name),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;
	}

	it('should emit ON UPDATE CASCADE', () => {
		const schema = makeSimpleSchema({
			columns: ['user_id'],
			references: { table: 'users', columns: ['id'] },
			onUpdate: 'CASCADE',
		});
		const stmts = generateDDL(schema);
		const fkStmt = stmts.find((s) => s.includes('FOREIGN KEY'));
		expect(fkStmt).toBeDefined();
		expect(fkStmt).toContain('ON UPDATE CASCADE');
	});

	it('should emit DEFERRABLE INITIALLY DEFERRED', () => {
		const schema = makeSimpleSchema({
			columns: ['user_id'],
			references: { table: 'users', columns: ['id'] },
			deferred: true,
		});
		const stmts = generateDDL(schema);
		const fkStmt = stmts.find((s) => s.includes('FOREIGN KEY'));
		expect(fkStmt).toBeDefined();
		expect(fkStmt).toContain('DEFERRABLE INITIALLY DEFERRED');
	});

	it('should NOT emit ON UPDATE when absent', () => {
		const schema = makeSimpleSchema({
			columns: ['user_id'],
			references: { table: 'users', columns: ['id'] },
		});
		const stmts = generateDDL(schema);
		const fkStmt = stmts.find((s) => s.includes('FOREIGN KEY'));
		expect(fkStmt).toBeDefined();
		expect(fkStmt).not.toContain('ON UPDATE');
		expect(fkStmt).not.toContain('DEFERRABLE');
	});

	it('should emit declared referenced schema verbatim with naming transforms', () => {
		const usersTable: TableIR = {
			name: 'tenantUsers',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		const tokensTable: TableIR = {
			name: 'apiTokens',
			columns: [{ name: 'tenantUserId', type: 'integer', nullable: false }],
			foreignKeys: [
				{
					columns: ['tenantUserId'],
					references: {
						schema: 'authData',
						table: 'tenantUsers',
						columns: ['id'],
					},
				},
			],
			indexes: [],
		};
		const schema = {
			tables: new Map([
				['tenantUsers', usersTable],
				['apiTokens', tokensTable],
			]),
			relations: new Map(),
			enums: new Map(),
			getTable: (name) =>
				[usersTable, tokensTable].find((t) => t.name === name),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;

		const stmts = generateDDL(schema, { naming: camelCaseNaming });
		const fkStmt = stmts.find((s) => s.includes('FOREIGN KEY'));

		expect(fkStmt).toContain('ALTER TABLE "api_tokens"');
		expect(fkStmt).toContain('FOREIGN KEY ("tenant_user_id")');
		expect(fkStmt).toContain('REFERENCES "authData"."tenant_users" ("id")');
		expect(fkStmt).not.toContain('"auth_data"');
	});
});

// ============================================================================
// Block 5: Column Enhancements in DDL
// ============================================================================

describe('Column enhancements in DDL', () => {
	function makeSchemaWithTable(table: import('@dbsp/types').TableIR): ModelIR {
		return {
			tables: new Map([[table.name, table]]),
			relations: new Map(),
			enums: new Map(),
			getTable: (name) => (name === table.name ? table : undefined),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		} as unknown as ModelIR;
	}

	it('should emit COLLATE in column definition', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [
				{ name: 'name', type: 'string', nullable: false, collation: 'en_US' },
			],
			foreignKeys: [],
			indexes: [],
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		const createStmt = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createStmt).toBeDefined();
		expect(createStmt).toContain('COLLATE "en_US"');
	});

	it('should emit GENERATED ALWAYS AS IDENTITY', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [
				{ name: 'id', type: 'integer', nullable: false, identity: 'always' },
			],
			foreignKeys: [],
			indexes: [],
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		const createStmt = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createStmt).toBeDefined();
		expect(createStmt).toContain('GENERATED ALWAYS AS IDENTITY');
	});

	it('should emit GENERATED BY DEFAULT AS IDENTITY', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [
				{ name: 'id', type: 'integer', nullable: false, identity: 'byDefault' },
			],
			foreignKeys: [],
			indexes: [],
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		const createStmt = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createStmt).toBeDefined();
		expect(createStmt).toContain('GENERATED BY DEFAULT AS IDENTITY');
	});

	it('should emit COMMENT ON TABLE after indexes', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [{ name: 'idx_users_id', columns: ['id'] }],
			comment: 'User accounts',
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		const commentIdx = stmts.findIndex((s) => s.includes('COMMENT ON TABLE'));
		const indexIdx = stmts.findIndex((s) => s.includes('CREATE INDEX'));
		expect(commentIdx).toBeGreaterThan(-1);
		expect(commentIdx).toBeGreaterThan(indexIdx);
		expect(stmts[commentIdx]).toMatch(
			/COMMENT ON TABLE "users" IS 'User accounts'/,
		);
	});

	it('should emit COMMENT ON COLUMN', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [
				{
					name: 'email',
					type: 'string',
					nullable: false,
					comment: 'Primary email',
				},
			],
			foreignKeys: [],
			indexes: [],
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		const commentStmt = stmts.find((s) => s.includes('COMMENT ON COLUMN'));
		expect(commentStmt).toBeDefined();
		expect(commentStmt).toMatch(
			/COMMENT ON COLUMN "users"\."email" IS 'Primary email'/,
		);
	});

	it('should escape single quotes in COMMENT', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [],
			foreignKeys: [],
			indexes: [],
			comment: "O'Brien's table",
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		const commentStmt = stmts.find((s) => s.includes('COMMENT ON TABLE'));
		expect(commentStmt).toContain("O''Brien''s table");
	});

	it('should not emit COMMENT statements when none are present', () => {
		const table: import('@dbsp/types').TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		const stmts = generateDDL(makeSchemaWithTable(table));
		expect(stmts.some((s) => s.includes('COMMENT ON'))).toBe(false);
	});
});

// ============================================================================
// Extensions and Sequences in DDL
// ============================================================================

describe('Extensions and sequences in DDL', () => {
	it('should emit CREATE EXTENSION before tables', () => {
		const model = new ModelIRImpl(
			new Map([
				[
					'users',
					{
						name: 'users',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					} satisfies TableIR,
				],
			]),
			new Map(),
			undefined,
			['uuid-ossp'],
		);
		const stmts = generateDDL(model);
		const extIdx = stmts.findIndex((s) => s.includes('CREATE EXTENSION'));
		const tableIdx = stmts.findIndex((s) => s.includes('CREATE TABLE'));
		expect(extIdx).toBeGreaterThanOrEqual(0);
		expect(tableIdx).toBeGreaterThan(extIdx);
	});

	it('should emit correct CREATE EXTENSION statement', () => {
		const model = new ModelIRImpl(new Map(), new Map(), undefined, [
			'pgcrypto',
			'uuid-ossp',
		]);
		const stmts = generateDDL(model);
		expect(stmts).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
		expect(stmts).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
	});

	it('should emit CREATE SEQUENCE before tables', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1, incrementBy: 1 };
		const model = new ModelIRImpl(
			new Map([
				[
					'orders',
					{
						name: 'orders',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					} satisfies TableIR,
				],
			]),
			new Map(),
			undefined,
			undefined,
			new Map([['order_seq', seq]]),
		);
		const stmts = generateDDL(model);
		const seqIdx = stmts.findIndex((s) => s.includes('CREATE SEQUENCE'));
		const tableIdx = stmts.findIndex((s) => s.includes('CREATE TABLE'));
		expect(seqIdx).toBeGreaterThanOrEqual(0);
		expect(tableIdx).toBeGreaterThan(seqIdx);
	});

	it('should emit CREATE SEQUENCE with all options', () => {
		const seq: SequenceIR = {
			name: 'order_seq',
			startWith: 100,
			incrementBy: 5,
			minValue: 1,
			maxValue: 9999,
			cycle: true,
		};
		const model = new ModelIRImpl(
			new Map(),
			new Map(),
			undefined,
			undefined,
			new Map([['order_seq', seq]]),
		);
		const stmts = generateDDL(model);
		expect(stmts).toContain(
			'CREATE SEQUENCE "order_seq" START WITH 100 INCREMENT BY 5 MINVALUE 1 MAXVALUE 9999 CYCLE;',
		);
	});

	it('should qualify sequence name with schemaName', () => {
		const seq: SequenceIR = { name: 'order_seq' };
		const model = new ModelIRImpl(
			new Map(),
			new Map(),
			undefined,
			undefined,
			new Map([['order_seq', seq]]),
		);
		const stmts = generateDDL(model, { schemaName: 'myschema' });
		expect(stmts.some((s) => s.includes('"myschema"."order_seq"'))).toBe(true);
	});

	it('should emit extensions before sequences before tables', () => {
		const seq: SequenceIR = { name: 'order_seq' };
		const model = new ModelIRImpl(
			new Map([
				[
					'orders',
					{
						name: 'orders',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					} satisfies TableIR,
				],
			]),
			new Map(),
			undefined,
			['uuid-ossp'],
			new Map([['order_seq', seq]]),
		);
		const stmts = generateDDL(model);
		const extIdx = stmts.findIndex((s) => s.includes('CREATE EXTENSION'));
		const seqIdx = stmts.findIndex((s) => s.includes('CREATE SEQUENCE'));
		const tableIdx = stmts.findIndex((s) => s.includes('CREATE TABLE'));
		expect(extIdx).toBeGreaterThanOrEqual(0);
		expect(seqIdx).toBeGreaterThanOrEqual(0);
		expect(extIdx).toBeLessThan(seqIdx);
		expect(seqIdx).toBeLessThan(tableIdx);
	});

	it('should skip extensions/sequences passes when not present', () => {
		const table: TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		const model = new ModelIRImpl(new Map([['users', table]]), new Map());
		const stmts = generateDDL(model);
		expect(stmts.some((s) => s.includes('CREATE EXTENSION'))).toBe(false);
		expect(stmts.some((s) => s.includes('CREATE SEQUENCE'))).toBe(false);
	});
});

// ============================================================================
// Partitioning DDL Tests
// ============================================================================

describe('Partitioning in DDL', () => {
	function makePartitionedModel(
		tableName: string,
		partition: PartitionIR,
	): ModelIR {
		const table: TableIR = {
			name: tableName,
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'created_at', type: 'timestamp', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			partition,
		};
		return new ModelIRImpl(new Map([[tableName, table]]), new Map());
	}

	it('should emit PARTITION BY RANGE in CREATE TABLE', () => {
		const model = makePartitionedModel('events', {
			strategy: 'RANGE',
			columns: ['created_at'],
		});
		const stmts = generateDDL(model);
		const createSql = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toBeDefined();
		expect(createSql).toContain('PARTITION BY RANGE ("created_at")');
		expect(createSql).toMatch(/\)\s+PARTITION BY RANGE/);
	});

	it('should emit PARTITION BY LIST in CREATE TABLE', () => {
		const model = makePartitionedModel('orders', {
			strategy: 'LIST',
			columns: ['region'],
		});
		const stmts = generateDDL(model);
		const createSql = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toContain('PARTITION BY LIST ("region")');
	});

	it('should emit PARTITION BY HASH in CREATE TABLE', () => {
		const model = makePartitionedModel('logs', {
			strategy: 'HASH',
			columns: ['id'],
		});
		const stmts = generateDDL(model);
		const createSql = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toContain('PARTITION BY HASH ("id")');
	});

	it('should not emit PARTITION BY for non-partitioned tables', () => {
		const table: TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		const model = new ModelIRImpl(new Map([['users', table]]), new Map());
		const stmts = generateDDL(model);
		const createSql = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).not.toContain('PARTITION BY');
	});

	it('should support multi-column partition keys', () => {
		const model = makePartitionedModel('sales', {
			strategy: 'RANGE',
			columns: ['year', 'month'],
		});
		const stmts = generateDDL(model);
		const createSql = stmts.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toContain('PARTITION BY RANGE ("year", "month")');
	});
});

describe('DDL Generation with Capabilities (CAPS-003)', () => {
	/** Build a rich ModelIR with enums, extensions, sequences, check constraints */
	function makeFullModel() {
		const table: TableIR = {
			name: 'orders',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'amount', type: 'decimal', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			checkConstraints: [
				{ name: 'orders_amount_check', expression: 'CHECK ((amount > 0))' },
			],
		};
		return new ModelIRImpl(
			new Map([['orders', table]]),
			new Map(),
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
			['uuid-ossp'],
			new Map([
				['order_seq', { name: 'order_seq', startWith: 1, incrementBy: 1 }],
			]),
		);
	}

	const noEnumCaps: DialectCapabilities = {
		...POSTGRESQL_CAPABILITIES,
		supportsDDLEnumTypes: false,
	};

	const noCheckCaps: DialectCapabilities = {
		...POSTGRESQL_CAPABILITIES,
		supportsDDLCheckConstraints: false,
	};

	const noExtCaps: DialectCapabilities = {
		...POSTGRESQL_CAPABILITIES,
		supportsDDLExtensions: false,
	};

	const noSeqCaps: DialectCapabilities = {
		...POSTGRESQL_CAPABILITIES,
		supportsDDLSequences: false,
	};

	// SC-09: Skip unsupported ENUMs
	it('should skip CREATE TYPE when supportsDDLEnumTypes is false', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model, { dialectCapabilities: noEnumCaps });
		expect(stmts.some((s) => s.includes('CREATE TYPE'))).toBe(false);
		// CREATE TABLE must still be present
		expect(stmts.some((s) => s.includes('CREATE TABLE'))).toBe(true);
	});

	// SC-10: PG generates everything
	it('should include all DDL features with POSTGRESQL_CAPABILITIES', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		expect(stmts.some((s) => s.includes('CREATE TYPE'))).toBe(true);
		expect(stmts.some((s) => s.includes('CREATE SEQUENCE'))).toBe(true);
		expect(stmts.some((s) => s.includes('CREATE EXTENSION'))).toBe(true);
	});

	// SC-12: Partial support — CHECK yes, ENUMs no
	it('should generate CHECK but skip ENUMs when partially supported', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model, { dialectCapabilities: noEnumCaps });
		// No ENUM
		expect(stmts.some((s) => s.includes('CREATE TYPE'))).toBe(false);
		// CHECK still present
		expect(stmts.some((s) => s.includes('CHECK'))).toBe(true);
	});

	it('should skip CHECK constraints when supportsDDLCheckConstraints is false', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model, { dialectCapabilities: noCheckCaps });
		expect(stmts.some((s) => s.includes('CHECK'))).toBe(false);
		// Table still created
		expect(stmts.some((s) => s.includes('CREATE TABLE'))).toBe(true);
	});

	it('should skip CREATE EXTENSION when supportsDDLExtensions is false', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model, { dialectCapabilities: noExtCaps });
		expect(stmts.some((s) => s.includes('CREATE EXTENSION'))).toBe(false);
	});

	it('should skip CREATE SEQUENCE when supportsDDLSequences is false', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model, { dialectCapabilities: noSeqCaps });
		expect(stmts.some((s) => s.includes('CREATE SEQUENCE'))).toBe(false);
	});

	it('should generate all features when no dialectCapabilities provided (backward compat)', () => {
		const model = makeFullModel();
		const stmts = generateDDL(model);
		expect(stmts.some((s) => s.includes('CREATE TYPE'))).toBe(true);
		expect(stmts.some((s) => s.includes('CREATE SEQUENCE'))).toBe(true);
		expect(stmts.some((s) => s.includes('CREATE EXTENSION'))).toBe(true);
		expect(stmts.some((s) => s.includes('CHECK'))).toBe(true);
	});
});
