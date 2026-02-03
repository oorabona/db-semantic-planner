/**
 * NQL v2.0 Parser Grammar (Chevrotain)
 *
 * Pipeline syntax for reads, SQL-familiar mutations.
 * See docs/plans/NQL-PARSER-AUDIT-2026-01.md Section 11 for EBNF.
 */

import { type CstNode, CstParser, type IToken } from 'chevrotain';
import {
	All,
	And,
	As,
	Asc,
	Ascendant,
	allTokens,
	Between,
	Bind,
	Case,
	Child,
	Comma,
	ContainedBy,
	Contains,
	Delete,
	DenseRank,
	Desc,
	Descendant,
	Distinct,
	Dot,
	Else,
	End,
	Equals,
	Every,
	Exists,
	False,
	Flat,
	From,
	GreaterThan,
	GreaterThanOrEqual,
	GroupBy,
	Identifier,
	In,
	Insert,
	Into,
	Is,
	Lag,
	LBracket,
	Lead,
	LessThan,
	LessThanOrEqual,
	Let,
	Like,
	Limit,
	LParen,
	Minus,
	None,
	Not,
	NotEquals,
	NqlLexer,
	Null,
	NumberLiteral,
	Offset,
	On,
	Or,
	OrderBy,
	Over,
	Overlaps,
	Parent,
	PartitionBy,
	Percent,
	Pipe,
	Plus,
	QuotedIdentifier,
	RangeValue,
	Rank,
	RBracket,
	RowNumber,
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
	When,
	Where,
} from '../lexer/tokens.js';

/**
 * NQL Parser using Chevrotain CstParser
 */
export class NqlParser extends CstParser {
	constructor() {
		super(allTokens, {
			recoveryEnabled: true, // Enable error recovery for better error messages
		});
		this.performSelfAnalysis();
	}

	/**
	 * Check if a token type can appear as an identifier segment.
	 * This includes regular identifiers, quoted identifiers, and pseudo-column keywords
	 * (parent, child, ascendant, descendant) which can be used in paths.
	 */
	private isIdentifierLike(tokenType: unknown): boolean {
		return (
			tokenType === Identifier ||
			tokenType === QuotedIdentifier ||
			tokenType === Parent ||
			tokenType === Child ||
			tokenType === Ascendant ||
			tokenType === Descendant
		);
	}

	// ============================================================
	// TOP-LEVEL RULES
	// ============================================================

