import { createToken, Lexer } from 'chevrotain';

// ============================================================
// WHITESPACE & COMMENTS
// ============================================================

export const WhiteSpace = createToken({
	name: 'WhiteSpace',
	pattern: /\s+/,
	group: Lexer.SKIPPED,
});

export const LineComment = createToken({
	name: 'LineComment',
	pattern: /#[^\n\r]*/,
	group: Lexer.SKIPPED,
});

// ============================================================
// KEYWORDS - Use word boundaries (\b) to prevent matching prefixes of identifiers
// ============================================================

// Query keywords
export const Select = createToken({ name: 'Select', pattern: /select\b/i });
export const Where = createToken({ name: 'Where', pattern: /where\b/i });
export const Flat = createToken({ name: 'Flat', pattern: /flat\b/i });
export const Via = createToken({ name: 'Via', pattern: /via\b/i });
export const Let = createToken({ name: 'Let', pattern: /let\b/i });
export const Bind = createToken({ name: 'Bind', pattern: /bind\b/i });
export const GroupBy = createToken({
	name: 'GroupBy',
	pattern: /group\s+by\b/i,
});
export const OrderBy = createToken({
	name: 'OrderBy',
	pattern: /order\s+by\b/i,
});
export const PartitionBy = createToken({
	name: 'PartitionBy',
	pattern: /partition\s+by\b/i,
});
export const Limit = createToken({ name: 'Limit', pattern: /limit\b/i });
export const Offset = createToken({ name: 'Offset', pattern: /offset\b/i });
export const Distinct = createToken({
	name: 'Distinct',
	pattern: /distinct\b/i,
});
// Asc/As: Asc must come before As in allTokens array since 'as' is prefix of 'asc'
export const Asc = createToken({ name: 'Asc', pattern: /asc\b/i });
export const As = createToken({ name: 'As', pattern: /as\b/i });
export const On = createToken({ name: 'On', pattern: /on\b/i });

// Boolean operators
export const And = createToken({ name: 'And', pattern: /and\b/i });
export const Or = createToken({ name: 'Or', pattern: /or\b/i });
export const Not = createToken({ name: 'Not', pattern: /not\b/i });

// Comparison operators (keyword-based)
// Insert/Into must come before In in allTokens array since 'in' is prefix
export const Insert = createToken({ name: 'Insert', pattern: /insert\b/i });
export const Into = createToken({ name: 'Into', pattern: /into\b/i });
export const In = createToken({ name: 'In', pattern: /in\b/i });
export const Between = createToken({ name: 'Between', pattern: /between\b/i });
export const Like = createToken({ name: 'Like', pattern: /like\b/i });

// Range operators (PostgreSQL)
export const Overlaps = createToken({
	name: 'Overlaps',
	pattern: /overlaps\b/i,
});
export const Contains = createToken({
	name: 'Contains',
	pattern: /contains\b/i,
});
export const ContainedBy = createToken({
	name: 'ContainedBy',
	pattern: /containedBy\b/i,
});

// Range literal tokens (grammar-based approach)
// Ranges start with [ which is unambiguous in NQL (not used elsewhere)
// This avoids conflicts with identifier lists like (col1, col2) in UPSERT ON clause
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/ });
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/ });

// Range value: matches date/time patterns inside range brackets
// Pattern: digits followed by at least one separator group (-/:T followed by digits)
// Examples: 2024-01-01, 08:00, 2024-01-01T08:00:00
// NOTE: Decimals like 10.5 use NumberLiteral (handled by rangeValue grammar rule)
// Must come BEFORE NumberLiteral in allTokens to match date patterns first
export const RangeValue = createToken({
	name: 'RangeValue',
	pattern: /-?\d+(?:[-:T]\d+)+/,
});
export const Is = createToken({ name: 'Is', pattern: /is\b/i });
export const Exists = createToken({ name: 'Exists', pattern: /exists\b/i });

// Mutation keywords
export const Update = createToken({ name: 'Update', pattern: /update\b/i });
export const Delete = createToken({ name: 'Delete', pattern: /delete\b/i });
export const From = createToken({ name: 'From', pattern: /from\b/i });
export const SetKeyword = createToken({ name: 'Set', pattern: /set\b/i });
export const Upsert = createToken({ name: 'Upsert', pattern: /upsert\b/i });

// Literals
export const True = createToken({ name: 'True', pattern: /true\b/i });
export const False = createToken({ name: 'False', pattern: /false\b/i });
export const Null = createToken({ name: 'Null', pattern: /null\b/i });

// Sort direction
export const Desc = createToken({ name: 'Desc', pattern: /desc\b/i });

// Window functions
export const Over = createToken({ name: 'Over', pattern: /over\b/i });
export const RowNumber = createToken({
	name: 'RowNumber',
	pattern: /row_number\b/i,
});
export const Rank = createToken({ name: 'Rank', pattern: /rank\b/i });
export const DenseRank = createToken({
	name: 'DenseRank',
	pattern: /dense_rank\b/i,
});
export const Lag = createToken({ name: 'Lag', pattern: /lag\b/i });
export const Lead = createToken({ name: 'Lead', pattern: /lead\b/i });

