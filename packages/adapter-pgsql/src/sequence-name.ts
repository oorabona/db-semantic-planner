import type { PhysicalNameInventory, SequenceIR } from '@dbsp/types';
import { quoteIdent } from './ddl/phases/utils.js';
import type { NamingPlugin } from './naming-plugin.js';
import { escapeDiagnosticText } from './validate.js';

export class SequenceNameMapKeyMismatchError extends Error {
	constructor(
		public readonly mapKey: string,
		public readonly sequenceName: string,
	) {
		super(
			`Declared sequence map key "${escapeDiagnosticText(mapKey)}" differs from SequenceIR.name ` +
				`"${escapeDiagnosticText(sequenceName)}". Use the same authored name for both.`,
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
			`Sequence name collision: authored sequences "${escapeDiagnosticText(firstAuthoredName)}" and ` +
				`"${escapeDiagnosticText(secondAuthoredName)}" both resolve to physical name ` +
				`"${escapeDiagnosticText(databaseName)}". Rename one of the sequences.`,
		);
		this.name = 'SequenceNameCollisionError';
	}
}

export class LegacySequenceNameError extends Error {
	constructor(
		public readonly authoredName: string,
		public readonly databaseName: string,
		public readonly schema?: string,
	) {
		const remediation = legacySequenceNameRemediation(
			authoredName,
			databaseName,
			schema,
		);
		super(
			`Declared sequence "${escapeDiagnosticText(authoredName)}" resolves to physical name ` +
				`"${escapeDiagnosticText(databaseName)}", but only the legacy raw sequence exists. ` +
				`${remediation}.`,
		);
		this.name = 'LegacySequenceNameError';
	}
}

function legacySequenceNameRemediation(
	authoredName: string,
	databaseName: string,
	schema: string | undefined,
): string {
	const wordOnly =
		`Rename "${escapeDiagnosticText(authoredName)}" to ` +
		`"${escapeDiagnosticText(databaseName)}" before comparing`;
	if (schema === undefined) return wordOnly;
	try {
		return `Rename it before comparing: ALTER SEQUENCE ${quoteIdent(schema, 'schema')}.${quoteIdent(authoredName)} RENAME TO ${quoteIdent(databaseName)}`;
	} catch {
		return wordOnly;
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
 * Retains authored standalone-sequence names after a model has been made
 * physical. The inventory is the physical model's authority for that
 * provenance; its ModelIR deliberately contains physical names only.
 */
export function declaredSequenceNamesFromInventory(
	inventory: PhysicalNameInventory,
): ReadonlyMap<string, string> {
	return new Map(
		inventory.entries.flatMap((entry) =>
			entry.logical.kind === 'sequence'
				? ([[entry.physical, entry.logical.name]] as const)
				: [],
		),
	);
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
