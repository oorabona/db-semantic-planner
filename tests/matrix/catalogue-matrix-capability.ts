/**
 * A version capability probe either concludes from one boolean row or fails.
 * Malformed catalogue reads are not evidence that an older server lacks it.
 */
export function requireCatalogueColumnCapability(
	rows: readonly unknown[],
): boolean {
	if (rows.length !== 1)
		throw new Error(
			`invalid catalogue capability read: expected exactly one row with boolean exists, received ${rows.length} rows`,
		);
	const row = rows[0];
	if (
		typeof row !== 'object' ||
		row === null ||
		typeof (row as { exists?: unknown }).exists !== 'boolean'
	)
		throw new Error(
			'invalid catalogue capability read: expected exactly one row with boolean exists',
		);
	return (row as { exists: boolean }).exists;
}
