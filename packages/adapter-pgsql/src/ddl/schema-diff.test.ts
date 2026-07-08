import { ModelIRImpl, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type {
	ColumnIR,
	DialectCapabilities,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
	PartitionIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	type CompareSchemataOptions,
	compareSchemata,
	type SchemaChange,
} from './schema-diff.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTable(overrides: Partial<TableIR> & { name: string }): TableIR {
	return {
		columns: [],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function makeCol(overrides: Partial<ColumnIR> & { name: string }): ColumnIR {
	return {
		type: 'string',
		nullable: false,
		...overrides,
	};
}

function makeModel(tables: TableIR[], externalTables?: Iterable<string>) {
	const tableMap = new Map(tables.map((t) => [t.name, t]));
	return new ModelIRImpl(
		tableMap,
		new Map(),
		undefined,
		undefined,
		undefined,
		externalTables,
	);
}

function changeKinds(changes: readonly SchemaChange[]) {
	return changes.map((c) => c.kind);
}

// ============================================================================
// Tests
// ============================================================================

describe('compareSchemata', () => {
	describe('table-level changes', () => {
		it('should detect new tables', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('create_table');
			expect(diff.changes[0]!.table).toBe('users');
			expect(diff.changes[0]!.destructive).toBe(false);
			expect(diff.summary.tables.added).toBe(1);
		});

		it('should detect dropped tables', () => {
			const schema = makeModel([]);
			const db = makeModel([
				makeTable({
					name: 'legacy',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_table');
			expect(diff.changes[0]!.table).toBe('legacy');
			expect(diff.changes[0]!.destructive).toBe(true);
			expect(diff.hasDestructive).toBe(true);
			expect(diff.summary.tables.dropped).toBe(1);
		});

		it('should not drop declared external tables', () => {
			const posts = makeTable({
				name: 'posts',
				columns: [
					makeCol({ name: 'id', type: 'integer' }),
					makeCol({ name: 'tenant_id', type: 'integer' }),
				],
				foreignKeys: [
					{
						columns: ['tenant_id'],
						references: { table: 'tenants', columns: ['id'] },
					},
				],
			});
			const tenants = makeTable({
				name: 'tenants',
				columns: [makeCol({ name: 'id', type: 'integer' })],
			});
			const schema = makeModel([posts], ['tenants']);
			const db = makeModel([posts, tenants]);

			const diff = compareSchemata(schema, db);

			expect(
				diff.changes.some(
					(c) => c.kind === 'drop_table' && c.table === 'tenants',
				),
			).toBe(false);
		});

		it('should produce no changes for identical schemas', () => {
			const table = makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', type: 'integer' })],
				primaryKey: 'id',
			});
			const schema = makeModel([table]);
			const db = makeModel([table]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
			expect(diff.hasDestructive).toBe(false);
		});
	});

	describe('column-level changes', () => {
		it('should detect added columns', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'email', type: 'string' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_column');
			expect(diff.changes[0]!.column).toBe('email');
			expect(diff.summary.columns.added).toBe(1);
		});

		it('should detect dropped columns', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'legacy_col', type: 'string' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_column');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect type changes', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'age', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'age', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect nullable changes', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string', nullable: true })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'email', type: 'string', nullable: false }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_nullable');
			expect(diff.changes[0]!.destructive).toBe(false);
		});

		it('should detect default changes', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: true }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: false }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_default');
		});

		it('should not flag identical defaults', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: true }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: true }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	describe('primary key changes', () => {
		it('should detect added PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
					primaryKey: 'id',
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_primary_key');
		});

		it('should detect dropped PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
					primaryKey: 'id',
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_primary_key');
			expect(diff.changes[0]!.destructive).toBe(true);
			expect(diff.changes[0]!.meta).toEqual({ columns: ['id'] });
		});

		it('should detect PK column change (drop+add)', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'uuid', type: 'uuid' }),
					],
					primaryKey: 'uuid',
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'uuid', type: 'uuid' }),
					],
					primaryKey: 'id',
				}),
			]);

			const diff = compareSchemata(schema, db);

			const kinds = changeKinds(diff.changes);
			expect(kinds).toContain('drop_primary_key');
			expect(kinds).toContain('add_primary_key');
			const dropPK = diff.changes.find((c) => c.kind === 'drop_primary_key');
			expect(dropPK?.meta).toEqual({ columns: ['id'] });
		});

		it('should handle composite PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'order_items',
					columns: [
						makeCol({ name: 'order_id', type: 'integer' }),
						makeCol({ name: 'product_id', type: 'integer' }),
					],
					primaryKey: ['order_id', 'product_id'],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'order_items',
					columns: [
						makeCol({ name: 'order_id', type: 'integer' }),
						makeCol({ name: 'product_id', type: 'integer' }),
					],
					primaryKey: ['order_id', 'product_id'],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	describe('foreign key changes', () => {
		const usersFk: ForeignKeyIR = {
			columns: ['author_id'],
			references: { table: 'users', columns: ['id'] },
			onDelete: 'CASCADE',
		};

		it('should detect added FK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [usersFk],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_foreign_key');
			expect(diff.summary.constraints.added).toBe(1);
		});

		it('should detect dropped FK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [usersFk],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_foreign_key');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect onDelete change', () => {
			const fkSetNull: ForeignKeyIR = { ...usersFk, onDelete: 'SET NULL' };

			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [usersFk],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [fkSetNull],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_foreign_key');
			expect(diff.summary.constraints.altered).toBe(1);
		});
	});

	describe('index changes', () => {
		const emailIdx: IndexIR = {
			name: 'idx_users_email',
			columns: ['email'],
			unique: true,
		};

		it('should detect new index', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [emailIdx],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('create_index');
			expect(diff.summary.indexes.added).toBe(1);
		});

		it('should detect dropped index', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [emailIdx],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_index');
		});

		it('should match indexes by columns+unique, not name', () => {
			const schemaIdx: IndexIR = {
				name: 'new_name',
				columns: ['email'],
				unique: true,
			};

			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [schemaIdx],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [emailIdx],
				}),
			]);

			// Same columns, same unique → no change (names differ but that's cosmetic)
			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});

		describe('Index enhancements', () => {
			it('should detect index method change as drop+create', () => {
				const schemaIdx: IndexIR = {
					name: 'idx_posts_body',
					columns: ['body'],
					method: 'gin',
				};
				const dbIdx: IndexIR = {
					name: 'idx_posts_body',
					columns: ['body'],
					// no method → btree (default)
				};

				const schema = makeModel([
					makeTable({
						name: 'posts',
						columns: [makeCol({ name: 'body', type: 'string' })],
						indexes: [schemaIdx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'posts',
						columns: [makeCol({ name: 'body', type: 'string' })],
						indexes: [dbIdx],
					}),
				]);

				const diff = compareSchemata(schema, db);
				const kinds = changeKinds(diff.changes);
				expect(kinds).toContain('create_index');
				expect(kinds).toContain('drop_index');
			});

			it('should detect partial index WHERE change', () => {
				const schemaIdx: IndexIR = {
					name: 'idx_users_active_email',
					columns: ['email'],
					where: 'active = true',
				};
				const dbIdx: IndexIR = {
					name: 'idx_users_active_email',
					columns: ['email'],
					// no WHERE
				};

				const schema = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string' })],
						indexes: [schemaIdx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string' })],
						indexes: [dbIdx],
					}),
				]);

				const diff = compareSchemata(schema, db);
				const kinds = changeKinds(diff.changes);
				expect(kinds).toContain('create_index');
				expect(kinds).toContain('drop_index');
			});

			it('should detect unique NULLS NOT DISTINCT change', () => {
				const schemaIdx: IndexIR = {
					name: 'idx_users_email_unique',
					columns: ['email'],
					unique: true,
					nullsNotDistinct: true,
				};
				const dbIdx: IndexIR = {
					name: 'idx_users_email_unique',
					columns: ['email'],
					unique: true,
				};

				const schema = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string' })],
						indexes: [schemaIdx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string' })],
						indexes: [dbIdx],
					}),
				]);

				const diff = compareSchemata(schema, db);
				const kinds = changeKinds(diff.changes);
				expect(kinds).toContain('create_index');
				expect(kinds).toContain('drop_index');
			});

			it('should detect opclass change', () => {
				const schemaIdx: IndexIR = {
					name: 'idx_posts_title',
					columns: ['title'],
					method: 'gin',
					opclass: { title: 'gin_trgm_ops' },
				};
				const dbIdx: IndexIR = {
					name: 'idx_posts_title',
					columns: ['title'],
					method: 'gin',
					// no opclass → default
				};

				const schema = makeModel([
					makeTable({
						name: 'posts',
						columns: [makeCol({ name: 'title', type: 'string' })],
						indexes: [schemaIdx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'posts',
						columns: [makeCol({ name: 'title', type: 'string' })],
						indexes: [dbIdx],
					}),
				]);

				const diff = compareSchemata(schema, db);
				const kinds = changeKinds(diff.changes);
				expect(kinds).toContain('create_index');
				expect(kinds).toContain('drop_index');
			});

			it('should detect WITH params change', () => {
				const schemaIdx: IndexIR = {
					name: 'idx_embeddings',
					columns: ['vec'],
					method: 'hnsw',
					with: { m: '16' },
				};
				const dbIdx: IndexIR = {
					name: 'idx_embeddings',
					columns: ['vec'],
					method: 'hnsw',
					// no WITH params
				};

				const schema = makeModel([
					makeTable({
						name: 'embeddings',
						columns: [makeCol({ name: 'vec', type: 'string' })],
						indexes: [schemaIdx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'embeddings',
						columns: [makeCol({ name: 'vec', type: 'string' })],
						indexes: [dbIdx],
					}),
				]);

				const diff = compareSchemata(schema, db);
				const kinds = changeKinds(diff.changes);
				expect(kinds).toContain('create_index');
				expect(kinds).toContain('drop_index');
			});

			it('should ignore identical enhanced indexes', () => {
				const idx: IndexIR = {
					name: 'idx_posts_title_trgm',
					columns: ['title'],
					method: 'gin',
					opclass: { title: 'gin_trgm_ops' },
					where: 'published = true',
					with: { fastupdate: 'on' },
				};

				const schema = makeModel([
					makeTable({
						name: 'posts',
						columns: [makeCol({ name: 'title', type: 'string' })],
						indexes: [idx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'posts',
						columns: [makeCol({ name: 'title', type: 'string' })],
						indexes: [idx],
					}),
				]);

				const diff = compareSchemata(schema, db);
				expect(diff.changes).toHaveLength(0);
			});
		});

		describe('implicit unique index suppression', () => {
			it('should not emit drop_index for col.unique=true implicit index', () => {
				// Schema: column with unique: true (no explicit index in indexes[])
				// DB: introspection adds the implicit unique index to indexes[]
				// Expected: no drop_index emitted — the index is auto-managed
				const schema = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string', unique: true })],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string', unique: true })],
						indexes: [
							{ name: 'users_email_key', columns: ['email'], unique: true },
						],
					}),
				]);

				const diff = compareSchemata(schema, db);
				expect(diff.changes).toHaveLength(0);
			});

			it('should still emit drop_index for explicit non-auto unique indexes', () => {
				// A unique index NOT backed by col.unique=true should still be dropped
				const schema = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string' })],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string' })],
						indexes: [
							{ name: 'idx_users_email', columns: ['email'], unique: true },
						],
					}),
				]);

				const diff = compareSchemata(schema, db);
				expect(diff.changes).toHaveLength(1);
				expect(diff.changes[0]!.kind).toBe('drop_index');
			});

			it('should suppress drop_index for multiple unique columns', () => {
				const schema = makeModel([
					makeTable({
						name: 'users',
						columns: [
							makeCol({ name: 'email', type: 'string', unique: true }),
							makeCol({ name: 'username', type: 'string', unique: true }),
						],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'users',
						columns: [
							makeCol({ name: 'email', type: 'string', unique: true }),
							makeCol({ name: 'username', type: 'string', unique: true }),
						],
						indexes: [
							{ name: 'users_email_key', columns: ['email'], unique: true },
							{
								name: 'users_username_key',
								columns: ['username'],
								unique: true,
							},
						],
					}),
				]);

				const diff = compareSchemata(schema, db);
				expect(diff.changes).toHaveLength(0);
			});

			it('should not suppress explicit index on a unique col when col.unique differs', () => {
				// Explicit index in schema.indexes[] overrides the auto-unique suppression
				const schemaIdx: IndexIR = {
					name: 'idx_email_custom',
					columns: ['email'],
					unique: true,
				};
				const schema = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string', unique: true })],
						indexes: [schemaIdx],
					}),
				]);
				const db = makeModel([
					makeTable({
						name: 'users',
						columns: [makeCol({ name: 'email', type: 'string', unique: true })],
						indexes: [schemaIdx],
					}),
				]);

				// Explicit index matches DB index → no diff
				const diff = compareSchemata(schema, db);
				expect(diff.changes).toHaveLength(0);
			});
		});
	});

	describe('complex scenarios', () => {
		it('should handle multiple changes across tables', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'email', type: 'string' }),
					],
					primaryKey: 'id',
				}),
				makeTable({
					name: 'orders',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'user_id', type: 'integer' }),
					],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['user_id'],
							references: { table: 'users', columns: ['id'] },
							onDelete: 'CASCADE',
						},
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
					primaryKey: 'id',
				}),
			]);

			const diff = compareSchemata(schema, db);

			const kinds = changeKinds(diff.changes);
			// orders is new table, email is new column
			expect(kinds).toContain('create_table');
			expect(kinds).toContain('add_column');
			expect(diff.summary.tables.added).toBe(1);
			expect(diff.summary.columns.added).toBe(1);
		});

		it('should correctly set hasDestructive', () => {
			// No destructive changes
			const schema1 = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'new_col', type: 'string' }),
					],
				}),
			]);
			const db1 = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			expect(compareSchemata(schema1, db1).hasDestructive).toBe(false);

			// With destructive changes
			const schema2 = makeModel([]);
			const db2 = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			expect(compareSchemata(schema2, db2).hasDestructive).toBe(true);
		});
	});

	describe('meta enrichment for DOWN SQL', () => {
		it('should include oldNullable in alter_column_nullable meta', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'name', type: 'string', nullable: false }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'name', type: 'string', nullable: true }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = diff.changes.find(
				(c) => c.kind === 'alter_column_nullable',
			);
			expect(change).toBeDefined();
			expect(change!.meta?.nullable).toBe(false);
			expect(change!.meta?.oldNullable).toBe(true);
		});

		it('should include oldDefault in alter_column_default meta', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'status', type: 'string', default: 'active' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'status', type: 'string', default: 'pending' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = diff.changes.find(
				(c) => c.kind === 'alter_column_default',
			);
			expect(change).toBeDefined();
			expect(change!.meta?.default).toBe('active');
			expect(change!.meta?.oldDefault).toBe('pending');
		});

		it('should include oldDefault as undefined when DB had no default', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'status', type: 'string', default: 'active' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'status', type: 'string' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = diff.changes.find(
				(c) => c.kind === 'alter_column_default',
			);
			expect(change).toBeDefined();
			expect(change!.meta?.default).toBe('active');
			expect(change!.meta?.oldDefault).toBeUndefined();
		});

		it('should include oldFk in alter_foreign_key meta', () => {
			const schemaFk: ForeignKeyIR = {
				columns: ['author_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};
			const dbFk: ForeignKeyIR = {
				columns: ['author_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'SET NULL',
			};

			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [schemaFk],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [dbFk],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = diff.changes.find((c) => c.kind === 'alter_foreign_key');
			expect(change).toBeDefined();
			expect(change!.meta?.fk).toEqual(schemaFk);
			expect(change!.meta?.oldFk).toEqual(dbFk);
			expect(change!.meta?.previousOnDelete).toBe('SET NULL');
		});
	});

	describe('type equivalence', () => {
		it('should not flag timestamp vs datetime as a type change', () => {
			const schema = makeModel([
				makeTable({
					name: 'events',
					columns: [
						makeCol({ name: 'created_at', type: 'timestamp' }),
						makeCol({ name: 'updated_at', type: 'timestamp' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'events',
					columns: [
						makeCol({ name: 'created_at', type: 'datetime' }),
						makeCol({ name: 'updated_at', type: 'datetime' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});

		it('should flag number vs integer as a type change (number can be NUMERIC)', () => {
			const schema = makeModel([
				makeTable({
					name: 'counters',
					columns: [makeCol({ name: 'count', type: 'number' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'counters',
					columns: [makeCol({ name: 'count', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
		});

		it('should still flag genuinely different types', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'data', type: 'jsonb' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'data', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
		});
	});

	describe('default normalization', () => {
		it('should strip PostgreSQL type casts from string defaults', () => {
			const schema = makeModel([
				makeTable({
					name: 'tasks',
					columns: [
						makeCol({ name: 'status', type: 'string', default: 'pending' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'tasks',
					columns: [
						makeCol({
							name: 'status',
							type: 'string',
							default: "'pending'::character varying",
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});

		it('should strip type casts from empty string defaults', () => {
			const schema = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({ name: 'description', type: 'text', default: '' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'description',
							type: 'text',
							default: "''::text",
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});

		it('should not strip casts from function calls', () => {
			const schema = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'id',
							type: 'uuid',
							default: 'gen_random_uuid()',
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'id',
							type: 'uuid',
							default: 'gen_random_uuid()',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});

		it('should still flag genuinely different defaults', () => {
			const schema = makeModel([
				makeTable({
					name: 'tasks',
					columns: [
						makeCol({ name: 'status', type: 'string', default: 'active' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'tasks',
					columns: [
						makeCol({
							name: 'status',
							type: 'string',
							default: "'pending'::character varying",
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_default');
		});
	});

	describe('dbCasing: snake_case', () => {
		const snakeCaseOpts: CompareSchemataOptions = {
			dbCasing: 'snake_case',
		};

		it('should match camelCase schema columns to snake_case DB columns', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'uuid' }),
						makeCol({ name: 'createdAt', type: 'timestamp' }),
						makeCol({ name: 'emailVerified', type: 'boolean' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'uuid' }),
						makeCol({ name: 'created_at', type: 'timestamp' }),
						makeCol({ name: 'email_verified', type: 'boolean' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db, snakeCaseOpts);

			expect(diff.changes).toHaveLength(0);
		});

		it('should match camelCase table names to snake_case DB table names', () => {
			const schema = makeModel([
				makeTable({
					name: 'envVariables',
					columns: [makeCol({ name: 'id', type: 'uuid' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'env_variables',
					columns: [makeCol({ name: 'id', type: 'uuid' })],
				}),
			]);

			const diff = compareSchemata(schema, db, snakeCaseOpts);

			expect(diff.changes).toHaveLength(0);
		});

		it('should match camelCase PK columns to snake_case DB PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'orderItems',
					columns: [
						makeCol({ name: 'orderId', type: 'integer' }),
						makeCol({ name: 'productId', type: 'integer' }),
					],
					primaryKey: ['orderId', 'productId'],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'order_items',
					columns: [
						makeCol({ name: 'order_id', type: 'integer' }),
						makeCol({ name: 'product_id', type: 'integer' }),
					],
					primaryKey: ['order_id', 'product_id'],
				}),
			]);

			const diff = compareSchemata(schema, db, snakeCaseOpts);

			expect(diff.changes).toHaveLength(0);
		});

		it('should match camelCase FK columns and referenced table to snake_case DB', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'uuid' })],
				}),
				makeTable({
					name: 'apiTokens',
					columns: [makeCol({ name: 'userId', type: 'uuid' })],
					foreignKeys: [
						{
							columns: ['userId'],
							references: { table: 'users', columns: ['id'] },
							onDelete: 'CASCADE',
						},
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'uuid' })],
				}),
				makeTable({
					name: 'api_tokens',
					columns: [makeCol({ name: 'user_id', type: 'uuid' })],
					foreignKeys: [
						{
							columns: ['user_id'],
							references: { table: 'users', columns: ['id'] },
							onDelete: 'CASCADE',
						},
					],
				}),
			]);

			const diff = compareSchemata(schema, db, snakeCaseOpts);

			expect(diff.changes).toHaveLength(0);
		});

		it('should match camelCase index columns to snake_case DB', () => {
			const schema = makeModel([
				makeTable({
					name: 'apiTokens',
					columns: [makeCol({ name: 'tokenHash', type: 'string' })],
					indexes: [{ columns: ['tokenHash'], unique: true }],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'api_tokens',
					columns: [makeCol({ name: 'token_hash', type: 'string' })],
					indexes: [{ columns: ['token_hash'], unique: true }],
				}),
			]);

			const diff = compareSchemata(schema, db, snakeCaseOpts);

			expect(diff.changes).toHaveLength(0);
		});

		it('should still detect real differences with casing normalization', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'uuid' }),
						makeCol({ name: 'createdAt', type: 'timestamp' }),
						makeCol({ name: 'newColumn', type: 'string' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'uuid' }),
						makeCol({ name: 'created_at', type: 'timestamp' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db, snakeCaseOpts);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_column');
			expect(diff.changes[0]!.column).toBe('new_column');
		});

		it('should produce no changes without dbCasing for same-casing schemas', () => {
			// Verify backward compatibility: no options = no normalization
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'created_at', type: 'timestamp' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'created_at', type: 'timestamp' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});
	});

	// ==========================================================================
	describe('originalDbType comparison', () => {
		it('detects vector dimension change via originalDbType', () => {
			const schema = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'embedding',
							type: 'text',
							originalDbType: 'vector(1024)',
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'embedding',
							type: 'text',
							originalDbType: 'vector(768)',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
			expect(diff.changes[0]!.meta).toMatchObject({
				fromType: 'vector(768)',
				toType: 'vector(1024)',
			});
		});

		it('detects precision change via originalDbType', () => {
			const schema = makeModel([
				makeTable({
					name: 'orders',
					columns: [
						makeCol({
							name: 'price',
							type: 'decimal',
							originalDbType: 'numeric(12,4)',
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'orders',
					columns: [
						makeCol({
							name: 'price',
							type: 'decimal',
							originalDbType: 'numeric(10,2)',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
		});

		it('ignores matching originalDbType', () => {
			const schema = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'embedding',
							type: 'text',
							originalDbType: 'vector(768)',
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'embedding',
							type: 'text',
							originalDbType: 'vector(768)',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});

		it('falls back to base type when no originalDbType', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'bio', type: 'text' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'bio', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
		});

		it('does not detect change when only schema has originalDbType', () => {
			const schema = makeModel([
				makeTable({
					name: 'orders',
					columns: [
						makeCol({ name: 'price', type: 'decimal', originalDbType: 'real' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'price', type: 'decimal' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			// Only one side has originalDbType → falls back to base type comparison
			// Both base types are 'decimal' → no change detected
			expect(diff.changes).toHaveLength(0);
		});

		it('case-insensitive originalDbType comparison', () => {
			const schema = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'embedding',
							type: 'text',
							originalDbType: 'vector(768)',
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'items',
					columns: [
						makeCol({
							name: 'embedding',
							type: 'text',
							originalDbType: 'VECTOR(768)',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
		});
	});
});

describe('CHECK constraints', () => {
	it('should detect added CHECK constraint', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
			}),
		]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toEqual(['add_check_constraint']);
	});

	it('should detect dropped CHECK constraint', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
			}),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toEqual(['drop_check_constraint']);
	});

	it('should detect changed CHECK expression', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age >= 0))' },
				],
			}),
		]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toEqual([
			'drop_check_constraint',
			'add_check_constraint',
		]);
	});

	it('should emit no changes for identical CHECK constraints', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'age', type: 'number' })],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);
		const diff = compareSchemata(schema, db);
		expect(diff.changes).toEqual([]);
	});

	it('should emit CHECK constraints for new tables', () => {
		const schema = makeModel([
			makeTable({
				name: 'products',
				columns: [makeCol({ name: 'price', type: 'number' })],
				checkConstraints: [
					{ name: 'products_price_check', expression: 'CHECK ((price > 0))' },
				],
			}),
		]);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db);
		const kinds = changeKinds(diff.changes);
		expect(kinds).toContain('create_table');
		expect(kinds).toContain('add_check_constraint');
	});
});

// ============================================================================
// ENUM Types
// ============================================================================

function makeModelWithEnums(
	tables: TableIR[],
	enums: Map<string, { name: string; values: string[] }>,
) {
	const tableMap = new Map(tables.map((t) => [t.name, t]));
	return new ModelIRImpl(tableMap, new Map(), enums as Map<string, EnumIR>);
}

describe('ENUM types', () => {
	it('should detect new enum type', () => {
		const schema = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toEqual(['create_enum']);
	});

	it('should detect dropped enum type', () => {
		const schema = makeModel([]);
		const db = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toEqual(['drop_enum']);
	});

	it('should detect new enum value', () => {
		const schema = makeModelWithEnums(
			[],
			new Map([
				[
					'status',
					{ name: 'status', values: ['active', 'inactive', 'pending'] },
				],
			]),
		);
		const db = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toEqual(['alter_enum_add_value']);
	});

	it('should flag removed enum value as destructive', () => {
		const schema = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active'] }]]),
		);
		const db = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const diff = compareSchemata(schema, db);
		expect(diff.changes.some((c) => c.destructive)).toBe(true);
	});

	it('should detect no changes for identical enums', () => {
		const schema = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const db = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const diff = compareSchemata(schema, db);
		expect(diff.changes).toEqual([]);
	});

	it('should emit alter_enum_add_value with correct position metadata', () => {
		const schema = makeModelWithEnums(
			[],
			new Map([
				[
					'status',
					{ name: 'status', values: ['active', 'inactive', 'pending'] },
				],
			]),
		);
		const db = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'alter_enum_add_value');
		expect(change?.meta?.value).toBe('pending');
		expect(change?.meta?.after).toBe('inactive');
	});

	it('should mark drop_enum as destructive', () => {
		const schema = makeModel([]);
		const db = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active'] }]]),
		);
		const diff = compareSchemata(schema, db);
		expect(diff.hasDestructive).toBe(true);
	});
});

// ============================================================================
// FK Enhancements: onUpdate + deferred
// ============================================================================

describe('FK enhancements — compareForeignKeys', () => {
	const baseFk: ForeignKeyIR = {
		columns: ['user_id'],
		references: { table: 'users', columns: ['id'] },
	};
	const usersTable = makeTable({
		name: 'users',
		columns: [makeCol({ name: 'id', type: 'integer' })],
	});

	it('should detect onUpdate change', () => {
		const schema = makeTable({
			name: 'orders',
			foreignKeys: [{ ...baseFk, onUpdate: 'CASCADE' }],
		});
		const db = makeTable({
			name: 'orders',
			foreignKeys: [baseFk],
		});
		const diff = compareSchemata(
			makeModel([usersTable, schema]),
			makeModel([usersTable, db]),
		);
		const change = diff.changes.find((c) => c.kind === 'alter_foreign_key');
		expect(change).toBeDefined();
		expect(change?.details).toContain('onDelete/onUpdate/deferred');
	});

	it('should detect deferred change', () => {
		const schema = makeTable({
			name: 'orders',
			foreignKeys: [{ ...baseFk, deferred: true }],
		});
		const db = makeTable({
			name: 'orders',
			foreignKeys: [baseFk],
		});
		const diff = compareSchemata(
			makeModel([usersTable, schema]),
			makeModel([usersTable, db]),
		);
		const change = diff.changes.find((c) => c.kind === 'alter_foreign_key');
		expect(change).toBeDefined();
		expect(change?.details).toContain('onDelete/onUpdate/deferred');
	});

	it('should detect combined onDelete+onUpdate+deferred change', () => {
		const schema = makeTable({
			name: 'orders',
			foreignKeys: [
				{
					...baseFk,
					onDelete: 'CASCADE',
					onUpdate: 'SET NULL',
					deferred: true,
				},
			],
		});
		const db = makeTable({
			name: 'orders',
			foreignKeys: [{ ...baseFk, onDelete: 'RESTRICT' }],
		});
		const diff = compareSchemata(
			makeModel([usersTable, schema]),
			makeModel([usersTable, db]),
		);
		const change = diff.changes.find((c) => c.kind === 'alter_foreign_key');
		expect(change).toBeDefined();
		expect(change?.meta?.oldFk).toBeDefined();
	});

	it('should ignore identical FK with onUpdate and deferred', () => {
		const fk: ForeignKeyIR = { ...baseFk, onUpdate: 'CASCADE', deferred: true };
		const schema = makeTable({ name: 'orders', foreignKeys: [fk] });
		const db = makeTable({ name: 'orders', foreignKeys: [fk] });
		const diff = compareSchemata(
			makeModel([usersTable, schema]),
			makeModel([usersTable, db]),
		);
		expect(
			diff.changes.filter((c) => c.kind === 'alter_foreign_key'),
		).toHaveLength(0);
	});
});

// ============================================================================
// Block 5: Column Enhancements — collation, identity, comments
// ============================================================================

describe('Column enhancements', () => {
	it('should detect collation change', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'name', collation: 'en_US' })],
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'name' })] }),
		]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find(
			(c) => c.kind === 'alter_column_collation',
		);
		expect(change).toBeDefined();
		expect(change?.column).toBe('name');
		expect(change?.destructive).toBe(false);
	});

	it('should detect identity added', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', identity: 'always' })],
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'id' })] }),
		]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'alter_column_identity');
		expect(change).toBeDefined();
		expect(change?.column).toBe('id');
		expect(change?.meta?.column).toMatchObject({ identity: 'always' });
		expect(change?.meta?.previousIdentity).toBeUndefined();
	});

	it('should detect identity removed', () => {
		const schema = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'id' })] }),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', identity: 'byDefault' })],
			}),
		]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'alter_column_identity');
		expect(change).toBeDefined();
		expect(change?.meta?.previousIdentity).toBe('byDefault');
	});

	it('should detect identity type change (always → byDefault)', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', identity: 'byDefault' })],
			}),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', identity: 'always' })],
			}),
		]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'alter_column_identity');
		expect(change).toBeDefined();
		expect(change?.meta?.column).toMatchObject({ identity: 'byDefault' });
		expect(change?.meta?.previousIdentity).toBe('always');
	});

	it('should detect table comment added', () => {
		const schema = makeModel([
			makeTable({ name: 'users', columns: [], comment: 'User accounts' }),
		]);
		const db = makeModel([makeTable({ name: 'users', columns: [] })]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'add_comment');
		expect(change).toBeDefined();
		expect(change?.table).toBe('users');
		expect(change?.column).toBeUndefined();
		expect(change?.meta?.target).toBe('table');
		expect(change?.meta?.comment).toBe('User accounts');
	});

	it('should detect column comment added', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'email', comment: 'Primary email' })],
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'email' })] }),
		]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'add_comment');
		expect(change).toBeDefined();
		expect(change?.column).toBe('email');
		expect(change?.meta?.target).toBe('column');
		expect(change?.meta?.comment).toBe('Primary email');
	});

	it('should detect comment removed (→ drop_comment)', () => {
		const schema = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'email' })] }),
		]);
		const db = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'email', comment: 'Old comment' })],
			}),
		]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'drop_comment');
		expect(change).toBeDefined();
		expect(change?.column).toBe('email');
		expect(change?.meta?.target).toBe('column');
	});

	it('should ignore identical collation', () => {
		const col = makeCol({ name: 'name', collation: 'en_US' });
		const schema = makeModel([makeTable({ name: 'users', columns: [col] })]);
		const db = makeModel([makeTable({ name: 'users', columns: [col] })]);
		const diff = compareSchemata(schema, db);
		expect(
			diff.changes.filter((c) => c.kind === 'alter_column_collation'),
		).toHaveLength(0);
	});

	it('should ignore identical identity', () => {
		const col = makeCol({ name: 'id', identity: 'always' });
		const schema = makeModel([makeTable({ name: 'users', columns: [col] })]);
		const db = makeModel([makeTable({ name: 'users', columns: [col] })]);
		const diff = compareSchemata(schema, db);
		expect(
			diff.changes.filter((c) => c.kind === 'alter_column_identity'),
		).toHaveLength(0);
	});

	it('should ignore identical comment', () => {
		const table = makeTable({
			name: 'users',
			columns: [],
			comment: 'Same comment',
		});
		const schema = makeModel([table]);
		const db = makeModel([table]);
		const diff = compareSchemata(schema, db);
		expect(
			diff.changes.filter(
				(c) => c.kind === 'add_comment' || c.kind === 'drop_comment',
			),
		).toHaveLength(0);
	});
});

