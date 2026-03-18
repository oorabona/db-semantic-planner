/**
 * DDL Generator Tests
 */

import type { ForeignKeyIR, IndexIR, ModelIR, TableIR } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
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
