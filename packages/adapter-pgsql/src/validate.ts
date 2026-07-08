/**
 * Identifier Validation for adapter-pgsql
 *
 * Security layer to prevent SQL injection via identifiers.
 * All table names, column names, schema names, and aliases MUST pass validation.
 */

// ============================================================================
// SQL Reserved Keywords (PostgreSQL)
// ============================================================================

/**
 * PostgreSQL reserved keywords that cannot be used as unquoted identifiers.
 * This is a subset of the most common ones - full list is much larger.
 * We allow these but they must be quoted.
 */
const SQL_RESERVED_KEYWORDS = new Set([
	'all',
	'analyse',
	'analyze',
	'and',
	'any',
	'array',
	'as',
	'asc',
	'asymmetric',
	'authorization',
	'binary',
	'both',
	'case',
	'cast',
	'check',
	'collate',
	'collation',
	'column',
	'concurrently',
	'constraint',
	'create',
	'cross',
	'current_catalog',
	'current_date',
	'current_role',
	'current_schema',
	'current_time',
	'current_timestamp',
	'current_user',
	'default',
	'deferrable',
	'desc',
	'distinct',
	'do',
	'else',
	'end',
	'except',
	'false',
	'fetch',
	'for',
	'foreign',
	'freeze',
	'from',
	'full',
	'grant',
	'group',
	'having',
	'ilike',
	'in',
	'initially',
	'inner',
	'intersect',
	'into',
	'is',
	'isnull',
	'join',
	'lateral',
	'leading',
	'left',
	'like',
	'limit',
	'localtime',
	'localtimestamp',
	'natural',
	'not',
	'notnull',
	'null',
	'offset',
	'on',
	'only',
	'or',
	'order',
	'outer',
	'overlaps',
	'placing',
	'primary',
	'references',
	'returning',
	'right',
	'select',
	'session_user',
	'similar',
	'some',
	'symmetric',
	'table',
	'timestamp',
	'tablesample',
	'then',
	'to',
	'trailing',
	'true',
	'union',
	'unique',
	'user',
	'using',
	'variadic',
	'verbose',
	'when',
	'where',
	'window',
	'with',
]);

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown when an identifier fails validation.
 */
export class InvalidIdentifierError extends Error {
	constructor(
		public readonly identifier: string,
		public readonly identifierType: string,
		public readonly reason: string,
	) {
		super(`Invalid ${identifierType} identifier "${identifier}": ${reason}`);
		this.name = 'InvalidIdentifierError';
	}
}

// ============================================================================
// Validation Functions
// ============================================================================

// ────────────────────────────────────────────────────────────────────
// NAMEDATALEN and character-length bookkeeping
//
// PostgreSQL caps identifier/role/collation names at NAMEDATALEN-1 bytes
// (63 bytes in the default build). Two length-check styles coexist in
// this file for historical reasons:
//
//   • `validateIdentifier()` uses `name.length > 63` (UTF-16 code units
//     as JavaScript counts them → effectively character count).
//   • `quoteRoleName()` / `validateCollationName()` use
//     `Buffer.byteLength(name, 'utf8') > 63` (actual byte count).
//
// Why the two styles coexist:
//   • `validateIdentifier` and `validateCollationName` sit *after* an
//     ASCII-only allowlist regex that rejects any multi-byte character,
//     so every accepted name has `.length === Buffer.byteLength(...)`
//     and the char-count form is equivalent to a byte-count form.
//   • `quoteRoleName` deliberately does NOT gate on an ASCII allowlist
//     (role names like `"utilisateur"` are legitimate); it rejects only
//     `"`, NUL, and control chars, then counts *bytes* because role
//     names can contain multi-byte UTF-8 and PostgreSQL truncates at
//     the byte level (strlen semantics).
// The asymmetry is intentional and safe. Do not collapse either style
// without also widening/narrowing the upstream input-validation rules.
// ────────────────────────────────────────────────────────────────────

