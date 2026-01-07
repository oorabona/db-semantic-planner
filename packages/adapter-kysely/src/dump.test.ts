import {
	belongsTo,
	defineSchema,
	hasMany,
	plan,
	type QueryIntent,
} from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDump, createDumpFromPlan, formatDump } from './dump.js';

// ============================================================================
// Test Setup
// ============================================================================

function createTestKysely() {
	return new Kysely<Record<string, unknown>>({
		dialect: new SqliteDialect({
			database: new Database(':memory:'),
		}),
	});
}

const basicSchema = defineSchema({
	users: {
		id: 'number',
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: 'number',
		title: 'string',
		content: 'string',
		userId: 'number',
		published: 'boolean',
	},
})
	.relations({
		users: {
			posts: hasMany('posts', { foreignKey: 'userId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'userId' }),
		},
	})
	.build();

// ============================================================================
// createDump Tests
// ============================================================================

describe('Dump API', () => {
	const kysely = createTestKysely();

	describe('createDump', () => {
		it('should create a dump from intent', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely);

			expect(dump.plan).toBeDefined();
			expect(dump.plan.rootTable).toBe('users');
			expect(dump.sql).toContain('select');
			expect(dump.sql).toContain('users');
			expect(dump.params).toEqual([]);
		});

		it('should include parameters in dump', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'eq',
					value: 42,
				},
			};

			const dump = createDump(intent, basicSchema, kysely);

			expect(dump.params).toContain(42);
		});

		it('should include metadata when options provided', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely, {
				tenant: 'acme',
				queryName: 'findUsers',
				correlationId: 'req-123',
			});

			expect(dump.meta).toBeDefined();
			expect(dump.meta?.tenant).toBe('acme');
			expect(dump.meta?.queryName).toBe('findUsers');
			expect(dump.meta?.correlationId).toBe('req-123');
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('should not include metadata when no options', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely);

			expect(dump.meta).toBeUndefined();
		});

		it('should use tenant as schema prefix', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely, {
				tenant: 'tenant_123',
			});

			expect(dump.sql).toContain('tenant_123');
		});
	});

	describe('createDumpFromPlan', () => {
		it('should create dump from existing plan', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'eq',
					value: 42,
				},
			};

			// Create plan separately
			const planReport = plan(intent, basicSchema);

			// Then create dump from plan
			const dump = createDumpFromPlan(planReport, basicSchema, kysely);

			expect(dump.plan).toBe(planReport);
			expect(dump.sql).toContain('select');
			expect(dump.params).toContain(42);
		});

		it('should include metadata with createDumpFromPlan', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const planReport = plan(intent, basicSchema);
			const dump = createDumpFromPlan(planReport, basicSchema, kysely, {
				queryName: 'getUserList',
			});

			expect(dump.meta?.queryName).toBe('getUserList');
		});
	});

	describe('formatDump', () => {
		it('should format basic dump', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely);
			const formatted = formatDump(dump);

			expect(formatted).toContain('[users]');
			expect(formatted).toContain('select');
		});

		it('should format dump with queryName', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely, {
				queryName: 'findActiveUsers',
			});
			const formatted = formatDump(dump);

			expect(formatted).toContain('[findActiveUsers]');
		});

		it('should format dump with parameters', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'comparison',
					field: 'name',
					operator: 'eq',
					value: 'Alice',
				},
			};

			const dump = createDump(intent, basicSchema, kysely);
			const formatted = formatDump(dump);

			expect(formatted).toContain('Params:');
			expect(formatted).toContain('Alice');
		});

		it('should format dump with correlationId', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const dump = createDump(intent, basicSchema, kysely, {
				correlationId: 'trace-456',
			});
			const formatted = formatDump(dump);

			expect(formatted).toContain('CorrelationId: trace-456');
		});
	});
});
