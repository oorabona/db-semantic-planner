type SplitDbType = {
	base: string;
	modifier: string | undefined;
	isArray: boolean;
	schemaQualified: boolean;
};

const TEMPORAL_TZ_SUFFIXES = [' without time zone', ' with time zone'] as const;
const SAFE_LOWERCASE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

const MULTIWORD_BASE_TYPES = new Set([
	'timestamp with time zone',
	'timestamp without time zone',
	'time with time zone',
	'time without time zone',
	'double precision',
	'character varying',
	'bit varying',
]);

const TYPE_ALIASES = new Map<string, string>([
	['character varying', 'varchar'],
	['character', 'char'],
	['bpchar', 'char'],
	['bit varying', 'varbit'],
	['timestamp with time zone', 'timestamptz'],
	['timestamp without time zone', 'timestamp'],
	['time with time zone', 'timetz'],
	['time without time zone', 'time'],
	['int', 'integer'],
	['int4', 'integer'],
	['int8', 'bigint'],
	['int2', 'smallint'],
	['float', 'double precision'],
	['float8', 'double precision'],
	['float4', 'real'],
	['bool', 'boolean'],
	['decimal', 'numeric'],
	['serial', 'integer'],
	['serial4', 'integer'],
	['bigserial', 'bigint'],
	['serial8', 'bigint'],
	['smallserial', 'smallint'],
	['serial2', 'smallint'],
]);

const BUILTIN_BASE_TYPES = new Set([
	...TYPE_ALIASES.keys(),
	...TYPE_ALIASES.values(),
	'bigint',
	'bit',
	'boolean',
	'box',
	'bytea',
	'char',
	'cidr',
	'circle',
	'date',
	'float',
	'inet',
	'integer',
	'interval',
	'json',
	'jsonb',
	'line',
	'lseg',
	'macaddr',
	'macaddr8',
	'money',
	'numeric',
	'path',
	'pg_lsn',
	'point',
	'polygon',
	'real',
	'text',
	'time',
	'timestamp',
	'timetz',
	'timestamptz',
	'tsquery',
	'tsvector',
	'txid_snapshot',
	'uuid',
	'varbit',
	'varchar',
	'xml',
	'jsonpath',
	'name',
	'oid',
	'regclass',
	'regtype',
	'regrole',
	'regnamespace',
	'regproc',
	'regprocedure',
	'xid',
	'xid8',
	'cid',
	'tid',
	'daterange',
	'int4range',
	'int8range',
	'numrange',
	'tsrange',
	'tstzrange',
	'datemultirange',
	'int4multirange',
	'int8multirange',
	'nummultirange',
	'tsmultirange',
	'tstzmultirange',
]);

