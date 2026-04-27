/**
 * CODEX regression tests for schema-codegen.
 *
 * Covers findings CODEX-11, CODEX-12, CODEX-13, CODEX-14:
 *   CODEX-11: SQL-expression defaults ({sql:'now()'}) must not serialize as [object Object]
 *   CODEX-12: FK onUpdate must be preserved in generated ref() calls
 *   CODEX-13: FK columns that are also PK must keep isPrimaryKey: true in ref()
 *   CODEX-14: String defaults must be escaped via JSON.stringify (not bare single-quote wrap)
 */

import { ref, schema } from '@dbsp/core';
import type { ForeignKeyIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateSchemaFile } from './schema-codegen.js';

// ---------------------------------------------------------------------------
// CODEX-11: SQL-expression defaults round-trip
// ---------------------------------------------------------------------------
describe('CODEX-11: SQL-expression defaults round-trip', () => {
	it('emits { sql: "now()" } for a SQL-expression default — not [object Object]', () => {
		const model = schema({
			events: {
				id: { type: 'uuid', primaryKey: true },
				created_at: { type: 'datetime', default: 'placeholder' },
			},
		}).model;

		// Override with the introspection shape
		const col = model.tables
			.get('events')
			?.columns.find((c) => c.name === 'created_at');
		if (col) (col as { default: unknown }).default = { sql: 'now()' };

		const result = generateSchemaFile(model);

		expect(result).toContain("{ sql: 'now()' }");
		expect(result).not.toContain('[object Object]');
	});

	it('emits { sql: "CURRENT_TIMESTAMP" } for a multi-word SQL default', () => {
		const model = schema({
			things: {
				id: { type: 'uuid', primaryKey: true },
				ts: { type: 'datetime', default: 'placeholder' },
			},
		}).model;

		const col = model.tables
			.get('things')
			?.columns.find((c) => c.name === 'ts');
		if (col)
			(col as { default: unknown }).default = { sql: 'CURRENT_TIMESTAMP' };

		const result = generateSchemaFile(model);
		expect(result).toContain("{ sql: 'CURRENT_TIMESTAMP' }");
		expect(result).not.toContain('[object Object]');
	});

	it('emits { sql: "..." } for a SQL default with special characters', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				x: { type: 'string', default: 'placeholder' },
			},
		}).model;

		const col = model.tables.get('t')?.columns.find((c) => c.name === 'x');
		if (col)
			(col as { default: unknown }).default = {
				sql: "nextval('seq'::regclass)",
			};

		const result = generateSchemaFile(model);
		// Single-quote style: apostrophes inside sql expr are escaped as \'
		expect(result).toContain("{ sql: 'nextval(\\'seq\\'::regclass)' }");
		expect(result).not.toContain('[object Object]');
	});
});

// ---------------------------------------------------------------------------
// CODEX-14: string defaults are properly escaped
// ---------------------------------------------------------------------------
describe('CODEX-14: string defaults are properly escaped via JSON.stringify', () => {
	it('escapes double-quote in string default (single-quote TS style)', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				label: { type: 'string', default: 'say "hi"' },
			},
		}).model;
		const result = generateSchemaFile(model);
		// Single-quote style: double-quotes don't need escaping inside single-quoted string
		expect(result).toContain('default: \'say "hi"\'');
		expect(result).not.toContain('[object Object]');
	});

	it('escapes backslash in string default', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				path: { type: 'string', default: 'C:\\Users' },
			},
		}).model;
		const result = generateSchemaFile(model);
		// Input: 'C:\Users' → output TS source: 'C:\\Users'
		expect(result).toContain("default: 'C:\\\\Users'");
	});

	it('escapes single-quote in string default (produces valid TS)', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string', default: "O'Brien" },
			},
		}).model;
		const result = generateSchemaFile(model);
		// Single-quote style: apostrophe must be escaped as \'
		expect(result).toContain("default: 'O\\'Brien'");
	});

	it('preserves number defaults as unquoted literals', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				count: { type: 'integer', default: 42 },
				score: { type: 'number', default: 0 },
			},
		}).model;
		const result = generateSchemaFile(model);
		expect(result).toContain('default: 42');
		expect(result).toContain('default: 0');
		expect(result).not.toContain("default: '42'");
	});

	it('preserves boolean defaults as unquoted literals', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				active: { type: 'boolean', default: true },
				archived: { type: 'boolean', default: false },
			},
		}).model;
		const result = generateSchemaFile(model);
		expect(result).toContain('default: true');
		expect(result).toContain('default: false');
	});

	it('emits null for a null default', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				opt: { type: 'string', nullable: true, default: 'placeholder' },
			},
		}).model;
		const col = model.tables.get('t')?.columns.find((c) => c.name === 'opt');
		if (col) (col as { default: unknown }).default = null;

		const result = generateSchemaFile(model);
		expect(result).toContain('default: null');
	});

	it('escapes newline in string default', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				note: { type: 'string', default: 'line1\nline2' },
			},
		}).model;
		const result = generateSchemaFile(model);
		// Single-quote style: \n becomes \\n in the TS source literal
		expect(result).toContain("default: 'line1\\nline2'");
	});
});

