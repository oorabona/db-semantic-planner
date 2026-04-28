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
			schema(
				{
					users: {
						tenantId: { type: 'uuid' },
						userId: { type: 'uuid' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						// targeting only 'userId' which is part of composite PK but not singleton PK
						authorId: ref('users', { references: ['userId'] }),
					},
				},
				{
					// table-level composite PK via constraints
					users: { primaryKey: ['tenantId', 'userId'] },
				},
			),
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
});

describe('idsArePrimaryKeys option', () => {
	it('default behavior (idsArePrimaryKeys=true): short-form id is implicit PK and FK to it succeeds', () => {
		// Both tables use short-form 'uuid' for id — implicit PK convention
		expect(() =>
			schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			}),
		).not.toThrow();
	});

	it('idsArePrimaryKeys=false: short-form id is NOT implicit PK; FK to it throws', () => {
		expect(() =>
			schema(
				{
					users: { id: 'uuid' },
					posts: { id: 'uuid', authorId: ref('users') },
				},
				undefined,
				{ idsArePrimaryKeys: false },
			),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining('neither primary key nor unique'),
			}),
		);
	});

	it('idsArePrimaryKeys=false: explicit primaryKey:true on id makes FK pass', () => {
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
				{ idsArePrimaryKeys: false },
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

	it('custom defaultPkColumnName + idsArePrimaryKeys=false requires explicit PK flag', () => {
		// Without explicit primaryKey flag on pk_uuid, FK fails when idsArePrimaryKeys=false
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
				{ idsArePrimaryKeys: false, defaultPkColumnName: 'pk_uuid' },
			),
		).toThrow(
			expect.objectContaining({
				message: expect.stringContaining('neither primary key nor unique'),
			}),
		);

		// With explicit primaryKey:true, it passes even with idsArePrimaryKeys=false
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
				{ idsArePrimaryKeys: false, defaultPkColumnName: 'pk_uuid' },
			),
		).not.toThrow();
	});
});
