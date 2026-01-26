import { fk, plan, schema, type QueryIntent } from '@dbsp/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
	createDump,
	createDumpFromPlan,
	formatDump,
	formatDumpJson,
	toJsonDump,
} from './dump.js';
import { REDACTED_PLACEHOLDER } from './types.js';

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

const basicSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		content: 'string',
		userId: fk('users', { as: 'author', inverse: 'posts' }),
		published: 'boolean',
	},
}).model;

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
				schemaName: 'acme',
				queryName: 'findUsers',
				correlationId: 'req-123',
			});

			expect(dump.meta).toBeDefined();
			expect(dump.meta?.schema).toBe('acme');
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
				schemaName: 'tenant_123',
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

	// ============================================================================
	// formatDumpJson Tests (ADAPTER-004)
	// ============================================================================

	describe('formatDumpJson', () => {
		describe('Scenario 2.1: formatDumpJson returns valid JSON', () => {
			it('should return valid JSON string', () => {
				// Given
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
				};
				const dump = createDump(intent, basicSchema, kysely, {
					correlationId: 'abc-123',
					queryName: 'findUsers',
				});

				// When
				const result = formatDumpJson(dump);

				// Then
				expect(() => JSON.parse(result)).not.toThrow();
			});
		});

		describe('Scenario 2.2: JSON includes all fields', () => {
			it('should include sql, params, correlationId, queryName, decisions', () => {
				// Given
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
				const dump = createDump(intent, basicSchema, kysely, {
					correlationId: 'trace-789',
					queryName: 'getUser',
					schemaName: 'acme',
				});

				// When
				const result = JSON.parse(formatDumpJson(dump));

				// Then
				expect(result.sql).toContain('select');
				expect(result.params).toContain(42);
				expect(result.correlationId).toBe('trace-789');
				expect(result.queryName).toBe('getUser');
				expect(result.schema).toBe('acme');
				expect(result.rootTable).toBe('users');
				expect(Array.isArray(result.decisions)).toBe(true);
				expect(Array.isArray(result.warnings)).toBe(true);
			});

			it('should include compiledAt as ISO string', () => {
				// Given
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
				};
				const dump = createDump(intent, basicSchema, kysely, {
					queryName: 'test',
				});

				// When
				const result = JSON.parse(formatDumpJson(dump));

				// Then
				expect(result.compiledAt).toBeDefined();
				expect(new Date(result.compiledAt).toISOString()).toBe(
					result.compiledAt,
				);
			});
		});

		describe('Scenario 2.3: JSON decisions are summarized', () => {
			it('should include decision type and choice only (no reasoning)', () => {
				// Given - EXISTS intent triggers filter-strategy decision
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					where: {
						kind: 'exists',
						relation: 'posts',
					},
				};
				const dump = createDump(intent, basicSchema, kysely);

				// When
				const result = toJsonDump(dump);

				// Then - decisions is array of {type, choice}
				expect(result.decisions.length).toBeGreaterThan(0);
				const decision = result.decisions[0];
				expect(decision).toHaveProperty('type');
				expect(decision).toHaveProperty('choice');
				// Should NOT have reasoning (verbose mode only)
				expect(decision).not.toHaveProperty('reasoning');
			});
		});

		describe('Scenario 2.4: formatDumpJson with redaction option', () => {
			it('should redact sensitive params when redact: true', () => {
				// Given
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					where: {
						kind: 'and',
						conditions: [
							{
								kind: 'comparison',
								field: 'email',
								operator: 'eq',
								value: 'john@example.com',
							},
							{
								kind: 'comparison',
								field: 'password',
								operator: 'eq',
								value: 'secret123',
							},
						],
					},
				};
				const dump = createDump(intent, basicSchema, kysely);

				// When
				const result = JSON.parse(
					formatDumpJson(dump, {
						redact: true,
						fieldHints: ['email', 'password'],
					}),
				);

				// Then - password is redacted, email is not
				expect(result.params).toContain('john@example.com');
				expect(result.params).toContain(REDACTED_PLACEHOLDER);
				expect(result.params).not.toContain('secret123');
			});

			it('should NOT redact when redact: false', () => {
				// Given
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					where: {
						kind: 'comparison',
						field: 'password',
						operator: 'eq',
						value: 'secret123',
					},
				};
				const dump = createDump(intent, basicSchema, kysely);

				// When - redact is false (default)
				const result = JSON.parse(formatDumpJson(dump));

				// Then - value is NOT redacted
				expect(result.params).toContain('secret123');
			});
		});

		describe('toJsonDump', () => {
			it('should return JsonDump object without stringifying', () => {
				// Given
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
				};
				const dump = createDump(intent, basicSchema, kysely);

				// When
				const result = toJsonDump(dump);

				// Then - it's an object, not a string
				expect(typeof result).toBe('object');
				expect(result.sql).toBeDefined();
				expect(result.rootTable).toBe('users');
			});
		});
	});

	// ============================================================================
	// Recursive Include Integration (DX-017)
	// ============================================================================

	describe('Recursive Include Integration (DX-017)', () => {
		// Schema with self-referential relation for recursive queries
		const recursiveSchema = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				parentId: fk('categories', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		}).model;

		it('should generate WITH RECURSIVE SQL for recursive include', () => {
			// Given - intent with recursive include (as IntentAST)
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [
					{
						relation: 'children',
						recursive: { maxDepth: 10 },
					},
				],
			};

			// When - create dump
			const dump = createDump(intent, recursiveSchema, kysely);

			// Then - SQL should contain WITH RECURSIVE
			expect(dump.sql.toUpperCase()).toContain('WITH RECURSIVE');
			expect(dump.sql).toContain('cte_categories_children');
			expect(dump.plan.ctes.length).toBeGreaterThan(0);
			expect(dump.plan.ctes.some((c) => c.recursive)).toBe(true);
		});

		it('should include depth tracking when requested', () => {
			// Given - intent with depth tracking
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [
					{
						relation: 'children',
						recursive: {
							maxDepth: 5,
							track: { depth: true },
						},
					},
				],
			};

			// When
			const dump = createDump(intent, recursiveSchema, kysely);

			// Then - should have depth column in CTE
			expect(dump.sql.toUpperCase()).toContain('WITH RECURSIVE');
			// The depth is tracked in the CTE
			expect(dump.sql.toLowerCase()).toContain('depth');
		});
	});
});
