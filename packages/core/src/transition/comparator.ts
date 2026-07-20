import type {
	CheckConstraintIR,
	ColumnIR,
	Comparator,
	CompareOutcome,
	EnumIR,
	EquivalenceContext,
	ForeignKeyIR,
	IndexIR,
	LogicalIdentity,
	ModelIR,
	ObservationRequest,
	ProofObligation,
	Proposition,
	RecognitionResult,
	RelationIR,
	ResourceAddress,
	RuleRef,
	SemanticArtifactRef,
	SequenceIR,
	TableIR,
	TransitionCandidate,
	TransitionRule,
	UnknownTransitionRecognition,
} from '@dbsp/types';
import { checkDelta } from './check-delta.js';
import { enumAddDelta } from './enum-delta.js';
import { semanticArtifactId } from './ids.js';
import {
	defaultIndexName,
	indexDelta,
	normalizedIndex,
} from './index-delta.js';
import type { PackRegistry } from './registry.js';
import { stableJson } from './stable-json.js';

const COMPARATOR_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.core.transition.comparator'),
	version: '0.1.0',
};

const TRANSITION_COMPARE_CURRENT_MODEL = Symbol.for(
	'dbsp.core.transition.compare.current-model',
);

type CompareOutcomeWithCurrentModel = CompareOutcome & {
	readonly [TRANSITION_COMPARE_CURRENT_MODEL]?: ModelIR;
};

export function transitionCompareCurrentModel(
	compare: CompareOutcome,
): ModelIR | undefined {
	return (compare as CompareOutcomeWithCurrentModel)[
		TRANSITION_COMPARE_CURRENT_MODEL
	];
}

