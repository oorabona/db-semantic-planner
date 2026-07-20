import type { ColumnJsReadType } from './model-ir.js';

export interface BigintJsReadConversionContext {
	readonly table: string;
	readonly column: string;
	readonly outputKey: string;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const INTEGER_STRING_RE = /^[+-]?\d+$/;

function formatValue(value: unknown): string {
	if (typeof value === 'string') return `"${value}"`;
	if (typeof value === 'bigint') return `${value.toString()}n`;
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function conversionError(
	value: unknown,
	target: Exclude<ColumnJsReadType, 'string'>,
	ctx: BigintJsReadConversionContext,
	reason: string,
): RangeError {
	return new RangeError(
		`Cannot convert PostgreSQL bigint column "${ctx.table}.${ctx.column}" output key "${ctx.outputKey}" value ${formatValue(value)} to ${target}: ${reason}.`,
	);
}

function toStrictBigInt(
	value: unknown,
	target: Exclude<ColumnJsReadType, 'string'>,
	ctx: BigintJsReadConversionContext,
): bigint {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!INTEGER_STRING_RE.test(trimmed)) {
			throw conversionError(
				value,
				target,
				ctx,
				'expected an integer string, bigint, or safe integer number',
			);
		}
		return BigInt(trimmed);
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) {
			throw conversionError(
				value,
				target,
				ctx,
				'expected a safe integer number',
			);
		}
		return BigInt(value);
	}
	throw conversionError(
		value,
		target,
		ctx,
		'expected an integer string, bigint, or safe integer number',
	);
}

export function convertBigintJsReadValue(
	value: unknown,
	js: ColumnJsReadType,
	ctx: BigintJsReadConversionContext,
): unknown {
	if (value === null || value === undefined) return value;

	switch (js) {
		case 'string':
			return value;
		case 'bigint':
			return toStrictBigInt(value, 'bigint', ctx);
		case 'number': {
			const bigintValue = toStrictBigInt(value, 'number', ctx);
			if (bigintValue > MAX_SAFE_BIGINT || bigintValue < MIN_SAFE_BIGINT) {
				throw conversionError(
					value,
					'number',
					ctx,
					"outside Number.MAX_SAFE_INTEGER; use js:'bigint' or omit js",
				);
			}
			return Number(bigintValue);
		}
		default:
			throw new Error(
				`Invalid bigint js read type '${String(js)}' for PostgreSQL bigint column "${ctx.table}.${ctx.column}".`,
			);
	}
}