// ============================================================
// PSEUDO-COLUMN KEYWORDS (Self-Referential Traversal)
// ============================================================

// Single-hop traversal
export const Parent = createToken({ name: 'Parent', pattern: /parent\b/i });
export const Child = createToken({ name: 'Child', pattern: /child\b/i });

// Recursive traversal (CTE-based)
// Ascendant must come before Asc in allTokens since 'asc' is prefix
export const Ascendant = createToken({
	name: 'Ascendant',
	pattern: /ascendant\b/i,
});
export const Descendant = createToken({
	name: 'Descendant',
	pattern: /descendant\b/i,
});

// ============================================================
// IDENTIFIERS & LITERALS
// ============================================================

export const Identifier = createToken({
	name: 'Identifier',
	pattern: /[a-zA-Z_][a-zA-Z0-9_]*/,
});

export const QuotedIdentifier = createToken({
	name: 'QuotedIdentifier',
	// SQL-style: "ident" with "" for escaped quote
	pattern: /"(?:[^"]|"")*"/,
});

export const StringLiteral = createToken({
	name: 'StringLiteral',
	// SQL-style: 'string' with '' for escaped quote
	pattern: /'(?:[^']|'')*'/,
});

export const NumberLiteral = createToken({
	name: 'NumberLiteral',
	// Note: No leading - sign. Negative numbers are parsed as unary minus + number
	// This matches SQL behavior where "price-1" is subtraction, not "price" followed by "-1"
	pattern: /\d+(\.\d+)?/,
});

// ============================================================
// OPERATORS & PUNCTUATION
// ============================================================

export const Pipe = createToken({ name: 'Pipe', pattern: /\|/ });
export const Comma = createToken({ name: 'Comma', pattern: /,/ });
export const Dot = createToken({ name: 'Dot', pattern: /\./ });
export const Star = createToken({ name: 'Star', pattern: /\*/ });
export const LParen = createToken({ name: 'LParen', pattern: /\(/ });
export const RParen = createToken({ name: 'RParen', pattern: /\)/ });
export const Colon = createToken({ name: 'Colon', pattern: /:/ });

// Comparison operators
export const Equals = createToken({ name: 'Equals', pattern: /=/ });
export const NotEquals = createToken({ name: 'NotEquals', pattern: /!=|<>/ });
export const LessThanOrEqual = createToken({
	name: 'LessThanOrEqual',
	pattern: /<=/,
});
export const GreaterThanOrEqual = createToken({
	name: 'GreaterThanOrEqual',
	pattern: />=/,
});
export const LessThan = createToken({ name: 'LessThan', pattern: /</ });
export const GreaterThan = createToken({ name: 'GreaterThan', pattern: />/ });

// Arithmetic operators
export const Plus = createToken({ name: 'Plus', pattern: /\+/ });
export const Minus = createToken({ name: 'Minus', pattern: /-/ });
export const Slash = createToken({ name: 'Slash', pattern: /\// });
export const Percent = createToken({ name: 'Percent', pattern: /%/ });

// ============================================================
// TOKEN ORDER (Important for Chevrotain!)
// Keywords must come before Identifier
// ============================================================

export const allTokens = [
	// Whitespace & comments (skipped)
	WhiteSpace,
	LineComment,

	// Multi-word keywords (must come first)
	GroupBy,
	OrderBy,
	PartitionBy,

	// Keywords (before Identifier!)
	// IMPORTANT: Order matters for prefix conflicts!
	// - Insert/Into BEFORE In
	// - Ascendant/Descendant BEFORE Asc/Desc
	// - Asc BEFORE As
	Select,
	Where,
	Flat,
	Via,
	Let,
	Bind,
	Limit,
	Offset,
	Distinct,
	// Pseudo-column keywords (self-referential traversal)
	Ascendant, // Must come before Asc
	Descendant, // Must come before Desc
	Parent,
	Child,
	Asc, // Must come before As
	As,
	On,
	And,
	Or,
	Not,
	Insert, // Must come before In
	Into, // Must come before In
	In,
	Between,
	Like,
	Overlaps,
	ContainedBy, // Must come before Contains (prefix)
	Contains,
	Is,
	Exists,
	Update,
	Delete,
	From,
	SetKeyword,
	Upsert,
	True,
	False,
	Null,
	Desc,
	Over,
	RowNumber,
	DenseRank, // Must come before Rank (prefix)
	Rank,
	Lag,
	Lead,

	// Range values (date/time patterns - must come before NumberLiteral)
	RangeValue,

	// Identifiers & literals
	Identifier,
	QuotedIdentifier,
	StringLiteral,
	NumberLiteral,

	// Multi-char operators (before single-char)
	NotEquals,
	LessThanOrEqual,
	GreaterThanOrEqual,

	// Single-char operators & punctuation
	Pipe,
	Comma,
	Dot,
	Star,
	LParen,
	RParen,
	LBracket,
	RBracket,
	Colon,
	Equals,
	LessThan,
	GreaterThan,
	Plus,
	Minus,
	Slash,
	Percent,
];

// Create the lexer instance
export const NqlLexer = new Lexer(allTokens);