/**
 * Validate that a string is a safe SQL identifier.
 *
 * Rules:
 * 1. Must not be empty
 * 2. Must not exceed 63 characters (PostgreSQL limit)
 * 3. Must start with letter or underscore
 * 4. Must contain only alphanumeric, underscore, or dollar sign
 * 5. Must not contain null bytes or control characters
 * 6. Reserved keywords are allowed (will be quoted)
 *
 * @param value The identifier to validate
 * @param type Type of identifier (for error messages): 'table', 'column', 'schema', 'alias', 'function'
 * @throws InvalidIdentifierError if validation fails
 */
export function validateIdentifier(
	value: string,
	type: 'table' | 'column' | 'schema' | 'alias' | 'function',
): void {
	// Rule 1: Not empty
	if (!value || value.length === 0) {
		throw new InvalidIdentifierError(value, type, 'cannot be empty');
	}

	// Rule 2: Length limit
	if (value.length > 63) {
		throw new InvalidIdentifierError(
			value,
			type,
			`exceeds maximum length of 63 characters (got ${value.length})`,
		);
	}

	// Rule 3 & 4: Character validation
	// PostgreSQL identifiers: start with letter/underscore, contain letter/digit/underscore/$
	const validIdentifierPattern = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;
	if (!validIdentifierPattern.test(value)) {
		// Check for specific issues
		if (/[\x00-\x1f\x7f]/.test(value)) {
			throw new InvalidIdentifierError(
				value,
				type,
				'contains control characters',
			);
		}
		if (/^[0-9]/.test(value)) {
			throw new InvalidIdentifierError(
				value,
				type,
				'cannot start with a digit',
			);
		}
		if (/[^\w$]/.test(value)) {
			throw new InvalidIdentifierError(
				value,
				type,
				'contains invalid characters (only letters, digits, underscore, and $ allowed)',
			);
		}
		throw new InvalidIdentifierError(
			value,
			type,
			'does not match valid identifier pattern',
		);
	}

	// Rule 5: No null bytes (extra safety)
	if (value.includes('\0')) {
		throw new InvalidIdentifierError(value, type, 'contains null byte');
	}

	// Note: Reserved keywords are allowed - they will be quoted by the AST helpers
}

/**
 * Check if an identifier is a SQL reserved keyword.
 */
export function isReservedKeyword(value: string): boolean {
	return SQL_RESERVED_KEYWORDS.has(value.toLowerCase());
}

/**
 * Validate a schema-qualified identifier (schema.table).
 *
 * @param schemaTable String in format "schema.table" or just "table"
 * @returns Object with validated schema and table names
 * @throws InvalidIdentifierError if validation fails
 */
export function validateQualifiedIdentifier(schemaTable: string): {
	schema?: string;
	table: string;
} {
	const parts = schemaTable.split('.');

	if (parts.length === 1) {
		validateIdentifier(parts[0]!, 'table');
		return { table: parts[0]! };
	}

	if (parts.length === 2) {
		const schema = parts[0]!;
		const table = parts[1]!;
		validateIdentifier(schema, 'schema');
		validateIdentifier(table, 'table');
		return { schema, table };
	}

	throw new InvalidIdentifierError(
		schemaTable,
		'table',
		'too many dots in qualified name (expected schema.table or table)',
	);
}

/**
 * Batch validate multiple identifiers.
 *
 * @param identifiers Map of identifier values to their types
 * @throws InvalidIdentifierError on first validation failure
 */
export function validateIdentifiers(
	identifiers: Record<string, 'table' | 'column' | 'schema' | 'alias'>,
): void {
	for (const [value, type] of Object.entries(identifiers)) {
		if (value) {
			validateIdentifier(value, type);
		}
	}
}

// ============================================================================
// Sanitization (for display/logging only - NOT for SQL)
// ============================================================================

/**
 * Sanitize an identifier for safe logging/display.
 * NOT for use in SQL - use validateIdentifier + AST helpers for that.
 */
export function sanitizeForDisplay(value: string): string {
	// Replace control characters with placeholders
	return value.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 100); // Truncate for display
}