// ============================================================================
// Extensions
// ============================================================================

function makeModelWithExtensions(extensions: string[]) {
	return new ModelIRImpl(new Map(), new Map(), undefined, extensions);
}

describe('Extensions', () => {
	it('should detect new extension', () => {
		const schema = makeModelWithExtensions(['uuid-ossp']);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('create_extension');
		const change = diff.changes.find((c) => c.kind === 'create_extension');
		expect(change?.meta?.extension).toBe('uuid-ossp');
		expect(change?.destructive).toBe(false);
	});

	it('should detect dropped extension', () => {
		const schema = makeModel([]);
		const db = makeModelWithExtensions(['uuid-ossp']);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('drop_extension');
		const change = diff.changes.find((c) => c.kind === 'drop_extension');
		expect(change?.meta?.extension).toBe('uuid-ossp');
		expect(change?.destructive).toBe(true);
	});

	it('should detect no changes for identical extensions', () => {
		const schema = makeModelWithExtensions(['uuid-ossp', 'pgcrypto']);
		const db = makeModelWithExtensions(['uuid-ossp', 'pgcrypto']);
		const diff = compareSchemata(schema, db);
		const extChanges = diff.changes.filter(
			(c) => c.kind === 'create_extension' || c.kind === 'drop_extension',
		);
		expect(extChanges).toHaveLength(0);
	});

	it('should detect multiple extension changes at once', () => {
		const schema = makeModelWithExtensions(['uuid-ossp', 'pgcrypto']);
		const db = makeModelWithExtensions(['pgcrypto', 'hstore']);
		const diff = compareSchemata(schema, db);
		const kinds = changeKinds(diff.changes);
		expect(kinds).toContain('create_extension'); // uuid-ossp to add
		expect(kinds).toContain('drop_extension'); // hstore to drop
	});

	describe('ignoreUnmanagedExtensions', () => {
		it('should not emit drop_extension for unmanaged DB extensions when option is true', () => {
			// schema declares nothing; DB has image-bundled extensions
			const schema = makeModel([]);
			const db = makeModelWithExtensions([
				'pgvector',
				'pg_search',
				'uuid-ossp',
			]);
			const diff = compareSchemata(schema, db, {
				ignoreUnmanagedExtensions: true,
			});
			const extChanges = diff.changes.filter(
				(c) => c.kind === 'create_extension' || c.kind === 'drop_extension',
			);
			expect(extChanges).toHaveLength(0);
		});

		it('should still emit create_extension for extensions in schema but missing from DB', () => {
			const schema = makeModelWithExtensions(['pgcrypto']);
			const db = makeModelWithExtensions(['pgvector', 'pg_search']); // pgcrypto absent
			const diff = compareSchemata(schema, db, {
				ignoreUnmanagedExtensions: true,
			});
			const creates = diff.changes.filter((c) => c.kind === 'create_extension');
			const drops = diff.changes.filter((c) => c.kind === 'drop_extension');
			expect(creates).toHaveLength(1);
			expect(creates[0]?.meta?.extension).toBe('pgcrypto');
			// pgvector and pg_search are unmanaged — must NOT be dropped
			expect(drops).toHaveLength(0);
		});

		it('should default to full-sync behaviour (drop unmanaged) when option is false', () => {
			const schema = makeModel([]);
			const db = makeModelWithExtensions(['pgvector']);
			const diff = compareSchemata(schema, db, {
				ignoreUnmanagedExtensions: false,
			});
			expect(changeKinds(diff.changes)).toContain('drop_extension');
		});

		it('should default to full-sync behaviour when option is omitted', () => {
			const schema = makeModel([]);
			const db = makeModelWithExtensions(['pgvector']);
			const diff = compareSchemata(schema, db);
			expect(changeKinds(diff.changes)).toContain('drop_extension');
		});
	});
});

