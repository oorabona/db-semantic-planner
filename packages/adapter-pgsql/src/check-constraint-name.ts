import type { CheckConstraintIR } from '@dbsp/types';

export class CheckConstraintNameCollisionError extends Error {
	constructor(
		public readonly table: string,
		public readonly firstAuthoredName: string,
		public readonly secondAuthoredName: string,
		public readonly databaseName: string,
	) {
		super(
			`CHECK constraint name collision on table "${table}": authored constraints ` +
				`"${firstAuthoredName}" and "${secondAuthoredName}" both resolve to ` +
				`physical name "${databaseName}". Rename one of the constraints.`,
		);
		this.name = 'CheckConstraintNameCollisionError';
	}
}

export function getCheckConstraintDatabaseName(
	check: Pick<CheckConstraintIR, 'name'>,
): string {
	return check.name;
}

export function assertNoCheckConstraintNameCollisions(table: {
	readonly name: string;
	readonly checkConstraints?: readonly Pick<CheckConstraintIR, 'name'>[];
}): void {
	const seen = new Map<string, string>();
	for (const check of table.checkConstraints ?? []) {
		const databaseName = getCheckConstraintDatabaseName(check);
		const previous = seen.get(databaseName);
		if (previous !== undefined) {
			throw new CheckConstraintNameCollisionError(
				table.name,
				previous,
				check.name,
				databaseName,
			);
		}
		seen.set(databaseName, check.name);
	}
}
