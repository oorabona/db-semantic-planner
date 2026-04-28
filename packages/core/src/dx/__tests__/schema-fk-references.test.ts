/**
 * Regression tests for buildRefColumn — column-level non-PK FK references.
 *
 * Verifies that `ref('table', { references: ['col'] })` correctly propagates
 * the target column into ModelIR ForeignKeyIR instead of always defaulting to 'id'.
 *
 * See: PR #83 fix/core-fk-non-pk-round-trip
 */

import { describe, expect, it } from 'vitest';
import { ref, schema, schemaToModelIR } from '../schema.js';

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
		const posts = model.tables.get('posts');
		const fk = posts?.foreignKeys?.[0];

		expect(fk).toBeDefined();
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

	it('defaults to ["id"] when options.references is not set but other options are', () => {
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

	it('stores the target column in the references array', () => {
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
		expect(Array.isArray(fk?.references.columns)).toBe(true);
		expect(fk?.references.columns).toHaveLength(1);
		expect(fk?.references.columns[0]).toBe('email');
	});
});
