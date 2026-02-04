import { describe, expect, it } from 'vitest';
import { parseCst } from '../src/parser/index.js';

/**
 * Parser Tests - Based on BDD scenarios from NQL-SPEC-2026-01.md
 *
 * PARSE-Q01 to PARSE-Q17: Query scenarios
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

		it('PARSE-Q05: Flat clause forces JOIN strategy', () => {
			const result = parseCst('orders | select *, customer.* | flat');
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q06: Deprecated `with` keyword errors (breaking change v2.1)', () => {
			const result = parseCst('orders | with customer');
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]?.message).toContain('Flat');
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

		it('PARSE-Q09b: Per-include limit', () => {
			const result = parseCst(
				'customers | select id, orders.* | limit orders 3',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q09c: Per-include limit with dotted path', () => {
			const result = parseCst(
				'customers | select id, orders.items.* | limit orders.items 5',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('PARSE-Q09d: Per-include limit + outer limit', () => {
			const result = parseCst(
				'customers | select id, orders.* | limit orders 3 | limit 5',
			);
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

		it('PARSE-Q17: Relation star (implicit include via path)', () => {
			// NQL v2.1: Relations included via path expressions, no 'with' keyword
			const result = parseCst('orders | select *, customer.*');
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
			// NQL v2.1: Relations included implicitly via path expressions
			const result = parseCst("orders | where customer.name = 'John'");
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

	describe('Window Functions', () => {
		it('parses row_number() over (order by)', () => {
			const result = parseCst(
				'products | select name, row_number() over (order by price) as rn',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses rank() over (partition by x order by y)', () => {
			const result = parseCst(
				'products | select name, rank() over (partition by category order by price desc) as price_rank',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses dense_rank() over ()', () => {
			const result = parseCst(
				'products | select dense_rank() over (order by price) as dr',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses aggregate window function: sum() over ()', () => {
			const result = parseCst(
				'sales | select date, amount, sum(amount) over (order by date) as running_total',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses lag() and lead() window functions', () => {
			const result = parseCst(
				'prices | select date, price, lag(price) over (order by date) as prev_price',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses window function with partition by only', () => {
			const result = parseCst(
				'sales | select customer_id, sum(amount) over (partition by customer_id) as customer_total',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses window function with empty over clause', () => {
			const result = parseCst(
				'products | select name, count(*) over () as total_products',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});
	});

	// ============================================================
	// SPEC-002: Cross-table Pseudo-columns (Relation Filters)
	// ============================================================
	describe('SPEC-002: Relation Filter Parsing', () => {
		describe('Explicit quantifier syntax', () => {
			it('parses some(relation).column = value', () => {
				const result = parseCst('users | where some(posts).featured = true');
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses none(relation).column = value', () => {
				const result = parseCst('users | where none(posts).published = false');
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses every(relation).column = value', () => {
				const result = parseCst(
					"users | where every(posts).status = 'approved'",
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses some(relation as alias, condition)', () => {
				const result = parseCst(
					'users | where some(posts as p, p.featured = true and p.published = true)',
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses none(relation as alias, condition)', () => {
				const result = parseCst(
					"users | where none(orders as o, o.status = 'cancelled' and o.total > 100)",
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses some(relation, condition) without alias', () => {
				const result = parseCst('users | where some(posts, featured = true)');
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses multi-hop relation path: some(author.company).name', () => {
				const result = parseCst(
					"posts | where some(author.company).name = 'Acme'",
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});
		});

		describe('ALL quantifier prefix syntax', () => {
			it('parses all relation.column = value', () => {
				const result = parseCst('users | where all posts.featured = true');
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses all with multi-hop path', () => {
				const result = parseCst(
					'posts | where all author.company.verified = true',
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});
		});

		describe('Quantifier combinations', () => {
			it('parses AND of quantified filters', () => {
				const result = parseCst(
					'users | where some(posts).featured = true and none(posts).draft = true',
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses OR of quantified filters', () => {
				const result = parseCst(
					'users | where some(posts).featured = true or every(posts).published = true',
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses quantified filter with regular comparison', () => {
				const result = parseCst(
					'users | where active = true and some(posts).featured = true',
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});
		});

		describe('Comparison operators in quantified filters', () => {
			it('parses some() with > comparison', () => {
				const result = parseCst('users | where some(orders).total > 1000');
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});

			it('parses every() with like comparison', () => {
				const result = parseCst(
					"users | where every(posts).title like '%important%'",
				);
				expect(result.errors).toHaveLength(0);
				expect(result.cst).toBeDefined();
			});
		});
	});

	describe('PARSE-CASE: CASE expression parsing', () => {
		it('parses simple CASE WHEN THEN END', () => {
			const result = parseCst(
				"products | select case when price > 100 then 'expensive' end",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses CASE with ELSE clause', () => {
			const result = parseCst(
				"products | select case when price > 100 then 'expensive' else 'cheap' end",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses CASE with multiple WHEN clauses', () => {
			const result = parseCst(
				"products | select case when price > 100 then 'high' when price > 50 then 'medium' else 'low' end",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses CASE with alias', () => {
			const result = parseCst(
				"products | select case when active = true then 'yes' else 'no' end as status",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses CASE with numeric results', () => {
			const result = parseCst(
				'products | select case when stock < 10 then 1 when stock < 50 then 2 else 3 end as priority',
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});

		it('parses CASE in mixed select', () => {
			const result = parseCst(
				"products | select name, price, case when price > 100 then 'high' else 'low' end as tier",
			);
			expect(result.errors).toHaveLength(0);
			expect(result.cst).toBeDefined();
		});
	});
});
