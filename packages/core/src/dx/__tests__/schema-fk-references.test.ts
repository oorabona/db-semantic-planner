/**
 * Regression tests for buildRefColumn — column-level non-PK FK references.
 *
 * Verifies that `ref('table', { references: ['col'] })` correctly propagates
 * the target column into ModelIR ForeignKeyIR instead of always defaulting to 'id'.
 */

import { describe, expect, it } from 'vitest';
import {
	ref,
	SchemaValidationError,
	schema,
	schemaToModelIR,
} from '../schema.js';

describe('buildRefColumn — column-level non-PK FK references', () => {
	it('preserves options.references in ModelIR FK declaration', () => {
		const db = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
				email: { type: 'string', unique: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				authorEmail: ref('users', { references: ['email'] }),
			},
		});

		const model = schemaToModelIR(db.definition);
		const fk = model.tables.get('posts')?.foreignKeys?.[0];
		expect(fk?.references.table).toBe('users');
		expect(fk?.references.columns).toEqual(['email']);
	});

	it('defaults to ["id"] when options.references is absent', () => {
		const db = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
			posts: {
				id: { type: 'uuid', primaryKey: true },
				authorId: ref('users'),
			},
		});

		const model = schemaToModelIR(db.definition);
		const fk = model.tables.get('posts')?.foreignKeys?.[0];
		expect(fk?.references.columns).toEqual(['id']);
	});

	it('defaults to ["id"] when other options are set without references', () => {
		const db = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
			posts: {
				id: { type: 'uuid', primaryKey: true },
				authorId: ref('users', { nullable: true }),
			},
		});

		const model = schemaToModelIR(db.definition);
		const fk = model.tables.get('posts')?.foreignKeys?.[0];
		expect(fk?.references.columns).toEqual(['id']);
	});

	it('plumbs onUpdate from options into ForeignKeyIR', () => {
		const db = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
			posts: {
				id: { type: 'uuid', primaryKey: true },
				authorId: ref('users', { onUpdate: 'CASCADE' }),
			},
		});

		const model = schemaToModelIR(db.definition);
		const fk = model.tables.get('posts')?.foreignKeys?.[0];
		expect(fk?.onUpdate).toBe('CASCADE');
	});

	it('throws SchemaValidationError on empty references array', () => {
		expect(() =>
			schema({
				users: { id: { type: 'uuid', primaryKey: true } },
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users', { references: [] }),
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('throws on multi-column references at column-level (length must be 1)', () => {
		expect(() =>
			schema({
				users: {
					tenantId: { type: 'uuid', primaryKey: true },
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users', { references: ['tenantId', 'id'] }),
				},
			}),
		).toThrow(SchemaValidationError);
	});
});

describe('FK target uniqueness gate (post-build validateFkTargets)', () => {
	it('accepts FK to a unique non-PK column', () => {
		expect(() =>
			schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string', unique: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorEmail: ref('users', { references: ['email'] }),
				},
			}),
		).not.toThrow();
	});

	it('rejects FK to a column that exists but is not PK or unique', () => {
		expect(() =>
			schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string' },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorEmail: ref('users', { references: ['email'] }),
				},
			}),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining('neither primary key nor unique'),
			}),
		);
	});

	it('rejects FK to a non-existent column', () => {
		expect(() =>
			schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users', { references: ['nonexistent'] }),
				},
			}),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining('non-existent column'),
			}),
		);
	});

	it('accepts default ref() (target=id with primaryKey:true)', () => {
		expect(() =>
			schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users'),
				},
			}),
		).not.toThrow();
	});

	it('rejects FK targeting a member of a composite PK alone (singleton-only rule)', () => {
		// Composite PK members do not make individual columns unique — matches PG semantics
		expect(() =>
			schema({
				users: {
					tenantId: { type: 'uuid', primaryKey: true },
					userId: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					// targeting only 'userId' which is part of composite PK but not singleton PK
					authorId: ref('users', { references: ['userId'] }),
				},
			}),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining('neither primary key nor unique'),
			}),
		);
	});

	it('accepts FK to a column with unique:true even when not PK', () => {
		expect(() =>
			schema({
				accounts: {
					id: { type: 'uuid', primaryKey: true },
					externalId: { type: 'string', unique: true },
				},
				sessions: {
					id: { type: 'uuid', primaryKey: true },
					accountExtId: ref('accounts', { references: ['externalId'] }),
				},
			}),
		).not.toThrow();
	});

	it('rejects FK targeting a non-PK column named like the implicit-PK convention', () => {
		// Edge case: target table has BOTH a column named 'id' (which is NOT PK)
		// AND a different actual PK. The FK targets 'id'. This must be rejected
		// because PostgreSQL would reject it (42830) — the 'id' column is neither
		// PK nor unique despite matching the implicit-PK convention name.
		expect(() =>
			schema({
				tags: {
					tagKey: { type: 'uuid', primaryKey: true }, // actual PK
					id: { type: 'string' }, // looks like implicit-PK by name, but isn't unique/PK
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					tagRef: ref('tags', { references: ['id'] }),
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('accepts FK to implicit-id PK on a target without explicit primaryKey flag', () => {
		// After the inferPrimaryKey priority swap, a target table with `id: 'uuid'`
		// (short-form, no flag) AND additional FK columns still resolves the PK as 'id',
		// not the FK column. The FK targeting 'id' must pass.
		expect(() =>
			schema({
				users: { id: 'uuid' }, // implicit PK via convention
				permissions: { id: 'uuid', userRef: ref('users') }, // userRef is FK column
				audits: {
					id: { type: 'uuid', primaryKey: true },
					permissionRef: ref('permissions'), // permissions.id resolves as PK, not userRef
				},
			}),
		).not.toThrow();
	});

	it('accepts FK to a column made unique via table-level unique index', () => {
		// Edge case: target column has no column-level `unique` flag, but the schema's
		// SchemaConstraints declares a single-column UNIQUE index covering it. PostgreSQL
		// accepts FKs to such columns; the gate must too.
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string', // no column-level unique
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						userEmail: ref('users', { references: ['email'] }),
					},
				},
				{
					users: {
						indexes: [{ columns: ['email'], unique: true }],
					},
				},
			),
		).not.toThrow();
	});

	it('rejects FK to a column with a non-unique table-level index', () => {
		// Sanity check: a non-unique index does NOT qualify for FK target.
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string',
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						userEmail: ref('users', { references: ['email'] }),
					},
				},
				{
					users: {
						indexes: [{ columns: ['email'] /* no unique */ }],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('rejects FK to a column covered only by a multi-column unique index', () => {
		// PG strict: a multi-column unique index does NOT make individual columns
		// referenceable (same rule as composite PK).
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string',
						tenantId: 'uuid',
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						userEmail: ref('users', { references: ['email'] }),
					},
				},
				{
					users: {
						indexes: [{ columns: ['tenantId', 'email'], unique: true }],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('rejects FK to a column covered only by a partial unique index (WHERE clause)', () => {
		// PG strict: partial unique indexes (WHERE clause) do NOT make a column referenceable
		// for foreign keys. The gate must reject these schemas at construction time.
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string',
						deletedAt: { type: 'datetime', nullable: true },
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						userEmail: ref('users', { references: ['email'] }),
					},
				},
				{
					users: {
						indexes: [
							{ columns: ['email'], unique: true, where: 'deleted_at IS NULL' },
						],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('rejects constraint-level FK to a non-existent table', () => {
		// validateRefs only checks column-level refs; constraint-level FKs to missing
		// tables must be caught by validateFkTargets instead.
		expect(() =>
			schema(
				{
					orders: { id: { type: 'uuid', primaryKey: true }, total: 'number' },
				},
				{
					orders: {
						foreignKeys: [ref('ghost_table', { columns: ['total'] })],
					},
				},
			),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining("non-existent table 'ghost_table'"),
			}),
		);
	});

	it('rejects composite FK referencing non-existent target columns (R6-3b)', () => {
		// A composite (table-level) FK where one of the referenced columns does not
		// exist on the target table must be caught at schema()-time, not at DDL apply time.
		expect(() =>
			schema(
				{
					users: {
						a: { type: 'uuid', primaryKey: true },
						b: { type: 'uuid', primaryKey: true },
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						aRef: { type: 'uuid' },
						bRef: { type: 'uuid' },
					},
				},
				{
					memberships: {
						foreignKeys: [
							ref('users', {
								columns: ['aRef', 'bRef'],
								references: ['a', 'nonExistent'], // 'nonExistent' is not on users
							}),
						],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('rejects FK with mismatched source/target column counts (R6-3a)', () => {
		// source has 2 columns, referenced has 1 — PostgreSQL would reject this; the gate must too.
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						a: { type: 'uuid' },
						b: { type: 'uuid' },
					},
				},
				{
					memberships: {
						foreignKeys: [
							ref('users', {
								columns: ['a', 'b'], // 2 source columns
								references: ['id'], // 1 referenced — mismatch
							}),
						],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('accepts FK to a column with a single-column UNIQUE btree index (explicit method)', () => {
		// btree is a uniqueness-capable method — must be accepted.
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string',
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						userEmail: ref('users', { references: ['email'] }),
					},
				},
				{
					users: {
						indexes: [{ columns: ['email'], unique: true, method: 'btree' }],
					},
				},
			),
		).not.toThrow();
	});

	it('rejects FK to a column whose UNIQUE index uses a non-unique-capable method (gin)', () => {
		// PostgreSQL does not allow UNIQUE on GIN/GiST/BRIN/SP-GiST/HNSW/BM25 indexes.
		// The gate must reject these schemas at construction time even when unique:true is set.
		expect(() =>
			schema(
				{
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: 'string',
					},
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						userEmail: ref('users', { references: ['email'] }),
					},
				},
				{
					users: {
						indexes: [{ columns: ['email'], unique: true, method: 'gin' }],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});
});

describe('defaultPkColumnName option', () => {
	it('default behavior: short-form id is implicit PK and FK to it succeeds', () => {
		// Both tables use short-form 'uuid' for id — implicit PK convention
		expect(() =>
			schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			}),
		).not.toThrow();
	});

	it('defaultPkColumnName: null — short-form id is NOT implicit PK; FK to it throws', () => {
		expect(() =>
			schema(
				{
					users: { id: 'uuid' },
					posts: { id: 'uuid', authorId: ref('users') },
				},
				undefined,
				{ defaultPkColumnName: null },
			),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining('neither primary key nor unique'),
			}),
		);
	});

	it('defaultPkColumnName: null — explicit primaryKey:true on id makes FK pass', () => {
		expect(() =>
			schema(
				{
					users: { id: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						authorId: ref('users'),
					},
				},
				undefined,
				{ defaultPkColumnName: null },
			),
		).not.toThrow();
	});

	it('custom defaultPkColumnName: short-form pk_uuid treated as PK', () => {
		expect(() =>
			schema(
				{
					users: { pk_uuid: 'uuid' },
					posts: {
						id: 'uuid',
						userPk: ref('users', { references: ['pk_uuid'] }),
					},
				},
				undefined,
				{ defaultPkColumnName: 'pk_uuid' },
			),
		).not.toThrow();
	});

	it('defaultPkColumnName: null — explicit primaryKey:true on pk_uuid works regardless of convention', () => {
		// With explicit primaryKey:true, the FK passes even when the implicit convention is disabled
		expect(() =>
			schema(
				{
					users: { pk_uuid: { type: 'uuid', primaryKey: true } },
					posts: {
						id: { type: 'uuid', primaryKey: true },
						userPk: ref('users', { references: ['pk_uuid'] }),
					},
				},
				undefined,
				{ defaultPkColumnName: null },
			),
		).not.toThrow();
	});

	it('rejects constraint-level FK whose source column does not exist on the local table', () => {
		expect(() =>
			schema(
				{
					users: { id: { type: 'uuid', primaryKey: true } },
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						realCol: { type: 'uuid' },
					},
				},
				{
					memberships: {
						foreignKeys: [
							ref('users', { columns: ['nonExistentSrc'], references: ['id'] }),
						],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('rejects constraint-level FK with zero-length references array', () => {
		expect(() =>
			schema(
				{
					users: { id: { type: 'uuid', primaryKey: true } },
					memberships: {
						id: { type: 'uuid', primaryKey: true },
						realCol: { type: 'uuid' },
					},
				},
				{
					memberships: {
						foreignKeys: [
							ref('users', { columns: ['realCol'], references: [] }),
						],
					},
				},
			),
		).toThrow(SchemaValidationError);
	});

	it('FK source column type matches the referenced non-PK unique column type (R5-1)', () => {
		const db = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
				email: { type: 'string', unique: true },
			},
			memberships: {
				id: { type: 'uuid', primaryKey: true },
				userEmail: ref('users', { references: ['email'] }),
			},
		});
		const model = schemaToModelIR(db.definition);
		const fkCol = model.tables
			.get('memberships')
			?.columns.find((c) => c.name === 'userEmail');
		// Must be 'string' (matches users.email type), NOT 'uuid' (which is users.id type)
		expect(fkCol?.type).toBe('string');
	});
});