// ============================================================================
// Sequences
// ============================================================================

function makeModelWithSequences(sequences: SequenceIR[]) {
	const seqMap = new Map(sequences.map((s) => [s.name, s]));
	return new ModelIRImpl(new Map(), new Map(), undefined, undefined, seqMap);
}

describe('Sequences', () => {
	it('should detect new sequence', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1, incrementBy: 1 };
		const schema = makeModelWithSequences([seq]);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('create_sequence');
		const change = diff.changes.find((c) => c.kind === 'create_sequence');
		expect((change?.meta?.sequence as SequenceIR).name).toBe('order_seq');
		expect(change?.destructive).toBe(false);
	});

	it('should detect dropped sequence', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1 };
		const schema = makeModel([]);
		const db = makeModelWithSequences([seq]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('drop_sequence');
		const change = diff.changes.find((c) => c.kind === 'drop_sequence');
		expect(change?.destructive).toBe(true);
	});

	it('should detect altered sequence (incrementBy changed)', () => {
		const schema = makeModelWithSequences([
			{ name: 'order_seq', startWith: 1, incrementBy: 5 },
		]);
		const db = makeModelWithSequences([
			{ name: 'order_seq', startWith: 1, incrementBy: 1 },
		]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('alter_sequence');
		const change = diff.changes.find((c) => c.kind === 'alter_sequence');
		expect(change?.destructive).toBe(false);
	});

	it('should detect altered sequence (cycle changed)', () => {
		const schema = makeModelWithSequences([{ name: 'order_seq', cycle: true }]);
		const db = makeModelWithSequences([{ name: 'order_seq', cycle: false }]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('alter_sequence');
	});

	it('should detect altered sequence (minValue/maxValue changed)', () => {
		const schema = makeModelWithSequences([
			{ name: 'order_seq', minValue: 10, maxValue: 1000 },
		]);
		const db = makeModelWithSequences([
			{ name: 'order_seq', minValue: 1, maxValue: 9999 },
		]);
		const diff = compareSchemata(schema, db);
		expect(changeKinds(diff.changes)).toContain('alter_sequence');
	});

	it('should detect no changes for identical sequences', () => {
		const seq: SequenceIR = {
			name: 'order_seq',
			startWith: 1,
			incrementBy: 1,
			cycle: false,
		};
		const schema = makeModelWithSequences([seq]);
		const db = makeModelWithSequences([seq]);
		const diff = compareSchemata(schema, db);
		const seqChanges = diff.changes.filter(
			(c) =>
				c.kind === 'create_sequence' ||
				c.kind === 'alter_sequence' ||
				c.kind === 'drop_sequence',
		);
		expect(seqChanges).toHaveLength(0);
	});

	it('should store previousSequence in alter_sequence meta', () => {
		const schema = makeModelWithSequences([
			{ name: 'order_seq', incrementBy: 5 },
		]);
		const db = makeModelWithSequences([{ name: 'order_seq', incrementBy: 1 }]);
		const diff = compareSchemata(schema, db);
		const change = diff.changes.find((c) => c.kind === 'alter_sequence');
		expect((change?.meta?.previousSequence as SequenceIR).incrementBy).toBe(1);
	});
});

