/**
 * Correctness proof tests for schema-bridge.ts — Commit 4 / FIND-022..FIND-026
 *
 * Each test is a regression gate for one of the five M findings.
 */

import { describe, expect, it } from 'vitest';
import {
	buildModelFromSchema,
	resolvedSchemaToGeneratedSchema,
	type GeneratedSchema,
} from './schema-bridge.js';

// ---------------------------------------------------------------------------
// FIND-022: Missing range types; time/jsonb downgraded
// ---------------------------------------------------------------------------

describe('FIND-022: range types and time/jsonb preservation', () => {
	it('should accept tsrange as a column type and preserve it in ModelIR', () => {
		// Regression gate: tsrange must not be rejected or downgraded
		const schema: GeneratedSchema = {
			tables: {
				schedules: {
					id: { type: 'uuid', primaryKey: true },
					range_col: { type: 'tsrange' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const model = buildModelFromSchema(schema);
		const table = model.getTable('schedules')!;
		const col = table.columns.find((c) => c.name === 'range_col');
		expect(col).toBeDefined();
		expect(col?.type).toBe('tsrange');
	});

	it('should accept int8range as a column type and preserve it in ModelIR', () => {
		const schema: GeneratedSchema = {
			tables: {
				items: {
					id: { type: 'uuid', primaryKey: true },
					id_range: { type: 'int8range' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const model = buildModelFromSchema(schema);
		const col = model
			.getTable('items')
			?.columns.find((c) => c.name === 'id_range');
		expect(col?.type).toBe('int8range');
	});

	it('should accept numrange as a column type and preserve it in ModelIR', () => {
		const schema: GeneratedSchema = {
			tables: {
				prices: {
					id: { type: 'uuid', primaryKey: true },
					price_range: { type: 'numrange' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const model = buildModelFromSchema(schema);
		const col = model
			.getTable('prices')
			?.columns.find((c) => c.name === 'price_range');
		expect(col?.type).toBe('numrange');
	});

	it('resolvedSchemaToGeneratedSchema should preserve time as time (not downgrade to timestamp)', () => {
		// Regression gate: time must not be silently downgraded
		const input = {
			tables: {
				events: {
					id: { type: 'uuid' },
					start_time: { type: 'time' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.schema.tables.events?.start_time?.type).toBe('time');
		}
	});

	it('resolvedSchemaToGeneratedSchema should preserve jsonb as jsonb (not downgrade to json)', () => {
		// Regression gate: jsonb must not be silently downgraded
		const input = {
			tables: {
				events: {
					id: { type: 'uuid' },
					metadata: { type: 'jsonb' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.schema.tables.events?.metadata?.type).toBe('jsonb');
		}
	});

	it('resolvedSchemaToGeneratedSchema should accept tsrange in resolved schema', () => {
		// Regression gate: tsrange via resolvedSchemaToGeneratedSchema path
		const input = {
			tables: {
				schedules: {
					id: { type: 'uuid' },
					range_col: { type: 'tsrange' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.schema.tables.schedules?.range_col?.type).toBe('tsrange');
		}
	});
});

// ---------------------------------------------------------------------------
// FIND-023: convertColumn validates but drops FK metadata
// ---------------------------------------------------------------------------

describe('FIND-023: FK metadata preserved through resolvedSchemaToGeneratedSchema', () => {
	it('should propagate onDelete, index, parentRole, childRole from references', () => {
		// Regression gate: all FK metadata must survive conversion
		const input = {
			tables: {
				users: { id: { type: 'uuid' } },
				orders: {
					id: { type: 'uuid' },
					user_id: {
						type: 'integer',
						references: {
							table: 'users',
							onDelete: 'CASCADE',
							index: true,
							parentRole: 'owner',
							childRole: 'owned',
						},
					},
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(true);
		if (result.success) {
			const userIdCol = result.schema.tables.orders?.user_id;
			expect(userIdCol?.references?.onDelete).toBe('CASCADE');
			expect(userIdCol?.references?.index).toBe(true);
			expect(userIdCol?.references?.parentRole).toBe('owner');
			expect(userIdCol?.references?.childRole).toBe('owned');
		}
	});

	it('should omit optional FK fields when not present (exactOptionalPropertyTypes)', () => {
		// Regression gate: optional fields must be absent when not supplied
		const input = {
			tables: {
				users: { id: { type: 'uuid' } },
				orders: {
					id: { type: 'uuid' },
					user_id: {
						type: 'integer',
						references: { table: 'users' },
					},
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(true);
		if (result.success) {
			const refs = result.schema.tables.orders?.user_id?.references;
			expect(refs?.table).toBe('users');
			expect('onDelete' in (refs ?? {})).toBe(false);
			expect('parentRole' in (refs ?? {})).toBe(false);
			expect('childRole' in (refs ?? {})).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// FIND-024: Proto-pollution keys rejected in schema accumulators
// ---------------------------------------------------------------------------

describe('FIND-024: prototype-pollution keys rejected during schema validation', () => {
	it('should reject __proto__ as a table name (JSON.parse attack vector)', () => {
		// Regression gate: __proto__ via JSON.parse must cause validation failure.
		// Note: JS object literal { __proto__: ... } sets the prototype — it does NOT
		// create an own property. The real attack vector is JSON.parse, which DOES
		// create an own __proto__ property.
		const rawJson =
			'{"tables":{"__proto__":{"id":{"type":"uuid"}},"users":{"id":{"type":"uuid"}}},"relations":{},"hints":{},"conventions":{"fkPattern":"{singular}Id","pluralize":true,"timestamps":[],"fkAutoIndex":false}}';
		const input = JSON.parse(rawJson);

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(false);
	});

	it('should reject constructor as a table name', () => {
		// Regression gate: constructor key must cause validation failure
		const input = {
			tables: {
				constructor: { id: { type: 'uuid' } },
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(false);
	});

	it('should reject prototype as a relation name', () => {
		// Regression gate: prototype key in relations must cause validation failure
		const input = {
			tables: {
				users: { id: { type: 'uuid' } },
				posts: { id: { type: 'uuid' }, authorId: { type: 'uuid' } },
			},
			relations: {
				prototype: {
					kind: 'belongsTo',
					target: 'users',
					foreignKey: 'authorId',
				},
			},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// FIND-025: columns prop collision with with-config branch detection
// ---------------------------------------------------------------------------

describe('FIND-025: column named "columns" does not confuse with-config branch detection', () => {
	it('resolvedSchemaToGeneratedSchema: flat table with column named columns resolves all columns', () => {
		// Regression gate: 'columns' as a column name in flat shorthand must not be
		// misread as the with-config 'columns' property, which would cause incorrect
		// routing and data loss (remaining columns treated as table config metadata).
		// The new discriminator uses Array.isArray(tableObj.primaryKey) instead of
		// checking for 'columns' presence.
		const input = {
			tables: {
				t: {
					id: { type: 'uuid' },
					columns: { type: 'text' },
					title: { type: 'text' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const result = resolvedSchemaToGeneratedSchema(input);
		expect(result.success).toBe(true);
		if (result.success) {
			const t = result.schema.tables.t;
			expect(t).toBeDefined();
			expect(Object.keys(t ?? {})).toContain('id');
			expect(Object.keys(t ?? {})).toContain('columns');
			expect(Object.keys(t ?? {})).toContain('title');
			// 'columns' column must have type text, not be treated as a nested map
			expect(t?.columns?.type).toBe('text');
		}
	});
});

// ---------------------------------------------------------------------------
// FIND-026: buildRelationIR drops sourceKey/targetKey
// ---------------------------------------------------------------------------

describe('FIND-026: sourceKey and targetKey threaded through buildRelationIR', () => {
	it('should preserve targetKey from belongsTo relation in ModelIR', () => {
		// Regression gate: targetKey must flow from GeneratedBelongsTo → RelationIR
		const schema: GeneratedSchema = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					slug: { type: 'string' },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorSlug: { type: 'string' },
				},
			},
			relations: {
				'posts.author': {
					kind: 'belongsTo',
					target: 'users',
					foreignKey: 'authorSlug',
					targetKey: 'slug',
				},
			},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const model = buildModelFromSchema(schema);
		const relation = model.getRelation('posts.author');
		expect(relation).toBeDefined();
		expect((relation as unknown as Record<string, unknown>).targetKey).toBe('slug');
	});

	it('should preserve sourceKey from hasMany relation in ModelIR', () => {
		// Regression gate: sourceKey must flow from GeneratedHasMany → RelationIR
		const schema: GeneratedSchema = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					userId: { type: 'string' },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					ownerRef: { type: 'string' },
				},
			},
			relations: {
				'users.posts': {
					kind: 'hasMany',
					target: 'posts',
					foreignKey: 'ownerRef',
					sourceKey: 'userId',
				},
			},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const model = buildModelFromSchema(schema);
		const relation = model.getRelation('users.posts');
		expect(relation).toBeDefined();
		expect((relation as unknown as Record<string, unknown>).sourceKey).toBe('userId');
	});

	it('should not set sourceKey/targetKey when not specified', () => {
		// Regression gate: when keys not specified, properties must be absent
		const schema: GeneratedSchema = {
			tables: {
				users: { id: { type: 'uuid', primaryKey: true } },
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: { type: 'uuid' },
				},
			},
			relations: {
				'posts.author': {
					kind: 'belongsTo',
					target: 'users',
					foreignKey: 'authorId',
				},
			},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const model = buildModelFromSchema(schema);
		const relation = model.getRelation('posts.author') as unknown as Record<
			string,
			unknown
		>;
		expect(relation).toBeDefined();
		expect('targetKey' in relation).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// M-2 regression: safeRecord applied to column-dict and indexes-dict
// ---------------------------------------------------------------------------

describe('M-2: prototype-pollution keys rejected in column dict and indexes dict', () => {
	it('column dict: __proto__ key injected via JSON.parse is rejected by Valibot', () => {
		// JSON.parse with the string '{"__proto__": ...}' creates an object whose
		// Object.keys() includes "__proto__" as an own-property — safeRecord must catch it
		// before Valibot iterates entries and potentially writes into the prototype chain.
		const baseInput = {
			tables: { users: { id: { type: 'uuid', primaryKey: true } } },
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};
		const input = JSON.parse(JSON.stringify(baseInput)) as Record<string, unknown>;

		// Inject __proto__ as an own-property column key via JSON.parse
		const tablesInput = input['tables'] as Record<string, unknown>;
		const usersTable = JSON.parse(
			'{"id": {"type": "uuid"}, "__proto__": {"type": "integer"}}',
		) as Record<string, unknown>;
		tablesInput['users'] = usersTable;

		// Verify the injection produced a true own-property (not inherited)
		expect(Object.keys(usersTable)).toContain('__proto__');

		const result = resolvedSchemaToGeneratedSchema(input);
		// The safeRecord wrapper must reject this input — success must be false
		expect(result.success).toBe(false);
	});

	it('indexes dict: __proto__ key injected via JSON.parse is rejected by Valibot', () => {
		// Inject __proto__ as an own-property index table-name key at the indexes level
		const baseInput = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		};

		const input = JSON.parse(JSON.stringify(baseInput)) as Record<string, unknown>;
		// indexes dict: map from table-name → IndexDefinition[]
		// Inject __proto__ as a table-name key in the indexes dict
		const indexesInput = JSON.parse(
			'{"__proto__": [{"name": "idx_evil", "columns": ["id"], "method": "btree"}]}',
		) as Record<string, unknown>;
		input['indexes'] = indexesInput;

		const result = resolvedSchemaToGeneratedSchema(input);
		// safeRecord on IndexesDefinitionSchema must reject the __proto__ key
		expect(result.success).toBe(false);
	});

	it('valid column dict with normal keys passes validation', () => {
		// Control test: no pollution keys → must succeed
		const result = resolvedSchemaToGeneratedSchema({
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'text' },
				},
			},
			relations: {},
			hints: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: [],
				fkAutoIndex: false,
			},
		});
		expect(result.success).toBe(true);
	});
});
