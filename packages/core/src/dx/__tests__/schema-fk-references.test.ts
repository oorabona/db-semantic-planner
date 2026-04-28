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

describe('validateRefs target uniqueness gate', () => {
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
});
