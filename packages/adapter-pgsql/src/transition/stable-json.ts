function stableNumber(value: number): string {
	if (Number.isNaN(value)) {
		return 'number:NaN';
	}
	if (Object.is(value, -0)) {
		return 'number:-0';
	}
	if (value === Number.POSITIVE_INFINITY) {
		return 'number:Infinity';
	}
	if (value === Number.NEGATIVE_INFINITY) {
		return 'number:-Infinity';
	}
	return `number:${value}`;
}

function objectTag(value: object): string {
	return Object.prototype.toString.call(value);
}

function stableJsonInner(value: unknown, seen: WeakSet<object>): string {
	if (value === null) {
		return 'null';
	}
	switch (typeof value) {
		case 'undefined':
			return 'undefined';
		case 'boolean':
			return `boolean:${value ? 'true' : 'false'}`;
		case 'number':
			return stableNumber(value);
		case 'bigint':
			return `bigint:${value.toString()}`;
		case 'string':
			return `string:${JSON.stringify(value)}`;
		case 'symbol':
			return `symbol:${JSON.stringify(String(value.description ?? ''))}`;
		case 'function':
			return `function:${JSON.stringify(value.name)}`;
		case 'object':
			break;
	}

	if (seen.has(value)) {
		throw new TypeError('stableJson cannot serialize cyclic structures');
	}
	seen.add(value);
	try {
		if (value instanceof Date) {
			const time = value.getTime();
			return Number.isNaN(time) ? 'date:Invalid' : `date:${time}`;
		}
		if (value instanceof RegExp) {
			return `regexp:${JSON.stringify(value.source)}/${value.flags}`;
		}
		if (value instanceof Map) {
			const entries = [...value.entries()]
				.map(
					([key, item]) =>
						`[${stableJsonInner(key, seen)},${stableJsonInner(item, seen)}]`,
				)
				.sort();
			return `map:[${entries.join(',')}]`;
		}
		if (value instanceof Set) {
			const entries = [...value.values()]
				.map((item) => stableJsonInner(item, seen))
				.sort();
			return `set:[${entries.join(',')}]`;
		}
		if (Array.isArray(value)) {
			const entries: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				entries.push(
					Object.hasOwn(value, index)
						? stableJsonInner(value[index], seen)
						: 'array-hole',
				);
			}
			return `array:[${entries.join(',')}]`;
		}
		const tag = objectTag(value);
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${stableJsonInner(item, seen)}`,
			);
		return `${tag}:{${entries.join(',')}}`;
	} finally {
		seen.delete(value);
	}
}

export function stableJson(value: unknown): string {
	return stableJsonInner(value, new WeakSet());
}