/**
 * Validate a PostgreSQL extension name for safe use in DDL statements.
 *
 * Extension names differ from regular SQL identifiers: they can contain
 * hyphens and dots (e.g. `uuid-ossp`, `postgis-raster`, `pg_trgm`).
 * However they must not contain injection vectors.
 *
 * Allowed: letters, digits, underscore, hyphen, dot (`[a-zA-Z0-9_\-.]+`)
 * Forbidden: double-quote, single-quote, semicolon, --, /*, *\/, dollar-quoted strings ($$), whitespace, NUL, backslash
 *
 * @param name The extension name to validate (e.g. `uuid-ossp`)
 * @param context Human-readable context label for the error message
 * @throws InvalidIdentifierError if the name fails validation
 */
export function validateExtensionName(
	name: string,
	context = 'extension',
): void {
	if (!name || name.length === 0) {
		throw new InvalidIdentifierError(name, context, 'cannot be empty');
	}

	// PostgreSQL NAMEDATALEN - 1 = 63 character limit
	if (name.length > 63) {
		throw new InvalidIdentifierError(
			name,
			context,
			`exceeds maximum length of 63 characters (got ${name.length})`,
		);
	}

	// Reject injection vectors before the character allowlist check
	if (/[\x00-\x1f\x7f]/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains control characters',
		);
	}
	if (/[\\]/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains backslash (forbidden in extension names)',
		);
	}
	if (/"/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains double-quote (identifier injection risk)',
		);
	}
	if (/'/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains single-quote (string injection risk)',
		);
	}
	if (/;/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains semicolon (statement injection risk)',
		);
	}
	if (/--/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains line-comment marker (--)',
		);
	}
	if (/\/\*/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains block-comment opener (/*)',
		);
	}
	if (/\*\//.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains block-comment closer (*/)',
		);
	}
	if (/\$\$/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains dollar-quoting ($$)',
		);
	}
	if (/\s/.test(name)) {
		throw new InvalidIdentifierError(name, context, 'contains whitespace');
	}

	// Final allowlist: letters, digits, underscore, hyphen, dot
	if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains characters not allowed in extension names (only letters, digits, underscore, hyphen, and dot allowed)',
		);
	}
}

/**
 * Validate a PostgreSQL collation name for safe use in DDL statements.
 *
 * Collation names differ from regular SQL identifiers: they can contain
 * hyphens and dots to represent locale strings (e.g. `en_US.utf8`,
 * `en-US-x-icu`, `C.UTF-8`, `C`). They must not contain injection vectors.
 *
 * Allowed: letter or underscore start, then letters, digits, underscore,
 *          hyphen, dot, and an optional trailing `@modifier` (1-10 characters
 *          from `[A-Za-z0-9-]`, e.g. `@euro`, `@latin9`, `@iso8859-15`).
 *          Modifier hyphens are allowed to cover codepage suffixes like
 *          `iso8859-15`. Pattern: `[a-zA-Z_][a-zA-Z0-9_.-]*(?:@[A-Za-z0-9-]{1,10})?`
 * Forbidden: any character outside [A-Za-z0-9_.-] and the optional
 *            @modifier (including single-quote, double-quote, semicolon, --,
 *            block-comment markers, dollar-quoting, whitespace, NUL byte,
 *            backslash, bare @, or @modifier longer than 10 characters)
 *
 * @param name    The collation name to validate (e.g. en_US.utf8, de_DE.utf8@euro)
 * @param context Human-readable context label for the error message
 * @throws InvalidIdentifierError if the name fails validation
 */