const UNQUOTED_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
// SQL-standard quoted identifier: >= 1 unit (any non-quote char, or an escaped
// ""), so an empty "" is rejected as a malformed type name.
const QUOTED_IDENTIFIER = '"(?:[^"]|"")+"';
const IDENTIFIER_RE = new RegExp(
	`^(?:${UNQUOTED_IDENTIFIER}|${QUOTED_IDENTIFIER})$`,
);
const QUALIFIED_IDENTIFIER_RE = new RegExp(
	`^(?:${UNQUOTED_IDENTIFIER}|${QUOTED_IDENTIFIER})\\.(?:${UNQUOTED_IDENTIFIER}|${QUOTED_IDENTIFIER})$`,
);
const QUOTED_IDENTIFIER_RE = new RegExp(QUOTED_IDENTIFIER, 'g');
const INTERVAL_FIELD = '(?:year|month|day|hour|minute|second)';
const INTERVAL_BASE_RE = new RegExp(
	`^interval(?: ${INTERVAL_FIELD}(?: to ${INTERVAL_FIELD})?)?$`,
	'i',
);
// No valid PostgreSQL type modifier contains a quote — numeric (n[,s]), a
// length, or a type-specific token like geometry(Point,4326). Disallowing `'`
// rejects malformed/unbalanced string literals such as geometry('unterminated).
const MODIFIER_CONTENT_RE = /^[A-Za-z0-9_,.\- ]+$/;
const MODIFIER_OPERATOR_RE = /[=<>+*/%|&!@#^~]/;

// Built-in types whose only valid modifier is a single length/precision integer
// — (n). Rejects malformed inputs like varchar('x') / bit(8,-1) / varchar(1 2) at
// the adapter boundary. interval field specs (interval day to second) are matched
// via INTERVAL_BASE_RE, not this set.
const SINGLE_INT_MODIFIER_BUILTINS = new Set([
	'varchar',
	'character varying',
	'char',
	'character',
	'bpchar',
	// float(p): PostgreSQL treats float(1..24) as real, float(25..53) as double
	// precision — a single-integer mantissa precision.
	'float',
	'bit',
	'bit varying',
	'varbit',
	'timestamp',
	'timestamptz',
	'timestamp with time zone',
	'timestamp without time zone',
	'time',
	'timetz',
	'time with time zone',
	'time without time zone',
	'interval',
]);
// Built-in types whose modifier is precision with an optional scale — (p) or
// (p,s). The scale may be negative on PostgreSQL 15+ (numeric(10,-2)).
const PRECISION_SCALE_BUILTINS = new Set(['numeric', 'decimal']);

function splitDbType(input: string): SplitDbType {
	const trimmed = input.trim();
	let rest = trimmed;
	let isArray = false;

	if (rest.endsWith('[]')) {
		isArray = true;
		rest = rest.slice(0, -2).trimEnd();
	}

	const lowerRest = rest.toLowerCase();
	for (const suffix of TEMPORAL_TZ_SUFFIXES) {
		if (!lowerRest.endsWith(suffix)) continue;

		const beforeSuffix = rest.slice(0, -suffix.length).trimEnd();
		const temporal = splitTrailingModifier(beforeSuffix);
		const temporalBase = normalizeBase(temporal.base).toLowerCase();

		if (temporalBase === 'timestamp' || temporalBase === 'time') {
			const base = normalizeBase(`${temporal.base}${suffix}`);
			return {
				base,
				modifier: temporal.modifier,
				isArray,
				schemaQualified: isSchemaQualified(base),
			};
		}
	}

	const split = splitTrailingModifier(rest);
	const base = normalizeBase(split.base);

	return {
		base,
		modifier: split.modifier,
		isArray,
		schemaQualified: isSchemaQualified(base),
	};
}

function splitTrailingModifier(input: string): {
	base: string;
	modifier: string | undefined;
} {
	const match = input.match(/^(.*)\(([^()]*)\)$/);
	if (!match) return { base: input.trim(), modifier: undefined };

	return {
		base: (match[1] ?? '').trimEnd(),
		modifier: (match[2] ?? '').trim(),
	};
}

function normalizeBase(base: string): string {
	const trimmed = base.trim();
	return trimmed.includes('"') ? trimmed : trimmed.replace(/\s+/g, ' ');
}

function isSchemaQualified(base: string): boolean {
	return QUALIFIED_IDENTIFIER_RE.test(base);
}

function canonicalizeDbType(type: string): string {
	const split = splitDbType(type);
	const base = normalizeBase(split.base);
	const canonicalBase = base.includes('"')
		? base
		: (TYPE_ALIASES.get(base.toLowerCase()) ?? base.toLowerCase());
	// Normalize whitespace only AROUND the comma so numeric(10, 2) canonicalizes
	// equal to numeric(10,2) (format_type emits no spaces; authored DSL may) —
	// without collapsing space WITHIN a token, so a malformed varchar(1 20) does
	// not canonicalize equal to varchar(120) and mask real drift.
	const modifier =
		split.modifier === undefined
			? ''
			: `(${split.modifier.replace(/\s*,\s*/g, ',').trim()})`;
	const arraySuffix = split.isArray ? '[]' : '';

	return `${canonicalBase}${modifier}${arraySuffix}`;
}

/**
 * Return a truncation-safe PostgreSQL CAST target for a database type string.
 */
export function dbTypeCastTarget(originalDbType: string): string {
	const split = splitDbType(originalDbType);
	const base = normalizeBase(split.base).toLowerCase();
	const hasModifier = split.modifier !== undefined;
	const arraySuffix = split.isArray ? '[]' : '';

	if (base === 'varchar' || base === 'character varying') {
		return hasModifier ? `varchar${arraySuffix}` : originalDbType;
	}

	if (base === 'char' || base === 'character' || base === 'bpchar') {
		return `text${arraySuffix}`;
	}

	if (base === 'bit' || base === 'bit varying' || base === 'varbit') {
		return hasModifier ? `bit varying${arraySuffix}` : originalDbType;
	}

	if (base === 'numeric' || base === 'decimal') {
		return hasModifier ? `numeric${arraySuffix}` : originalDbType;
	}

	if (base === 'timestamp with time zone' || base === 'timestamptz') {
		return hasModifier
			? `timestamp with time zone${arraySuffix}`
			: originalDbType;
	}

	if (base === 'timestamp without time zone') {
		return hasModifier
			? `timestamp without time zone${arraySuffix}`
			: originalDbType;
	}

	if (base === 'timestamp') {
		return hasModifier
			? `timestamp without time zone${arraySuffix}`
			: originalDbType;
	}

	if (base === 'time with time zone' || base === 'timetz') {
		return hasModifier ? `time with time zone${arraySuffix}` : originalDbType;
	}

	if (base === 'time without time zone') {
		return hasModifier
			? `time without time zone${arraySuffix}`
			: originalDbType;
	}

	if (base === 'time') {
		return hasModifier ? `time${arraySuffix}` : originalDbType;
	}

	// interval, optionally with a field spec (e.g. `interval day to second`):
	// drop the precision modifier so the cast never rounds fractional seconds.
	if (INTERVAL_BASE_RE.test(base)) {
		return hasModifier ? `${base}${arraySuffix}` : originalDbType;
	}

	// Custom/UDT or any other type: emit the already-valid SQL spelling as-is. A
	// bare name folds per PostgreSQL's identifier rules; a case-sensitive type is
	// already quoted upstream (introspection renders catalog names via
	// quoteTypeIdentifier). Re-quoting here would change a bare name's meaning.
	return originalDbType;
}

export function dbTypesEqual(a: string, b: string): boolean {
	return canonicalizeDbType(a) === canonicalizeDbType(b);
}

/**
 * True when a database type string is a recognized built-in PostgreSQL type
 * spelling rather than a custom/UDT identifier.
 */
export function isPgBuiltInTypeName(type: string): boolean {
	const split = splitDbType(type);
	const base = normalizeBase(split.base);

	if (base.includes('"') || split.schemaQualified) return false;

	// Built-in check is case-insensitive and comes FIRST: a mixed-case spelling
	// of a built-in (VarChar, Numeric, Timestamp) is a built-in — PostgreSQL
	// folds it to the canonical type. Only a bare name that resolves to no
	// built-in is treated as a custom/UDT identifier. A bare name that collides
	// (case-insensitively) with a built-in — e.g. `Money` vs `money` — is the
	// built-in; a case-sensitive custom type must be quoted (`"Money"`), which
	// introspection stores via quoteTypeIdentifier.
	const baseLower = base.toLowerCase();
	return (
		MULTIWORD_BASE_TYPES.has(baseLower) ||
		INTERVAL_BASE_RE.test(base) ||
		BUILTIN_BASE_TYPES.has(baseLower)
	);
}

/**
 * Render a RAW catalog identifier (a bare typname, e.g. from pg_type.typname)
 * so a mixed-case catalog type (`Status`, `Money`) survives PostgreSQL identifier
 * folding: a safe lowercase identifier stays bare; anything case-sensitive is
 * quoted with inner `"` doubled.
 *
 * This is the ONLY place quoting is added. Callers that already hold a rendered
 * SQL type string (originalDbType) must emit it as-is — re-quoting a bare name
 * would change its meaning, since PostgreSQL folds unquoted identifiers.
 *
 * Scope: this handles CASE sensitivity only. A pathological custom type whose
 * lowercase catalog name collides with a reserved word or a built-in (a type
 * literally named `select` or `text`) is NOT disambiguated here — that needs
 * oid/namespace-aware rendering and is a pre-existing limitation of the
 * udt_name fallback (only the typmod/array format_type paths are oid-accurate).
 */
export function quoteTypeIdentifier(rawIdentifier: string): string {
	// Do NOT trim: leading/trailing whitespace is part of a raw catalog typname
	// (e.g. a type literally named ` Money`), so trimming would target a different
	// type. Such a name is not a safe lowercase identifier and is quoted verbatim.
	if (SAFE_LOWERCASE_IDENTIFIER_RE.test(rawIdentifier)) return rawIdentifier;
	return `"${rawIdentifier.replace(/"/g, '""')}"`;
}

/** Unwrap one layer of SQL identifier quoting, collapsing doubled `""`. */
function unquoteIdentifier(id: string): string {
	const t = id.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
		return t.slice(1, -1).replace(/""/g, '"');
	}
	return t;
}