export function withTransitionCompareCurrentModel<T extends CompareOutcome>(
	compare: T,
	current: ModelIR,
): T {
	Object.defineProperty(compare, TRANSITION_COMPARE_CURRENT_MODEL, {
		value: current,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return compare;
}

function columnChanged(
	desired: ColumnIR | undefined,
	current: ColumnIR | undefined,
): boolean {
	if (!desired || !current) {
		return true;
	}
	return (
		stableJson(columnForComparison(desired, desired)) !==
		stableJson(columnForComparison(current, desired))
	);
}

type ColumnFieldName = string;

type NormalizeIdentifier = (identifier: string) => string;

type NormalizationConflict =
	| { readonly kind: 'table'; readonly table: string }
	| {
			readonly kind: 'column';
			readonly table: string;
			readonly column: string;
	  }
	| {
			readonly kind: 'check';
			readonly table: string;
			readonly check: string;
	  }
	| {
			readonly kind: 'relation';
			readonly source: string;
			readonly relation: string;
	  }
	| { readonly kind: 'enum'; readonly enum: string }
	| { readonly kind: 'sequence'; readonly sequence: string };

type ManagedCollectionPolicy =
	| { readonly managed: false }
	| {
			readonly managed: true;
			/**
			 * Undefined keys means an explicit empty desired collection: manage the
			 * whole current collection and assert it is empty.
			 */
			readonly keys?: ReadonlySet<string>;
	  };

type ManagedModelCollections = {
	readonly extensions: ManagedCollectionPolicy;
	readonly sequences: ManagedCollectionPolicy;
	readonly enums: ManagedCollectionPolicy;
	readonly relations: ManagedCollectionPolicy;
};

type ModelLevelCollectionsComparison = {
	readonly relations: unknown;
	readonly enums: unknown;
	readonly extensions: readonly string[];
	readonly sequences: unknown;
};

function normalizeColumnList(
	columns: readonly string[],
	normalize: NormalizeIdentifier,
): readonly string[] {
	return columns.map((column) => normalize(column));
}

function normalizeColumnRef(
	ref: string | readonly string[] | undefined,
	normalize: NormalizeIdentifier,
): string | readonly string[] | undefined {
	if (Array.isArray(ref)) {
		return normalizeColumnList(ref, normalize);
	}
	return typeof ref === 'string' ? normalize(ref) : ref;
}

function normalizeDefinedColumnRef(
	ref: string | readonly string[],
	normalize: NormalizeIdentifier,
): string | readonly string[] {
	return typeof ref === 'string'
		? normalize(ref)
		: normalizeColumnList(ref, normalize);
}

function normalizeForeignKey(
	foreignKey: ForeignKeyIR,
	normalize: NormalizeIdentifier,
): ForeignKeyIR {
	return {
		...foreignKey,
		columns: normalizeColumnList(foreignKey.columns, normalize),
		references: {
			...foreignKey.references,
			table: normalize(foreignKey.references.table),
			columns: normalizeColumnList(foreignKey.references.columns, normalize),
		},
	};
}

function normalizeIndex(
	index: IndexIR,
	normalize: NormalizeIdentifier,
): IndexIR {
	return {
		...index,
		columns: normalizeColumnList(index.columns, normalize),
		...(index.include
			? { include: normalizeColumnList(index.include, normalize) }
			: {}),
		...(index.opclass
			? {
					opclass: Object.fromEntries(
						Object.entries(index.opclass).map(([column, value]) => [
							normalize(column),
							value,
						]),
					),
				}
			: {}),
	};
}

function normalizeRelation(
	relation: RelationIR,
	normalize: NormalizeIdentifier,
): RelationIR {
	const { foreignKey, otherKey, sourceKey, targetKey, through, ...rest } =
		relation;
	return {
		...rest,
		name: normalize(relation.name),
		source: normalize(relation.source),
		target: normalize(relation.target),
		...(through !== undefined
			? { through: typeof through === 'string' ? normalize(through) : through }
			: {}),
		...(foreignKey !== undefined
			? { foreignKey: normalizeColumnRef(foreignKey, normalize) }
			: {}),
		...(otherKey !== undefined
			? {
					otherKey:
						typeof otherKey === 'string' ? normalize(otherKey) : otherKey,
				}
			: {}),
		...(sourceKey !== undefined
			? { sourceKey: normalizeColumnRef(sourceKey, normalize) }
			: {}),
		...(targetKey !== undefined
			? { targetKey: normalizeColumnRef(targetKey, normalize) }
			: {}),
	};
}

function normalizeTable(
	table: TableIR,
	normalize: NormalizeIdentifier,
): {
	readonly table: TableIR;
	readonly conflicts: readonly NormalizationConflict[];
} {
	const tableName = normalize(table.name);
	const conflicts: NormalizationConflict[] = [];
	const seenColumns = new Set<string>();
	const columns = table.columns.map((column) => {
		const name = normalize(column.name);
		if (seenColumns.has(name)) {
			conflicts.push({ kind: 'column', table: tableName, column: name });
		}
		seenColumns.add(name);
		return { ...column, name };
	});
	const seenChecks = new Set<string>();
	const checkConstraints = table.checkConstraints?.map((check) => {
		const name = normalize(check.name);
		if (seenChecks.has(name)) {
			conflicts.push({ kind: 'check', table: tableName, check: name });
		}
		seenChecks.add(name);
		return { ...check, name };
	});
	return {
		table: {
			...table,
			name: tableName,
			columns,
			...(checkConstraints !== undefined ? { checkConstraints } : {}),
			...(table.primaryKey !== undefined
				? { primaryKey: normalizeDefinedColumnRef(table.primaryKey, normalize) }
				: {}),
			foreignKeys: table.foreignKeys.map((foreignKey) =>
				normalizeForeignKey(foreignKey, normalize),
			),
			indexes: table.indexes.map((index) => normalizeIndex(index, normalize)),
			...(table.pseudoColumns
				? {
						pseudoColumns: table.pseudoColumns.map((pseudoColumn) => ({
							...pseudoColumn,
							table: normalize(pseudoColumn.table),
							foreignKeyColumn: normalize(pseudoColumn.foreignKeyColumn),
							targetColumn: normalize(pseudoColumn.targetColumn),
						})),
					}
				: {}),
			...(table.partition
				? {
						partition: {
							...table.partition,
							columns: normalizeColumnList(table.partition.columns, normalize),
						},
					}
				: {}),
		},
		conflicts,
	};
}

function checkForComparison(check: CheckConstraintIR): CheckConstraintIR {
	const { requiresEnumLabels: _requiresEnumLabels, ...physicalCheck } = check;
	return physicalCheck;
}

function checksForComparison(
	checks: readonly CheckConstraintIR[] | undefined,
): readonly CheckConstraintIR[] | undefined {
	return checks?.map(checkForComparison);
}

function logicalIdentityForComparison(identity: LogicalIdentity | undefined):
	| {
			readonly id: string;
			readonly carrier:
				| {
						readonly kind: string;
						readonly authenticated: false;
				  }
				| undefined;
	  }
	| undefined {
	if (identity === undefined) {
		return undefined;
	}
	// A malformed identity that reached comparison without a carrier (e.g. a
	// spoofed/legacy db-side shape that bypassed validation) must NOT crash the
	// comparator. Reflect the missing carrier as `undefined` so it compares as a
	// real difference against a well-formed carrier (fail closed → surfaces as
	// drift), never silently equal.
	return {
		id: identity.id,
		carrier: identity.carrier
			? {
					kind: identity.carrier.kind,
					authenticated: identity.carrier.authenticated,
				}
			: undefined,
	};
}

function columnForComparison(
	column: ColumnIR,
	desiredIntent: ColumnIR = column,
): unknown {
	const {
		js: _js,
		logicalIdentity: _logicalIdentity,
		uniqueConstraintName: _uniqueConstraintName,
		...rest
	} = column;
	const logicalIdentity = logicalIdentityForComparison(column.logicalIdentity);
	const base = logicalIdentity ? { ...rest, logicalIdentity } : rest;
	return Object.hasOwn(desiredIntent, 'uniqueConstraintName')
		? { ...base, uniqueConstraintName: column.uniqueConstraintName }
		: base;
}

function logicalIdentityChanged(
	desired: { readonly logicalIdentity?: LogicalIdentity } | undefined,
	current: { readonly logicalIdentity?: LogicalIdentity } | undefined,
): boolean {
	if (!desired || !current) {
		return false;
	}
	return (
		stableJson(logicalIdentityForComparison(desired.logicalIdentity)) !==
		stableJson(logicalIdentityForComparison(current.logicalIdentity))
	);
}

function normalizeNamedMap<T extends { readonly name: string }>(
	items: ReadonlyMap<string, T> | undefined,
	normalize: NormalizeIdentifier,
	kind: 'enum' | 'sequence',
): {
	readonly items: ReadonlyMap<string, T> | undefined;
	readonly conflicts: readonly NormalizationConflict[];
} {
	if (!items) {
		return { items: undefined, conflicts: [] };
	}
	const normalizedItems = new Map<string, T>();
	const conflicts: NormalizationConflict[] = [];
	for (const item of items.values()) {
		const normalized = { ...item, name: normalize(item.name) };
		if (normalizedItems.has(normalized.name)) {
			conflicts.push(
				kind === 'enum'
					? { kind: 'enum', enum: normalized.name }
					: { kind: 'sequence', sequence: normalized.name },
			);
		}
		normalizedItems.set(normalized.name, normalized);
	}
	return { items: normalizedItems, conflicts };
}

function normalizeCurrentModelForComparison(
	model: ModelIR,
	normalize: NormalizeIdentifier,
): {
	readonly model: ModelIR;
	readonly conflicts: readonly NormalizationConflict[];
} {
	const conflicts: NormalizationConflict[] = [];
	const tables = new Map<string, TableIR>();
	for (const table of model.tables.values()) {
		const normalized = normalizeTable(table, normalize);
		if (tables.has(normalized.table.name)) {
			conflicts.push({ kind: 'table', table: normalized.table.name });
		}
		tables.set(normalized.table.name, normalized.table);
		conflicts.push(...normalized.conflicts);
	}
	const relations = new Map<string, RelationIR>();
	for (const relation of model.relations.values()) {
		const normalized = normalizeRelation(relation, normalize);
		const key = `${normalized.source}.${normalized.name}`;
		if (relations.has(key)) {
			conflicts.push({
				kind: 'relation',
				source: normalized.source,
				relation: normalized.name,
			});
		}
		relations.set(key, normalized);
	}
	const externalTables = model.externalTables
		? new Set([...model.externalTables].map((table) => normalize(table)))
		: undefined;
	const enums = normalizeNamedMap<EnumIR>(model.enums, normalize, 'enum');
	const sequences = normalizeNamedMap<SequenceIR>(
		model.sequences,
		normalize,
		'sequence',
	);
	conflicts.push(...enums.conflicts, ...sequences.conflicts);
	return {
		model: {
			...model,
			tables,
			...(externalTables ? { externalTables } : {}),
			relations,
			...(enums.items ? { enums: enums.items } : {}),
			...(sequences.items ? { sequences: sequences.items } : {}),
			getTable: (name: string) => tables.get(name),
			getRelation: (qualifiedName: string) => relations.get(qualifiedName),
			getRelationsFrom: (sourceTable: string) =>
				[...relations.values()].filter(
					(relation) => relation.source === sourceTable,
				),
			getRelationsTo: (targetTable: string) =>
				[...relations.values()].filter(
					(relation) => relation.target === targetTable,
				),
			isAmbiguous: (sourceTable: string, targetTable: string) => {
				const matches = [...relations.values()].filter(
					(relation) =>
						relation.source === sourceTable && relation.target === targetTable,
				);
				return {
					ambiguous: matches.length > 1,
					options: matches.map((relation) => relation.name),
				};
			},
		},
		conflicts,
	};
}

function tableForComparison(
	table: TableIR,
	perspective: 'desired' | 'current' = 'desired',
	desiredIntentTable: TableIR = table,
): unknown {
	const logicalIdentity = logicalIdentityForComparison(table.logicalIdentity);
	return {
		name: table.name,
		...(logicalIdentity ? { logicalIdentity } : {}),
		columns: table.columns.map((column) =>
			columnForComparison(
				column,
				desiredIntentTable.columns.find(
					(desiredColumn) => desiredColumn.name === column.name,
				) ?? column,
			),
		),
		primaryKey: table.primaryKey,
		foreignKeys: table.foreignKeys,
		indexes: table.indexes.map((index) =>
			normalizedIndex(table.name, index, perspective),
		),
		checkConstraints: checksForComparison(table.checkConstraints),
		pseudoColumns: table.pseudoColumns,
		comment: table.comment,
		partition: table.partition,
		rlsEnabled: table.rlsEnabled,
		policies: table.policies,
	};
}

function externalTableNames(
	desired: ModelIR,
	current: ModelIR,
): ReadonlySet<string> {
	const desiredManagedTables = new Set(desired.tables.keys());
	return new Set(
		[
			...(desired.externalTables ?? []),
			...(current.externalTables ?? []),
		].filter((table) => !desiredManagedTables.has(table)),
	);
}

function relationTouchesExternalTable(
	relation: RelationIR,
	externalTables: ReadonlySet<string>,
): boolean {
	return (
		externalTables.has(relation.source) ||
		externalTables.has(relation.target) ||
		(typeof relation.through === 'string' &&
			externalTables.has(relation.through))
	);
}

function managedRelationsForComparison(
	relations: ReadonlyMap<string, RelationIR> | undefined,
	externalTables: ReadonlySet<string>,
): ReadonlyMap<string, RelationIR> {
	return new Map(
		[...(relations ?? new Map<string, RelationIR>()).entries()].filter(
			([, relation]) => !relationTouchesExternalTable(relation, externalTables),
		),
	);
}

function modelRelations(
	model: ModelIR,
): ReadonlyMap<string, RelationIR> | undefined {
	return (model as { readonly relations?: ReadonlyMap<string, RelationIR> })
		.relations;
}

function managedMapPolicy<T>(
	items: ReadonlyMap<string, T> | undefined,
): ManagedCollectionPolicy {
	if (items === undefined) {
		return { managed: false };
	}
	if (items.size === 0) {
		return { managed: true };
	}
	return { managed: true, keys: new Set(items.keys()) };
}

function managedListPolicy(
	items: readonly string[] | undefined,
): ManagedCollectionPolicy {
	if (items === undefined) {
		return { managed: false };
	}
	if (items.length === 0) {
		return { managed: true };
	}
	return { managed: true, keys: new Set(items) };
}

function managedRelationPolicy(
	relations: ReadonlyMap<string, RelationIR> | undefined,
	externalTables: ReadonlySet<string>,
): ManagedCollectionPolicy {
	if (relations === undefined) {
		return { managed: false };
	}
	if (relations.size === 0) {
		return { managed: true };
	}
	return {
		managed: true,
		keys: new Set(
			managedRelationsForComparison(relations, externalTables).keys(),
		),
	};
}

function managedModelCollections(
	desired: ModelIR,
	externalTables: ReadonlySet<string>,
): ManagedModelCollections {
	return {
		extensions: managedListPolicy(desired.extensions),
		sequences: managedMapPolicy(desired.sequences),
		enums: managedMapPolicy(desired.enums),
		relations: managedRelationPolicy(modelRelations(desired), externalTables),
	};
}

function isManagedCollectionKey(
	policy: ManagedCollectionPolicy,
	key: string,
): boolean {
	return policy.managed && (policy.keys === undefined || policy.keys.has(key));
}

function projectManagedMapEntries<T>(
	items: ReadonlyMap<string, T> | undefined,
	policy: ManagedCollectionPolicy,
	valueForEntry: (name: string, value: T) => T = (_name, value) => value,
): readonly (readonly [string, T])[] {
	if (!policy.managed) {
		return [];
	}
	return [...(items ?? new Map<string, T>()).entries()]
		.filter(([name]) => isManagedCollectionKey(policy, name))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => [name, valueForEntry(name, value)] as const);
}

function extensionNamesForComparison(
	extensions: readonly string[] | undefined,
	policy: ManagedCollectionPolicy,
): readonly string[] {
	if (!policy.managed) {
		return [];
	}
	return [...new Set(extensions ?? [])]
		.filter((extension) => isManagedCollectionKey(policy, extension))
		.sort((left, right) => left.localeCompare(right));
}

function modelLevelCollectionsForComparison(
	model: ModelIR,
	externalTables: ReadonlySet<string>,
	managedCollections: ManagedModelCollections,
	options: {
		readonly enumValueForComparison?: (name: string, enumDef: EnumIR) => EnumIR;
	} = {},
): ModelLevelCollectionsComparison {
	return {
		relations: projectManagedMapEntries(
			managedRelationsForComparison(modelRelations(model), externalTables),
			managedCollections.relations,
		),
		enums: projectManagedMapEntries(
			model.enums,
			managedCollections.enums,
			options.enumValueForComparison,
		),
		extensions: extensionNamesForComparison(
			model.extensions,
			managedCollections.extensions,
		),
		sequences: projectManagedMapEntries(
			model.sequences,
			managedCollections.sequences,
		),
	};
}

function modelForComparison(
	model: ModelIR,
	externalTables: ReadonlySet<string>,
	managedCollections: ManagedModelCollections,
	perspective: 'desired' | 'current' = 'desired',
	desiredIntent: ModelIR = model,
): unknown {
	return {
		tables: [...model.tables.entries()]
			.filter(([name]) => !externalTables.has(name))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, table]) => [
				name,
				tableForComparison(
					table,
					perspective,
					desiredIntent.getTable(name) ?? table,
				),
			]),
		...modelLevelCollectionsForComparison(
			model,
			externalTables,
			managedCollections,
		),
	};
}

