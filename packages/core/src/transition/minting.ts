import type { ProvenPlanShape } from '@dbsp/types';
import type { InProcessProvenPlan } from './index.js';

const minted = new WeakSet<object>();

function isObject(value: unknown): value is object {
	return (
		(typeof value === 'object' && value !== null) || typeof value === 'function'
	);
}

function childPath(parent: string, key: string | symbol): string {
	if (typeof key === 'symbol') {
		return `${parent}[${String(key)}]`;
	}
	if (/^(0|[1-9]\d*)$/.test(key)) {
		return `${parent}[${key}]`;
	}
	if (/^[A-Za-z_$][\w$]*$/.test(key)) {
		return `${parent}.${key}`;
	}
	return `${parent}[${JSON.stringify(key)}]`;
}

function kindOf(value: object): string {
	if (typeof value === 'function') {
		return 'function';
	}
	if (value instanceof Map) {
		return 'Map';
	}
	if (value instanceof Set) {
		return 'Set';
	}
	if (value instanceof Date) {
		return 'Date';
	}
	if (value instanceof RegExp) {
		return 'RegExp';
	}
	if (ArrayBuffer.isView(value)) {
		return 'typed array';
	}
	if (value instanceof ArrayBuffer) {
		return 'ArrayBuffer';
	}
	return value.constructor?.name ?? 'object';
}

function plainDataError(kind: string, path: string): Error {
	return new Error(
		`a minted plan must be plain data; found ${kind} at ${path}`,
	);
}

/**
 * Whether `stableJson` will serialize this own key of an array. Its array branch
 * walks `0 .. length - 1` and reads nothing else, so the bound is the array's own
 * length rather than the language's array-index range: assigning `a[2 ** 32]`
 * leaves `length` untouched, which is exactly how a property stays readable by
 * the executor and absent from the digest.
 */
function isVisibleArrayIndex(value: readonly unknown[], key: string): boolean {
	const index = Number(key);
	return (
		String(index) === key &&
		Number.isInteger(index) &&
		index >= 0 &&
		index < value.length
	);
}

function assertPlainDataAndFreeze(
	value: unknown,
	path: string,
	seen: WeakSet<object>,
): void {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'undefined'
	) {
		return;
	}
	if (typeof value === 'bigint' || typeof value === 'symbol') {
		throw plainDataError(typeof value, path);
	}
	if (!isObject(value)) {
		return;
	}
	if (seen.has(value)) {
		return;
	}
	seen.add(value);
	if (typeof value === 'function') {
		throw plainDataError('function', path);
	}
	if (
		value instanceof Map ||
		value instanceof Set ||
		value instanceof Date ||
		value instanceof RegExp ||
		ArrayBuffer.isView(value) ||
		value instanceof ArrayBuffer
	) {
		throw plainDataError(kindOf(value), path);
	}

	let prototype: object | null;
	let keys: readonly (string | symbol)[];
	try {
		prototype = Object.getPrototypeOf(value);
		keys = Reflect.ownKeys(value);
	} catch (error) {
		throw plainDataError(
			error instanceof Error ? `Proxy (${error.message})` : 'Proxy',
			path,
		);
	}

	const isPlainObject = prototype === Object.prototype;
	const isPlainArray = Array.isArray(value) && prototype === Array.prototype;
	if (!isPlainObject && !isPlainArray) {
		throw plainDataError(kindOf(value), path);
	}

	for (const key of keys) {
		if (typeof key === 'symbol') {
			throw plainDataError('symbol key', childPath(path, key));
		}
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, key);
		} catch (error) {
			throw plainDataError(
				error instanceof Error ? `Proxy (${error.message})` : 'Proxy',
				childPath(path, key),
			);
		}
		if (!descriptor) {
			continue;
		}
		if ('get' in descriptor || 'set' in descriptor) {
			throw plainDataError('accessor', childPath(path, key));
		}
		if (isPlainObject && !descriptor.enumerable) {
			// This property is readable by execution code but invisible to stableJson
			// and JSON.stringify, so it could change the stored plan under one digest.
			throw plainDataError('non-enumerable property', childPath(path, key));
		}
		if (isPlainArray && key !== 'length' && !isVisibleArrayIndex(value, key)) {
			// This property is readable by execution code but invisible to stableJson
			// and JSON.stringify, so it could change the stored plan under one digest.
			throw plainDataError('named array property', childPath(path, key));
		}
		assertPlainDataAndFreeze(descriptor.value, childPath(path, key), seen);
	}

	try {
		Object.freeze(value);
	} catch (error) {
		throw plainDataError(
			error instanceof Error ? `Proxy (${error.message})` : 'Proxy',
			path,
		);
	}
}

export function mintInProcessPlan(shape: ProvenPlanShape): InProcessProvenPlan {
	assertPlainDataAndFreeze(shape, '$', new WeakSet<object>());
	minted.add(shape);
	return shape as InProcessProvenPlan;
}

export function isMintedInProcessPlan(
	plan: unknown,
): plan is InProcessProvenPlan {
	return isObject(plan) && minted.has(plan);
}