// ============================================================================
// Partitioning Tests
// ============================================================================

describe('Partitioning', () => {
	function makePartitionedTable(
		name: string,
		partition?: PartitionIR,
	): TableIR {
		return {
			name,
			columns: [{ name: 'created_at', type: 'timestamp', nullable: false }],
			foreignKeys: [],
			indexes: [],
			...(partition ? { partition } : {}),
		};
	}

	it('should not flag identical partition config', () => {
		const partition: PartitionIR = {
			strategy: 'RANGE',
			columns: ['created_at'],
		};
		const schema = makeModel([makePartitionedTable('events', partition)]);
		const db = makeModel([makePartitionedTable('events', partition)]);
		const diff = compareSchemata(schema, db);
		const partitionChanges = diff.changes.filter(
			(c) => c.meta?.isPartitionChange === true,
		);
		expect(partitionChanges).toHaveLength(0);
	});

	it('should flag strategy change as destructive', () => {
		const schema = makeModel([
			makePartitionedTable('events', {
				strategy: 'RANGE',
				columns: ['created_at'],
			}),
		]);
		const db = makeModel([
			makePartitionedTable('events', {
				strategy: 'LIST',
				columns: ['created_at'],
			}),
		]);
		const diff = compareSchemata(schema, db);
		const partitionChange = diff.changes.find(
			(c) => c.meta?.isPartitionChange === true,
		);
		expect(partitionChange).toBeDefined();
		expect(partitionChange?.kind).toBe('drop_table');
		expect(partitionChange?.destructive).toBe(true);
		expect(partitionChange?.details).toContain('LIST');
		expect(partitionChange?.details).toContain('RANGE');
	});

	it('should flag column change as destructive', () => {
		const schema = makeModel([
			makePartitionedTable('events', {
				strategy: 'RANGE',
				columns: ['updated_at'],
			}),
		]);
		const db = makeModel([
			makePartitionedTable('events', {
				strategy: 'RANGE',
				columns: ['created_at'],
			}),
		]);
		const diff = compareSchemata(schema, db);
		const partitionChange = diff.changes.find(
			(c) => c.meta?.isPartitionChange === true,
		);
		expect(partitionChange).toBeDefined();
		expect(partitionChange?.destructive).toBe(true);
	});

	it('should flag adding partition to existing non-partitioned table as destructive', () => {
		const schema = makeModel([
			makePartitionedTable('events', {
				strategy: 'RANGE',
				columns: ['created_at'],
			}),
		]);
		const db = makeModel([makePartitionedTable('events')]);
		const diff = compareSchemata(schema, db);
		const partitionChange = diff.changes.find(
			(c) => c.meta?.isPartitionChange === true,
		);
		expect(partitionChange).toBeDefined();
		expect(partitionChange?.kind).toBe('drop_table');
		expect(partitionChange?.destructive).toBe(true);
		expect(partitionChange?.details).toContain(
			'Cannot add partition to existing table',
		);
	});

	it('should flag removing partition as destructive', () => {
		const schema = makeModel([makePartitionedTable('events')]);
		const db = makeModel([
			makePartitionedTable('events', {
				strategy: 'HASH',
				columns: ['id'],
			}),
		]);
		const diff = compareSchemata(schema, db);
		const partitionChange = diff.changes.find(
			(c) => c.meta?.isPartitionChange === true,
		);
		expect(partitionChange).toBeDefined();
		expect(partitionChange?.kind).toBe('drop_table');
		expect(partitionChange?.destructive).toBe(true);
		expect(partitionChange?.details).toContain(
			'Cannot remove partition from existing table',
		);
	});
});