function columnWithRevertedFields(
	desired: ColumnIR,
	current: ColumnIR,
	fields: ReadonlySet<ColumnFieldName>,
): ColumnIR {
	const reverted: Record<string, unknown> = { ...desired };
	const currentRecord = current as unknown as Record<string, unknown>;
	for (const field of fields) {
		if (Object.hasOwn(current, field)) {
			reverted[field] = currentRecord[field];
		} else {
			delete reverted[field];
		}
	}
	return reverted as unknown as ColumnIR;
}

function columnChangeKey(table: string, column: string): string {
	return JSON.stringify([table, column]);
}

function declaredColumnFieldsFor(
	rule: TransitionRule,
): readonly ColumnFieldName[] {
	return rule.consumesColumnFields ?? [];
}

function addColumnFieldCoverage(
	coverage: Map<string, Set<ColumnFieldName>>,
	key: string,
	fields: readonly ColumnFieldName[],
): void {
	if (fields.length === 0) {
		return;
	}
	const existing = coverage.get(key) ?? new Set<ColumnFieldName>();
	for (const field of fields) {
		existing.add(field);
	}
	coverage.set(key, existing);
}

function mergeColumnFieldCoverage(
	...maps: readonly ReadonlyMap<string, ReadonlySet<ColumnFieldName>>[]
): ReadonlyMap<string, ReadonlySet<ColumnFieldName>> {
	const merged = new Map<string, Set<ColumnFieldName>>();
	for (const map of maps) {
		for (const [key, fields] of map) {
			addColumnFieldCoverage(merged, key, [...fields]);
		}
	}
	return merged;
}

