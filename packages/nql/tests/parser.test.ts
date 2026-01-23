import { describe, expect, it } from 'vitest';
import { parseCst } from '../src/parser/index.js';

/**
 * Parser Tests - Based on BDD scenarios from NQL-SPEC-2026-01.md
 *
 * PARSE-Q01 to PARSE-Q18: Query scenarios
 * PARSE-M01 to PARSE-M07: Mutation scenarios
 */

describe('NqlParser', () => {
	describe('Query Parsing (PARSE-Q01-Q18)', () => {
		it('PARSE-Q01: Simple table reference', () => {
			const result = parseCst('products');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q02: Filter with comparison', () => {
			const result = parseCst('products | where price > 100');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q03: Multiple where clauses (ANDed)', () => {
			const result = parseCst(
				'products | where active = true | where price < 500',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q04: Select with alias', () => {
			const result = parseCst('products | select name, price as cost');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q05: Join with `with`', () => {
			const result = parseCst('orders | with customer');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q06: Join with `via` disambiguation', () => {
			const result = parseCst('orders | with customer via customerId');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q07: Aggregation with group by', () => {
			const result = parseCst(
				'orders | group by status | select status, count(*)',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q08: Order by with direction', () => {
			const result = parseCst('products | order by price desc');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q09: Limit and offset', () => {
			const result = parseCst('products | limit 10 | offset 20');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q10: BETWEEN expression', () => {
			const result = parseCst('products | where price between 100 and 500');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q11: IN with value list', () => {
			const result = parseCst("products | where category in ('A', 'B', 'C')");
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q12: IN with date range literal', () => {
			const result = parseCst("orders | where created in 'last 30 days'");
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q13: EXISTS subquery', () => {
			const result = parseCst(
				'customers | where exists (orders | where customerId = customers.id)',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q14: IS NULL check', () => {
			const result = parseCst('products | where deletedAt is null');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q15: IS NOT NULL check', () => {
			const result = parseCst('products | where description is not null');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q16: Scalar subquery in expression', () => {
			const result = parseCst(
				'products | where price > (products | select avg(price))',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q17: Relation star', () => {
			const result = parseCst('orders | with customer | select *, customer.*');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q18: Let binding (CTE)', () => {
			const query = `
        let active_products = products | where active = true
        active_products | select name, price
      `;
			const result = parseCst(query);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});
	});

	describe('Mutation Parsing (PARSE-M01-M07)', () => {
		it('PARSE-M01: INSERT', () => {
			const result = parseCst(
				"insert into products set name = 'iPhone', price = 999",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-M02: UPDATE with WHERE', () => {
			const result = parseCst('update products set price = 899 where id = 1');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-M03: DELETE with WHERE', () => {
			const result = parseCst('delete from products where id = 1');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-M04: DELETE without WHERE is error', () => {
			const result = parseCst('delete from products');
			// Parser should accept it syntactically; semantic layer enforces WHERE requirement
			// Per spec: "semantic layer enforces WHERE requirement"
			expect(result.errors).toHaveLength(0);
		});

		it('PARSE-M05: UPSERT', () => {
			const result = parseCst(
				"upsert into products on id set name = 'iPhone', price = 999 where id = 1",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-M06: INSERT with RETURNING (pipeline)', () => {
			const result = parseCst(
				"insert into products set name = 'X' | select id, name",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-M07: Mutation with bind for chaining', () => {
			const result = parseCst(`
        insert into orders set customerId = 1 | bind order
        insert into order_items set orderId = order.id, productId = 5
      `);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});
	});

	describe('Error Recovery', () => {
		it('reports error for invalid syntax', () => {
			const result = parseCst('products | | where');
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it('reports error for unclosed parenthesis', () => {
			const result = parseCst('products | where price in (1, 2, 3');
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it('reports error for invalid expression', () => {
			const result = parseCst('products | where = 5');
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	describe('Edge Cases', () => {
		it('handles empty input', () => {
			const result = parseCst('');
			// Empty program is valid (0 statements)
			expect(result.cst).toBeDefined();
		});

		it('handles whitespace only', () => {
			const result = parseCst('   \n\t   ');
			expect(result.cst).toBeDefined();
		});

		it('handles comments', () => {
			const result = parseCst(`
        # This is a comment
        products | where active = true
      `);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles quoted identifiers', () => {
			const result = parseCst('"order" | where "user-id" = 1');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles SQL-style string escapes', () => {
			const result = parseCst("products | where name = 'O''Brien'");
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles complex nested expressions', () => {
			const result = parseCst(
				'products | where (price > 100 and active = true) or category = 5',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles multiple order by columns', () => {
			const result = parseCst('products | order by category asc, price desc');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles dot notation for columns', () => {
			const result = parseCst(
				"orders | with customer | where customer.name = 'John'",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles function calls in select', () => {
			const result = parseCst(
				'orders | select count(*), sum(amount), avg(amount)',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles distinct keyword', () => {
			const result = parseCst('products | select distinct category');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles LIKE operator', () => {
			const result = parseCst("products | where name like '%phone%'");
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles NOT operator', () => {
			const result = parseCst('products | where not (price > 1000)');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('handles arithmetic expressions', () => {
			const result = parseCst('products | select price * 1.1 as priceWithTax');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});
	});
});
