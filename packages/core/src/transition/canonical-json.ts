import { createHash } from 'node:crypto';

/** Raised when a value cannot cross the durable JSON payload boundary. */
export class CanonicalJsonError extends TypeError {
	constructor(path: string, detail: string, options?: ErrorOptions) {
		super(`canonical JSON refuses ${path}: ${detail}`, options);
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

const MAX_RENDERED_PATH_KEY = 160;

function memberPath(path: string, key: string): string {
	const rendered =
		key.length <= MAX_RENDERED_PATH_KEY
			? key
			: `${key.slice(0, MAX_RENDERED_PATH_KEY)}…<truncated>`;
	// JSON bracket notation is deliberate: member keys never appear raw in a
	// diagnostic, and dots/control characters cannot impersonate path syntax.
	return `${path}[${JSON.stringify(rendered)}]`;
}

function scalar(value: unknown, path: string): string | undefined {
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
			return undefined;
	}
}

/** Reflection may invoke proxy traps; preserve the boundary's typed refusal. */
function captureReflection<T>(path: string, capture: () => T): T {
	try {
		return capture();
	} catch (error) {
		throw new CanonicalJsonError(path, 'reflection failed', { cause: error });
	}
}

type EncodeTask =
	| { readonly kind: 'value'; readonly value: unknown; readonly path: string }
	| { readonly kind: 'text'; readonly text: string }
	| {
			readonly kind: 'close';
			readonly value: object;
			readonly text: ']' | '}';
	  };

/** Iterative so every refusal, including deep graphs and cycles, uses our error contract. */
function encodeCanonicalJson(value: unknown, path: string): string {
	const output: string[] = [];
	const active = new WeakSet<object>();
	const tasks: EncodeTask[] = [{ kind: 'value', value, path }];
	while (tasks.length > 0) {
		const task = tasks.pop();
		if (!task) continue;
		if (task.kind === 'text') {
			output.push(task.text);
			continue;
		}
		if (task.kind === 'close') {
			active.delete(task.value);
			output.push(task.text);
			continue;
		}
		const encoded = scalar(task.value, task.path);
		if (encoded !== undefined) {
			output.push(encoded);
			continue;
		}
		const object = task.value as object;
		if (active.has(object))
			throw new CanonicalJsonError(
				task.path,
				'cyclic values are not JSON values',
			);
		active.add(object);
		const isArray = captureReflection(task.path, () => Array.isArray(object));
		if (isArray) {
			if (
				captureReflection(task.path, () => Object.getPrototypeOf(object)) !==
				Array.prototype
			)
				throw new CanonicalJsonError(
					task.path,
					'arrays require Array.prototype',
				);
			if (
				captureReflection(task.path, () => Object.getOwnPropertySymbols(object))
					.length > 0
			)
				throw new CanonicalJsonError(
					task.path,
					'symbol-keyed members are not JSON members',
				);
			for (const key of captureReflection(task.path, () =>
				Object.getOwnPropertyNames(object),
			)) {
				if (key === 'length') continue;
				if (!/^(?:0|[1-9][0-9]*)$/u.test(key))
					throw new CanonicalJsonError(
						task.path,
						'array non-index members are not JSON members',
					);
				if (BigInt(key) > 4294967294n)
					throw new CanonicalJsonError(
						task.path,
						'array non-index members are not JSON members',
					);
			}
			output.push('[');
			tasks.push({ kind: 'close', value: object, text: ']' });
			const length = captureReflection(
				task.path,
				() => (object as unknown[]).length,
			);
			for (let index = length - 1; index >= 0; index -= 1) {
				const itemPath = `${task.path}[${index}]`;
				const descriptor = captureReflection(itemPath, () =>
					Object.getOwnPropertyDescriptor(object, String(index)),
				);
				if (!descriptor)
					throw new CanonicalJsonError(
						itemPath,
						'array holes are not JSON values',
					);
				if (!descriptor.enumerable || !('value' in descriptor))
					throw new CanonicalJsonError(
						itemPath,
						'array members must be enumerable data properties',
					);
				if (index < length - 1) tasks.push({ kind: 'text', text: ',' });
				tasks.push({ kind: 'value', value: descriptor.value, path: itemPath });
			}
			continue;
		}
		const prototype = captureReflection(task.path, () =>
			Object.getPrototypeOf(object),
		);
		if (prototype !== Object.prototype && prototype !== null)
			throw new CanonicalJsonError(
				task.path,
				'only plain objects are JSON objects',
			);
		if (
			captureReflection(task.path, () => Object.getOwnPropertySymbols(object))
				.length > 0
		)
			throw new CanonicalJsonError(
				task.path,
				'symbol-keyed members are not JSON members',
			);
		const entries = Object.entries(
			captureReflection(task.path, () =>
				Object.getOwnPropertyDescriptors(object),
			),
		);
		for (const [key, descriptor] of entries) {
			const keyPath = memberPath(task.path, key);
			if (!descriptor.enumerable)
				throw new CanonicalJsonError(
					keyPath,
					'non-enumerable members are not JSON members',
				);
			if (!('value' in descriptor))
				throw new CanonicalJsonError(
					keyPath,
					'accessor members are not JSON values',
				);
			if (descriptor.value === undefined)
				throw new CanonicalJsonError(keyPath, 'undefined is not a JSON value');
		}
		entries.sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		output.push('{');
		tasks.push({ kind: 'close', value: object, text: '}' });
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (!entry) continue;
			const [key, descriptor] = entry;
			if (index < entries.length - 1) tasks.push({ kind: 'text', text: ',' });
			tasks.push({
				kind: 'value',
				value: descriptor.value,
				path: memberPath(task.path, key),
			});
			tasks.push({ kind: 'text', text: `${JSON.stringify(key)}:` });
		}
	}
	return output.join('');
}
