/**
 * NQL Error Types
 *
 * Structured error types for lexer, parser, and semantic errors.
 */

/** Source location for error reporting */
export interface SourceLocation {
	line: number;
	column: number;
	offset: number;
}

/** Base error interface for all NQL errors */
export interface NqlError {
	code: string;
	message: string;
	location?: SourceLocation | undefined;
	suggestion?: string | undefined;
}

/** Lexer errors (tokenization failures) */
export interface NqlLexerError extends NqlError {
	code: `ERR-LEX-${string}`;
	unexpectedChar?: string | undefined;
}

/** Parser errors (syntax errors) */
export interface NqlParseError extends NqlError {
	code: `ERR-PARSE-${string}`;
	expected?: string[] | undefined;
	found?: string | undefined;
}

/** Semantic errors (validation failures) */
export interface NqlSemanticError extends NqlError {
	code: `ERR-SEM-${string}`;
	relatedSymbol?: string | undefined;
}

/** Warning (non-fatal issues) */
export interface NqlWarning {
	code: string;
	message: string;
	location?: SourceLocation | undefined;
	suggestion?: string | undefined;
}

/** Error codes enum for type safety */
export const NqlErrorCodes = {
	// Lexer errors
	LEX_UNEXPECTED_CHAR: 'ERR-LEX-001',
	LEX_UNTERMINATED_STRING: 'ERR-LEX-002',
	LEX_INVALID_NUMBER: 'ERR-LEX-003',

	// Parser errors
	PARSE_UNEXPECTED_TOKEN: 'ERR-PARSE-001',
	PARSE_MISSING_WHERE: 'ERR-PARSE-002',
	PARSE_INVALID_SUBQUERY: 'ERR-PARSE-003',
	PARSE_UNCLOSED_PAREN: 'ERR-PARSE-004',

	// Semantic errors
	SEM_UNKNOWN_COLUMN: 'ERR-SEM-001',
	SEM_AGGREGATE_BEFORE_GROUP: 'ERR-SEM-002',
	SEM_CIRCULAR_REFERENCE: 'ERR-SEM-003',
	SEM_DUPLICATE_BINDING: 'ERR-SEM-004',
	SEM_UNKNOWN_TABLE: 'ERR-SEM-005',
	SEM_INVALID_IDENTIFIER: 'ERR-SEM-006',
	SEM_INVALID_SYNTAX: 'ERR-SEM-007',
	SEM_UNREACHABLE: 'ERR-SEM-008',

	// Limit errors
	LIMIT_SUBQUERY_DEPTH: 'ERR-LIMIT-001',
	LIMIT_CLAUSE_COUNT: 'ERR-LIMIT-002',
	LIMIT_JOIN_COUNT: 'ERR-LIMIT-003',
} as const;

/** Create a formatted error message with location */
export function formatError(error: NqlError): string {
	let msg = `[${error.code}] ${error.message}`;
	if (error.location) {
		msg += ` (line ${error.location.line}, column ${error.location.column})`;
	}
	if (error.suggestion) {
		msg += `\n  → ${error.suggestion}`;
	}
	return msg;
}

/** Create a lexer error */
export function createLexerError(
	code: string,
	message: string,
	location?: SourceLocation,
	unexpectedChar?: string,
): NqlLexerError {
	return {
		code: code as `ERR-LEX-${string}`,
		message,
		location: location as SourceLocation | undefined,
		unexpectedChar: unexpectedChar as string | undefined,
	};
}

/** Create a parse error */
export function createParseError(
	code: string,
	message: string,
	location?: SourceLocation,
	expected?: string[],
	found?: string,
): NqlParseError {
	return {
		code: code as `ERR-PARSE-${string}`,
		message,
		location: location as SourceLocation | undefined,
		expected: expected as string[] | undefined,
		found: found as string | undefined,
	};
}

/** Create a semantic error */
export function createSemanticError(
	code: string,
	message: string,
	location?: SourceLocation,
	suggestion?: string,
	relatedSymbol?: string,
): NqlSemanticError {
	return {
		code: code as `ERR-SEM-${string}`,
		message,
		location: location as SourceLocation | undefined,
		suggestion: suggestion as string | undefined,
		relatedSymbol: relatedSymbol as string | undefined,
	};
}

/**
 * Throwable semantic error class.
 * Extends Error for compatibility with catch/toThrow patterns
 * while carrying structured NQL error metadata.
 */
export class NqlSemanticException extends Error {
	readonly code: `ERR-SEM-${string}`;
	readonly location?: SourceLocation | undefined;
	readonly suggestion?: string | undefined;
	readonly relatedSymbol?: string | undefined;

	constructor(
		code: string,
		message: string,
		location?: SourceLocation,
		suggestion?: string,
		relatedSymbol?: string,
	) {
		super(message);
		this.name = 'NqlSemanticException';
		this.code = code as `ERR-SEM-${string}`;
		this.location = location as SourceLocation | undefined;
		this.suggestion = suggestion as string | undefined;
		this.relatedSymbol = relatedSymbol as string | undefined;
	}
}