function recognizedColumnFieldsAreDisjoint(
	recognized: readonly RecognizedRuleEntry[],
): boolean {
	if (recognized.length < 2) {
		return false;
	}
	const claimed = new Set<ColumnFieldName>();
	for (const entry of recognized) {
		const fields = declaredColumnFieldsFor(entry.rule);
		if (fields.length === 0) {
			return false;
		}
		for (const field of fields) {
			if (claimed.has(field)) {
				return false;
			}
			claimed.add(field);
		}
	}
	return true;
}

function revertRecognizedColumnChanges(
	desired: ModelIR,
	current: ModelIR,
	recognizedColumnFields: ReadonlyMap<string, ReadonlySet<ColumnFieldName>>,
	externalTables: ReadonlySet<string>,
	managedCollections: ManagedModelCollections,
	recognizedTableKeys: ReadonlySet<string> = new Set(),
	recognizedEnumKeys: ReadonlySet<string> = new Set(),
	recognizedCheckKeys: ReadonlySet<string> = new Set(),
	recognizedCheckReplacements: ReadonlyMap<
		string,
		CheckConstraintIR
	> = new Map(),
	recognizedIndexKeys: ReadonlySet<string> = new Set(),
): unknown {
	return {
		tables: [...desired.tables.entries()]
			.filter(([name]) => !externalTables.has(name))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, table]) => {
				const currentTable = current.getTable(name);
				const tableWithRevertedIdentity =
					recognizedTableKeys.has(name) && currentTable
						? tableWithLogicalIdentity(table, currentTable.logicalIdentity)
						: table;
				const revertedChecks = revertRecognizedCheckChanges(
					name,
					tableWithRevertedIdentity.checkConstraints,
					currentTable?.checkConstraints,
					recognizedCheckKeys,
					recognizedCheckReplacements,
				);
				const revertedIndexes = revertRecognizedIndexChanges(
					name,
					tableWithRevertedIdentity.indexes,
					currentTable?.indexes,
					recognizedIndexKeys,
				);
				const tableWithRevertedColumns = {
					...tableWithRevertedIdentity,
					columns: tableWithRevertedIdentity.columns.map((column) => {
						const key = JSON.stringify([name, column.name]);
						const currentColumn = currentTable?.columns.find(
							(candidate) => candidate.name === column.name,
						);
						const fields = recognizedColumnFields.get(key);
						return fields && currentColumn
							? columnWithRevertedFields(column, currentColumn, fields)
							: column;
					}),
				};
				const tableWithRevertedChecks =
					revertedChecks === undefined
						? (({ checkConstraints: _checkConstraints, ...rest }: TableIR) =>
								rest)(tableWithRevertedColumns)
						: {
								...tableWithRevertedColumns,
								checkConstraints: revertedChecks,
							};
				return [
					name,
					tableForComparison({
						...tableWithRevertedChecks,
						indexes: revertedIndexes,
					}),
				];
			}),
		...modelLevelCollectionsForComparison(
			desired,
			externalTables,
			managedCollections,
			{
				enumValueForComparison: (name, enumDef) => {
					const currentEnum = current.enums?.get(name);
					return recognizedEnumKeysForName(recognizedEnumKeys, name) &&
						currentEnum
						? currentEnum
						: enumDef;
				},
			},
		),
	};
}

function tableWithLogicalIdentity(
	table: TableIR,
	identity: LogicalIdentity | undefined,
): TableIR {
	const { logicalIdentity: _logicalIdentity, ...rest } = table;
	return identity ? { ...rest, logicalIdentity: identity } : rest;
}

function recognizedEnumKeysForName(
	recognizedEnumKeys: ReadonlySet<string>,
	name: string,
): boolean {
	for (const key of recognizedEnumKeys) {
		const parsed = JSON.parse(key) as unknown;
		if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === name) {
			return true;
		}
	}
	return false;
}

function normalizationConflictIsManaged(
	conflict: NormalizationConflict,
	managedCollections: ManagedModelCollections,
): boolean {
	switch (conflict.kind) {
		case 'relation':
			return isManagedCollectionKey(
				managedCollections.relations,
				`${conflict.source}.${conflict.relation}`,
			);
		case 'enum':
			return isManagedCollectionKey(managedCollections.enums, conflict.enum);
		case 'sequence':
			return isManagedCollectionKey(
				managedCollections.sequences,
				conflict.sequence,
			);
		default:
			return true;
	}
}

function managedMapRecognitionKeys<T>(
	desired: ReadonlyMap<string, T> | undefined,
	current: ReadonlyMap<string, T> | undefined,
	policy: ManagedCollectionPolicy,
): ReadonlySet<string> {
	if (!policy.managed) {
		return new Set();
	}
	if (policy.keys !== undefined) {
		return new Set(policy.keys);
	}
	return new Set([
		...(desired ?? new Map<string, T>()).keys(),
		...(current ?? new Map<string, T>()).keys(),
	]);
}

