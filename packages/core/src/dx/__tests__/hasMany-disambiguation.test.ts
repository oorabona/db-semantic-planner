/**
 * Tests for hasMany relation disambiguation when multiple FKs point to the same table.
 *
 * When a table has 2+ FKs with explicit `as` naming to the same target table,
 * the hasMany inverse relations on the target must be distinct.
 *
 * --- schema() DSL path (dx/schema.ts → buildRelations) ---
 * Uses `as` + `inverse` to produce explicit inverse names.
 * Two FKs to the same table already generate distinct inverses via
 * the `${localRelation}_${sourceTable}` convention: caller_calls, callee_calls.
 *
 */

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { createOrm } from '../orm.js';
import { ref, schema } from '../schema.js';

// ---------------------------------------------------------------------------
// schema() DSL schemas
// ---------------------------------------------------------------------------

/**
 * schema() DSL: two FKs from calls → symbols with explicit `as` naming.
 * Generates inverse names: caller_calls, callee_calls (distinct, no collision).
 */
const callGraphSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		caller_id: ref('symbols', { as: 'caller' }),
		callee_id: ref('symbols', { as: 'callee' }),
	},
});

/** Single FK schema — backward-compat check. */
const singleFkSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users'),
	},
});

function buildOrm(db: typeof callGraphSchema) {
	const adapter = createPgsqlCompileOnlyAdapter({ model: db.model });
	return createOrm({ model: db.model, adapter });
}

// ---------------------------------------------------------------------------
// Tests: schema() DSL path (buildRelations via schema())
// ---------------------------------------------------------------------------

describe('hasMany disambiguation — schema() DSL path', () => {
	it('symbols table has TWO distinct hasMany relations', () => {
		const { model } = callGraphSchema;
		const symbolRelations = model.getRelationsFrom('symbols');
		const hasManyNames = symbolRelations
			.filter((r) => r.type === 'hasMany')
			.map((r) => r.name);
		// schema() DSL uses ${localRelation}_${sourceTable} convention
		expect(hasManyNames).toContain('caller_calls');
		expect(hasManyNames).toContain('callee_calls');
		expect(hasManyNames).toHaveLength(2);
	});

	it('caller_calls uses caller_id FK', () => {
		const { model } = callGraphSchema;
		const callerCalls = model.getRelation('symbols.caller_calls');
		expect(callerCalls?.foreignKey).toBe('caller_id');
	});

	it('callee_calls uses callee_id FK', () => {
		const { model } = callGraphSchema;
		const calleeCalls = model.getRelation('symbols.callee_calls');
		expect(calleeCalls?.foreignKey).toBe('callee_id');
	});

	it('include("caller_calls") compiles and SQL uses caller_id', () => {
		const orm = buildOrm(callGraphSchema);
		const { symbols } = callGraphSchema.tables;
		const { sql } = orm
			.from(symbols)
			.include('caller_calls', { join: 'left' })
			.dump();
		expect(sql).toContain('caller_id');
		expect(sql).not.toContain('callee_id');
	});

	it('include("callee_calls") compiles and SQL uses callee_id', () => {
		const orm = buildOrm(callGraphSchema);
		const { symbols } = callGraphSchema.tables;
		const { sql } = orm
			.from(symbols)
			.include('callee_calls', { join: 'left' })
			.dump();
		expect(sql).toContain('callee_id');
		expect(sql).not.toContain('caller_id');
	});

	it('forward belongsTo relations from calls: caller and callee', () => {
		const { model } = callGraphSchema;
		const caller = model.getRelation('calls.caller');
		const callee = model.getRelation('calls.callee');
		expect(caller?.type).toBe('belongsTo');
		expect(caller?.foreignKey).toBe('caller_id');
		expect(callee?.type).toBe('belongsTo');
		expect(callee?.foreignKey).toBe('callee_id');
	});
});

// ---------------------------------------------------------------------------
// Tests: backward compat — single FK
// ---------------------------------------------------------------------------

describe('hasMany disambiguation — backward compat, single FK', () => {
	it('schema() DSL: single FK uses local-relation_table convention', () => {
		const { model } = singleFkSchema;
		const userRelations = model.getRelationsFrom('users');
		const hasManyRelation = userRelations.find((r) => r.type === 'hasMany');
		// localRelation='author' (from authorId), inverse='author_posts'
		expect(hasManyRelation?.name).toBe('author_posts');
		expect(hasManyRelation?.foreignKey).toBe('authorId');
	});
});
