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

function readPayload(value: unknown, shape: IncludePayloadShape): unknown {
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return shape.isToOne ? null : [];
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
			if (strategy === 'json_agg' && shape.strategy === 'json_agg') {
				if (!Object.hasOwn(row, shape.outputLabel)) continue;
				assignments.set(
					shape.publicKey,
					readPayload(row[shape.outputLabel], shape),
				);
				deletions.add(shape.outputLabel);
			} else if (
				strategy === 'flat' &&
				shape.strategy !== 'json_agg' &&
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