function revertRecognizedCheckChanges(
	tableName: string,
	desiredChecks: readonly CheckConstraintIR[] | undefined,
	currentChecks: readonly CheckConstraintIR[] | undefined,
	recognizedCheckKeys: ReadonlySet<string>,
	recognizedCheckReplacements: ReadonlyMap<string, CheckConstraintIR>,
): readonly CheckConstraintIR[] | undefined {
	if (recognizedCheckKeys.size === 0 || desiredChecks === undefined) {
		return desiredChecks;
	}
	const reverted: CheckConstraintIR[] = [];
	for (const check of desiredChecks) {
		const key = JSON.stringify([tableName, check.name]);
		if (!recognizedCheckKeys.has(key)) {
			reverted.push(check);
			continue;
		}
		const replacement = recognizedCheckReplacements.get(key);
		if (replacement) {
			reverted.push(replacement);
			continue;
		}
		const currentCheck = currentChecks?.find(
			(candidate) => candidate.name === check.name,
		);
		if (currentCheck) {
			reverted.push(currentCheck);
		}
	}
	if (reverted.length === 0 && currentChecks === undefined) {
		return undefined;
	}
	return reverted;
}

function checkChangeKey(tableName: string, checkName: string): string {
	return JSON.stringify([tableName, checkName]);
}

function indexChangeKey(
	tableName: string,
	index: Pick<IndexIR, 'name' | 'columns'>,
): string {
	return JSON.stringify([tableName, defaultIndexName(tableName, index)]);
}

function revertRecognizedIndexChanges(
	tableName: string,
	desiredIndexes: readonly IndexIR[],
	currentIndexes: readonly IndexIR[] | undefined,
	recognizedIndexKeys: ReadonlySet<string>,
): readonly IndexIR[] {
	if (recognizedIndexKeys.size === 0) {
		return desiredIndexes;
	}
	const currentByName = new Map(
		(currentIndexes ?? []).map((index) => [
			defaultIndexName(tableName, index),
			index,
		]),
	);
	const reverted: IndexIR[] = [];
	for (const index of desiredIndexes) {
		const key = indexChangeKey(tableName, index);
		if (!recognizedIndexKeys.has(key)) {
			reverted.push(index);
			continue;
		}
		const current = currentByName.get(defaultIndexName(tableName, index));
		if (current) {
			reverted.push(current);
		}
	}
	return reverted;
}

function resourceForColumn(
	engine: string,
	table: string,
	column?: string,
): ResourceAddress {
	const resource: ResourceAddress = {
		engine,
		database: 'model',
		kind: column ? 'column' : 'table',
		name: column ?? table,
	};
	return column ? { ...resource, qualifiedBy: [table] } : resource;
}

function resourceForCheck(
	engine: string,
	table: string,
	check?: string,
): ResourceAddress {
	if (!check) {
		return resourceForColumn(engine, table);
	}
	return {
		engine,
		database: 'model',
		kind: 'check-constraint',
		name: check,
		qualifiedBy: [table],
	};
}

function resourceForIndex(
	engine: string,
	table: string,
	index?: string,
): ResourceAddress {
	if (!index) {
		return resourceForColumn(engine, table);
	}
	return {
		engine,
		database: 'model',
		kind: 'index',
		name: index,
		qualifiedBy: [table],
	};
}

function resourceForEnum(
	engine: string,
	enumDef: EnumIR | undefined,
	name: string,
): ResourceAddress {
	const resource: ResourceAddress = {
		engine,
		database: 'model',
		kind: 'type',
		name,
		qualifiedBy: ['enum'],
	};
	return enumDef?.schema ? { ...resource, schema: enumDef.schema } : resource;
}

function resourceForNormalizationConflict(
	engine: string,
	conflict: NormalizationConflict,
): ResourceAddress {
	switch (conflict.kind) {
		case 'column':
			return resourceForColumn(engine, conflict.table, conflict.column);
		case 'check':
			return resourceForCheck(engine, conflict.table, conflict.check);
		case 'table':
			return resourceForColumn(engine, conflict.table);
		case 'relation':
			return {
				engine,
				database: 'model',
				kind: 'relation',
				name: conflict.relation,
				qualifiedBy: [conflict.source],
			};
		case 'enum':
			return {
				engine,
				database: 'model',
				kind: 'type',
				name: conflict.enum,
				qualifiedBy: ['enum'],
			};
		case 'sequence':
			return {
				engine,
				database: 'model',
				kind: 'sequence',
				name: conflict.sequence,
			};
	}
}

function noDriftProposition(): Proposition {
	return {
		kind: 'dbsp.model.no-drift',
		scope: [
			{
				engine: 'model',
				database: 'model',
				kind: 'schema',
				name: 'model',
			},
		],
	};
}

