/**
 * PostgreSQL database type canonicalization.
 *
 * Keeps the alias table intentionally small: only spellings PostgreSQL commonly
 * returns through catalog introspection that would otherwise cause round-trip
 * type diffs.
 */

import { parseValidatedDbTypeName } from './validate.js';

export interface CanonicalizeDbTypeOptions {
	readonly charLength?: number | null;
	readonly numericPrecision?: number | null;
	readonly numericScale?: number | null;
}

const TYPE_ALIASES: ReadonlyMap<string, string> = new Map([
	['int4', 'integer'],
	['int8', 'bigint'],
	['int2', 'smallint'],
	['bool', 'boolean'],
	['float8', 'double precision'],
	['float4', 'real'],
	['bpchar', 'char'],
	['varbit', 'bit varying'],
	['character varying', 'varchar'],
	['character', 'char'],
	['decimal', 'numeric'],
	['timestamp without time zone', 'timestamp'],
	['timestamp with time zone', 'timestamptz'],
	['time without time zone', 'time'],
	['time with time zone', 'timetz'],
]);

const RUNTIME_UNBOUNDED_MODIFIER_BASES = new Set([
	'varchar',
	'character varying',
	'numeric',
	'decimal',
]);

const RUNTIME_TEXT_CAST_MODIFIER_BASES = new Set([
	'char',
	'bpchar',
	'character',
]);

const RUNTIME_BIT_VARYING_CAST_MODIFIER_BASES = new Set([
	'bit',
	'varbit',
	'bit varying',
]);

function normalizeTypeText(rawType: string): string {
	return rawType
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/\s*\(\s*/g, '(')
		.replace(/\s*,\s*/g, ',')
		.replace(/\s+\)/g, ')');
}

function splitArraySuffix(typeName: string): {
	readonly elementType: string;
	readonly arraySuffix: string;
} {
	let elementType = typeName.trim();
	let dimensions = 0;

	while (true) {
		const match = /\s*\[\s*\]$/.exec(elementType);
		if (!match) break;
		elementType = elementType.slice(0, match.index);
		dimensions++;
	}

	return { elementType, arraySuffix: '[]'.repeat(dimensions) };
}

function splitTypeModifier(typeName: string): {
	readonly base: string;
	readonly modifier?: string;
} {
	if (!typeName.endsWith(')')) return { base: typeName };

	let inQuotedIdentifier = false;
	let depth = 0;
	let modifierStart: number | undefined;

	for (let index = 0; index < typeName.length; index++) {
		const char = typeName[index];

		if (char === '"') {
			if (inQuotedIdentifier && typeName[index + 1] === '"') {
				index++;
				continue;
			}
			inQuotedIdentifier = !inQuotedIdentifier;
			continue;
		}

		if (inQuotedIdentifier) continue;

		if (char === '(') {
			if (depth === 0) modifierStart = index;
			depth++;
			continue;
		}

		if (char === ')') {
			if (depth === 0) return { base: typeName };
			depth--;
			if (depth === 0 && index !== typeName.length - 1) {
				modifierStart = undefined;
			}
		}
	}

	if (inQuotedIdentifier || depth !== 0 || modifierStart === undefined) {
		return { base: typeName };
	}

	return {
		base: typeName.slice(0, modifierStart).trim(),
		modifier: typeName.slice(modifierStart),
	};
}

export function stripTrailingDbTypeModifier(typeName: string): string {
	const { base, modifier } = splitTypeModifier(typeName);
	return modifier === undefined ? typeName : base;
}

export function resolveRuntimeDbTypeCastName(originalDbType: string): string {
	const typeName = originalDbType.trim();
	const parsed = parseValidatedDbTypeName(typeName);
	if (parsed.modifier === undefined) return typeName;

	const arraySuffix = '[]'.repeat(parsed.arrayDimensions);
	if (
		parsed.baseKey !== undefined &&
		RUNTIME_UNBOUNDED_MODIFIER_BASES.has(parsed.baseKey)
	) {
		return `${parsed.base}${arraySuffix}`;
	}

	if (
		parsed.baseKey !== undefined &&
		RUNTIME_TEXT_CAST_MODIFIER_BASES.has(parsed.baseKey)
	) {
		return `text${arraySuffix}`;
	}

	if (
		parsed.baseKey !== undefined &&
		RUNTIME_BIT_VARYING_CAST_MODIFIER_BASES.has(parsed.baseKey)
	) {
		return `bit varying${arraySuffix}`;
	}

	return typeName;
}

function foldUnquotedIdentifierCase(typeName: string): string {
	let result = '';
	let inQuotedIdentifier = false;

	for (let index = 0; index < typeName.length; index++) {
		const char = typeName[index]!;

		if (char === '"') {
			result += char;
			if (inQuotedIdentifier && typeName[index + 1] === '"') {
				result += typeName[index + 1];
				index++;
				continue;
			}
			inQuotedIdentifier = !inQuotedIdentifier;
			continue;
		}

		result += inQuotedIdentifier ? char : char.toLowerCase();
	}

	return result;
}

function applyModifier(base: string, modifier: string): string {
	if (base === 'numeric') {
		const numericModifier = /^\((\d+),(-?\d+)\)$/.exec(modifier);
		if (numericModifier && Number(numericModifier[2]) === 0) {
			return `numeric(${numericModifier[1]})`;
		}
	}

	return `${base}${modifier}`;
}

/**
 * Canonicalize a PostgreSQL type string for dbsp round-trip comparisons.
 *
 * Unknown unquoted types are folded to lowercase, matching PostgreSQL's
 * identifier rules. Quoted identifiers keep their exact case.
 */
export function canonicalizeDbType(
	rawType: string,
	opts: CanonicalizeDbTypeOptions = {},
): string {
	const { elementType, arraySuffix } = splitArraySuffix(rawType);
	if (arraySuffix !== '') {
		return `${canonicalizeDbType(elementType, opts)}${arraySuffix}`;
	}

	const temporalMatch =
		/^\s*(timestamp|time)\s*(?:\(\s*(\d+)\s*\))?\s*(with|without)\s+time\s+zone\s*$/i.exec(
			rawType,
		);
	if (temporalMatch) {
		const family = temporalMatch[1]!.toLowerCase();
		const precision = temporalMatch[2];
		const zone = temporalMatch[3]!.toLowerCase();
		const base =
			family === 'timestamp'
				? zone === 'with'
					? 'timestamptz'
					: 'timestamp'
				: zone === 'with'
					? 'timetz'
					: 'time';
		return precision !== undefined ? `${base}(${precision})` : base;
	}

	const normalized = normalizeTypeText(rawType);
	const { base: rawBase, modifier } = splitTypeModifier(normalized);
	const foldedBase = foldUnquotedIdentifierCase(rawBase);
	const base = TYPE_ALIASES.get(foldedBase) ?? foldedBase;

	if (modifier) return applyModifier(base, modifier);

	if (
		(base === 'varchar' || base === 'char') &&
		opts.charLength !== undefined &&
		opts.charLength !== null
	) {
		return `${base}(${opts.charLength})`;
	}

	if (
		base === 'numeric' &&
		opts.numericPrecision !== undefined &&
		opts.numericPrecision !== null
	) {
		const scale = opts.numericScale;
		if (scale !== undefined && scale !== null && scale !== 0) {
			return `${base}(${opts.numericPrecision},${scale})`;
		}
		return `${base}(${opts.numericPrecision})`;
	}

	return base;
}
