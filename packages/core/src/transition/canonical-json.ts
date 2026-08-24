import { createHash } from 'node:crypto';

/** Raised when a value cannot cross the durable JSON payload boundary. */
export class CanonicalJsonError extends TypeError {
	constructor(path: string, detail: string) {
		super(`canonical JSON refuses ${path}: ${detail}`);
		this.name = 'CanonicalJsonError';
	}
}

/**
 * Encodes a JSON value with lexically sorted object keys and preserved array
 * order. Unlike JSON.stringify, this refuses values it would omit or coerce.
 */
export function canonicalJson(value: unknown): string {
	return encodeCanonicalJson(value, '$');
}

/** Hashes the canonical durable representation of a JSON payload. */
export function canonicalJsonDigest(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function encodeCanonicalJson(value: unknown, path: string): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return JSON.stringify(value);
		case 'number':
			if (!Number.isFinite(value))
				throw new CanonicalJsonError(
					path,
					'numbers must be finite JSON numbers',
				);
			return JSON.stringify(value);
		case 'undefined':
			throw new CanonicalJsonError(path, 'undefined is not a JSON value');
		case 'bigint':
		case 'function':
		case 'symbol':
			throw new CanonicalJsonError(path, `${typeof value} is not a JSON value`);
		case 'object':
			break;
	}

	if (Array.isArray(value)) {
		const values: string[] = [];
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index))
				throw new CanonicalJsonError(
					`${path}[${index}]`,
					'array holes are not JSON values',
				);
			values.push(encodeCanonicalJson(value[index], `${path}[${index}]`));
		}
		return `[${values.join(',')}]`;
	}

	if (
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new CanonicalJsonError(path, 'only plain objects are JSON objects');
	const symbols = Object.getOwnPropertySymbols(value);
	if (symbols.length > 0)
		throw new CanonicalJsonError(
			path,
			'symbol-keyed members are not JSON members',
		);
	const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
	for (const [key, descriptor] of entries) {
		if (!descriptor.enumerable)
			throw new CanonicalJsonError(
				`${path}.${key}`,
				'non-enumerable members are not JSON members',
			);
		if (!('value' in descriptor))
			throw new CanonicalJsonError(
				`${path}.${key}`,
				'accessor members are not JSON values',
			);
		if (descriptor.value === undefined)
			throw new CanonicalJsonError(
				`${path}.${key}`,
				'undefined is not a JSON value',
			);
	}
	return `{${entries
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(
			([key, descriptor]) =>
				`${JSON.stringify(key)}:${encodeCanonicalJson(descriptor.value, `${path}.${key}`)}`,
		)
		.join(',')}}`;
}
