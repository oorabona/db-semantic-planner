/**
 * NQL v2.0 Parser Grammar (Chevrotain)
 *
 * Pipeline syntax for reads, SQL-familiar mutations.
 * See docs/plans/NQL-PARSER-AUDIT-2026-01.md Section 11 for EBNF.
 */

import { type CstNode, CstParser, type IToken } from 'chevrotain';
import {
	And,
	As,
	Asc,
	Ascendant,
	allTokens,
	Between,
	Bind,
	Child,
	Colon,
	Comma,
	ContainedBy,
	Contains,
	Delete,
	DenseRank,
	Desc,
	Descendant,
	Distinct,
	Dot,
	Equals,
	Exists,
	False,
	From,
	GreaterThan,
	GreaterThanOrEqual,
	GroupBy,
	// Identifiers & Literals
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
	// Pseudo-column keywords (self-referential traversal)
	Parent,
	PartitionBy,
	Percent,
	// Operators & Punctuation
	Pipe,
	Plus,
	QuotedIdentifier,
	RangeValue,
	Rank,
	RBracket,
	RowNumber,
	RParen,
	// Keywords
	Select,
	SetKeyword,
	Slash,
	Star,
	StringLiteral,
	True,
	Update,
	Upsert,
	Via,
	Where,
	With,
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
	 * query_clause = where_clause | select_clause | with_clause
	 *              | group_clause | order_clause | limit_clause | offset_clause ;
	 */
	private queryClause = this.RULE('queryClause', () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.whereClause) },
			{ ALT: () => this.SUBRULE(this.selectClause) },
			{ ALT: () => this.SUBRULE(this.withClause) },
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
	 * with_clause = "with" join_spec { "," join_spec } ;
	 */
	private withClause = this.RULE('withClause', () => {
		this.CONSUME(With);
		this.SUBRULE(this.joinSpec);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.joinSpec);
		});
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
	 * limit_clause = "limit" NUMBER ;
	 */
	private limitClause = this.RULE('limitClause', () => {
		this.CONSUME(Limit);
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
	// JOIN SPECIFICATION
	// ============================================================

	/**
	 * join_spec = ident_segment [ "(" param_list ")" ] [ "via" ident_segment ] [ "on" boolean_expr ] ;
	 */
	private joinSpec = this.RULE('joinSpec', () => {
		this.SUBRULE(this.identSegment);
		this.OPTION(() => {
			this.CONSUME(LParen);
			this.SUBRULE(this.paramList);
			this.CONSUME(RParen);
		});
		this.OPTION2(() => {
			this.CONSUME(Via);
			this.SUBRULE2(this.identSegment);
		});
		this.OPTION3(() => {
			this.CONSUME(On);
			this.SUBRULE(this.booleanExpr);
		});
	});

	/**
	 * param_list = param { "," param } ;
	 */
	private paramList = this.RULE('paramList', () => {
		this.SUBRULE(this.param);
		this.MANY(() => {
			this.CONSUME(Comma);
			this.SUBRULE2(this.param);
		});
	});

	/**
	 * param = IDENT ":" literal ;
	 */
	private param = this.RULE('param', () => {
		this.CONSUME(Identifier);
		this.CONSUME(Colon);
		this.SUBRULE(this.literal);
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
	 *              | comparison
	 *              | between_check
	 *              | exists_check
	 *              | in_check
	 *              | is_null_check ;
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
	 * primary_expr = literal | path_expr | func_call | "(" expr ")" | "(" scalar_subquery ")" ;
	 */
	private primaryExpr = this.RULE('primaryExpr', () => {
		this.OR([
			// Literal
			{ ALT: () => this.SUBRULE(this.literal) },
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
	 * scalar_subquery = table_ref "|" query_clause { "|" query_clause } ;
	 * MUST have at least one pipe to disambiguate from (expr)
	 */
	private scalarSubquery = this.RULE('scalarSubquery', () => {
		this.SUBRULE(this.tableRef);
		this.CONSUME(Pipe);
		this.SUBRULE(this.queryClause);
		this.MANY(() => {
			this.CONSUME2(Pipe);
			this.SUBRULE2(this.queryClause);
		});
	});

	/**
	 * path_expr = ident_segment { "." ident_segment } ;
	 */
	private pathExpr = this.RULE('pathExpr', () => {
		this.SUBRULE(this.identSegment);
		this.MANY(() => {
			this.CONSUME(Dot);
			this.SUBRULE2(this.identSegment);
		});
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
	 * Function argument list - handles count(*) specially
	 */
	private funcArgList = this.RULE('funcArgList', () => {
		this.OR([
			// count(*) special case
			{ ALT: () => this.CONSUME(Star) },
			// Normal expression list
			{ ALT: () => this.SUBRULE(this.exprList) },
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
	 * mutation = insert_stmt | update_stmt | delete_stmt | upsert_stmt ;
	 */
	private mutation = this.RULE('mutation', () => {
		this.OR([
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
