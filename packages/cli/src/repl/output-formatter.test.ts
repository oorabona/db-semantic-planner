/**
 * NQL v2.1: Tests for output formatters (json|table|csv)
 */

import { describe, expect, it } from 'vitest';
import { formatOutput } from './output-formatter.js';

describe('formatOutput', () => {
	describe('json mode', () => {
		it('should format rows as nested JSON', () => {
			// Arrange
			const rows = [
				{ id: 1, name: 'Alice', address: { city: 'Paris' } },
				{ id: 2, name: 'Bob', address: { city: 'Lyon' } },
			];
			const columns = ['id', 'name', 'address'];

			// Act
			const result = formatOutput(rows, columns, 'json');

			// Assert
			expect(result).toContain('"id": 1');
			expect(result).toContain('"name": "Alice"');
			expect(result).toContain('"city": "Paris"');
			// JSON preserves nested structure
			const parsed = JSON.parse(result);
			expect(parsed[0].address.city).toBe('Paris');
		});

		it('should handle empty rows', () => {
			// Arrange
			const rows: Record<string, unknown>[] = [];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'json');

			// Assert
			expect(result).toBe('[]');
		});
	});

	describe('table mode', () => {
		it('should format flat rows as ASCII table', () => {
			// Arrange
			const rows = [
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'table');

			// Assert
			expect(result).toContain('id');
			expect(result).toContain('name');
			expect(result).toContain('Alice');
			expect(result).toContain('Bob');
			expect(result).toContain('---'); // Separator
		});

		it('should flatten nested objects using underscore convention', () => {
			// Arrange
			const rows = [
				{ id: 1, customer: { name: 'Alice', address: { city: 'Paris' } } },
			];
			const columns = ['id', 'customer'];

			// Act
			const result = formatOutput(rows, columns, 'table');

			// Assert
			// Nested customer.name becomes customer_name
			expect(result).toContain('customer_name');
			expect(result).toContain('Alice');
			// Nested customer.address.city becomes customer_address_city
			expect(result).toContain('customer_address_city');
			expect(result).toContain('Paris');
		});

		it('should handle empty rows', () => {
			// Arrange
			const rows: Record<string, unknown>[] = [];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'table');

			// Assert
			expect(result).toBe('(empty result set)');
		});

		it('should handle arrays by stringifying them', () => {
			// Arrange
			const rows = [{ id: 1, tags: ['a', 'b', 'c'] }];
			const columns = ['id', 'tags'];

			// Act
			const result = formatOutput(rows, columns, 'table');

			// Assert
			expect(result).toContain('["a","b","c"]');
		});

		it('should handle null values', () => {
			// Arrange
			const rows = [{ id: 1, name: null }];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'table');

			// Assert
			expect(result).toContain('null');
		});
	});

	describe('csv mode', () => {
		it('should format flat rows as CSV', () => {
			// Arrange
			const rows = [
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'csv');

			// Assert
			const lines = result.split('\n');
			expect(lines[0]).toBe('id,name');
			expect(lines[1]).toBe('1,Alice');
			expect(lines[2]).toBe('2,Bob');
		});

		it('should flatten nested objects', () => {
			// Arrange
			const rows = [{ id: 1, customer: { name: 'Alice' } }];
			const columns = ['id', 'customer'];

			// Act
			const result = formatOutput(rows, columns, 'csv');

			// Assert
			const lines = result.split('\n');
			expect(lines[0]).toContain('customer_name');
			expect(lines[1]).toContain('Alice');
		});

		it('should escape values with commas', () => {
			// Arrange
			const rows = [{ id: 1, desc: 'Hello, World' }];
			const columns = ['id', 'desc'];

			// Act
			const result = formatOutput(rows, columns, 'csv');

			// Assert
			expect(result).toContain('"Hello, World"');
		});

		it('should escape values with quotes', () => {
			// Arrange
			const rows = [{ id: 1, desc: 'Say "Hello"' }];
			const columns = ['id', 'desc'];

			// Act
			const result = formatOutput(rows, columns, 'csv');

			// Assert
			expect(result).toContain('"Say ""Hello"""');
		});

		it('should handle empty rows', () => {
			// Arrange
			const rows: Record<string, unknown>[] = [];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'csv');

			// Assert
			expect(result).toBe('');
		});

		it('should handle null values', () => {
			// Arrange
			const rows = [{ id: 1, name: null }];
			const columns = ['id', 'name'];

			// Act
			const result = formatOutput(rows, columns, 'csv');

			// Assert
			const lines = result.split('\n');
			expect(lines[1]).toBe('1,null');
		});
	});
});
