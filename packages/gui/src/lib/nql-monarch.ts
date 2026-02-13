/**
 * Monaco Monarch tokenizer for NQL (Natural Query Language).
 *
 * Uses Monarch instead of TextMate grammar (simpler, no WASM/Oniguruma needed).
 * Keyword list derived from Chevrotain token definitions in packages/nql/src/lexer.ts.
 */
import type { languages } from "monaco-editor";

export const NQL_LANGUAGE_ID = "nql";

export const nqlMonarchTokensProvider: languages.IMonarchLanguage = {
	defaultToken: "identifier",
	ignoreCase: true,

	keywords: [
		// Query
		"select", "from", "where", "limit", "offset", "order", "by",
		"group", "having", "distinct", "as",
		// Joins
		"join", "left", "right", "inner", "outer", "cross", "on",
		// Mutation
		"insert", "into", "values", "set", "update", "delete", "upsert",
		// Include / relation
		"include", "with", "strategy", "flat", "json_agg", "cte",
		// Logical
		"and", "or", "not", "in", "between", "like", "ilike", "is",
		"null", "true", "false", "exists",
		// Sort
		"asc", "desc",
		// CASE
		"case", "when", "then", "else", "end",
		// Set ops
		"union", "intersect", "except", "all",
		// Aggregates
		"count", "sum", "avg", "min", "max", "array_agg", "string_agg",
		// Window
		"over", "partition", "rows", "range", "unbounded", "preceding",
		"following", "current", "row",
		// Binding
		"bind",
		// Returning
		"returning",
	],

	operators: [
		"=", "!=", "<>", "<", "<=", ">", ">=", "~", "~*", "!~", "!~*",
	],

	tokenizer: {
		root: [
			// Pipe operator (special highlight)
			[/\|/, "keyword.pipe"],

			// Comments
			[/\/\/.*$/, "comment"],
			[/\/\*/, "comment", "@comment"],

			// Strings (single-quoted, SQL style)
			[/'/, "string", "@string"],

			// Numbers
			[/\d+(\.\d+)?/, "number"],

			// Operators
			[/[=!<>~]+/, {
				cases: {
					"@operators": "operator",
					"@default": "delimiter",
				},
			}],

			// Dot accessor
			[/\./, "delimiter.dot"],

			// Parentheses / brackets
			[/[()[\]{}]/, "delimiter.bracket"],

			// Comma
			[/,/, "delimiter"],

			// Identifiers and keywords
			[/[a-zA-Z_]\w*/, {
				cases: {
					"@keywords": "keyword",
					"@default": "identifier",
				},
			}],

			// Dollar params ($1, $2)
			[/\$\d+/, "variable"],
		],

		comment: [
			[/[^/*]+/, "comment"],
			[/\*\//, "comment", "@pop"],
			[/[/*]/, "comment"],
		],

		string: [
			[/[^']+/, "string"],
			[/''/, "string.escape"],
			[/'/, "string", "@pop"],
		],
	},
};

export const nqlLanguageConfiguration: languages.LanguageConfiguration = {
	comments: {
		lineComment: "//",
		blockComment: ["/*", "*/"],
	},
	brackets: [
		["(", ")"],
		["[", "]"],
	],
	autoClosingPairs: [
		{ open: "(", close: ")" },
		{ open: "[", close: "]" },
		{ open: "'", close: "'", notIn: ["string"] },
	],
	surroundingPairs: [
		{ open: "(", close: ")" },
		{ open: "'", close: "'" },
	],
};
