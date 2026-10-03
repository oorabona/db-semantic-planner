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
	for (const column of shape.columns)
		if (Object.hasOwn(value, column.publicKey))
			setValue(
				value,
				column.publicKey,
				readColumn(value[column.publicKey], column),
			);
	for (const child of shape.children)
		if (Object.hasOwn(value, child.publicKey))
			setValue(
				value,
				child.publicKey,
				readPayload(value[child.publicKey], child),
			);
	return value;
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
	): unknown => {
		const value: Record<string, unknown> = {};
		let present = false;
		for (const column of shape.columns) {
			const raw = row[column.outputLabel];
			if (raw !== null && raw !== undefined) present = true;
			setValue(value, column.publicKey, readColumn(raw, column));
			delete row[column.outputLabel];
		}
		for (const child of shape.children) {
			const childValue = assembleFlat(row, child);
			setValue(value, child.publicKey, childValue);
			if (shape.columns.length === 0 && childValue !== null) present = true;
		}
		return present ? value : null;
	};
	for (const row of rows) {
		if (!record(row)) continue;
		for (const shape of shapes) {
			if (strategy === 'json_agg' && shape.strategy === 'json_agg') {
				if (!Object.hasOwn(row, shape.outputLabel)) continue;
				setValue(
					row,
					shape.publicKey,
					readPayload(row[shape.outputLabel], shape),
				);
				delete row[shape.outputLabel];
			} else if (
				strategy === 'flat' &&
				shape.strategy !== 'json_agg' &&
				(shape.columns.length > 0 || shape.children.length > 0)
			)
				setValue(row, shape.publicKey, assembleFlat(row, shape));
		}
	}
}