export function validateCollationName(
	name: string,
	context = 'collation',
): void {
	if (!name || name.length === 0) {
		throw new InvalidIdentifierError(name, context, 'cannot be empty');
	}

	// PostgreSQL NAMEDATALEN - 1 = 63 byte limit. For collation names the
	// equivalence of .length and Buffer.byteLength() still holds because the
	// accepted charset ([A-Za-z0-9_.-] plus the @modifier [A-Za-z0-9-]) is
	// entirely ASCII — every character is a single byte in UTF-8.
	if (Buffer.byteLength(name, 'utf8') > 63) {
		throw new InvalidIdentifierError(
			name,
			context,
			`exceeds maximum length of 63 bytes (got ${Buffer.byteLength(name, 'utf8')})`,
		);
	}

	// Reject NUL bytes — PostgreSQL silently truncates at the first NUL
	if (/\x00/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains NUL byte (\\x00) which would be silently truncated by PostgreSQL',
		);
	}

	// Reject other control characters (0x01-0x1F, 0x7F)
	if (/[\x01-\x1f\x7f]/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains control characters (only printable characters allowed)',
		);
	}

	// Reject backslash
	if (/[\\]/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains backslash (forbidden in collation names)',
		);
	}

	// Reject embedded double-quotes — not valid inside a collation name
	if (/"/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains double-quote (identifier injection risk)',
		);
	}

	// Reject single-quotes
	if (/'/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains single-quote (string injection risk)',
		);
	}

	// Reject semicolons
	if (/;/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains semicolon (statement injection risk)',
		);
	}

	// Reject line-comment marker
	if (/--/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains line-comment marker (--)',
		);
	}

	// Reject block-comment opener
	if (/\/\*/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains block-comment opener (/*)',
		);
	}

	// Reject block-comment closer
	if (/\*\//.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains block-comment closer (*/)',
		);
	}

	// Reject dollar-quoting
	if (/\$\$/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains dollar-quoting ($$)',
		);
	}

	// Reject whitespace
	if (/\s/.test(name)) {
		throw new InvalidIdentifierError(name, context, 'contains whitespace');
	}

	// Final allowlist: must start with letter or underscore, then allow
	// letters, digits, underscore, hyphen, dot (covers en_US.utf8, en-US-x-icu, C.UTF-8).
	// An optional trailing @modifier (1-10 alphanumeric or hyphen chars) is also
	// accepted, e.g. de_DE.utf8@euro, en_US.utf8@latin9, en_US@iso8859-15. Bare @,
	// overlong modifiers, and non-[A-Za-z0-9-] characters inside the modifier are
	// rejected. Must match: [a-zA-Z_][a-zA-Z0-9_.-]*(?:@[A-Za-z0-9-]{1,10})?
	if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*(?:@[A-Za-z0-9-]{1,10})?$/.test(name)) {
		throw new InvalidIdentifierError(
			name,
			context,
			'contains characters not allowed in collation names (only letters, digits, underscore, hyphen, and dot allowed; optional @modifier must be 1-10 alphanumeric/hyphen characters, e.g. @euro, @latin9, @iso8859-15)',
		);
	}
}

