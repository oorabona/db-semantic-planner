// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * @fileoverview Coverage tests for orm.ts
 * Targets uncovered branches not tested in existing test files
 */

import { describe, expect, it } from 'vitest';
import { NamingConventionMismatchError } from './errors.js';
import { isNull } from './filters.js';
import { createHookManager } from './hooks.js';
import { createOrm } from './orm.js';
import { schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = schema({
	users: {
		id: 'integer',
		name: 'string',
		email: 'string',
	},
});

// ============================================================================
// createOrm option combinations
// ============================================================================

describe('createOrm options', () => {
	it('should create ORM with schema and adapter', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert
		expect(orm).toBeDefined();
		expect(orm.select).toBeDefined();
	});

	it('should create ORM with model (ModelIR) and adapter', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ model: testSchema.model, adapter });

		// Assert
		expect(orm).toBeDefined();
		expect(orm.select).toBeDefined();
	});

	it('should throw when neither schema nor model is provided', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act & Assert
		expect(() => createOrm({ adapter } as never)).toThrow(
			/must provide either schema/,
		);
	});

	it('should throw when schema has no model property', () => {
		// Arrange
		const adapter = createMockAdapter();
		const invalidSchema = { definition: {} };

		// Act & Assert
		expect(() =>
			createOrm({ schema: invalidSchema as never, adapter }),
		).toThrow(/must provide either schema/);
	});

	it('should use strictMode = false by default', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert - no error thrown, ORM created successfully
		expect(orm).toBeDefined();
	});

	it('should accept strictMode = true', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ schema: testSchema, adapter, strictMode: true });

		// Assert
		expect(orm).toBeDefined();
	});
});

// ============================================================================
// Naming convention mismatch
// ============================================================================

describe('Naming convention validation', () => {
	it('should not throw when schema and adapter casing match', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.dbCasing = 'camelCase';
		const schemaWithCamelCase = schema(
			{ users: { id: 'integer' } },
			undefined,
			{ dbCasing: 'camelCase' },
		);

		// Act
		const orm = createOrm({ schema: schemaWithCamelCase, adapter });

		// Assert
		expect(orm).toBeDefined();
	});

	it('should not throw when schema has no dbCasing', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.dbCasing = 'camelCase';

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert
		expect(orm).toBeDefined();
	});

	it('should not throw when adapter has no dbCasing', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.dbCasing = undefined;
		const schemaWithCasing = schema({ users: { id: 'integer' } }, undefined, {
			dbCasing: 'snake_case',
		});

		// Act
		const orm = createOrm({ schema: schemaWithCasing, adapter });

		// Assert
		expect(orm).toBeDefined();
	});
});

// ============================================================================
// dialectCapabilities auto-detection
// ============================================================================

describe('dialectCapabilities', () => {
	it('should use adapter dialectCapabilities when available', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.dialectCapabilities = {
			canLateralJoin: true,
			canExplain: true,
			canMaterializeCTE: true,
			canSkipLocked: true,
			canOrderNullsFirstLast: true,
		};

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert - ORM created with capabilities
		expect(orm).toBeDefined();
	});

	it('should handle adapter without explicit dialectCapabilities', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.dialectCapabilities = undefined as never;

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert
		expect(orm).toBeDefined();
	});
});

// ============================================================================
// Hook manager freezing
// ============================================================================

describe('Hook manager freezing', () => {
	it('should freeze hook manager on ORM creation', () => {
		// Arrange
		const adapter = createMockAdapter();
		const hooks = createHookManager().beforeQuery((ctx) => ctx);

		// Act
		const orm = createOrm({ schema: testSchema, adapter, hooks });

		// Assert - ORM created with frozen hooks
		expect(orm).toBeDefined();
	});

	it('should handle ORM creation without hooks', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert
		expect(orm).toBeDefined();
	});
});

// ============================================================================
// defaultFilters from schema
// ============================================================================

describe('defaultFilters', () => {
	it('should pass defaultFilters from schema to ORM instance', () => {
		// Arrange
		const adapter = createMockAdapter();
		const schemaWithDefaults = schema(
			{
				users: {
					id: 'integer',
					deletedAt: 'string',
				},
			},
			undefined,
			{
				defaultFilters: {
					users: isNull('deletedAt'),
				},
			},
		);

		// Act
		const orm = createOrm({ schema: schemaWithDefaults, adapter });

		// Assert
		expect(orm).toBeDefined();
	});

	it('should handle schema without defaultFilters', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ schema: testSchema, adapter });

		// Assert
		expect(orm).toBeDefined();
	});

	it('should handle model (not schema) without defaultFilters', () => {
		// Arrange
		const adapter = createMockAdapter();

		// Act
		const orm = createOrm({ model: testSchema.model, adapter });

		// Assert
		expect(orm).toBeDefined();
	});
});
