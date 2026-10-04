import {
	convertBigintJsReadValue,
	type IncludePayloadShape,
} from '@dbsp/types';

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readColumn(
	value: unknown,
	column: IncludePayloadShape['columns'][number],
): unknown {
	const handling = column.readHandling;
	return handling
		? convertBigintJsReadValue(value, handling.js, {
				table: handling.table,
				column: handling.column,
				outputKey: column.publicKey,
			})
		: value;
}

function setValue(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

export class InvalidJsonAggPayloadError extends Error {
	constructor(path: string, cause: unknown) {
		super(`Invalid JSON in json_agg payload '${path}'.`, { cause });
		this.name = 'InvalidJsonAggPayloadError';
	}
}

function readPayload(value: unknown, shape: IncludePayloadShape): unknown {
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch (cause) {
			throw new InvalidJsonAggPayloadError(shape.path, cause);
		}
	}
	if (value === null || value === undefined) return shape.isToOne ? null : [];
	if (Array.isArray(value)) {
		const items = value.map((item) => readPayload(item, shape));
		return shape.isToOne ? (items[0] ?? null) : items;
	}
	if (!record(value)) return value;
	const converted = { ...value };
	for (const column of shape.columns)
		if (Object.hasOwn(value, column.publicKey))
			setValue(
				converted,
				column.publicKey,
				readColumn(value[column.publicKey], column),
			);
	for (const child of shape.children)
		if (Object.hasOwn(value, child.publicKey))
			setValue(
				converted,
				child.publicKey,
				readPayload(value[child.publicKey], child),
			);
	return converted;
}

function readRecursivePayload(
	raw: unknown,
	shape: IncludePayloadShape,
): unknown {
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch (cause) {
			throw new InvalidJsonAggPayloadError(shape.path, cause);
		}
	}
	if (!Array.isArray(raw) || raw.some((item) => !record(item)))
		throw new Error(
			`Invalid recursive include payload '${shape.path}': expected an array of objects.`,
		);
	const options = shape.recursive!;
	const fields = shape.privateFields!;
	const key = (role: 'node' | 'parent' | 'depth') =>
		fields.find((field) => field.role === role)!.jsonKey;
	const nodes = raw.map((item) => {
		const value = readPayload(item, { ...shape, isToOne: false }) as Record<
			string,
			unknown
		>;
		for (const field of fields) {
			if (!Object.hasOwn(item, field.jsonKey))
				throw new Error(
					`Invalid recursive include payload '${shape.path}': missing '${field.jsonKey}'.`,
				);
			setValue(
				value,
				field.jsonKey,
				readColumn(item[field.jsonKey], {
					publicKey: field.jsonKey,
					readHandling: field.readHandling,
				} as IncludePayloadShape['columns'][number]),
			);
		}
		const depth = value[key('depth')];
		if (!Number.isSafeInteger(depth) || (depth as number) < 0)
			throw new Error(
				`Invalid recursive include payload '${shape.path}': invalid depth.`,
			);
		return {
			value,
			node: value[key('node')],
			parent: value[key('parent')],
			depth: depth as number,
		};
	});
	for (const node of nodes) {
		for (const field of fields) delete node.value[field.jsonKey];
		if (options.includeDepth || options.flat)
			setValue(node.value, 'depth', node.depth);
	}
	if (options.flat) return nodes.map((node) => node.value);
	if (options.direction === 'ancestors') {
		let chain: Record<string, unknown> | null = null;
		for (let i = nodes.length - 1; i >= 0; i--) {
			setValue(nodes[i]!.value, shape.publicKey, chain);
			chain = nodes[i]!.value;
		}
		return chain;
	}
	const byKey = new Map(
		nodes
			.filter((node) => node.node !== null && node.node !== undefined)
			.map((node) => [node.node, node]),
	);
	const roots: Record<string, unknown>[] = [];
	for (const node of nodes) setValue(node.value, shape.publicKey, []);
	for (const node of nodes) {
		const parent = byKey.get(node.parent);
		if (parent && parent.depth < node.depth)
			(parent.value[shape.publicKey] as unknown[]).push(node.value);
		else roots.push(node.value);
	}
	return roots;
}

/** SQL has already chosen keys. Hydration reads exact owned labels only. */
export function hydrateResolvedIncludes(
	rows: readonly unknown[],
	shapes: readonly IncludePayloadShape[],
	strategy: 'json_agg' | 'flat',
): void {
	const assembleFlat = (
		row: Record<string, unknown>,
		shape: IncludePayloadShape,
		deletions: Set<string>,
	): unknown => {
		const value: Record<string, unknown> = {};
		let present = false;
		let owned = false;
		for (const column of shape.columns) {
			if (!Object.hasOwn(row, column.outputLabel)) continue;
			owned = true;
			const raw = row[column.outputLabel];
			if (raw !== null && raw !== undefined) present = true;
			setValue(value, column.publicKey, readColumn(raw, column));
			deletions.add(column.outputLabel);
		}
		for (const child of shape.children) {
			const childValue = assembleFlat(row, child, deletions);
			if (childValue === undefined) continue;
			owned = true;
			setValue(value, child.publicKey, childValue);
			if (shape.columns.length === 0 && childValue !== null) present = true;
		}
		if (shape.presence) {
			const label = shape.presence.outputLabel;
			if (!Object.hasOwn(row, label))
				throw new Error(
					`Missing include presence marker '${label}' for '${shape.path}'.`,
				);
			deletions.add(label);
			return row[label] === null ? null : value;
		}
		return owned ? (present ? value : null) : undefined;
	};
	for (const row of rows) {
		if (!record(row)) continue;
		const assignments = new Map<string, unknown>();
		const deletions = new Set<string>();
		for (const shape of shapes) {
			if (shape.outputMode === 'flat') continue;
			if (
				strategy === 'json_agg' &&
				(shape.strategy === 'json_agg' || shape.recursive)
			) {
				if (!Object.hasOwn(row, shape.outputLabel)) continue;
				assignments.set(
					shape.publicKey,
					shape.recursive
						? readRecursivePayload(row[shape.outputLabel], shape)
						: readPayload(row[shape.outputLabel], shape),
				);
				deletions.add(shape.outputLabel);
			} else if (
				strategy === 'flat' &&
				(shape.strategy === 'join' || shape.strategy === 'lateral') &&
				(shape.presence !== undefined ||
					shape.columns.length > 0 ||
					shape.children.length > 0)
			) {
				const value = assembleFlat(row, shape, deletions);
				if (value !== undefined) assignments.set(shape.publicKey, value);
			}
		}
		for (const key of deletions) delete row[key];
		for (const [key, value] of assignments) setValue(row, key, value);
	}
}