// ============================================================================
// Regression: F-006 — buildSummary missing ChangeKind cases
// ============================================================================

describe('buildSummary — missing ChangeKind cases (F-006 regression)', () => {
	it('F-006: alter_column_collation counts as columns.altered', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'name', collation: 'en_US' })],
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'name' })] }),
		]);
		const diff = compareSchemata(schema, db);
		expect(diff.summary.columns.altered).toBeGreaterThanOrEqual(1);
	});

	it('F-006: alter_column_identity counts as columns.altered', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', identity: 'always' })],
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'id' })] }),
		]);
		const diff = compareSchemata(schema, db);
		expect(diff.summary.columns.altered).toBeGreaterThanOrEqual(1);
	});

	it('F-006: create_extension does not throw and does not count in tables/columns/indexes/constraints', () => {
		const schema = makeModelWithExtensions(['uuid-ossp']);
		const db = makeModel([]);
		// Must not throw (was hitting unhandled default in switch before fix)
		expect(() => compareSchemata(schema, db)).not.toThrow();
		const diff = compareSchemata(schema, db);
		expect(diff.summary.tables.added).toBe(0);
		expect(diff.summary.columns.added).toBe(0);
		expect(diff.summary.indexes.added).toBe(0);
		expect(diff.summary.constraints.added).toBe(0);
	});

	it('F-006: drop_extension does not count in summary', () => {
		const schema = makeModel([]);
		const db = makeModelWithExtensions(['pgcrypto']);
		const diff = compareSchemata(schema, db);
		expect(diff.summary.tables.dropped).toBe(0);
		expect(diff.summary.constraints.dropped).toBe(0);
	});

	it('F-006: create_sequence does not count in summary', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1, incrementBy: 1 };
		const schema = makeModelWithSequences([seq]);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db);
		expect(diff.summary.tables.added).toBe(0);
		expect(diff.summary.columns.added).toBe(0);
	});

	it('F-006: alter_sequence does not count in summary', () => {
		const seq1: SequenceIR = {
			name: 'order_seq',
			startWith: 1,
			incrementBy: 1,
		};
		const seq2: SequenceIR = {
			name: 'order_seq',
			startWith: 100,
			incrementBy: 1,
		};
		const schema = makeModelWithSequences([seq1]);
		const db = makeModelWithSequences([seq2]);
		const diff = compareSchemata(schema, db);
		expect(diff.summary.tables.altered ?? 0).toBe(0);
		expect(diff.summary.columns.altered).toBe(0);
	});

	it('F-006: drop_sequence does not count in summary', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1 };
		const schema = makeModel([]);
		const db = makeModelWithSequences([seq]);
		const diff = compareSchemata(schema, db);
		expect(diff.summary.tables.dropped).toBe(0);
		expect(diff.summary.indexes.dropped).toBe(0);
	});

	it('F-006: add_comment does not count in summary', () => {
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id' })],
				comment: 'User accounts',
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'id' })] }),
		]);
		const diff = compareSchemata(schema, db);
		// add_comment should not inflate any summary bucket
		expect(diff.summary.tables.added).toBe(0);
		expect(diff.summary.columns.added).toBe(0);
		expect(diff.summary.constraints.added).toBe(0);
	});
});

