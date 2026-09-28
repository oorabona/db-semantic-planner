import type { SequenceIR } from '@dbsp/types';
import type { NamingPlugin } from './naming-plugin.js';

export class SequenceNameMapKeyMismatchError extends Error {
	constructor(
		public readonly mapKey: string,
		public readonly sequenceName: string,
	) {
		super(
			`Declared sequence map key "${mapKey}" differs from SequenceIR.name ` +
				`"${sequenceName}". Use the same authored name for both.`,
		);
		this.name = 'SequenceNameMapKeyMismatchError';
	}
}

export class SequenceNameCollisionError extends Error {
	constructor(
		public readonly firstAuthoredName: string,
		public readonly secondAuthoredName: string,
		public readonly databaseName: string,
	) {
		super(
			`Sequence name collision: authored sequences "${firstAuthoredName}" and ` +
				`"${secondAuthoredName}" both resolve to physical name ` +
				`"${databaseName}". Rename one of the sequences.`,
		);
		this.name = 'SequenceNameCollisionError';
	}
}

export class LegacySequenceNameError extends Error {
	constructor(
		public readonly authoredName: string,
		public readonly databaseName: string,
	) {
		super(
			`Declared sequence "${authoredName}" resolves to physical name ` +
				`"${databaseName}", but only the legacy raw sequence exists. ` +
				`Rename it before comparing: ALTER SEQUENCE "${authoredName}" ` +
				`RENAME TO "${databaseName}".`,
		);
		this.name = 'LegacySequenceNameError';
	}
}

/** Returns the physical PostgreSQL name for one authored sequence declaration. */
export function getSequenceDatabaseName(
	sequence: Pick<SequenceIR, 'name'>,
	naming: NamingPlugin,
): string {
	return naming.toDatabase(sequence.name);
}

/**
 * Converts authored sequence declarations to one physical-name map.
 *
 * The returned map must be treated as physical: do not send it through a
 * NamingPlugin again, because custom plugins need not be idempotent.
 */
export function physicalizeDeclaredSequences(
	sequences: ReadonlyMap<string, SequenceIR> | undefined,
	naming: NamingPlugin,
): Map<string, SequenceIR> {
	const physicalSequences = new Map<string, SequenceIR>();
	const authoredNames = new Map<string, string>();
	for (const [key, sequence] of sequences ?? []) {
		if (key !== sequence.name)
			throw new SequenceNameMapKeyMismatchError(key, sequence.name);
		const databaseName = getSequenceDatabaseName(sequence, naming);
		const firstAuthoredName = authoredNames.get(databaseName);
		if (firstAuthoredName !== undefined)
			throw new SequenceNameCollisionError(
				firstAuthoredName,
				sequence.name,
				databaseName,
			);
		authoredNames.set(databaseName, sequence.name);
		physicalSequences.set(databaseName, { ...sequence, name: databaseName });
	}
	return physicalSequences;
}
