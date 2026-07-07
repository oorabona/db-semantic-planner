type ParsedIdentifierPart = {
	readonly text: string;
	readonly quoted: boolean;
	readonly end: number;
};

export type ParsedPostgresTypeName = {
	readonly base: string;
	readonly baseKey: string | undefined;
	readonly modifier: string | undefined;
	readonly arrayDimensions: number;
};

export type ParsePostgresTypeNameOptions = {
	readonly allowOuterWhitespace?: boolean;
	readonly allowQuotedIdentifiers?: boolean;
	readonly maxArrayDimensions?: number;
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;

const MULTI_WORD_TYPE_BASES = new Set([
	'double precision',
	'character varying',
	'bit varying',
	'timestamp without time zone',
	'timestamp with time zone',
	'time without time zone',
	'time with time zone',
]);

const NUMERIC_MODIFIER_BASES = new Set(['numeric', 'decimal']);
const LENGTH_MODIFIER_BASES = new Set([
	'varchar',
	'char',
	'character varying',
	'character',
	'bpchar',
	'bit',
	'bit varying',
	'varbit',
	'vector',
]);
const TEMPORAL_PRECISION_MODIFIER_BASES = new Set([
	'timestamp',
	'timestamptz',
	'timestamp without time zone',
	'timestamp with time zone',
	'time',
	'timetz',
	'time without time zone',
	'time with time zone',
]);
const COMPOUND_MODIFIER_BASES = new Set(['geometry', 'geography']);
const SAFE_COMPOUND_MODIFIER_PATTERN = /^[A-Za-z0-9_,\s]{1,128}$/;

function stripArraySuffixes(type: string): {
	readonly rest: string;
	readonly arrayDimensions: number;
} {
	let rest = type;
	let arrayDimensions = 0;

	while (true) {
		const match = /\s*\[\s*\]$/.exec(rest);
		if (!match) break;
		rest = rest.slice(0, match.index);
		arrayDimensions++;
	}

	return { rest, arrayDimensions };
}

function splitTypeModifier(type: string):
	| {
			readonly base: string;
			readonly modifier?: string;
	  }
	| undefined {
	let inQuotedIdentifier = false;
	let modifierStart: number | undefined;
	let closedModifier = false;

	for (let index = 0; index < type.length; index++) {
		const char = type[index];

		if (char === '"') {
			if (inQuotedIdentifier && type[index + 1] === '"') {
				index++;
				continue;
			}
			inQuotedIdentifier = !inQuotedIdentifier;
			continue;
		}

		if (inQuotedIdentifier) continue;

		if (char === '(') {
			if (modifierStart !== undefined || closedModifier) return undefined;
			modifierStart = index;
			continue;
		}

		if (char === ')') {
			if (modifierStart === undefined || index !== type.length - 1) {
				return undefined;
			}
			closedModifier = true;
		}
	}

	if (inQuotedIdentifier) return undefined;
	if (modifierStart === undefined)
		return closedModifier ? undefined : { base: type };
	if (!closedModifier) return undefined;

	const base = type.slice(0, modifierStart);
	if (base.length === 0 || base !== base.trimEnd()) return undefined;

	return {
		base,
		modifier: type.slice(modifierStart + 1, -1),
	};
}

function parseIdentifierPart(
	input: string,
	start: number,
	allowQuotedIdentifiers: boolean,
): ParsedIdentifierPart | undefined {
	if (input[start] === '"') {
		if (!allowQuotedIdentifiers) return undefined;

		let text = '"';
		let content = '';

		for (let index = start + 1; index < input.length; index++) {
			const char = input.charAt(index);
			if (char === '"') {
				if (input[index + 1] === '"') {
					text += '""';
					content += '"';
					index++;
					continue;
				}
				text += '"';
				return content.length > 0
					? { text, quoted: true, end: index + 1 }
					: undefined;
			}
			text += char;
			content += char;
		}

		return undefined;
	}

	const match = IDENTIFIER_PATTERN.exec(input.slice(start));
	if (!match) return undefined;
	return {
		text: match[0],
		quoted: false,
		end: start + match[0].length,
	};
}

function identifierKey(part: ParsedIdentifierPart): string | undefined {
	if (!part.quoted) return part.text.toLowerCase();

	const content = part.text.slice(1, -1).replace(/""/g, '"');
	return content === content.toLowerCase() ? content : undefined;
}

function parseTypeBase(
	base: string,
	allowQuotedIdentifiers: boolean,
):
	| {
			readonly baseKey: string | undefined;
			readonly customSchemaQualified: boolean;
	  }
	| undefined {
	if (base.length === 0 || base !== base.trim()) return undefined;

	const lowerBase = base.toLowerCase();
	if (MULTI_WORD_TYPE_BASES.has(lowerBase)) {
		return { baseKey: lowerBase, customSchemaQualified: false };
	}

	const first = parseIdentifierPart(base, 0, allowQuotedIdentifiers);
	if (!first) return undefined;
	if (first.end === base.length) {
		return {
			baseKey: first.quoted ? undefined : first.text.toLowerCase(),
			customSchemaQualified: false,
		};
	}
	if (base[first.end] !== '.') return undefined;

	const schemaKey = identifierKey(first);
	const secondStart = first.end + 1;
	const second = parseIdentifierPart(base, secondStart, allowQuotedIdentifiers);
	if (second?.end === base.length) {
		if (schemaKey === 'pg_catalog') {
			return { baseKey: identifierKey(second), customSchemaQualified: false };
		}
		return { baseKey: undefined, customSchemaQualified: true };
	}

	const secondBase = base.slice(secondStart);
	if (
		schemaKey === 'pg_catalog' &&
		MULTI_WORD_TYPE_BASES.has(secondBase.toLowerCase())
	) {
		return {
			baseKey: secondBase.toLowerCase(),
			customSchemaQualified: false,
		};
	}

	return undefined;
}

function isValidModifier(
	baseKey: string | undefined,
	modifier: string,
	customSchemaQualified: boolean,
): boolean {
	if (modifier.length === 0) return false;

	if (baseKey === undefined) {
		return (
			customSchemaQualified && SAFE_COMPOUND_MODIFIER_PATTERN.test(modifier)
		);
	}

	if (NUMERIC_MODIFIER_BASES.has(baseKey)) {
		return /^\d+(?:,\s*-?\d+)?$/.test(modifier);
	}

	if (
		LENGTH_MODIFIER_BASES.has(baseKey) ||
		TEMPORAL_PRECISION_MODIFIER_BASES.has(baseKey)
	) {
		return /^\d+$/.test(modifier);
	}

	if (COMPOUND_MODIFIER_BASES.has(baseKey)) {
		return SAFE_COMPOUND_MODIFIER_PATTERN.test(modifier);
	}

	return false;
}

export function parsePostgresTypeName(
	type: string,
	options: ParsePostgresTypeNameOptions = {},
): ParsedPostgresTypeName | undefined {
	const {
		allowOuterWhitespace = false,
		allowQuotedIdentifiers = true,
		maxArrayDimensions = Number.POSITIVE_INFINITY,
	} = options;
	const normalized = allowOuterWhitespace ? type.trim() : type;
	if (
		normalized.length === 0 ||
		(!allowOuterWhitespace && normalized !== normalized.trim())
	) {
		return undefined;
	}
	if (/;|--|\/\*|\*\/|\0/.test(normalized)) return undefined;

	const { rest: withoutArrays, arrayDimensions } =
		stripArraySuffixes(normalized);
	if (
		withoutArrays.length === 0 ||
		arrayDimensions > maxArrayDimensions ||
		withoutArrays !== withoutArrays.trimEnd()
	) {
		return undefined;
	}

	const modifierParts = splitTypeModifier(withoutArrays);
	if (!modifierParts) return undefined;

	const baseParts = parseTypeBase(modifierParts.base, allowQuotedIdentifiers);
	if (!baseParts) return undefined;

	if (
		modifierParts.modifier !== undefined &&
		!isValidModifier(
			baseParts.baseKey,
			modifierParts.modifier,
			baseParts.customSchemaQualified,
		)
	) {
		return undefined;
	}

	return {
		base: modifierParts.base,
		baseKey: baseParts.baseKey,
		modifier: modifierParts.modifier,
		arrayDimensions,
	};
}
