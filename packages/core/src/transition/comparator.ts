import type {
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
	return {
		...relation,
		name: normalize(relation.name),
		source: normalize(relation.source),
		target: normalize(relation.target),
		through:
			typeof relation.through === 'string'
				? normalize(relation.through)
				: relation.through,
		foreignKey: normalizeColumnRef(relation.foreignKey, normalize),
		otherKey:
			typeof relation.otherKey === 'string'
				? normalize(relation.otherKey)
				: relation.otherKey,
		sourceKey: normalizeColumnRef(relation.sourceKey, normalize),
		targetKey: normalizeColumnRef(relation.targetKey, normalize),
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
	return {
		table: {
			...table,
			name: tableName,
			columns,
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
): ReadonlyMap<string, T> | undefined {
	if (!items) {
		return undefined;
	}
	return new Map(
		[...items.values()].map((item) => {
			const normalized = { ...item, name: normalize(item.name) };
			return [normalized.name, normalized];
		}),
	);
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
	const enums = normalizeNamedMap<EnumIR>(model.enums, normalize);
	const sequences = normalizeNamedMap<SequenceIR>(model.sequences, normalize);
	return {
		model: {
			...model,
			tables,
			...(externalTables ? { externalTables } : {}),
			relations,
			...(enums ? { enums } : {}),
			...(sequences ? { sequences } : {}),
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

function mapToEntries<T>(map: ReadonlyMap<string, T> | undefined): unknown {
	if (!map) {
		return undefined;
	}
	return [...map.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);
}

function setToValues(set: ReadonlySet<string> | undefined): unknown {
	return set ? [...set.values()].sort() : undefined;
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

function modelForComparison(model: ModelIR): unknown {
	return {
		tables: [...model.tables.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, table]) => [name, tableForComparison(table)]),
		externalTables: setToValues(model.externalTables),
		relations: mapToEntries(model.relations),
		enums: mapToEntries(model.enums),
		extensions: model.extensions,
		sequences: mapToEntries(model.sequences),
	};
}

function revertRecognizedColumnChanges(
	desired: ModelIR,
	current: ModelIR,
	recognizedColumnKeys: ReadonlySet<string>,
): unknown {
	return {
		tables: [...desired.tables.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, table]) => {
				const currentTable = current.getTable(name);
				return [
					name,
					tableForComparison({
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
					}),
				];
			}),
		externalTables: setToValues(desired.externalTables),
		relations: mapToEntries(desired.relations),
		enums: mapToEntries(desired.enums),
		extensions: desired.extensions,
		sequences: mapToEntries(desired.sequences),
	};
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

function resourceForNormalizationConflict(
	engine: string,
	conflict: NormalizationConflict,
): ResourceAddress {
	return conflict.kind === 'column'
		? resourceForColumn(engine, conflict.table, conflict.column)
		: resourceForColumn(engine, conflict.table);
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
	const tables = new Map<string, TableIR>([
		[
			table.name,
			{
				...table,
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
			if (normalizedCurrent.conflicts.length > 0) {
				return {
					kind: 'unsupported',
					changes: normalizedCurrent.conflicts.map((conflict) =>
						resourceForNormalizationConflict(engine, conflict),
					),
				};
			}
			const currentForComparison = normalizedCurrent.model;
			const desiredComparison = modelForComparison(desired);
			const currentComparison = modelForComparison(currentForComparison);
			if (stableJson(desiredComparison) === stableJson(currentComparison)) {
				return { kind: 'no-drift', claimedInvariant: noDriftProposition() };
			}

			const candidates: TransitionCandidate[] = [];
			const unknownRecognitions: UnknownTransitionRecognition[] = [];
			const unsupported: ResourceAddress[] = [];
			const recognizedColumnKeys = new Set<string>();
			const pendingColumnKeys = new Set<string>();

			const tableNames = new Set<string>([
				...desired.tables.keys(),
				...currentForComparison.tables.keys(),
			]);

			for (const tableName of tableNames) {
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
			}

			const hiddenDiffsRemain =
				stableJson(
					revertRecognizedColumnChanges(
						desired,
						currentForComparison,
						new Set([...recognizedColumnKeys, ...pendingColumnKeys]),
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

			if (unknownRecognitions.length > 0) {
				return {
					kind: 'unknown',
					recognitions: unknownRecognitions,
					obligations: unknownRecognitions.flatMap((entry) => [
						...entry.obligations,
					]),
				};
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