	/**
	 * program = { let_stmt | statement } ;
	 * Supports multiple statements (queries or mutations) with optional let bindings
	 */
	public program = this.RULE('program', () => {
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.SUBRULE(this.letStatement) },
				{ ALT: () => this.SUBRULE(this.statement) },
			]);
		});
	});

	/**
	 * let_stmt = "let" IDENT "=" query ;
	 */
	private letStatement = this.RULE('letStatement', () => {
		this.CONSUME(Let);
		this.SUBRULE(this.identSegment);
		this.CONSUME(Equals);
		this.SUBRULE(this.query);
	});

	/**
	 * statement = query | mutation_pipeline ;
	 */
	private statement = this.RULE('statement', () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.mutationPipeline) },
			{ ALT: () => this.SUBRULE(this.query) },
		]);
	});

	// ============================================================
	// QUERIES
	// ============================================================

	/**
	 * query = table_ref { "|" query_clause } ;
	 */
	public query = this.RULE('query', () => {
		this.SUBRULE(this.tableRef);
		this.MANY(() => {
			this.CONSUME(Pipe);
			this.SUBRULE(this.queryClause);
		});
	});

	/**
	 * table_ref = ident_segment ;
	 */
	private tableRef = this.RULE('tableRef', () => {
		this.SUBRULE(this.identSegment);
	});

	/**
	 * query_clause = where_clause | select_clause | flat_clause
	 *              | group_clause | order_clause | limit_clause | offset_clause ;
	 * NQL v2.1: Removed with_clause, added flat_clause
	 */
	private queryClause = this.RULE('queryClause', () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.whereClause) },
			{ ALT: () => this.SUBRULE(this.selectClause) },
			{ ALT: () => this.SUBRULE(this.flatClause) },
			{ ALT: () => this.SUBRULE(this.groupClause) },
			{ ALT: () => this.SUBRULE(this.orderClause) },
			{ ALT: () => this.SUBRULE(this.limitClause) },
			{ ALT: () => this.SUBRULE(this.offsetClause) },
		]);
	});

	// ============================================================
	// CLAUSES
	// ============================================================

	/**
	 * where_clause = "where" boolean_expr ;
	 */
	private whereClause = this.RULE('whereClause', () => {
		this.CONSUME(Where);
		this.SUBRULE(this.booleanExpr);
	});

	/**
	 * select_clause = "select" [ "distinct" ] select_list ;
	 */
	private selectClause = this.RULE('selectClause', () => {
		this.CONSUME(Select);
		this.OPTION(() => this.CONSUME(Distinct));
		this.SUBRULE(this.selectList);
	});

	/**
	 * flat_clause = "flat" ;
	 * NQL v2.1: Forces JOIN strategy instead of json_agg for relation includes
	 */
	private flatClause = this.RULE('flatClause', () => {
		this.CONSUME(Flat);
	});

	/**
	 * group_clause = "group" "by" expr_list ;
	 */
	private groupClause = this.RULE('groupClause', () => {
		this.CONSUME(GroupBy);
		this.SUBRULE(this.exprList);
	});

	/**
	 * order_clause = "order" "by" order_list ;
	 */
	private orderClause = this.RULE('orderClause', () => {
		this.CONSUME(OrderBy);
		this.SUBRULE(this.orderList);
	});

	/**
	 * limit_clause = "limit" [ident_segment ("." ident_segment)*] NUMBER ;
	 */
	private limitClause = this.RULE('limitClause', () => {
		this.CONSUME(Limit);
		// Per-include limit: limit <relation> <N>
		// Outer limit:       limit <N>
		// LL(1): IDENTIFIER → per-include, NUMBER → outer
		this.OPTION(() => {
			this.SUBRULE(this.identSegment);
			this.MANY(() => {
				this.CONSUME(Dot);
				this.SUBRULE2(this.identSegment);
			});
		});
		this.CONSUME(NumberLiteral);
	});

	/**
	 * offset_clause = "offset" NUMBER ;
	 */
	private offsetClause = this.RULE('offsetClause', () => {
		this.CONSUME(Offset);
		this.CONSUME(NumberLiteral);
	});

	// ============================================================
	// SELECT
	// ============================================================

	/**
	 * select_list = select_item { "," select_item } ;
	 */
	private selectList = this.RULE('selectList', () => {
		this.SUBRULE(this.selectItem);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.selectItem);
		});
	});

	/**
	 * select_item = "*" | path_star | expr [ "as" ident_segment ] ;
	 * where path_star = ident { "." ident } "." "*"
	 */
	private selectItem = this.RULE('selectItem', () => {
		this.OR([
			// Star alone - matches `*`
			{
				GATE: () => this.LA(1).tokenType === Star,
				ALT: () => this.CONSUME(Star),
			},
			// path.* (relation star) - matches `relation.*` or `a.b.*`
			{
				GATE: () => this.isRelationStar(),
				ALT: () => this.SUBRULE(this.relationStarExpr),
			},
			// expr [ "as" alias ]
			{
				ALT: () => {
					this.SUBRULE(this.expression);
					this.OPTION(() => {
						this.CONSUME(As);
						this.SUBRULE(this.identSegment);
					});
				},
			},
		]);
	});

	/**
	 * relation_star_expr = ident { "." ident } "." "*"
	 * Parses `relation.*` or `a.b.c.*` patterns
	 */
	private relationStarExpr = this.RULE('relationStarExpr', () => {
		this.SUBRULE(this.identSegment);
		// Parse zero or more `.ident` pairs, stopping before `.*`
		this.MANY({
			GATE: () => {
				// Continue if next is `.ident`, stop if next is `.*`
				return (
					this.LA(1).tokenType === Dot &&
					this.isIdentifierLike(this.LA(2).tokenType)
				);
			},
			DEF: () => {
				this.CONSUME(Dot);
				this.SUBRULE2(this.identSegment);
			},
		});
		// Consume the final `.*`
		this.CONSUME2(Dot);
		this.CONSUME(Star);
	});

	/**
	 * Check if current position looks like `path.*`
	 */
	private isRelationStar(): boolean {
		// Look ahead to find pattern: ident(.ident)*.star
		let i = 1;
		while (this.isIdentifierLike(this.LA(i).tokenType)) {
			i++;
			if (this.LA(i).tokenType === Dot) {
				i++;
				// Check if it's .* or .ident
				if (this.LA(i).tokenType === Star) {
					return true;
				}
			} else {
				return false;
			}
		}
		return false;
	}

	// ============================================================
	// ORDER
	// ============================================================

	/**
	 * order_list = order_item { "," order_item } ;
	 */
	private orderList = this.RULE('orderList', () => {
		this.SUBRULE(this.orderItem);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.orderItem);
		});
	});

	/**
	 * order_item = expr [ "asc" | "desc" ] ;
	 */
	private orderItem = this.RULE('orderItem', () => {
		this.SUBRULE(this.expression);
		this.OPTION(() => {
			this.OR([
				{ ALT: () => this.CONSUME(Asc) },
				{ ALT: () => this.CONSUME(Desc) },
			]);
		});
	});

	// ============================================================
	// EXPRESSIONS
	// ============================================================

	/**
	 * boolean_expr = or_expr ;
	 */
	private booleanExpr = this.RULE('booleanExpr', () => {
		this.SUBRULE(this.orExpr);
	});

	/**
	 * or_expr = and_expr { "or" and_expr } ;
	 */
	private orExpr = this.RULE('orExpr', () => {
		this.SUBRULE(this.andExpr);
		this.MANY(() => {
			this.CONSUME(Or);
			this.SUBRULE2(this.andExpr);
		});
	});

	/**
	 * and_expr = not_expr { "and" not_expr } ;
	 */
	private andExpr = this.RULE('andExpr', () => {
		this.SUBRULE(this.notExpr);
		this.MANY(() => {
			this.CONSUME(And);
			this.SUBRULE2(this.notExpr);
		});
	});

	/**
	 * not_expr = [ "not" ] primary_cond ;
	 */
	private notExpr = this.RULE('notExpr', () => {
		this.OPTION(() => this.CONSUME(Not));
		this.SUBRULE(this.primaryCond);
	});

	/**
	 * primary_cond = "(" boolean_expr ")"
	 *              | quantified_relation_filter   -- SPEC-002: some()/none()/every()
	 *              | all_relation_filter          -- SPEC-002: all relation.col = val
	 *              | exists_check
	 *              | comparison / between / in / is_null ;
	 */
	private primaryCond = this.RULE('primaryCond', () => {
		this.OR([
			// Parenthesized boolean expression
			{
				GATE: () => this.LA(1).tokenType === LParen && !this.isScalarSubquery(),
				ALT: () => {
					this.CONSUME(LParen);
					this.SUBRULE(this.booleanExpr);
					this.CONSUME(RParen);
				},
			},
			// SPEC-002: Explicit quantifiers - some()/none()/every()
			{
				GATE: () =>
					this.LA(1).tokenType === Some ||
					this.LA(1).tokenType === None ||
					this.LA(1).tokenType === Every,
				ALT: () => this.SUBRULE(this.quantifiedRelationFilter),
			},
			// SPEC-002: ALL quantifier prefix - all relation.col = val
			{
				GATE: () => this.LA(1).tokenType === All,
				ALT: () => this.SUBRULE(this.allRelationFilter),
			},
			// EXISTS check
			{
				ALT: () => this.SUBRULE(this.existsCheck),
			},
			// Expression-based conditions (comparison, between, in, is null)
			{
				ALT: () => {
					// Parse the left expression first
					this.SUBRULE(this.expression);
					// Then check what follows
					this.OR2([
						// BETWEEN expr AND expr
						{ ALT: () => this.SUBRULE(this.betweenSuffix) },
						// [NOT] IN (...)
						{ ALT: () => this.SUBRULE(this.inSuffix) },
						// IS [NOT] NULL
						{ ALT: () => this.SUBRULE(this.isNullSuffix) },
						// Range operators (overlaps, contains, containedBy) with range literal
						{ ALT: () => this.SUBRULE(this.rangeOpSuffix) },
						// comparison (=, !=, <, >, <=, >=, like)
						{ ALT: () => this.SUBRULE(this.comparisonSuffix) },
					]);
				},
			},
		]);
	});

	/**
	 * comparison_suffix = comp_op expr ;
	 */
	private comparisonSuffix = this.RULE('comparisonSuffix', () => {
		this.SUBRULE(this.compOp);
		this.SUBRULE(this.expression);
	});

	/**
	 * comp_op = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like" ;
	 * Note: Range operators (overlaps, contains, containedBy) are handled
	 * separately in rangeOpSuffix to allow (value,value) range syntax.
	 */
	private compOp = this.RULE('compOp', () => {
		this.OR([
			{ ALT: () => this.CONSUME(Equals) },
			{ ALT: () => this.CONSUME(NotEquals) },
			{ ALT: () => this.CONSUME(LessThan) },
			{ ALT: () => this.CONSUME(GreaterThan) },
			{ ALT: () => this.CONSUME(LessThanOrEqual) },
			{ ALT: () => this.CONSUME(GreaterThanOrEqual) },
			{ ALT: () => this.CONSUME(Like) },
		]);
	});

	/**
	 * range_op = "overlaps" | "contains" | "containedBy" ;
	 * PostgreSQL range operators - handled separately to support (value,value) syntax.
	 */
	private rangeOp = this.RULE('rangeOp', () => {
		this.OR([
			{ ALT: () => this.CONSUME(Overlaps) },
			{ ALT: () => this.CONSUME(Contains) },
			{ ALT: () => this.CONSUME(ContainedBy) },
		]);
	});

	/**
	 * range_op_suffix = range_op (range_literal | literal) ;
	 * Example: overlaps [1,10) or contains (0,100) or contains 25
	 * Note: contains can take a scalar value (e.g., contains 25 checks if range contains the value)
	 */
	private rangeOpSuffix = this.RULE('rangeOpSuffix', () => {
		this.SUBRULE(this.rangeOp);
		this.OR([
			{ ALT: () => this.SUBRULE(this.rangeLiteral) },
			{ ALT: () => this.SUBRULE2(this.literal) },
		]);
	});

	/**
	 * between_suffix = "between" expr "and" expr ;
	 */
	private betweenSuffix = this.RULE('betweenSuffix', () => {
		this.CONSUME(Between);
		this.SUBRULE(this.expression);
		this.CONSUME(And);
		this.SUBRULE2(this.expression);
	});

	/**
	 * exists_check = [ "not" ] "exists" "(" scalar_subquery ")" ;
	 */
	private existsCheck = this.RULE('existsCheck', () => {
		this.OPTION(() => this.CONSUME(Not));
		this.CONSUME(Exists);
		this.CONSUME(LParen);
		this.SUBRULE(this.scalarSubquery);
		this.CONSUME(RParen);
	});

	// ============================================================
	// SPEC-002: RELATION FILTER EXPRESSIONS
	// ============================================================

	/**
	 * SPEC-002: Explicit quantifier function
	 * quantified_relation_filter = quantifier "(" path_expr ")" "." ident_segment comp_op expr
	 *                            | quantifier "(" path_expr [ "as" IDENT ] "," boolean_expr ")" ;
	 * quantifier = "some" | "none" | "every" ;
	 *
	 * Examples:
	 *   some(posts).featured = true
	 *   none(posts).published = true
	 *   every(posts).status = 'approved'
	 *   some(posts as p, p.featured = true and p.published = true)
	 */
	private quantifiedRelationFilter = this.RULE(
		'quantifiedRelationFilter',
		() => {
			// Quantifier keyword
			this.OR([
				{ ALT: () => this.CONSUME(Some) },
				{ ALT: () => this.CONSUME(None) },
				{ ALT: () => this.CONSUME(Every) },
			]);
			this.CONSUME(LParen);
			// Relation path
			this.SUBRULE(this.pathExpr);
			// Check what follows: ) . column or as alias , condition )
			this.OR2([
				// Simple form: some(posts).column = value
				{
					GATE: () =>
						this.LA(1).tokenType === RParen && this.LA(2).tokenType === Dot,
					ALT: () => {
						this.CONSUME(RParen);
						this.CONSUME(Dot);
						this.SUBRULE(this.identSegment);
						this.SUBRULE(this.compOp);
						this.SUBRULE(this.expression);
					},
				},
				// Aliased form: some(posts as p, condition)
				{
					GATE: () => this.LA(1).tokenType === As,
					ALT: () => {
						this.CONSUME(As);
						this.SUBRULE2(this.identSegment);
						this.CONSUME(Comma);
						this.SUBRULE(this.booleanExpr);
						this.CONSUME2(RParen);
					},
				},
				// Direct condition form: some(posts, condition)
				{
					GATE: () => this.LA(1).tokenType === Comma,
					ALT: () => {
						this.CONSUME2(Comma);
						this.SUBRULE2(this.booleanExpr);
						this.CONSUME3(RParen);
					},
				},
			]);
		},
	);

	/**
	 * SPEC-002: ALL quantifier prefix for implicit relation filter
	 * all_relation_filter = "all" path_expr comp_op expr ;
	 *
	 * The path_expr contains both the relation and column, e.g., posts.featured
	 * The visitor will split it: relation = all but last segment, column = last segment
	 *
	 * Examples:
	 *   all posts.featured = true   (relation: posts, column: featured)
	 *   all author.posts.published = true  (relation: author.posts, column: published)
	 */
	private allRelationFilter = this.RULE('allRelationFilter', () => {
		this.CONSUME(All);
		this.SUBRULE(this.pathExpr);
		this.SUBRULE(this.compOp);
		this.SUBRULE(this.expression);
	});

	/**
	 * in_suffix = [ "not" ] "in" ( "(" value_list ")" | "(" scalar_subquery ")" | date_range_literal ) ;
	 */
	private inSuffix = this.RULE('inSuffix', () => {
		this.OPTION(() => this.CONSUME(Not));
		this.CONSUME(In);
		this.OR([
			// Date range literal (string without parentheses)
			{
				GATE: () => this.LA(1).tokenType === StringLiteral,
				ALT: () => this.CONSUME(StringLiteral),
			},
			// Parenthesized: either value list or subquery
			{
				ALT: () => {
					this.CONSUME(LParen);
					this.OR2([
						// Subquery (starts with identifier and has pipe)
						{
							GATE: () => this.isScalarSubqueryInParen(),
							ALT: () => this.SUBRULE(this.scalarSubquery),
						},
						// Value list
						{
							ALT: () => this.SUBRULE(this.valueList),
						},
					]);
					this.CONSUME(RParen);
				},
			},
		]);
	});

	/**
	 * is_null_suffix = "is" [ "not" ] "null" ;
	 */
	private isNullSuffix = this.RULE('isNullSuffix', () => {
		this.CONSUME(Is);
		this.OPTION(() => this.CONSUME(Not));
		this.CONSUME(Null);
	});

	/**
	 * Check if inside parentheses we have a scalar subquery
	 * A scalar subquery MUST have at least one pipe
	 */
	private isScalarSubqueryInParen(): boolean {
		// Look for: ident | ...
		let i = 1;
		// Skip identifier(s)
		while (this.isIdentifierLike(this.LA(i).tokenType)) {
			i++;
			if (this.LA(i).tokenType === Dot) {
				i++;
			} else {
				break;
			}
		}
		// Must have pipe for it to be a subquery
		return this.LA(i).tokenType === Pipe;
	}

	/**
	 * Check if we're looking at a scalar subquery (for expression context)
	 */
	private isScalarSubquery(): boolean {
		// After ( we need ident | to be a subquery
		if (this.LA(1).tokenType !== LParen) return false;
		let i = 2;
		while (this.isIdentifierLike(this.LA(i).tokenType)) {
			i++;
			if (this.LA(i).tokenType === Dot) {
				i++;
			} else {
				break;
			}
		}
		return this.LA(i).tokenType === Pipe;
	}

	// ============================================================
	// ARITHMETIC EXPRESSIONS
	// ============================================================

	/**
	 * expr = add_expr ;
	 */
	private expression = this.RULE('expression', () => {
		this.SUBRULE(this.addExpr);
	});

	/**
	 * add_expr = mul_expr { ("+" | "-") mul_expr } ;
	 */
	private addExpr = this.RULE('addExpr', () => {
		this.SUBRULE(this.mulExpr);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.CONSUME(Plus) },
				{ ALT: () => this.CONSUME(Minus) },
			]);
			this.SUBRULE2(this.mulExpr);
		});
	});

	/**
	 * mul_expr = unary_expr { ("*" | "/" | "%") unary_expr } ;
	 */
	private mulExpr = this.RULE('mulExpr', () => {
		this.SUBRULE(this.unaryExpr);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.CONSUME(Star) },
				{ ALT: () => this.CONSUME(Slash) },
				{ ALT: () => this.CONSUME(Percent) },
			]);
			this.SUBRULE2(this.unaryExpr);
		});
	});

	/**
	 * unary_expr = [ "-" ] primary_expr ;
	 */
	private unaryExpr = this.RULE('unaryExpr', () => {
		this.OPTION(() => this.CONSUME(Minus));
		this.SUBRULE(this.primaryExpr);
	});

	/**
	 * primary_expr = literal | case_expr | path_expr | func_call | "(" expr ")" | "(" scalar_subquery ")" ;
	 */
	private primaryExpr = this.RULE('primaryExpr', () => {
		this.OR([
			// Literal
			{ ALT: () => this.SUBRULE(this.literal) },
			// CASE expression: CASE WHEN ... THEN ... [ELSE ...] END
			{
				GATE: () => this.LA(1).tokenType === Case,
				ALT: () => this.SUBRULE(this.caseExpr),
			},
			// Function call: ident(...) or window function keyword(...)
			{
				GATE: () =>
					(this.LA(1).tokenType === Identifier ||
						this.LA(1).tokenType === QuotedIdentifier ||
						this.LA(1).tokenType === RowNumber ||
						this.LA(1).tokenType === Rank ||
						this.LA(1).tokenType === DenseRank ||
						this.LA(1).tokenType === Lag ||
						this.LA(1).tokenType === Lead) &&
					this.LA(2).tokenType === LParen,
				ALT: () => this.SUBRULE(this.funcCall),
			},
			// Path expression: ident.ident...
			{ ALT: () => this.SUBRULE(this.pathExpr) },
			// Parenthesized: either expression or scalar subquery
			{
				ALT: () => {
					this.CONSUME(LParen);
					this.OR2([
						// Scalar subquery
						{
							GATE: () => this.isScalarSubqueryStart(),
							ALT: () => this.SUBRULE(this.scalarSubquery),
						},
						// Expression
						{ ALT: () => this.SUBRULE(this.expression) },
					]);
					this.CONSUME(RParen);
				},
			},
		]);
	});

	/**
	 * Check if at start of scalar subquery (ident | ...)
	 */
	private isScalarSubqueryStart(): boolean {
		let i = 1;
		while (this.isIdentifierLike(this.LA(i).tokenType)) {
			i++;
			if (this.LA(i).tokenType === Dot) {
				i++;
			} else {
				break;
			}
		}
		return this.LA(i).tokenType === Pipe;
	}

	/**
	 * scalar_subquery = query ;
	 * Delegates to the `query` rule (gate already ensures at least one pipe).
	 */
	private scalarSubquery = this.RULE('scalarSubquery', () => {
		this.SUBRULE(this.query);
	});

	/**
	 * path_expr = ident_segment { "." ident_segment } ;
	 */
	private pathExpr = this.RULE('pathExpr', () => {
		this.SUBRULE(this.identSegment);
		// Optional depth hint: ascendant[3].column → bounded traversal
		this.OPTION2(() => {
			this.CONSUME(LBracket);
			this.CONSUME(NumberLiteral);
			this.CONSUME(RBracket);
		});
		this.MANY(() => {
			this.CONSUME(Dot);
			this.SUBRULE2(this.identSegment);
		});
	});

	/**
	 * case_expr = "CASE" when_clause { when_clause } [ else_clause ] "END" ;
	 * when_clause = "WHEN" expression "THEN" expression ;
	 * else_clause = "ELSE" expression ;
	 */
	private caseExpr = this.RULE('caseExpr', () => {
		this.CONSUME(Case);
		// At least one WHEN clause required
		this.AT_LEAST_ONE(() => {
			this.CONSUME(When);
			this.SUBRULE(this.booleanExpr); // Boolean expression for condition
			this.CONSUME(Then);
			this.SUBRULE(this.expression); // Result can be any expression
		});
		// Optional ELSE clause
		this.OPTION(() => {
			this.CONSUME(Else);
			this.SUBRULE2(this.expression);
		});
		this.CONSUME(End);
	});

	/**
	 * func_call = ( window_func | IDENT ) "(" [ func_arg_list ] ")" [ window_clause ] ;
	 * window_func = "row_number" | "rank" | "dense_rank" | "lag" | "lead" ;
	 * Regular functions can also have OVER (e.g., sum(x) OVER (...))
	 */
	private funcCall = this.RULE('funcCall', () => {
		// Window function keyword or regular identifier
		this.OR([
			{ ALT: () => this.CONSUME(RowNumber) },
			{ ALT: () => this.CONSUME(Rank) },
			{ ALT: () => this.CONSUME(DenseRank) },
			{ ALT: () => this.CONSUME(Lag) },
			{ ALT: () => this.CONSUME(Lead) },
			{ ALT: () => this.SUBRULE(this.identSegment) },
		]);
		this.CONSUME(LParen);
		this.OPTION(() => this.SUBRULE(this.funcArgList));
		this.CONSUME(RParen);
		// Optional OVER clause (makes it a window function)
		this.OPTION2(() => this.SUBRULE(this.windowClause));
	});

	/**
	 * window_clause = "over" "(" [ partition_clause ] [ order_clause_in_window ] ")" ;
	 */
	private windowClause = this.RULE('windowClause', () => {
		this.CONSUME(Over);
		this.CONSUME(LParen);
		this.OPTION(() => this.SUBRULE(this.partitionClause));
		this.OPTION2(() => this.SUBRULE(this.orderClauseInWindow));
		this.CONSUME(RParen);
	});

	/**
	 * partition_clause = "partition" "by" expr_list ;
	 */
	private partitionClause = this.RULE('partitionClause', () => {
		this.CONSUME(PartitionBy);
		this.SUBRULE(this.exprList);
	});

	/**
	 * order_clause_in_window = "order" "by" order_list ;
	 * Same as orderClause but separate rule for clarity
	 */
	private orderClauseInWindow = this.RULE('orderClauseInWindow', () => {
		this.CONSUME(OrderBy);
		this.SUBRULE(this.orderList);
	});

	/**
	 * Function argument list - handles count(*) and DISTINCT specially
	 * func_arg_list = "*" | [ "distinct" ] expr_list ;
	 */
	private funcArgList = this.RULE('funcArgList', () => {
		this.OR([
			// count(*) special case
			{ ALT: () => this.CONSUME(Star) },
			// Optional DISTINCT modifier + expression list
			// e.g., count(distinct status), sum(distinct price)
			{
				ALT: () => {
					this.OPTION(() => this.CONSUME(Distinct));
					this.SUBRULE(this.exprList);
				},
			},
		]);
	});

	/**
	 * expr_list = expr { "," expr } ;
	 */
	private exprList = this.RULE('exprList', () => {
		this.SUBRULE(this.expression);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.expression);
		});
	});

	/**
	 * value_list = expr { "," expr } ;
	 */
	private valueList = this.RULE('valueList', () => {
		this.SUBRULE(this.expression);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.expression);
		});
	});

	// ============================================================
	// LITERALS & IDENTIFIERS
	// ============================================================

	/**
	 * literal = STRING | NUMBER | "true" | "false" | "null" ;
	 */
	private literal = this.RULE('literal', () => {
		this.OR([
			{ ALT: () => this.CONSUME(StringLiteral) },
			{ ALT: () => this.CONSUME(NumberLiteral) },
			{ ALT: () => this.CONSUME(True) },
			{ ALT: () => this.CONSUME(False) },
			{ ALT: () => this.CONSUME(Null) },
			// Note: Range literals are NOT here - they only appear after range operators
			// (overlaps, contains, containedBy) via rangeOpSuffix rule
		]);
	});

	/**
	 * range_literal = ( "[" | "(" ) range_value "," range_value ( "]" | ")" ) ;
	 * range_value = RANGE_VALUE | NUMBER | "-" NUMBER ;
	 *
	 * PostgreSQL-style range bounds (full support):
	 * - Opening: [ (inclusive) or ( (exclusive)
	 * - Closing: ] (inclusive) or ) (exclusive)
	 * Examples: [1,10], (0,100), [1,10), (0,10]
	 *
	 * Note: This is only called from rangeOpSuffix (after overlaps/contains/containedBy),
	 * so there's no ambiguity with grouped expressions like (a + b).
	 */
	private rangeLiteral = this.RULE('rangeLiteral', () => {
		// Opening: [ (inclusive) or ( (exclusive)
		this.OR1([
			{ ALT: () => this.CONSUME(LBracket) },
			{ ALT: () => this.CONSUME(LParen) },
		]);
		this.SUBRULE(this.rangeValue, { LABEL: 'lower' });
		this.CONSUME(Comma);
		this.SUBRULE2(this.rangeValue, { LABEL: 'upper' });
		// Closing: ] (inclusive) or ) (exclusive)
		this.OR2([
			{ ALT: () => this.CONSUME(RBracket) },
			{ ALT: () => this.CONSUME(RParen) },
		]);
	});

	/**
	 * range_value = RANGE_VALUE | NUMBER | "-" NUMBER ;
	 * RANGE_VALUE matches date/time patterns (2024-01-01, 08:00)
	 * NUMBER matches plain integers
	 */
	private rangeValue = this.RULE('rangeValue', () => {
		this.OR([
			{ ALT: () => this.CONSUME(RangeValue) },
			{
				ALT: () => {
					this.OPTION(() => this.CONSUME(Minus));
					this.CONSUME(NumberLiteral);
				},
			},
		]);
	});

	/**
	 * ident_segment = IDENT | QUOTED_IDENT ;
	 */
	private identSegment = this.RULE('identSegment', () => {
		this.OR([
			{ ALT: () => this.CONSUME(Identifier) },
			{ ALT: () => this.CONSUME(QuotedIdentifier) },
			// Pseudo-column keywords can appear in paths
			// If quoted ("parent"), they're real columns, not pseudo-columns
			{ ALT: () => this.CONSUME(Parent) },
			{ ALT: () => this.CONSUME(Child) },
			{ ALT: () => this.CONSUME(Ascendant) },
			{ ALT: () => this.CONSUME(Descendant) },
		]);
	});

	// ============================================================
	// MUTATIONS
	// ============================================================

	/**
	 * mutation_pipeline = mutation { "|" mutation_clause } ;
	 */
	private mutationPipeline = this.RULE('mutationPipeline', () => {
		this.SUBRULE(this.mutation);
		this.MANY(() => {
			this.CONSUME(Pipe);
			this.SUBRULE(this.mutationClause);
		});
	});

	/**
	 * mutation_clause = select_clause | bind_clause ;
	 */
	private mutationClause = this.RULE('mutationClause', () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.selectClause) },
			{ ALT: () => this.SUBRULE(this.bindClause) },
		]);
	});

	/**
	 * bind_clause = "bind" IDENT ;
	 */
	private bindClause = this.RULE('bindClause', () => {
		this.CONSUME(Bind);
		this.SUBRULE(this.identSegment);
	});

	/**
	 * mutation = insert_from_stmt | insert_stmt | update_stmt | delete_stmt | upsert_stmt ;
	 * Note: insert_from_stmt must come before insert_stmt because both start with "insert into".
	 * We use BACKTRACK to resolve the ambiguity.
	 */
	private mutation = this.RULE('mutation', () => {
		this.OR([
			// BACKTRACK for INSERT FROM (insert into X from Y) vs INSERT SET (insert into X set ...)
			{
				ALT: () => this.SUBRULE(this.insertFromStmt),
				GATE: this.BACKTRACK(this.insertFromStmt),
			},
			{ ALT: () => this.SUBRULE(this.insertStmt) },
			{ ALT: () => this.SUBRULE(this.updateStmt) },
			{ ALT: () => this.SUBRULE(this.deleteStmt) },
			{ ALT: () => this.SUBRULE(this.upsertStmt) },
		]);
	});

	/**
	 * insert_stmt = "insert" "into" ident_segment "set" assignment_list ;
	 */
	private insertStmt = this.RULE('insertStmt', () => {
		this.CONSUME(Insert);
		this.CONSUME(Into);
		this.SUBRULE(this.identSegment);
		this.CONSUME(SetKeyword);
		this.SUBRULE(this.assignmentList);
	});

	/**
	 * insert_from_stmt = "insert" "into" ident_segment "from" ident_segment [ "where" boolean_expr ] [ "limit" number ] ;
	 * @example insert into archived_users from users where active = false limit 100
	 */
	private insertFromStmt = this.RULE('insertFromStmt', () => {
		this.CONSUME(Insert);
		this.CONSUME(Into);
		this.SUBRULE(this.identSegment); // target table
		this.CONSUME(From);
		this.SUBRULE2(this.identSegment); // source table
		this.OPTION(() => {
			this.CONSUME(Where);
			this.SUBRULE(this.booleanExpr);
		});
		this.OPTION2(() => {
			this.CONSUME(Limit);
			this.CONSUME(NumberLiteral);
		});
	});

	/**
	 * update_stmt = "update" ident_segment "set" assignment_list [ "where" boolean_expr ] ;
	 */
	private updateStmt = this.RULE('updateStmt', () => {
		this.CONSUME(Update);
		this.SUBRULE(this.identSegment);
		this.CONSUME(SetKeyword);
		this.SUBRULE(this.assignmentList);
		this.OPTION(() => {
			this.CONSUME(Where);
			this.SUBRULE(this.booleanExpr);
		});
	});

	/**
	 * delete_stmt = "delete" "from" ident_segment [ "where" boolean_expr ] ;
	 * Note: WHERE is checked at semantic layer (to allow proper error messages)
	 */
	private deleteStmt = this.RULE('deleteStmt', () => {
		this.CONSUME(Delete);
		this.CONSUME(From);
		this.SUBRULE(this.identSegment);
		this.OPTION(() => {
			this.CONSUME(Where);
			this.SUBRULE(this.booleanExpr);
		});
	});

	/**
	 * upsert_stmt = "upsert" "into" ident_segment "on" ( "(" ident_list ")" | ident_segment ) "set" assignment_list [ "where" boolean_expr ] ;
	 * Allows both `on (id1, id2)` and `on id` syntax
	 */
	private upsertStmt = this.RULE('upsertStmt', () => {
		this.CONSUME(Upsert);
		this.CONSUME(Into);
		this.SUBRULE(this.identSegment);
		this.CONSUME(On);
		this.OR([
			{
				ALT: () => {
					this.CONSUME(LParen);
					this.SUBRULE(this.identList);
					this.CONSUME(RParen);
				},
			},
			{
				ALT: () => {
					this.SUBRULE2(this.identSegment);
				},
			},
		]);
		this.CONSUME(SetKeyword);
		this.SUBRULE(this.assignmentList);
		this.OPTION(() => {
			this.CONSUME(Where);
			this.SUBRULE(this.booleanExpr);
		});
	});

	/**
	 * assignment_list = assignment { "," assignment } ;
	 */
	private assignmentList = this.RULE('assignmentList', () => {
		this.SUBRULE(this.assignment);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.assignment);
		});
	});

	/**
	 * assignment = ident_segment "=" expr ;
	 */
	private assignment = this.RULE('assignment', () => {
		this.SUBRULE(this.identSegment);
		this.CONSUME(Equals);
		this.SUBRULE(this.expression);
	});

	/**
	 * ident_list = ident_segment { "," ident_segment } ;
	 */
	private identList = this.RULE('identList', () => {
		this.SUBRULE(this.identSegment);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.identSegment);
		});
	});
}

// Singleton parser instance
export const nqlParser = new NqlParser();

/**
 * Parse NQL input and return CST
 */
export function parseCst(input: string): {
	cst: CstNode | undefined;
	errors: Array<{ message: string; token?: IToken }>;
} {
	const lexResult = NqlLexer.tokenize(input);

	if (lexResult.errors.length > 0) {
		return {
			cst: undefined,
			errors: lexResult.errors.map((e) => ({
				message: e.message,
			})),
		};
	}

	nqlParser.input = lexResult.tokens;
	const cst = nqlParser.program();

	return {
		cst,
		errors: nqlParser.errors.map((e) => ({
			message: e.message,
			token: e.token,
		})),
	};
}
