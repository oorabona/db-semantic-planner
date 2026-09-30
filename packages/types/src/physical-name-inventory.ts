/** A dialect-neutral address of one declared or derived database name.
 *
 * `name` is always in the model's logical spelling. For derived objects it is
 * the template result from logical parts (for example `pk_<table>`), rather
 * than a database spelling.
 */
export type LogicalNameAddress =
	| {
			readonly kind: 'table' | 'enum' | 'sequence';
			readonly schema: string;
			readonly name: string;
	  }
	| {
			readonly kind: 'column' | 'index' | 'constraint' | 'policy';
			readonly schema: string;
			readonly table: string;
			readonly name: string;
	  };

export interface PhysicalNameEntry {
	readonly logical: LogicalNameAddress;
	readonly physical: string;
	/** Sequence entries distinguish authored declarations from serial/identity predictions. */
	readonly sequenceProvenance?: 'declared' | 'generated';
}

export class PhysicalNameInventoryDuplicateError extends Error {
	constructor(
		public readonly scope: 'logical-address' | 'table' | 'column',
		public readonly first: PhysicalNameEntry,
		public readonly second: PhysicalNameEntry,
	) {
		super(
			`Duplicate physical-name inventory ${scope}: ` +
				`"${first.physical}" is claimed by ${addressText(first.logical)} and ${addressText(second.logical)}.`,
		);
		this.name = 'PhysicalNameInventoryDuplicateError';
	}
}

export interface PhysicalNameInventory {
	readonly entries: readonly PhysicalNameEntry[];
	has(address: LogicalNameAddress): boolean;
	get(address: LogicalNameAddress): string;
}

/** Creates an immutable, canonical logical-address-to-physical-name inventory. */
export function createPhysicalNameInventory(
	entries: readonly PhysicalNameEntry[],
): PhysicalNameInventory {
	const byAddress = new Map<string, PhysicalNameEntry>();
	const tables = new Map<string, PhysicalNameEntry>();
	const columns = new Map<string, PhysicalNameEntry>();
	const copied = entries.map((entry) =>
		Object.freeze({
			logical: Object.freeze({ ...entry.logical }) as LogicalNameAddress,
			physical: entry.physical,
			...(entry.sequenceProvenance === undefined
				? {}
				: { sequenceProvenance: entry.sequenceProvenance }),
		}),
	);
	const physicalTables = new Map<string, string>();
	for (const entry of copied) {
		if (entry.logical.kind === 'table')
			physicalTables.set(
				`${entry.logical.schema}\u0000${entry.logical.name}`,
				entry.physical,
			);
	}

	for (const entry of copied) {
		const key = addressKey(entry.logical);
		const firstAddress = byAddress.get(key);
		if (firstAddress)
			throw new PhysicalNameInventoryDuplicateError(
				'logical-address',
				firstAddress,
				entry,
			);
		byAddress.set(key, entry);

		if (entry.logical.kind === 'table') {
			const tableKey = `${entry.logical.schema}\u0000${entry.physical}`;
			const firstTable = tables.get(tableKey);
			if (firstTable)
				throw new PhysicalNameInventoryDuplicateError(
					'table',
					firstTable,
					entry,
				);
			tables.set(tableKey, entry);
		}
		if (entry.logical.kind === 'column') {
			const physicalTable =
				physicalTables.get(
					`${entry.logical.schema}\u0000${entry.logical.table}`,
				) ?? entry.logical.table;
			const columnKey = `${entry.logical.schema}\u0000${physicalTable}\u0000${entry.physical}`;
			const firstColumn = columns.get(columnKey);
			if (firstColumn)
				throw new PhysicalNameInventoryDuplicateError(
					'column',
					firstColumn,
					entry,
				);
			columns.set(columnKey, entry);
		}
	}

	const sorted = Object.freeze(
		[...copied].sort((left, right) =>
			addressKey(left.logical) < addressKey(right.logical)
				? -1
				: addressKey(left.logical) > addressKey(right.logical)
					? 1
					: 0,
		),
	);
	return Object.freeze({
		entries: sorted,
		has(address: LogicalNameAddress): boolean {
			return byAddress.has(addressKey(address));
		},
		get(address: LogicalNameAddress): string {
			const entry = byAddress.get(addressKey(address));
			if (!entry) throw new PhysicalNameInventoryMissingError(address);
			return entry.physical;
		},
	});
}

export class PhysicalNameInventoryMissingError extends Error {
	constructor(public readonly address: LogicalNameAddress) {
		super(`Physical name inventory has no entry for ${addressText(address)}.`);
		this.name = 'PhysicalNameInventoryMissingError';
	}
}

function addressKey(address: LogicalNameAddress): string {
	return 'table' in address
		? `${address.kind}\u0000${address.schema}\u0000${address.table}\u0000${address.name}`
		: `${address.kind}\u0000${address.schema}\u0000${address.name}`;
}

function addressText(address: LogicalNameAddress): string {
	return 'table' in address
		? `${address.kind} ${address.schema}.${address.table}.${address.name}`
		: `${address.kind} ${address.schema}.${address.name}`;
}
