import type { IndexIR } from '@dbsp/types';
import { stableJson } from './stable-json.js';

export type IndexSetEntry = {
	readonly name: string;
	readonly columns: readonly string[];
	readonly unique?: boolean;
	readonly valid?: boolean;
	readonly ready?: boolean;
	readonly method?: string;
	readonly where?: string;
	readonly expressions?: readonly string[];
	readonly include?: readonly string[];
	readonly opclass?: Readonly<Record<string, string>>;
	readonly with?: Readonly<Record<string, string>>;
	readonly nullsNotDistinct?: boolean;
};

export type IndexDelta =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'add-unique-index';
			readonly index: IndexSetEntry;
			readonly expectedBefore: readonly IndexSetEntry[];
			readonly expectedAfter: readonly IndexSetEntry[];
	  }
	| { readonly kind: 'unsupported' };

export function defaultIndexName(
	tableName: string,
	index: Pick<IndexIR, 'name' | 'columns'>,
): string {
	return index.name ?? `idx_${tableName}_${index.columns.join('_')}`;
}

function nonEmptyArray<T>(
	value: readonly T[] | undefined,
): value is readonly T[] {
	return value !== undefined && value.length > 0;
}

function nonEmptyRecord(
	value: Readonly<Record<string, string>> | undefined,
): value is Readonly<Record<string, string>> {
	return value !== undefined && Object.keys(value).length > 0;
}

function normalizedMethod(index: IndexIR): string | undefined {
	return index.method && index.method !== 'btree' ? index.method : undefined;
}

type IndexPerspective = 'desired' | 'current';

function normalizedCatalogFlag(
	value: boolean | undefined,
	perspective: IndexPerspective,
): boolean | undefined {
	if (perspective === 'desired') {
		return value === false ? false : undefined;
	}
	return value === true ? undefined : false;
}

export function normalizedIndex(
	tableName: string,
	index: IndexIR,
	perspective: IndexPerspective = 'desired',
): IndexSetEntry {
	const method = normalizedMethod(index);
	return {
		name: defaultIndexName(tableName, index),
		columns: [...index.columns],
		...(index.unique ? { unique: true } : {}),
		...(normalizedCatalogFlag(index.valid, perspective) === false
			? { valid: false }
			: {}),
		...(normalizedCatalogFlag(index.ready, perspective) === false
			? { ready: false }
			: {}),
		...(method ? { method } : {}),
		...(index.where ? { where: index.where } : {}),
		...(nonEmptyArray(index.expressions)
			? { expressions: [...index.expressions] }
			: {}),
		...(nonEmptyArray(index.include) ? { include: [...index.include] } : {}),
		...(nonEmptyRecord(index.opclass) ? { opclass: index.opclass } : {}),
		...(nonEmptyRecord(index.with) ? { with: index.with } : {}),
		...(index.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
	};
}

function byName(left: IndexSetEntry, right: IndexSetEntry): number {
	return left.name.localeCompare(right.name);
}

function sortedIndexes(
	tableName: string,
	indexes: readonly IndexIR[],
	perspective: IndexPerspective,
): readonly IndexSetEntry[] {
	return [...indexes]
		.map((index) => normalizedIndex(tableName, index, perspective))
		.sort(byName);
}

function hasDuplicateNames(indexes: readonly IndexSetEntry[]): boolean {
	return new Set(indexes.map((index) => index.name)).size !== indexes.length;
}

function indexKeySet(indexes: readonly IndexSetEntry[]): ReadonlySet<string> {
	return new Set(indexes.map((index) => index.name));
}

function hasOnlyPlainColumns(index: IndexSetEntry): boolean {
	return (
		index.columns.length > 0 &&
		index.columns.every(
			(column) => typeof column === 'string' && column.length > 0,
		)
	);
}

function hasUnsupportedShape(index: IndexSetEntry): boolean {
	return (
		index.unique !== true ||
		index.valid === false ||
		index.ready === false ||
		index.method !== undefined ||
		index.where !== undefined ||
		nonEmptyArray(index.expressions) ||
		nonEmptyArray(index.include) ||
		nonEmptyRecord(index.opclass) ||
		nonEmptyRecord(index.with) ||
		index.nullsNotDistinct === true ||
		!hasOnlyPlainColumns(index)
	);
}

function structurallyEquivalentUniqueIndex(
	left: IndexSetEntry,
	right: IndexSetEntry,
): boolean {
	if (hasUnsupportedShape(left) || hasUnsupportedShape(right)) {
		return false;
	}
	return stableJson(left.columns) === stableJson(right.columns);
}

function existingValidEquivalent(
	added: IndexSetEntry,
	current: readonly IndexSetEntry[],
): boolean {
	return current.some(
		(candidate) =>
			candidate.name !== added.name &&
			candidate.valid !== false &&
			candidate.ready !== false &&
			structurallyEquivalentUniqueIndex(candidate, added),
	);
}

// Shared by the core comparator and adapter PostgreSQL CIC rule. This is the
// intentionally narrow first slice: exactly one plain UNIQUE btree index add.
export function indexDelta(
	tableName: string,
	desiredIndexes: readonly IndexIR[],
	currentIndexes: readonly IndexIR[],
): IndexDelta {
	const desired = sortedIndexes(tableName, desiredIndexes, 'desired');
	const current = sortedIndexes(tableName, currentIndexes, 'current');
	if (stableJson(desired) === stableJson(current)) {
		return { kind: 'none' };
	}
	if (hasDuplicateNames(desired) || hasDuplicateNames(current)) {
		return { kind: 'unsupported' };
	}

	const desiredNames = indexKeySet(desired);
	const currentNames = indexKeySet(current);
	const added = desired.filter((index) => !currentNames.has(index.name));
	const removed = current.filter((index) => !desiredNames.has(index.name));
	if (removed.length > 0 || added.length !== 1) {
		return { kind: 'unsupported' };
	}

	const mismatches = desired.filter((desiredIndex) => {
		const currentIndex = current.find(
			(candidate) => candidate.name === desiredIndex.name,
		);
		return (
			currentIndex && stableJson(currentIndex) !== stableJson(desiredIndex)
		);
	});
	if (mismatches.length > 0) {
		return { kind: 'unsupported' };
	}

	const index = added[0];
	if (
		!index ||
		hasUnsupportedShape(index) ||
		existingValidEquivalent(index, current)
	) {
		return { kind: 'unsupported' };
	}
	return {
		kind: 'add-unique-index',
		index,
		expectedBefore: current,
		expectedAfter: desired,
	};
}