// ---------------------------------------------------------------------------
// CODEX-12: FK onUpdate preserved in ref()
// ---------------------------------------------------------------------------
describe('CODEX-12: FK onUpdate preserved in generated ref()', () => {
	it('emits onUpdate: "CASCADE" when FK has ON UPDATE CASCADE', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: ref('users'),
			},
		}).model;

		// Inject onUpdate via mutation of the FK (simulates introspection)
		const table = model.tables.get('orders');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) (fk as unknown as { onUpdate: string }).onUpdate = 'CASCADE';
		}

		const result = generateSchemaFile(model);
		expect(result).toContain("onUpdate: 'CASCADE'");
	});

	it('omits onUpdate when FK has ON UPDATE NO ACTION (default)', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: ref('users'),
			},
		}).model;

		const table = model.tables.get('orders');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) (fk as unknown as { onUpdate: string }).onUpdate = 'NO ACTION';
		}

		const result = generateSchemaFile(model);
		expect(result).not.toContain('onUpdate:');
	});

	it('emits both onDelete and onUpdate when both are non-default', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: ref('users'),
			},
		}).model;

		const table = model.tables.get('orders');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) {
				(fk as unknown as { onDelete: string; onUpdate: string }).onDelete =
					'RESTRICT';
				(fk as unknown as { onDelete: string; onUpdate: string }).onUpdate =
					'SET DEFAULT';
			}
		}

		const result = generateSchemaFile(model);
		expect(result).toContain("onDelete: 'RESTRICT'");
		expect(result).toContain("onUpdate: 'SET DEFAULT'");
	});

	it('handles SET NULL as onUpdate', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				author_id: ref('users', { nullable: true }),
			},
		}).model;

		const table = model.tables.get('posts');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) (fk as unknown as { onUpdate: string }).onUpdate = 'SET NULL';
		}

		const result = generateSchemaFile(model);
		expect(result).toContain("onUpdate: 'SET NULL'");
	});
});

// ---------------------------------------------------------------------------
// CODEX-13: FK + PK overlap — shared-PK 1:1 pattern
// ---------------------------------------------------------------------------
describe('CODEX-13: FK + PK overlap', () => {
	it('emits isPrimaryKey: true inside ref() for a column that is both PK and FK', () => {
		// Shared-PK 1:1: profiles.id is PK and also FK → users.id
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			profiles: {
				id: { type: 'uuid', primaryKey: true },
			},
		}).model;

		// Inject FK: profiles.id → users.id
		const table = model.tables.get('profiles');
		if (table) {
			(table.foreignKeys as Array<ForeignKeyIR>).push({
				columns: ['id'] as readonly string[],
				references: { table: 'users', columns: ['id'] as readonly string[] },
			});
		}

		const result = generateSchemaFile(model);

		// Must emit ref() (FK wins the code structure)
		expect(result).toContain("ref('users'");
		// Must preserve the PK flag inside ref() options
		expect(result).toContain('isPrimaryKey: true');
	});

	it('does NOT emit isPrimaryKey for a non-PK FK column', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				author_id: ref('users'),
			},
		}).model;

		const result = generateSchemaFile(model);

		// author_id is FK but not PK — isPrimaryKey must not appear
		expect(result).toContain("author_id: ref('users')");
		expect(result).not.toContain('isPrimaryKey: true');
	});

	it('emits isPrimaryKey: true even when the column is also nullable FK', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			profiles: {
				id: { type: 'uuid', primaryKey: true },
			},
		}).model;

		const table = model.tables.get('profiles');
		if (table) {
			(table.foreignKeys as Array<ForeignKeyIR>).push({
				columns: ['id'] as readonly string[],
				references: { table: 'users', columns: ['id'] as readonly string[] },
			});
			// Mark the column nullable
			const col = table.columns.find((c) => c.name === 'id');
			if (col) (col as { nullable: boolean }).nullable = true;
		}

		const result = generateSchemaFile(model);
		expect(result).toContain('isPrimaryKey: true');
		expect(result).toContain('nullable: true');
		expect(result).toContain("ref('users'");
	});
});

// ---------------------------------------------------------------------------
// C2 regression: non-PK FK column reference preserved in codegen
// ---------------------------------------------------------------------------
describe('[C2] schema codegen preserves non-PK FK column references', () => {
	it('emits references option when FK targets a non-id column (regression gate)', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
				email: { type: 'string' },
			},
			memberships: {
				id: { type: 'uuid', primaryKey: true },
				user_email: { type: 'string' },
			},
		}).model;

		// Inject FK: memberships.user_email → users.email
		const table = model.tables.get('memberships');
		if (table) {
			(table.foreignKeys as Array<import('@dbsp/types').ForeignKeyIR>).push({
				columns: ['user_email'] as readonly string[],
				references: {
					table: 'users',
					columns: ['email'] as readonly string[],
				},
			});
		}

		const result = generateSchemaFile(model);

		// Must emit ref('users', { references: ['email'] }) — not ref('users')
		expect(result).toContain("references: ['email']");
		expect(result).not.toMatch(/ref\('users'\)(?!\s*\/\*)/);
	});

	it('does NOT emit references option when FK targets the default PK (id)', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				author_id: { type: 'uuid' },
			},
		}).model;

		// Inject FK: posts.author_id → users.id  (default PK, no references: needed)
		const table = model.tables.get('posts');
		if (table) {
			(table.foreignKeys as Array<import('@dbsp/types').ForeignKeyIR>).push({
				columns: ['author_id'] as readonly string[],
				references: {
					table: 'users',
					columns: ['id'] as readonly string[],
				},
			});
		}

		const result = generateSchemaFile(model);
		expect(result).not.toContain("references:");
	});
});
