import { describe, expect, it } from 'vitest';
import { NqlLexer } from '../src/lexer/index.js';
import {
	All,
	And,
	As,
	Asc,
	Between,
	Bind,
	Case,
	Comma,
	Delete,
	Desc,
	Distinct,
	Dot,
	End,
	Every,
	Exists,
	False,
	Flat,
	From,
	GroupBy,
	Identifier,
	In,
	Insert,
	Into,
	Is,
	Like,
	Limit,
	LParen,
	Minus,
	None,
	Not,
	Null,
	NumberLiteral,
	Offset,
	On,
	Or,
	OrderBy,
	Percent,
	Pipe,
	Plus,
	QuotedIdentifier,
	RParen,
	Select,
	SetKeyword,
	Slash,
	Some,
	Star,
	StringLiteral,
	Then,
	True,
	Update,
	Upsert,
	Via,
	When,
	Where,
} from '../src/lexer/tokens.js';

describe('NqlLexer', () => {
	describe('LEX-01: Simple query tokenization', () => {
		it('tokenizes simple query', () => {
			const result = NqlLexer.tokenize('products | where active = true');
			expect(result.errors).toHaveLength(0);

			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toEqual([
				'Identifier',
				'Pipe',
				'Where',
				'Identifier',
				'Equals',
				'True',
			]);
		});

		it('tokenizes table name correctly', () => {
			const result = NqlLexer.tokenize('products');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens).toHaveLength(1);
			expect(result.tokens[0]!.tokenType).toBe(Identifier);
			expect(result.tokens[0]!.image).toBe('products');
		});
	});

	describe('LEX-02: Quoted identifiers', () => {
		it('tokenizes quoted identifier for reserved word', () => {
			const result = NqlLexer.tokenize('"order" | where id = 1');
			expect(result.errors).toHaveLength(0);

			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toContain('QuotedIdentifier');
			expect(result.tokens[0]!.image).toBe('"order"');
		});

		it('tokenizes quoted identifier with special characters', () => {
			const result = NqlLexer.tokenize('"user-id" = 5');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(QuotedIdentifier);
			expect(result.tokens[0]!.image).toBe('"user-id"');
		});

		it('tokenizes escaped quotes in identifier', () => {
			const result = NqlLexer.tokenize('"col""name"');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(QuotedIdentifier);
			expect(result.tokens[0]!.image).toBe('"col""name"');
		});
	});

	describe('LEX-03: String literals with escapes', () => {
		it('tokenizes simple string', () => {
			const result = NqlLexer.tokenize("where name = 'John'");
			expect(result.errors).toHaveLength(0);
			const stringToken = result.tokens.find(
				(t) => t.tokenType === StringLiteral,
			);
			expect(stringToken?.image).toBe("'John'");
		});

		it('tokenizes string with escaped quote', () => {
			const result = NqlLexer.tokenize("where name = 'O''Brien'");
			expect(result.errors).toHaveLength(0);
			const stringToken = result.tokens.find(
				(t) => t.tokenType === StringLiteral,
			);
			expect(stringToken?.image).toBe("'O''Brien'");
		});

		it('tokenizes string with multiple escaped quotes', () => {
			const result = NqlLexer.tokenize("where name = 'It''s a ''test'''");
			expect(result.errors).toHaveLength(0);
			const stringToken = result.tokens.find(
				(t) => t.tokenType === StringLiteral,
			);
			expect(stringToken?.image).toBe("'It''s a ''test'''");
		});
	});

	describe('LEX-04: Invalid characters', () => {
		it('reports error for @ symbol', () => {
			const result = NqlLexer.tokenize('products | where @ = 1');
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it('reports error for $ symbol', () => {
			const result = NqlLexer.tokenize('products | where $price = 1');
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	describe('Number literals', () => {
		it('tokenizes integer', () => {
			const result = NqlLexer.tokenize('100');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(NumberLiteral);
			expect(result.tokens[0]!.image).toBe('100');
		});

		it('tokenizes decimal', () => {
			const result = NqlLexer.tokenize('99.99');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(NumberLiteral);
			expect(result.tokens[0]!.image).toBe('99.99');
		});

		it('tokenizes negative number as unary minus + number', () => {
			// SQL behavior: -42 is tokenized as unary minus followed by number
			// This allows "price-1" to be parsed as subtraction, not "price" + "-1"
			const result = NqlLexer.tokenize('-42');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens.length).toBe(2);
			expect(result.tokens[0]!.tokenType).toBe(Minus);
			expect(result.tokens[0]!.image).toBe('-');
			expect(result.tokens[1]!.tokenType).toBe(NumberLiteral);
			expect(result.tokens[1]!.image).toBe('42');
		});
	});

	describe('Keywords', () => {
		it('recognizes all query keywords', () => {
			const keywords = [
				['select', Select],
				['where', Where],
				['flat', Flat],
				['via', Via],
				['bind', Bind],
				['group by', GroupBy],
				['order by', OrderBy],
				['limit', Limit],
				['offset', Offset],
				['distinct', Distinct],
				['as', As],
				['on', On],
			] as const;

			for (const [keyword, expectedToken] of keywords) {
				const result = NqlLexer.tokenize(keyword);
				expect(result.errors).toHaveLength(0);
				expect(result.tokens[0]!.tokenType).toBe(expectedToken);
			}
		});

		it('recognizes boolean operators', () => {
			const result = NqlLexer.tokenize('and or not');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(And);
			expect(result.tokens[1]!.tokenType).toBe(Or);
			expect(result.tokens[2]!.tokenType).toBe(Not);
		});

		it('recognizes comparison keywords', () => {
			const keywords = [
				['in', In],
				['between', Between],
				['like', Like],
				['is', Is],
				['exists', Exists],
			] as const;

			for (const [keyword, expectedToken] of keywords) {
				const result = NqlLexer.tokenize(keyword);
				expect(result.errors).toHaveLength(0);
				expect(result.tokens[0]!.tokenType).toBe(expectedToken);
			}
		});

		it('recognizes quantifier keywords (SPEC-002)', () => {
			const keywords = [
				['all', All],
				['some', Some],
				['none', None],
				['every', Every],
			] as const;

			for (const [keyword, expectedToken] of keywords) {
				const result = NqlLexer.tokenize(keyword);
				expect(result.errors).toHaveLength(0);
				expect(result.tokens[0]!.tokenType).toBe(expectedToken);
			}
		});

		it('recognizes mutation keywords', () => {
			const keywords = [
				['insert', Insert],
				['into', Into],
				['update', Update],
				['delete', Delete],
				['from', From],
				['set', SetKeyword],
				['upsert', Upsert],
			] as const;

			for (const [keyword, expectedToken] of keywords) {
				const result = NqlLexer.tokenize(keyword);
				expect(result.errors).toHaveLength(0);
				expect(result.tokens[0]!.tokenType).toBe(expectedToken);
			}
		});

		it('recognizes literals', () => {
			const result = NqlLexer.tokenize('true false null');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(True);
			expect(result.tokens[1]!.tokenType).toBe(False);
			expect(result.tokens[2]!.tokenType).toBe(Null);
		});

		it('recognizes sort directions', () => {
			const result = NqlLexer.tokenize('asc desc');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(Asc);
			expect(result.tokens[1]!.tokenType).toBe(Desc);
		});
	});

	describe('Case insensitivity', () => {
		it('recognizes keywords in any case', () => {
			const cases = ['SELECT', 'Select', 'select', 'sElEcT'];
			for (const kw of cases) {
				const result = NqlLexer.tokenize(kw);
				expect(result.errors).toHaveLength(0);
				expect(result.tokens[0]!.tokenType).toBe(Select);
			}
		});

		it('preserves identifier case', () => {
			const result = NqlLexer.tokenize('ProductName');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.image).toBe('ProductName');
		});
	});

	describe('Operators', () => {
		it('tokenizes comparison operators', () => {
			const result = NqlLexer.tokenize('= != < > <= >=');
			expect(result.errors).toHaveLength(0);
			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toEqual([
				'Equals',
				'NotEquals',
				'LessThan',
				'GreaterThan',
				'LessThanOrEqual',
				'GreaterThanOrEqual',
			]);
		});

		it('tokenizes arithmetic operators', () => {
			const result = NqlLexer.tokenize('+ - * / %');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(Plus);
			expect(result.tokens[1]!.tokenType).toBe(Minus);
			expect(result.tokens[2]!.tokenType).toBe(Star);
			expect(result.tokens[3]!.tokenType).toBe(Slash);
			expect(result.tokens[4]!.tokenType).toBe(Percent);
		});

		it('tokenizes punctuation', () => {
			const result = NqlLexer.tokenize('( ) , . |');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(LParen);
			expect(result.tokens[1]!.tokenType).toBe(RParen);
			expect(result.tokens[2]!.tokenType).toBe(Comma);
			expect(result.tokens[3]!.tokenType).toBe(Dot);
			expect(result.tokens[4]!.tokenType).toBe(Pipe);
		});
	});

	describe('Whitespace and comments', () => {
		it('skips whitespace', () => {
			const result = NqlLexer.tokenize('  products   |   where   ');
			expect(result.errors).toHaveLength(0);
			expect(result.tokens).toHaveLength(3);
		});

		it('skips line comments', () => {
			const result = NqlLexer.tokenize('products # this is a comment\n| where');
			expect(result.errors).toHaveLength(0);
			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toEqual(['Identifier', 'Pipe', 'Where']);
		});

		it('handles multiple comments', () => {
			const result = NqlLexer.tokenize(`
        # Comment 1
        products
        # Comment 2
        | where active = true
      `);
			expect(result.errors).toHaveLength(0);
			expect(result.tokens.length).toBeGreaterThan(0);
		});
	});

	describe('Complex queries', () => {
		it('tokenizes full pipeline query', () => {
			const query = `
        products
        | where category.name = 'Electronics'
        | where price between 100 and 500
        | select name, price, category.name as cat
        | order by price desc
        | limit 10
      `;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			expect(result.tokens.length).toBeGreaterThan(20);
		});

		it('tokenizes aggregation query', () => {
			const query = `
        orders
        | where created in 'last 30 days'
        | group by customer.name
        | select customer.name, sum(amount) as revenue, count(*) as cnt
        | order by revenue desc
        | limit 10
      `;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
		});

		it('tokenizes insert mutation', () => {
			const query = `insert into products set name = 'iPhone 15', price = 999`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toContain('Insert');
			expect(tokenTypes).toContain('Into');
			expect(tokenTypes).toContain('Set');
		});

		it('tokenizes mutation with bind', () => {
			const query = `insert into products set name = 'X' | bind product`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toContain('Bind');
		});
	});

	describe('LEX-CASE: CASE expression tokens', () => {
		it('tokenizes simple CASE expression', () => {
			const query = `case when x then y end`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			const tokens = result.tokens;
			expect(tokens[0]!.tokenType).toBe(Case);
			expect(tokens[1]!.tokenType).toBe(When);
			expect(tokens[2]!.tokenType).toBe(Identifier);
			expect(tokens[3]!.tokenType).toBe(Then);
			expect(tokens[4]!.tokenType).toBe(Identifier);
			expect(tokens[5]!.tokenType).toBe(End);
		});

		it('tokenizes CASE with ELSE', () => {
			const query = `case when x then y else z end`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toContain('Case');
			expect(tokenTypes).toContain('When');
			expect(tokenTypes).toContain('Then');
			expect(tokenTypes).toContain('Else');
			expect(tokenTypes).toContain('End');
		});

		it('tokenizes CASE keywords case-insensitively', () => {
			const query = `CASE WHEN price > 100 THEN 'high' ELSE 'low' END`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			expect(result.tokens[0]!.tokenType).toBe(Case);
			expect(result.tokens[1]!.tokenType).toBe(When);
		});

		it('tokenizes CASE with multiple WHEN clauses', () => {
			const query = `case when a then 1 when b then 2 else 0 end`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			const whenCount = result.tokens.filter(
				(t) => t.tokenType === When,
			).length;
			const thenCount = result.tokens.filter(
				(t) => t.tokenType === Then,
			).length;
			expect(whenCount).toBe(2);
			expect(thenCount).toBe(2);
		});

		it('tokenizes CASE in select clause', () => {
			const query = `products | select case when price > 100 then 'expensive' else 'cheap' end as tier`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			const tokenTypes = result.tokens.map((t) => t.tokenType.name);
			expect(tokenTypes).toContain('Select');
			expect(tokenTypes).toContain('Case');
			expect(tokenTypes).toContain('As');
		});

		it('does not match case/when/then/else/end as prefix of identifiers', () => {
			const query = `caseStudy whenDone thenValue elseWhere endTime`;
			const result = NqlLexer.tokenize(query);
			expect(result.errors).toHaveLength(0);
			// All should be identifiers, not keywords
			expect(result.tokens.every((t) => t.tokenType === Identifier)).toBe(true);
		});
	});
});