function makeFocusedModel(table: TableIR, column: ColumnIR): ModelIR {
	const { checkConstraints: _checkConstraints, ...tableWithoutChecks } = table;
	const tables = new Map<string, TableIR>([
		[
			table.name,
			{
				...tableWithoutChecks,
				columns: [column],
			},
		],
	]);
	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function makeFocusedTableModel(table: TableIR): ModelIR {
	const { checkConstraints: _checkConstraints, ...tableWithoutChecks } = table;
	const tables = new Map<string, TableIR>([
		[
			table.name,
			{
				...tableWithoutChecks,
				columns: [],
				indexes: [],
				foreignKeys: [],
			},
		],
	]);
	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function makeFocusedEnumModel(enumDef: EnumIR): ModelIR {
	const enums = new Map<string, EnumIR>([[enumDef.name, enumDef]]);
	return {
		tables: new Map(),
		relations: new Map(),
		enums,
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function makeFocusedCheckModel(table: TableIR): ModelIR {
	const { columns: _columns, ...tableWithoutColumns } = table;
	const tables = new Map<string, TableIR>([
		[
			table.name,
			{
				...tableWithoutColumns,
				columns: [],
			},
		],
	]);
	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function makeFocusedIndexModel(table: TableIR): ModelIR {
	const { checkConstraints: _checkConstraints, ...tableWithoutChecks } = table;
	const tables = new Map<string, TableIR>([[table.name, tableWithoutChecks]]);
	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function requestToObligation(
	request: ObservationRequest,
	appliesTo?: string,
): ProofObligation {
	const propositionBase = {
		kind: request.kind,
		scope: request.scope,
	};
	const proposition: Proposition =
		request.detail === undefined
			? propositionBase
			: { ...propositionBase, detail: request.detail };
	const obligation: ProofObligation = {
		proposition,
		scope: request.scope,
		dischargeableBy: [request],
	};
	return appliesTo ? { ...obligation, appliesTo } : obligation;
}

function ruleRef(rule: TransitionRule): RuleRef {
	return {
		id: rule.id,
		pack: rule.artifact,
	};
}

type RecognizedRuleEntry = {
	readonly rule: TransitionRule;
	readonly result: Extract<
		RecognitionResult<unknown>,
		{ readonly recognized: true }
	>;
};

function candidateFromRule(
	rule: TransitionRule,
	result: Extract<RecognitionResult<unknown>, { readonly recognized: true }>,
	recognizedRules: readonly TransitionRule[],
	why: string,
): TransitionCandidate {
	const { match } = result;
	const required = rule.requiredObservations(match);
	const ref = ruleRef(rule);
	const candidate = {
		rule: ref,
		match,
		requiredObservations: required,
		obligations: required.map((request) => requestToObligation(request)),
		selectionRationale: {
			chosen: ref,
			overRules: recognizedRules
				.filter((candidate) => candidate !== rule)
				.map((candidate) => ruleRef(candidate)),
			why,
		},
	};
	return result.claimDrafts
		? { ...candidate, claimDrafts: result.claimDrafts }
		: candidate;
}

type ArbitrationResult =
	| {
			readonly kind: 'candidate';
			readonly candidate: TransitionCandidate;
			readonly candidateRule: TransitionRule;
	  }
	| {
			readonly kind: 'ambiguous';
			readonly candidates: readonly RuleRef[];
	  };

function arbitrateRecognizedRules(
	registry: PackRegistry,
	recognized: readonly RecognizedRuleEntry[],
): ArbitrationResult {
	const recognizedRules = recognized.map((entry) => entry.rule);
	if (recognized.length === 1) {
		const entry = recognized[0];
		if (!entry) {
			return { kind: 'ambiguous', candidates: [] };
		}
		return {
			kind: 'candidate',
			candidateRule: entry.rule,
			candidate: candidateFromRule(
				entry.rule,
				entry.result,
				recognizedRules,
				'recognized transition rule',
			),
		};
	}

	const resolution = registry.resolveRulePrecedence(recognizedRules);
	if (!resolution.ok) {
		return {
			kind: 'ambiguous',
			candidates: recognizedRules.map((entry) => ruleRef(entry)),
		};
	}
	const chosenEntry = recognized.find(
		(entry) => entry.rule === resolution.rule,
	);
	if (!chosenEntry) {
		return {
			kind: 'ambiguous',
			candidates: recognizedRules.map((entry) => ruleRef(entry)),
		};
	}
	return {
		kind: 'candidate',
		candidateRule: chosenEntry.rule,
		candidate: candidateFromRule(
			chosenEntry.rule,
			chosenEntry.result,
			recognizedRules,
			`recognized transition rule selected by declared precedence: ${resolution.reason}`,
		),
	};
}

export function createComparator(registry: PackRegistry): Comparator {
	return {
		artifact: COMPARATOR_ARTIFACT,
		compare(
			desired: ModelIR,
			current: ModelIR,
			context?: EquivalenceContext,
		): CompareOutcome {
			const engine =
				context?.engine ??
				registry.allRules()[0]?.support.engine ??
				'unknown-transition-engine';
			const recognitionContextFor = (rule: TransitionRule) => {
				const equivalence = registry.resolveEquivalence(rule.artifact);
				const recognitionContext: EquivalenceContext = {
					...(context ?? {}),
					engine,
				};
				return equivalence
					? { equivalence, context: recognitionContext }
					: { context: recognitionContext };
			};
			const normalizeCurrentIdentifier =
				registry.comparatorNameNormalizer()?.normalizeCurrentIdentifier ??
				((identifier: string) => identifier);
			const normalizedCurrent = normalizeCurrentModelForComparison(
				current,
				normalizeCurrentIdentifier,
			);
			const currentForComparison = normalizedCurrent.model;
			const ignoredExternalTables = externalTableNames(
				desired,
				currentForComparison,
			);
			const managedCollections = managedModelCollections(
				desired,
				ignoredExternalTables,
			);
			const blockingNormalizationConflicts = normalizedCurrent.conflicts.filter(
				(conflict) =>
					normalizationConflictIsManaged(conflict, managedCollections),
			);
			if (blockingNormalizationConflicts.length > 0) {
				return {
					kind: 'unsupported',
					changes: blockingNormalizationConflicts.map((conflict) =>
						resourceForNormalizationConflict(engine, conflict),
					),
				};
			}
			const desiredComparison = modelForComparison(
				desired,
				ignoredExternalTables,
				managedCollections,
				'desired',
			);
			const currentComparison = modelForComparison(
				currentForComparison,
				ignoredExternalTables,
				managedCollections,
				'current',
				desired,
			);
			if (stableJson(desiredComparison) === stableJson(currentComparison)) {
				return { kind: 'no-drift', claimedInvariant: noDriftProposition() };
			}

			const candidates: TransitionCandidate[] = [];
			const unknownRecognitions: UnknownTransitionRecognition[] = [];
			const unsupported: ResourceAddress[] = [];
			const recognizedColumnFields = new Map<string, Set<ColumnFieldName>>();
			const pendingColumnFields = new Map<string, Set<ColumnFieldName>>();
			const recognizedTableKeys = new Set<string>();
			const pendingTableKeys = new Set<string>();
			const recognizedEnumKeys = new Set<string>();
			const pendingEnumKeys = new Set<string>();
			const recognizedCheckKeys = new Set<string>();
			const pendingCheckKeys = new Set<string>();
			const pendingCheckReplacements = new Map<string, CheckConstraintIR>();
			const recognizedIndexKeys = new Set<string>();
			const pendingIndexKeys = new Set<string>();

			const tableNames = new Set<string>([
				...desired.tables.keys(),
				...currentForComparison.tables.keys(),
			]);

			for (const tableName of tableNames) {
				if (ignoredExternalTables.has(tableName)) {
					continue;
				}
				const desiredTable = desired.getTable(tableName);
				const currentTable = currentForComparison.getTable(tableName);
				if (!desiredTable || !currentTable) {
					unsupported.push(resourceForColumn(engine, tableName));
					continue;
				}

				if (logicalIdentityChanged(desiredTable, currentTable)) {
					const focusedDesired = makeFocusedTableModel(desiredTable);
					const focusedCurrent = makeFocusedTableModel(currentTable);
					const recognitionEntries = registry.allRules().map((rule) => ({
						rule,
						result: rule.recognize(
							focusedDesired,
							focusedCurrent,
							recognitionContextFor(rule),
						),
					}));
					const recognized = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: true }
							>;
						} => entry.result.recognized === true,
					);
					const unknown = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: 'unknown' }
							>;
						} => entry.result.recognized === 'unknown',
					);

					if (recognized.length === 0) {
						if (unknown.length > 0) {
							for (const entry of unknown) {
								unknownRecognitions.push({
									rule: ruleRef(entry.rule),
									desired: focusedDesired,
									current: focusedCurrent,
									obligations: entry.result.obligations,
								});
							}
							pendingTableKeys.add(tableName);
							continue;
						}
						unsupported.push(resourceForColumn(engine, tableName));
						continue;
					}

					const arbitration = arbitrateRecognizedRules(registry, recognized);
					if (arbitration.kind === 'ambiguous') {
						return {
							kind: 'ambiguous',
							candidates: arbitration.candidates,
						};
					}
					candidates.push(arbitration.candidate);
					recognizedTableKeys.add(tableName);
					pendingTableKeys.add(tableName);
				}

				const columnNames = new Set<string>([
					...desiredTable.columns.map((column) => column.name),
					...currentTable.columns.map((column) => column.name),
				]);

				for (const columnName of columnNames) {
					const desiredColumn = desiredTable.columns.find(
						(column) => column.name === columnName,
					);
					const currentColumn = currentTable.columns.find(
						(column) => column.name === columnName,
					);
					if (!columnChanged(desiredColumn, currentColumn)) {
						continue;
					}
					if (!desiredColumn || !currentColumn) {
						unsupported.push(resourceForColumn(engine, tableName, columnName));
						continue;
					}
					const columnKey = columnChangeKey(tableName, columnName);

					const focusedDesired = makeFocusedModel(desiredTable, desiredColumn);
					const focusedCurrent = makeFocusedModel(currentTable, currentColumn);
					const recognitionEntries = registry.allRules().map((rule) => ({
						rule,
						result: rule.recognize(
							focusedDesired,
							focusedCurrent,
							recognitionContextFor(rule),
						),
					}));
					const recognized = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: true }
							>;
						} => entry.result.recognized === true,
					);
					const unknown = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: 'unknown' }
							>;
						} => entry.result.recognized === 'unknown',
					);

					if (recognized.length === 0) {
						if (unknown.length > 0) {
							for (const entry of unknown) {
								unknownRecognitions.push({
									rule: ruleRef(entry.rule),
									desired: focusedDesired,
									current: focusedCurrent,
									obligations: entry.result.obligations,
								});
								addColumnFieldCoverage(
									pendingColumnFields,
									columnKey,
									declaredColumnFieldsFor(entry.rule),
								);
							}
							continue;
						}
						unsupported.push(resourceForColumn(engine, tableName, columnName));
						continue;
					}

					if (recognizedColumnFieldsAreDisjoint(recognized)) {
						for (const entry of recognized) {
							candidates.push(
								candidateFromRule(
									entry.rule,
									entry.result,
									[entry.rule],
									'recognized transition rule with disjoint column field coverage',
								),
							);
							addColumnFieldCoverage(
								recognizedColumnFields,
								columnKey,
								declaredColumnFieldsFor(entry.rule),
							);
							addColumnFieldCoverage(
								pendingColumnFields,
								columnKey,
								declaredColumnFieldsFor(entry.rule),
							);
						}
						continue;
					}

					const arbitration = arbitrateRecognizedRules(registry, recognized);
					if (arbitration.kind === 'ambiguous') {
						return {
							kind: 'ambiguous',
							candidates: arbitration.candidates,
						};
					}
					candidates.push(arbitration.candidate);
					addColumnFieldCoverage(
						recognizedColumnFields,
						columnKey,
						declaredColumnFieldsFor(arbitration.candidateRule),
					);
					addColumnFieldCoverage(
						pendingColumnFields,
						columnKey,
						declaredColumnFieldsFor(arbitration.candidateRule),
					);
				}

				const tableCheckDelta = checkDelta(
					desiredTable.checkConstraints,
					currentTable.checkConstraints,
				);
				if (tableCheckDelta.kind === 'unsupported') {
					unsupported.push(resourceForCheck(engine, tableName));
					continue;
				}
				if (tableCheckDelta.kind !== 'none') {
					const checkName =
						tableCheckDelta.kind === 'add-check'
							? tableCheckDelta.check.name
							: tableCheckDelta.desired.name;
					const checkKey = checkChangeKey(tableName, checkName);
					if (tableCheckDelta.kind === 'expression-mismatch') {
						pendingCheckKeys.add(checkKey);
						const currentCheck = currentTable.checkConstraints?.find(
							(candidate) => candidate.name === tableCheckDelta.current.name,
						);
						if (currentCheck) {
							pendingCheckReplacements.set(checkKey, currentCheck);
						}
					}
					const focusedDesired = makeFocusedCheckModel(desiredTable);
					const focusedCurrent = makeFocusedCheckModel(currentTable);
					const recognitionEntries = registry.allRules().map((rule) => ({
						rule,
						result: rule.recognize(
							focusedDesired,
							focusedCurrent,
							recognitionContextFor(rule),
						),
					}));
					const recognized = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: true }
							>;
						} => entry.result.recognized === true,
					);
					const unknown = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: 'unknown' }
							>;
						} => entry.result.recognized === 'unknown',
					);
					const recognizedUnsupported = recognitionEntries.find(
						(entry) => entry.result.recognized === 'unsupported',
					);

					if (recognized.length === 0) {
						if (unknown.length > 0) {
							for (const entry of unknown) {
								unknownRecognitions.push({
									rule: ruleRef(entry.rule),
									desired: focusedDesired,
									current: focusedCurrent,
									obligations: entry.result.obligations,
								});
							}
							pendingCheckKeys.add(checkKey);
							continue;
						}
						if (recognizedUnsupported?.result.recognized === 'unsupported') {
							unsupported.push(...recognizedUnsupported.result.changes);
							continue;
						}
						unsupported.push(resourceForCheck(engine, tableName, checkName));
						continue;
					}

					const arbitration = arbitrateRecognizedRules(registry, recognized);
					if (arbitration.kind === 'ambiguous') {
						return {
							kind: 'ambiguous',
							candidates: arbitration.candidates,
						};
					}
					candidates.push(arbitration.candidate);
					recognizedCheckKeys.add(checkKey);
					pendingCheckKeys.add(checkKey);
				}

				const tableIndexDelta = indexDelta(
					tableName,
					desiredTable.indexes,
					currentTable.indexes,
				);
				if (tableIndexDelta.kind === 'unsupported') {
					unsupported.push(resourceForIndex(engine, tableName));
					continue;
				}
				if (tableIndexDelta.kind === 'add-unique-index') {
					const indexKey = indexChangeKey(tableName, tableIndexDelta.index);
					const focusedDesired = makeFocusedIndexModel(desiredTable);
					const focusedCurrent = makeFocusedIndexModel(currentTable);
					const recognitionEntries = registry.allRules().map((rule) => ({
						rule,
						result: rule.recognize(
							focusedDesired,
							focusedCurrent,
							recognitionContextFor(rule),
						),
					}));
					const recognized = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: true }
							>;
						} => entry.result.recognized === true,
					);
					const unknown = recognitionEntries.filter(
						(
							entry,
						): entry is {
							readonly rule: TransitionRule;
							readonly result: Extract<
								RecognitionResult<unknown>,
								{ readonly recognized: 'unknown' }
							>;
						} => entry.result.recognized === 'unknown',
					);
					const recognizedUnsupported = recognitionEntries.find(
						(entry) => entry.result.recognized === 'unsupported',
					);

					if (recognized.length === 0) {
						if (unknown.length > 0) {
							for (const entry of unknown) {
								unknownRecognitions.push({
									rule: ruleRef(entry.rule),
									desired: focusedDesired,
									current: focusedCurrent,
									obligations: entry.result.obligations,
								});
							}
							pendingIndexKeys.add(indexKey);
							continue;
						}
						if (recognizedUnsupported?.result.recognized === 'unsupported') {
							unsupported.push(...recognizedUnsupported.result.changes);
							continue;
						}
						unsupported.push(
							resourceForIndex(engine, tableName, tableIndexDelta.index.name),
						);
						continue;
					}

					const arbitration = arbitrateRecognizedRules(registry, recognized);
					if (arbitration.kind === 'ambiguous') {
						return {
							kind: 'ambiguous',
							candidates: arbitration.candidates,
						};
					}
					candidates.push(arbitration.candidate);
					recognizedIndexKeys.add(indexKey);
					pendingIndexKeys.add(indexKey);
				}
			}

			const enumNames = managedMapRecognitionKeys(
				desired.enums,
				currentForComparison.enums,
				managedCollections.enums,
			);

			for (const enumName of enumNames) {
				const desiredEnum = desired.enums?.get(enumName);
				const currentEnum = currentForComparison.enums?.get(enumName);
				if (!desiredEnum || !currentEnum) {
					unsupported.push(
						resourceForEnum(engine, desiredEnum ?? currentEnum, enumName),
					);
					continue;
				}
				const delta = enumAddDelta(
					desiredEnum,
					currentEnum,
					context?.targetSchema === undefined
						? {}
						: { targetSchema: context.targetSchema },
				);
				if (delta.kind === 'none') {
					pendingEnumKeys.add(JSON.stringify([enumName, null]));
					continue;
				}
				if (delta.kind === 'unsupported') {
					unsupported.push(resourceForEnum(engine, desiredEnum, enumName));
					continue;
				}

				const focusedDesired = makeFocusedEnumModel(desiredEnum);
				const focusedCurrent = makeFocusedEnumModel(currentEnum);
				const recognitionEntries = registry.allRules().map((rule) => ({
					rule,
					result: rule.recognize(
						focusedDesired,
						focusedCurrent,
						recognitionContextFor(rule),
					),
				}));
				const recognized = recognitionEntries.filter(
					(
						entry,
					): entry is {
						readonly rule: TransitionRule;
						readonly result: Extract<
							RecognitionResult<unknown>,
							{ readonly recognized: true }
						>;
					} => entry.result.recognized === true,
				);
				const unknown = recognitionEntries.filter(
					(
						entry,
					): entry is {
						readonly rule: TransitionRule;
						readonly result: Extract<
							RecognitionResult<unknown>,
							{ readonly recognized: 'unknown' }
						>;
					} => entry.result.recognized === 'unknown',
				);

				if (recognized.length === 0) {
					if (unknown.length > 0) {
						for (const entry of unknown) {
							unknownRecognitions.push({
								rule: ruleRef(entry.rule),
								desired: focusedDesired,
								current: focusedCurrent,
								obligations: entry.result.obligations,
							});
						}
						pendingEnumKeys.add(JSON.stringify([enumName, delta.label]));
						continue;
					}
					unsupported.push(resourceForEnum(engine, desiredEnum, enumName));
					continue;
				}

				const arbitration = arbitrateRecognizedRules(registry, recognized);
				if (arbitration.kind === 'ambiguous') {
					return {
						kind: 'ambiguous',
						candidates: arbitration.candidates,
					};
				}
				candidates.push(arbitration.candidate);
				recognizedEnumKeys.add(JSON.stringify([enumName, delta.label]));
				pendingEnumKeys.add(JSON.stringify([enumName, delta.label]));
			}

			const hiddenDiffsRemain =
				stableJson(
					revertRecognizedColumnChanges(
						desired,
						currentForComparison,
						mergeColumnFieldCoverage(
							recognizedColumnFields,
							pendingColumnFields,
						),
						ignoredExternalTables,
						managedCollections,
						new Set([...recognizedTableKeys, ...pendingTableKeys]),
						new Set([...recognizedEnumKeys, ...pendingEnumKeys]),
						new Set([...recognizedCheckKeys, ...pendingCheckKeys]),
						pendingCheckReplacements,
						new Set([...recognizedIndexKeys, ...pendingIndexKeys]),
					),
				) !== stableJson(currentComparison);
			if (hiddenDiffsRemain) {
				unsupported.push({
					engine,
					database: 'model',
					kind: 'schema',
					name: 'model',
				});
			}

			if (unsupported.length > 0) {
				return { kind: 'unsupported', changes: unsupported };
			}

			if (unknownRecognitions.length > 0 && candidates.length > 0) {
				return {
					kind: 'uncomposable',
					candidates,
					recognitions: unknownRecognitions,
					obligations: [
						...candidates.flatMap((candidate) => [...candidate.obligations]),
						...unknownRecognitions.flatMap((entry) => [...entry.obligations]),
					],
					detail:
						'mixed recognized and unknown transition changes cannot be retried without proving the whole diff',
				};
			}

			if (unknownRecognitions.length > 0) {
				return {
					kind: 'unknown',
					recognitions: unknownRecognitions,
					obligations: unknownRecognitions.flatMap((entry) => [
						...entry.obligations,
					]),
				};
			}

			if (candidates.length === 0) {
				return withTransitionCompareCurrentModel(
					{ kind: 'no-drift', claimedInvariant: noDriftProposition() },
					current,
				);
			}

			return withTransitionCompareCurrentModel(
				{
					kind: 'transitions',
					candidates,
					obligations: candidates.flatMap((candidate) => [
						...candidate.obligations,
					]),
				},
				current,
			);
		},
	};
}
