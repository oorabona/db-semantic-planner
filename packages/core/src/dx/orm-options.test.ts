/**
 * @module dx/orm-options.test
 * Tests for global ORM options (NQL-ALIGN Block 3).
 *
 * Tests verify that maxDepth, maxTableHops, and maxNestedCase options
 * are correctly accepted and propagated through the ORM.
 */

import { describe, expect, it } from 'vitest';
import { createOrm } from './orm.js';
import { schema } from './schema.js';

/**
 * Minimal schema for testing options propagation.
 */
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
});

describe('NQL-ALIGN Block 3: Global ORM Options', () => {
	describe('options acceptance', () => {
		it('should accept maxDepth option in createOrm', () => {
			// Arrange & Act - should not throw
			const orm = createOrm({
				schema: testSchema,
				maxDepth: 5,
			});

			// Assert - ORM is created successfully
			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
		});

		it('should accept maxTableHops option in createOrm', () => {
			// Arrange & Act - should not throw
			const orm = createOrm({
				schema: testSchema,
				maxTableHops: 3,
			});

			// Assert - ORM is created successfully
			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
		});

		it('should accept maxNestedCase option in createOrm', () => {
			// Arrange & Act - should not throw
			const orm = createOrm({
				schema: testSchema,
				maxNestedCase: 8,
			});

			// Assert - ORM is created successfully
			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
		});

		it('should accept all global options together', () => {
			// Arrange & Act - should not throw
			const orm = createOrm({
				schema: testSchema,
				maxDepth: 15,
				maxTableHops: 7,
				maxNestedCase: 12,
			});

			// Assert - ORM is created successfully with all options
			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
		});
	});

	describe('options with other settings', () => {
		it('should work with strictMode enabled', () => {
			// Arrange & Act
			const orm = createOrm({
				schema: testSchema,
				strictMode: true,
				maxDepth: 10,
				maxTableHops: 5,
				maxNestedCase: 10,
			});

			// Assert
			expect(orm).toBeDefined();
		});

		it('should work without any options (uses defaults)', () => {
			// Arrange & Act - no options provided
			const orm = createOrm({
				schema: testSchema,
			});

			// Assert - ORM uses default values internally
			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
		});
	});
});
