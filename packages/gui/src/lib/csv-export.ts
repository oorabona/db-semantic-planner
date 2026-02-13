/**
 * CSV export utility for query results.
 * RFC 4180 compliant: quotes fields containing commas, quotes, or newlines.
 */

function escapeField(value: unknown): string {
	if (value == null) return '';
	const str = String(value);
	if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

export function toCsv(
	columns: readonly string[],
	rows: ReadonlyArray<Record<string, unknown>>,
): string {
	const header = columns.map(escapeField).join(',');
	const body = rows.map((row) => columns.map((col) => escapeField(row[col])).join(','));
	return [header, ...body].join('\n');
}

export function downloadCsv(csv: string, filename: string): void {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}
