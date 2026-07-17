import type {
	CheckConstraintIR,
	ColumnIR,
	Comparator,
	CompareOutcome,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
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
import type { PackRegistry } from './registry.js';
import { stableJson } from './stable-json.js';

const COMPARATOR_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.core.transition.comparator'),
	version: '0.1.0',
};

type RuleWithPrecedence = TransitionRule & {
	readonly precedence?: number;
};

function columnChanged(
	desired: ColumnIR | undefined,
	current: ColumnIR | undefined,
): boolean {
	if (!desired || !current) {
		return true;
	}
	return stableJson(desired) !== stableJson(current);
}

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
		relations.set(`${normalized.source}.${normalized.name}`, normalized);
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

function tableForComparison(table: TableIR): unknown {
	return {
		name: table.name,
		columns: table.columns,
		primaryKey: table.primaryKey,
		foreignKeys: table.foreignKeys,
		indexes: table.indexes,
		checkConstraints: table.checkConstraints,
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
): unknown {
	return {
		tables: [...model.tables.entries()]
			.filter(([name]) => !externalTables.has(name))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, table]) => [name, tableForComparison(table)]),
		...modelLevelCollectionsForComparison(
			model,
			externalTables,
			managedCollections,
		),
	};
}

function revertRecognizedColumnChanges(
	desired: ModelIR,
	current: ModelIR,
	recognizedColumnKeys: ReadonlySet<string>,
	externalTables: ReadonlySet<string>,
	managedCollections: ManagedModelCollections,
	recognizedEnumKeys: ReadonlySet<string> = new Set(),
	recognizedCheckKeys: ReadonlySet<string> = new Set(),
	recognizedCheckReplacements: ReadonlyMap<
		string,
		CheckConstraintIR
	> = new Map(),
): unknown {
	return {
		tables: [...desired.tables.entries()]
			.filter(([name]) => !externalTables.has(name))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, table]) => {
				const currentTable = current.getTable(name);
				const revertedChecks = revertRecognizedCheckChanges(
					name,
					table.checkConstraints,
					currentTable?.checkConstraints,
					recognizedCheckKeys,
					recognizedCheckReplacements,
				);
				const tableWithRevertedColumns = {
					...table,
					columns: table.columns.map((column) => {
						const key = JSON.stringify([name, column.name]);
						const currentColumn = currentTable?.columns.find(
							(candidate) => candidate.name === column.name,
						);
						return recognizedColumnKeys.has(key) && currentColumn
							? currentColumn
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
				return [name, tableForComparison(tableWithRevertedChecks)];
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

function chooseByPrecedence(
	rules: readonly TransitionRule[],
): TransitionRule | undefined {
	const withPrecedence = rules.filter(
		(rule): rule is RuleWithPrecedence =>
			typeof (rule as RuleWithPrecedence).precedence === 'number',
	);
	if (withPrecedence.length !== rules.length) {
		return undefined;
	}
	const highest = Math.max(
		...withPrecedence.map((rule) => rule.precedence ?? 0),
	);
	const winners = withPrecedence.filter((rule) => rule.precedence === highest);
	return winners.length === 1 ? winners[0] : undefined;
}

function candidateFromRule(
	rule: TransitionRule,
	result: Extract<RecognitionResult<unknown>, { readonly recognized: true }>,
	recognizedRules: readonly TransitionRule[],
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
			overRules: recognizedRules.map((candidate) => ruleRef(candidate)),
			why: 'recognized transition rule',
		},
	};
	return result.claimDrafts
		? { ...candidate, claimDrafts: result.claimDrafts }
		: candidate;
}

export function createComparator(registry: PackRegistry): Comparator {
	return {
		artifact: COMPARATOR_ARTIFACT,
		compare(desired: ModelIR, current: ModelIR): CompareOutcome {
			const engine =
				registry.allRules()[0]?.support.engine ?? 'unknown-transition-engine';
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
			);
			const currentComparison = modelForComparison(
				currentForComparison,
				ignoredExternalTables,
				managedCollections,
			);
			if (stableJson(desiredComparison) === stableJson(currentComparison)) {
				return { kind: 'no-drift', claimedInvariant: noDriftProposition() };
			}

			const candidates: TransitionCandidate[] = [];
			const unknownRecognitions: UnknownTransitionRecognition[] = [];
			const unsupported: ResourceAddress[] = [];
			const recognizedColumnKeys = new Set<string>();
			const pendingColumnKeys = new Set<string>();
			const recognizedEnumKeys = new Set<string>();
			const pendingEnumKeys = new Set<string>();
			const recognizedCheckKeys = new Set<string>();
			const pendingCheckKeys = new Set<string>();
			const pendingCheckReplacements = new Map<string, CheckConstraintIR>();

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

					const focusedDesired = makeFocusedModel(desiredTable, desiredColumn);
					const focusedCurrent = makeFocusedModel(currentTable, currentColumn);
					const recognitionEntries = registry.allRules().map((rule) => {
						const equivalence = registry.resolveEquivalence(rule.artifact);
						return {
							rule,
							result: rule.recognize(
								focusedDesired,
								focusedCurrent,
								equivalence
									? { equivalence, context: { engine } }
									: { context: { engine } },
							),
						};
					});
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
							pendingColumnKeys.add(JSON.stringify([tableName, columnName]));
							continue;
						}
						unsupported.push(resourceForColumn(engine, tableName, columnName));
						continue;
					}

					const chosen =
						recognized.length === 1
							? recognized[0]?.rule
							: chooseByPrecedence(recognized.map((entry) => entry.rule));
					if (!chosen) {
						return {
							kind: 'ambiguous',
							candidates: recognized.map((entry) => ruleRef(entry.rule)),
						};
					}

					const chosenEntry = recognized.find((entry) => entry.rule === chosen);
					if (!chosenEntry?.result.recognized) {
						unsupported.push(resourceForColumn(engine, tableName, columnName));
						continue;
					}
					candidates.push(
						candidateFromRule(
							chosen,
							chosenEntry.result,
							recognized.map((entry) => entry.rule),
						),
					);
					recognizedColumnKeys.add(JSON.stringify([tableName, columnName]));
					pendingColumnKeys.add(JSON.stringify([tableName, columnName]));
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
					const recognitionEntries = registry.allRules().map((rule) => {
						const equivalence = registry.resolveEquivalence(rule.artifact);
						return {
							rule,
							result: rule.recognize(
								focusedDesired,
								focusedCurrent,
								equivalence
									? { equivalence, context: { engine } }
									: { context: { engine } },
							),
						};
					});
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

					const chosen =
						recognized.length === 1
							? recognized[0]?.rule
							: chooseByPrecedence(recognized.map((entry) => entry.rule));
					if (!chosen) {
						return {
							kind: 'ambiguous',
							candidates: recognized.map((entry) => ruleRef(entry.rule)),
						};
					}

					const chosenEntry = recognized.find((entry) => entry.rule === chosen);
					if (!chosenEntry?.result.recognized) {
						unsupported.push(resourceForCheck(engine, tableName, checkName));
						continue;
					}
					candidates.push(
						candidateFromRule(
							chosen,
							chosenEntry.result,
							recognized.map((entry) => entry.rule),
						),
					);
					recognizedCheckKeys.add(checkKey);
					pendingCheckKeys.add(checkKey);
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
				const delta = enumAddDelta(desiredEnum, currentEnum);
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
				const recognitionEntries = registry.allRules().map((rule) => {
					const equivalence = registry.resolveEquivalence(rule.artifact);
					return {
						rule,
						result: rule.recognize(
							focusedDesired,
							focusedCurrent,
							equivalence
								? { equivalence, context: { engine } }
								: { context: { engine } },
						),
					};
				});
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

				const chosen =
					recognized.length === 1
						? recognized[0]?.rule
						: chooseByPrecedence(recognized.map((entry) => entry.rule));
				if (!chosen) {
					return {
						kind: 'ambiguous',
						candidates: recognized.map((entry) => ruleRef(entry.rule)),
					};
				}

				const chosenEntry = recognized.find((entry) => entry.rule === chosen);
				if (!chosenEntry?.result.recognized) {
					unsupported.push(resourceForEnum(engine, desiredEnum, enumName));
					continue;
				}
				candidates.push(
					candidateFromRule(
						chosen,
						chosenEntry.result,
						recognized.map((entry) => entry.rule),
					),
				);
				recognizedEnumKeys.add(JSON.stringify([enumName, delta.label]));
				pendingEnumKeys.add(JSON.stringify([enumName, delta.label]));
			}

			const hiddenDiffsRemain =
				stableJson(
					revertRecognizedColumnChanges(
						desired,
						currentForComparison,
						new Set([...recognizedColumnKeys, ...pendingColumnKeys]),
						ignoredExternalTables,
						managedCollections,
						new Set([...recognizedEnumKeys, ...pendingEnumKeys]),
						new Set([...recognizedCheckKeys, ...pendingCheckKeys]),
						pendingCheckReplacements,
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
				return { kind: 'no-drift', claimedInvariant: noDriftProposition() };
			}

			return {
				kind: 'transitions',
				candidates,
				obligations: candidates.flatMap((candidate) => [
					...candidate.obligations,
				]),
			};
		},
	};
}