/**
 * Classify how a rendered originalDbType references a given catalog typname, so
 * the enum drop-dependency scan can rewrite the column correctly before the type
 * is dropped: `scalar` -> cast to `text`, `array` -> cast to `text[]`. Returns
 * null when it does not reference the type. Bare or quoted names match; a
 * schema-qualified reference is not matched (cross-schema disambiguation needs
 * type-oid identity the column IR does not carry — a pre-existing limitation).
 */
export function enumReferenceKind(
	originalDbType: string,
	typname: string,
): 'scalar' | 'array' | null {
	const split = splitDbType(originalDbType);
	if (split.schemaQualified) return null;
	if (unquoteIdentifier(normalizeBase(split.base)) !== typname) return null;
	return split.isArray ? 'array' : 'scalar';
}

/**
 * Validate that a database type string is structurally a type name.
 */
export function validateDbType(type: string): string {
	if (typeof type !== 'string') {
		throw new Error(
			`Unsafe database type name: expected a string, received ${typeof type}`,
		);
	}

	if (!isStructurallyValidDbType(type)) {
		throw new Error(
			`Unsafe database type name: "${type}". Must be a structurally valid PostgreSQL type name.`,
		);
	}

	return type;
}

function isStructurallyValidDbType(type: string): boolean {
	const trimmed = type.trim();
	if (trimmed.length === 0 || trimmed !== type) return false;
	if (/[;]|--|\/\*|\*\//.test(trimmed)) return false;
	if (trimmed.endsWith('[][]')) return false;
	if (hasForbiddenTypeKeyword(trimmed)) return false;

	const split = splitDbType(trimmed);
	const base = split.base;
	const baseLower = base.toLowerCase();

	if (
		split.modifier !== undefined &&
		!isSafeModifier(split.modifier, baseLower)
	) {
		return false;
	}

	if (MULTIWORD_BASE_TYPES.has(baseLower)) {
		return true;
	}

	if (INTERVAL_BASE_RE.test(base)) {
		return true;
	}

	return IDENTIFIER_RE.test(base) || split.schemaQualified;
}

function isSafeModifier(modifier: string, baseLower: string): boolean {
	const structurallySafe =
		modifier.length > 0 &&
		!/[();]|--|\/\*|\*\//.test(modifier) &&
		!MODIFIER_OPERATOR_RE.test(modifier) &&
		MODIFIER_CONTENT_RE.test(modifier) &&
		!hasForbiddenTypeKeyword(modifier);
	if (!structurallySafe) return false;

	// numeric/decimal: precision with an optional (possibly negative) scale.
	if (PRECISION_SCALE_BUILTINS.has(baseLower)) {
		return /^\d+(\s*,\s*-?\d+)?$/.test(modifier);
	}
	// A single-integer-modifier built-in, or an interval (with an optional field
	// spec): the modifier must be exactly one non-negative integer. Rejects
	// varchar('x'), varchar(10,-2), bit(8,-1), interval day to second(foo),
	// varchar(1 2).
	if (
		SINGLE_INT_MODIFIER_BUILTINS.has(baseLower) ||
		INTERVAL_BASE_RE.test(baseLower)
	) {
		return /^\d+$/.test(modifier.trim());
	}
	// A recognized built-in that takes no modifier at all (integer, text, double
	// precision, uuid, oid, ...) — reject any modifier.
	if (
		BUILTIN_BASE_TYPES.has(baseLower) ||
		MULTIWORD_BASE_TYPES.has(baseLower)
	) {
		return false;
	}
	// Non-built-in (custom / extension) types keep an opaque modifier so
	// geometry(Point,4326) / vector(768) pass.
	return true;
}

function hasForbiddenTypeKeyword(type: string): boolean {
	const withoutQuotedIdentifiers = type.replace(QUOTED_IDENTIFIER_RE, '""');

	return /\bnot\s+null\b|\b(default|references|check|primary|unique|constraint|select|insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i.test(
		withoutQuotedIdentifiers,
	);
}