/** Safe PostgreSQL type name pattern: base_name, optional (precision,scale), optional [] */
const SAFE_TYPE_PATTERN =
	/^[a-zA-Z_][a-zA-Z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/;

/**
 * Validate a raw SQL expression used in DDL contexts (defaults, policy USING/CHECK).
 * Rejects injection vectors: semicolons, line-comment markers, block-comment markers.
 *
 * @security Called before any ModelIR-sourced string is interpolated into DDL.
 * @param sql The raw SQL expression string to validate.
 * @param context Human-readable context label for the error message.
 * @throws Error if the expression contains forbidden characters.
 */
export function validateSqlExpression(sql: string, context: string): void {
	// Forbidden: semicolons (statement injection), line comments (--),
	// block comment openers (/*), block comment closers (*/) — defense-in-depth
	// so a partial payload cannot close an enclosing comment to inject SQL —
	// dollar-quoted strings ($$), backslashes.
	if (/[;]|--|\/\*|\*\/|\$\$|\\/.test(sql)) {
		throw new Error(
			`Unsafe SQL expression in ${context}: contains forbidden characters (;, --, /*, */, "$$" (dollar-quoted strings), \\). Value: "${sql}"`,
		);
	}
}

/**
 * Validate a raw CHECK constraint expression, allowing forbidden-looking tokens
 * inside PostgreSQL string literals while still rejecting them outside literals.
 *
 * This intentionally does not parse CHECK semantics. It only tracks enough
 * PostgreSQL literal context to prevent false positives for inert quoted text.
 * Escape strings such as E'...' and U&'...' are treated as ordinary single-
 * quoted strings; backslash-escaped quote cases may fail closed.
 *
 * @security Used only for CHECK constraint text sourced from ModelIR.
 * @param sql The raw CHECK expression string to validate.
 * @param context Human-readable context label for the error message.
 * @throws Error if the expression contains unsafe tokens outside literals or an
 * unterminated literal.
 */
export function validateCheckExpression(sql: string, context: string): void {
	let i = 0;
	let singleQuoted = false;
	let dollarQuoteDelimiter: string | undefined;

	while (i < sql.length) {
		if (singleQuoted) {
			if (sql[i] === "'") {
				if (sql[i + 1] === "'") {
					i += 2;
					continue;
				}
				singleQuoted = false;
			}
			i++;
			continue;
		}

		if (dollarQuoteDelimiter) {
			if (sql.startsWith(dollarQuoteDelimiter, i)) {
				i += dollarQuoteDelimiter.length;
				dollarQuoteDelimiter = undefined;
				continue;
			}
			i++;
			continue;
		}

		if (sql[i] === "'") {
			singleQuoted = true;
			i++;
			continue;
		}

		const dollarDelimiter = readDollarQuoteDelimiter(sql, i);
		if (dollarDelimiter) {
			dollarQuoteDelimiter = dollarDelimiter;
			i += dollarDelimiter.length;
			continue;
		}

		const forbiddenToken = forbiddenCheckTokenAt(sql, i);
		if (forbiddenToken) {
			throw new Error(
				`Unsafe SQL expression in ${context}: contains forbidden token "${forbiddenToken}" outside string literal. Value: "${sql}"`,
			);
		}

		i++;
	}

	if (singleQuoted) {
		throw new Error(
			`Unsafe SQL expression in ${context}: unterminated single-quoted string literal. Value: "${sql}"`,
		);
	}

	if (dollarQuoteDelimiter) {
		throw new Error(
			`Unsafe SQL expression in ${context}: unterminated dollar-quoted string literal ${dollarQuoteDelimiter}. Value: "${sql}"`,
		);
	}
}

function forbiddenCheckTokenAt(sql: string, index: number): string | undefined {
	const ch = sql[index];
	if (ch === ';' || ch === '\\') return ch;

	const pair = sql.slice(index, index + 2);
	if (pair === '--' || pair === '/*' || pair === '*/') return pair;

	return undefined;
}

function readDollarQuoteDelimiter(
	sql: string,
	index: number,
): string | undefined {
	if (sql[index] !== '$') return undefined;
	const previous = index > 0 ? sql[index - 1] : undefined;
	if (previous && isIdentifierContinuationBeforeDollarQuote(previous)) {
		return undefined;
	}

	if (sql[index + 1] === '$') return '$$';
	if (!isDollarQuoteTagStart(sql[index + 1])) return undefined;

	let cursor = index + 2;
	while (isDollarQuoteTagContinuation(sql[cursor])) {
		cursor++;
	}

	if (sql[cursor] !== '$') return undefined;
	return sql.slice(index, cursor + 1);
}

function isIdentifierContinuationBeforeDollarQuote(ch: string): boolean {
	// PostgreSQL also permits "$" after the first identifier character; blocking
	// a delimiter immediately after "$" prevents opening inside identifiers such
	// as a$$tag$.
	return /[A-Za-z0-9_$]/.test(ch);
}

function isDollarQuoteTagStart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isDollarQuoteTagContinuation(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Validate a PostgreSQL type name coming from `originalDbType` (populated by introspection).
 * Rejects strings that do not match the PostgreSQL type-name grammar to prevent injection.
 *
 * @security Called before any originalDbType value is interpolated into DDL column types.
 * @param type The type name string to validate.
 * @returns The original string (unchanged) when valid.
 * @throws Error if the type name does not match the safe pattern.
 */
export function validateDbTypeName(type: string): string {
	if (!SAFE_TYPE_PATTERN.test(type)) {
		throw new Error(
			`Unsafe database type name: "${type}". Must match PostgreSQL type name rules.`,
		);
	}
	return type;
}
