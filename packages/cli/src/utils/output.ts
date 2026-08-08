/** Shared CLI JSON boundary. Keep every machine-readable document here. */
export function serializeCliJson(value: unknown): string {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined)
		throw new Error('CLI JSON output must be a JSON-serializable document');
	return serialized;
}

export function printCliJson(value: unknown): void {
	console.log(serializeCliJson(value));
}