describe('compareSchemata with Capabilities (CAPS-003)', () => {
	// SC-11: compareSchemata ignores unsupported features

	it('should not emit enum changes when supportsDDLEnumTypes is false', () => {
		const caps: DialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLEnumTypes: false,
		};
		const schema = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db, { dialectCapabilities: caps });
		const enumChanges = diff.changes.filter(
			(c) => c.kind === 'create_enum' || c.kind === 'drop_enum',
		);
		expect(enumChanges).toHaveLength(0);
	});

	it('should emit enum changes when supportsDDLEnumTypes is true', () => {
		const caps: DialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLEnumTypes: true,
		};
		const schema = makeModelWithEnums(
			[],
			new Map([['status', { name: 'status', values: ['active', 'inactive'] }]]),
		);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db, { dialectCapabilities: caps });
		const enumChanges = diff.changes.filter((c) => c.kind === 'create_enum');
		expect(enumChanges).toHaveLength(1);
	});

	it('should emit all changes when no dialectCapabilities provided (backward compat)', () => {
		const schema = makeModelWithEnums(
			[makeTable({ name: 'users', columns: [makeCol({ name: 'id' })] })],
			new Map([['status', { name: 'status', values: ['active'] }]]),
		);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db);
		expect(diff.changes.some((c) => c.kind === 'create_enum')).toBe(true);
		expect(diff.changes.some((c) => c.kind === 'create_table')).toBe(true);
	});

	it('should not emit sequence changes when supportsDDLSequences is false', () => {
		const caps: DialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLSequences: false,
		};
		const seq: SequenceIR = { name: 'order_seq', startWith: 1 };
		const schema = makeModelWithSequences([seq]);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db, { dialectCapabilities: caps });
		const seqChanges = diff.changes.filter((c) => c.kind === 'create_sequence');
		expect(seqChanges).toHaveLength(0);
	});

	it('should not emit check constraint changes for new table when supportsDDLCheckConstraints is false', () => {
		const caps: DialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLCheckConstraints: false,
		};
		const schema = makeModel([
			makeTable({
				name: 'orders',
				columns: [makeCol({ name: 'id' }), makeCol({ name: 'amount' })],
				checkConstraints: [
					{ name: 'orders_amount_check', expression: 'CHECK ((amount > 0))' },
				],
			}),
		]);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db, { dialectCapabilities: caps });
		const checkChanges = diff.changes.filter(
			(c) => c.kind === 'add_check_constraint',
		);
		expect(checkChanges).toHaveLength(0);
		// create_table still emitted
		expect(diff.changes.some((c) => c.kind === 'create_table')).toBe(true);
	});

	it('should emit check constraints with POSTGRESQL_CAPABILITIES', () => {
		const schema = makeModel([
			makeTable({
				name: 'orders',
				columns: [makeCol({ name: 'id' }), makeCol({ name: 'amount' })],
				checkConstraints: [
					{ name: 'orders_amount_check', expression: 'CHECK ((amount > 0))' },
				],
			}),
		]);
		const db = makeModel([]);
		const diff = compareSchemata(schema, db, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const checkChanges = diff.changes.filter(
			(c) => c.kind === 'add_check_constraint',
		);
		expect(checkChanges).toHaveLength(1);
	});

	it('should not emit comment changes when supportsDDLComments is false', () => {
		const caps: DialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLComments: false,
		};
		const schema = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id' })],
				comment: 'User table',
			}),
		]);
		const db = makeModel([
			makeTable({ name: 'users', columns: [makeCol({ name: 'id' })] }),
		]);
		const diff = compareSchemata(schema, db, { dialectCapabilities: caps });
		const commentChanges = diff.changes.filter((c) => c.kind === 'add_comment');
		expect(commentChanges).toHaveLength(0);
	});
});
