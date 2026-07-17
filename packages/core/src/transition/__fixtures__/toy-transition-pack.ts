import type {
	GuardExecutionResult,
	OperationObservation,
	OperationRuntime,
	TransitionExecutionClient,
	TransitionPack,
} from '@dbsp/core';
import type {
	ApplicableEvaluation,
	Assumption,
	AssumptionId,
	ColumnIR,
	EvidenceId,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	JsonValue,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	PhysicalOperation,
	ProofObligation,
	RecognitionResult,
	ResourceAddress,
	RuleEvaluation,
	SemanticArtifactId,
	SemanticArtifactRef,
	TransitionCompositionFact,
	TransitionFragment,
	TransitionFragmentComposition,
	TransitionRule,
} from '@dbsp/types';

const TOY_RULE_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.toy.rules.toydb1'),
	version: '0.1.0',
};

const TOY_OPERATION_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.toy.operations.toydb1'),
	version: '0.1.0',
};

const TOY_SET_REQUIRED_KIND = {
	artifact: TOY_OPERATION_ARTIFACT,
	name: 'ToySetRequired',
} as const;

const TOY_CHOICE_ADD_VALUE_KIND = {
	artifact: TOY_OPERATION_ARTIFACT,
	name: 'ToyChoiceAddValue',
} as const;

const TOY_ENGINE = 'toydb';
const TOY_DATABASE = 'toy-memory';
const TOY_SET_REQUIRED_RULE_ID = 'toy.column.set-required';
const TOY_CHOICE_ADD_VALUE_RULE_ID = 'toy.choice.add-value';
const TOY_SET_REQUIRED_CAPABILITY = 'toy.column.set-required';
const TOY_CHOICE_ADD_VALUE_CAPABILITY = 'toy.choice.add-value';
const TOY_COLUMN_EXISTS = 'toy.column.exists';
const TOY_COLUMN_NO_NULL_VALUES = 'toy.column.no-null-values';
const TOY_CHOICE_VALUE_VISIBLE = 'toy.choice.value-visible';
const TOY_CHOICE_VALUE_ABSENT = 'toy.choice.value-absent';

export type ToyRow = Record<string, unknown>;

export interface ToyDb {
	model: ModelIR;
	rows: Record<string, ToyRow[]>;
}

type ToyColumnPayload = {
	readonly name: string;
	readonly type: ColumnIR['type'];
	readonly nullable: boolean;
	readonly originalDbType?: string;
	readonly default?: JsonValue;
};

type ToyColumnMatch = {
	readonly table: string;
	readonly column: string;
	readonly expectedBefore: ToyColumnPayload;
	readonly expectedAfter: ToyColumnPayload;
	readonly defaultChoiceValue?: string;
};

type ToyChoiceAddValueMatch = ToyColumnMatch & {
	readonly value: string;
};

type ToySetRequiredPayload = JsonValue & {
	readonly table: string;
	readonly column: string;
	readonly expectedBefore: ToyColumnPayload;
	readonly expectedAfter: ToyColumnPayload;
	readonly defaultChoiceValue?: string;
};

type ToyChoiceAddValuePayload = JsonValue & {
	readonly table: string;
	readonly column: string;
	readonly value: string;
	readonly expectedBefore: ToyColumnPayload;
	readonly expectedAfter: ToyColumnPayload;
};

function semanticArtifactId(value: string): SemanticArtifactId {
	return value as SemanticArtifactId;
}

function assumptionId(value: string): AssumptionId {
	return value as AssumptionId;
}

function evidenceId(value: string): EvidenceId {
	return value as EvidenceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonDefault(value: unknown): JsonValue | undefined {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	return undefined;
}

function orderedJson(value: unknown): unknown {
	if (value instanceof Map) {
		return [...value.entries()]
			.sort(([left], [right]) => String(left).localeCompare(String(right)))
			.map(([key, entry]) => [key, orderedJson(entry)]);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => orderedJson(entry));
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, orderedJson(entry)]),
		);
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(orderedJson(value));
}

function toyContext(context: ObservationContext): ObservationContext {
	return {
		...context,
		engine: TOY_ENGINE,
		engineVersion: '1',
		databaseId: TOY_DATABASE,
		capabilities: [
			...new Set([
				...context.capabilities,
				TOY_SET_REQUIRED_CAPABILITY,
				TOY_CHOICE_ADD_VALUE_CAPABILITY,
			]),
		].sort(),
		privileges: [...new Set([...context.privileges, 'toy.ddl'])].sort(),
		sessionConfiguration: context.sessionConfiguration,
		extensions: context.extensions,
	};
}

function columnResource(table: string, column: string): ResourceAddress {
	return {
		engine: TOY_ENGINE,
		database: TOY_DATABASE,
		kind: 'column',
		name: column,
		qualifiedBy: [table],
	};
}

function tableResource(table: string): ResourceAddress {
	return {
		engine: TOY_ENGINE,
		database: TOY_DATABASE,
		kind: 'table',
		name: table,
	};
}

function choiceFact(
	table: string,
	column: string,
	value: string,
): TransitionCompositionFact {
	return {
		kind: TOY_CHOICE_VALUE_VISIBLE,
		resource: columnResource(table, column),
		detail: { table, column, value },
	};
}

function columnPayload(column: ColumnIR): ToyColumnPayload {
	const result: ToyColumnPayload = {
		name: column.name,
		type: column.type,
		nullable: column.nullable,
		...(column.originalDbType ? { originalDbType: column.originalDbType } : {}),
	};
	const defaultValue = jsonDefault(column.default);
	return defaultValue === undefined
		? result
		: { ...result, default: defaultValue };
}

function columnFromPayload(payload: ToyColumnPayload): ColumnIR {
	return {
		name: payload.name,
		type: payload.type,
		nullable: payload.nullable,
		...(payload.originalDbType
			? { originalDbType: payload.originalDbType }
			: {}),
		...(payload.default !== undefined ? { default: payload.default } : {}),
	};
}

function columnDigest(column: ToyColumnPayload): string {
	return stableJson(column);
}

function fingerprint(column: ToyColumnPayload): FingerprintManifest {
	return {
		algorithm: 'toy-stable-json-v1',
		semanticModel: TOY_OPERATION_ARTIFACT,
		includedFacts: [{ key: 'column', value: columnDigest(column) }],
		excludedOrUnknownFacts: [],
		digest: columnDigest(column),
	};
}

function tableAndColumn(model: ModelIR):
	| {
			readonly table: string;
			readonly column: ColumnIR;
	  }
	| undefined {
	const entries = [...model.tables.values()];
	const table = entries[0];
	if (!table || entries.length !== 1 || table.columns.length !== 1) {
		return undefined;
	}
	const column = table.columns[0];
	return column ? { table: table.name, column } : undefined;
}

function currentColumn(
	db: ToyDb,
	table: string,
	column: string,
): ColumnIR | undefined {
	return db.model
		.getTable(table)
		?.columns.find((entry) => entry.name === column);
}

function replaceColumn(
	db: ToyDb,
	tableName: string,
	columnName: string,
	next: ColumnIR,
): void {
	const table = db.model.getTable(tableName);
	if (!table) {
		throw new Error(`toy table ${tableName} does not exist`);
	}
	const columns = table.columns.map((column) =>
		column.name === columnName ? next : column,
	);
	(db.model.tables as Map<string, typeof table>).set(tableName, {
		...table,
		columns,
	});
}

function parseToyChoice(
	type: string | undefined,
): readonly string[] | undefined {
	const match = /^toy_choice\((.*)\)$/.exec(type ?? '');
	if (!match) {
		return undefined;
	}
	const raw = match[1] ?? '';
	return raw
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function toyChoice(values: readonly string[]): string {
	return `toy_choice(${values.join(',')})`;
}

function addedChoiceValue(
	current: ColumnIR,
	desired: ColumnIR,
): string | undefined {
	const before = parseToyChoice(current.originalDbType);
	const after = parseToyChoice(desired.originalDbType);
	if (!before || !after || after.length !== before.length + 1) {
		return undefined;
	}
	for (let index = 0; index < before.length; index += 1) {
		if (before[index] !== after[index]) {
			return undefined;
		}
	}
	const value = after[after.length - 1];
	return value && !before.includes(value) ? value : undefined;
}

function columnWithoutTransitionFields(column: ColumnIR): unknown {
	const {
		nullable: _nullable,
		default: _default,
		originalDbType: _originalDbType,
		...rest
	} = column;
	return rest;
}

function defaultChoiceValue(
	current: ColumnIR,
	desired: ColumnIR,
): string | undefined {
	if (
		desired.default === current.default ||
		typeof desired.default !== 'string'
	) {
		return undefined;
	}
	return desired.default;
}

function visibleChoiceValue(
	column: ColumnIR | undefined,
	value: string,
): boolean {
	return parseToyChoice(column?.originalDbType)?.includes(value) ?? false;
}

function setRequiredMatch(
	desired: ModelIR,
	current: ModelIR,
): ToyColumnMatch | undefined {
	const desiredEntry = tableAndColumn(desired);
	const currentEntry = tableAndColumn(current);
	if (
		!desiredEntry ||
		!currentEntry ||
		desiredEntry.table !== currentEntry.table ||
		desiredEntry.column.name !== currentEntry.column.name ||
		currentEntry.column.nullable !== true ||
		desiredEntry.column.nullable !== false
	) {
		return undefined;
	}
	const defaultValue = defaultChoiceValue(
		currentEntry.column,
		desiredEntry.column,
	);
	if (
		defaultValue !== undefined &&
		!visibleChoiceValue(currentEntry.column, defaultValue)
	) {
		return undefined;
	}
	const expected = {
		...currentEntry.column,
		nullable: false,
		...(defaultValue !== undefined ? { default: defaultValue } : {}),
	};
	if (stableJson(expected) !== stableJson(desiredEntry.column)) {
		return undefined;
	}
	return {
		table: desiredEntry.table,
		column: desiredEntry.column.name,
		expectedBefore: columnPayload(currentEntry.column),
		expectedAfter: columnPayload(desiredEntry.column),
		...(defaultValue !== undefined ? { defaultChoiceValue: defaultValue } : {}),
	};
}

function choiceAddValueMatch(
	desired: ModelIR,
	current: ModelIR,
): ToyChoiceAddValueMatch | undefined {
	const desiredEntry = tableAndColumn(desired);
	const currentEntry = tableAndColumn(current);
	if (
		!desiredEntry ||
		!currentEntry ||
		desiredEntry.table !== currentEntry.table ||
		desiredEntry.column.name !== currentEntry.column.name
	) {
		return undefined;
	}
	if (
		stableJson(columnWithoutTransitionFields(desiredEntry.column)) !==
		stableJson(columnWithoutTransitionFields(currentEntry.column))
	) {
		return undefined;
	}
	const value = addedChoiceValue(currentEntry.column, desiredEntry.column);
	if (!value) {
		return undefined;
	}
	const desiredType = desiredEntry.column.originalDbType;
	if (!desiredType) {
		return undefined;
	}
	const expectedAfter = {
		...currentEntry.column,
		originalDbType: desiredType,
	};
	return {
		table: desiredEntry.table,
		column: desiredEntry.column.name,
		value,
		expectedBefore: columnPayload(currentEntry.column),
		expectedAfter: columnPayload(expectedAfter),
	};
}

function setRequiredOperationRef(match: ToyColumnMatch): string {
	return `toy:set-required:${stableJson([match.table, match.column, match.defaultChoiceValue ?? null])}`;
}

function choiceAddOperationRef(match: ToyChoiceAddValueMatch): string {
	return `toy:choice-add-value:${stableJson([match.table, match.column, match.value])}`;
}

function setRequiredOperation(match: ToyColumnMatch): PhysicalOperation {
	const payload: ToySetRequiredPayload = {
		table: match.table,
		column: match.column,
		expectedBefore: match.expectedBefore,
		expectedAfter: match.expectedAfter,
		...(match.defaultChoiceValue
			? { defaultChoiceValue: match.defaultChoiceValue }
			: {}),
	};
	return {
		ref: setRequiredOperationRef(match),
		operationKind: TOY_SET_REQUIRED_KIND,
		payload,
	};
}

function choiceAddValueOperation(
	match: ToyChoiceAddValueMatch,
): PhysicalOperation {
	const payload: ToyChoiceAddValuePayload = {
		table: match.table,
		column: match.column,
		value: match.value,
		expectedBefore: match.expectedBefore,
		expectedAfter: match.expectedAfter,
	};
	return {
		ref: choiceAddOperationRef(match),
		operationKind: TOY_CHOICE_ADD_VALUE_KIND,
		payload,
	};
}

function columnExistsRequest(match: ToyColumnMatch): ObservationRequest {
	return {
		kind: TOY_COLUMN_EXISTS,
		scope: [columnResource(match.table, match.column)],
		detail: { table: match.table, column: match.column },
	};
}

function noNullValuesRequest(match: ToyColumnMatch): ObservationRequest {
	return {
		kind: TOY_COLUMN_NO_NULL_VALUES,
		scope: [columnResource(match.table, match.column)],
		detail: { table: match.table, column: match.column },
	};
}

function choiceValueRequest(
	kind: typeof TOY_CHOICE_VALUE_VISIBLE | typeof TOY_CHOICE_VALUE_ABSENT,
	match: Pick<ToyChoiceAddValueMatch, 'table' | 'column' | 'value'>,
): ObservationRequest {
	return {
		kind,
		scope: [columnResource(match.table, match.column)],
		detail: { table: match.table, column: match.column, value: match.value },
	};
}

function requestForFact(fact: TransitionCompositionFact): ObservationRequest {
	const request = {
		kind: fact.kind,
		scope: [fact.resource],
	};
	return fact.detail === undefined
		? request
		: { ...request, detail: fact.detail };
}

function obligationFor(
	request: ObservationRequest,
	appliesTo?: string,
): ProofObligation {
	const obligation: ProofObligation = {
		proposition: {
			kind: request.kind,
			scope: request.scope,
			...(request.detail !== undefined ? { detail: request.detail } : {}),
		},
		scope: request.scope,
		dischargeableBy: [request],
	};
	return appliesTo ? { ...obligation, appliesTo } : obligation;
}

function claimHolds(
	evidence: readonly EvidenceObservation[],
	request: ObservationRequest,
): boolean | undefined {
	for (const observation of evidence) {
		if (
			observation.request.kind !== request.kind ||
			stableJson(observation.request.scope) !== stableJson(request.scope) ||
			stableJson(observation.request.detail) !== stableJson(request.detail)
		) {
			continue;
		}
		const claims = isRecord(observation.result.value)
			? observation.result.value.claims
			: undefined;
		if (!Array.isArray(claims)) {
			return undefined;
		}
		for (const claim of claims) {
			if (
				isRecord(claim) &&
				claim.kind === request.kind &&
				typeof claim.holds === 'boolean'
			) {
				return claim.holds;
			}
		}
	}
	return undefined;
}

function operationAssumption(
	table: string,
	column: string,
	operation: string,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.toy.operation-pack-semantics:${stableJson([operation, table, column])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: TOY_OPERATION_ARTIFACT },
		statement: 'toy operation semantics are correct',
		scope: [tableResource(table), columnResource(table, column)],
	};
}

function operationEffects(
	operation: PhysicalOperation,
): OperationEffectAssessment {
	const payload = operation.payload;
	if (!isRecord(payload)) {
		throw new Error('toy operation payload must be an object');
	}
	const table = String(payload.table);
	const column = String(payload.column);
	const resource = columnResource(table, column);
	return {
		effects: {
			reads: [{ kind: 'column', name: column, within: tableResource(table) }],
			writes: [{ kind: 'column', name: column, within: tableResource(table) }],
			locks: [{ resource, mode: 'toy-column-exclusive', order: 0 }],
			invalidates: [
				{ proposition: TOY_COLUMN_EXISTS, scope: { within: resource } },
			],
			contextMutations: [],
			externalEffects: {
				accountedFor: [resource],
				couldNotAccountFor: [],
			},
			execution: {
				transaction: 'joins-current',
				commitBoundary: 'none',
			},
		},
		restsOn: [operationAssumption(table, column, operation.operationKind.name)],
	};
}

function payloadColumn(
	payload: JsonValue,
	key: 'expectedBefore' | 'expectedAfter',
): ToyColumnPayload {
	if (!isRecord(payload) || !isRecord(payload[key])) {
		throw new Error(`toy operation missing ${key} column payload`);
	}
	const column = payload[key];
	if (
		typeof column.name !== 'string' ||
		typeof column.type !== 'string' ||
		typeof column.nullable !== 'boolean'
	) {
		throw new Error(`toy operation has invalid ${key} column payload`);
	}
	return {
		name: column.name,
		type: column.type as ColumnIR['type'],
		nullable: column.nullable,
		...(typeof column.originalDbType === 'string'
			? { originalDbType: column.originalDbType }
			: {}),
		...(column.default !== undefined
			? { default: column.default as JsonValue }
			: {}),
	};
}

function operationColumnRef(operation: PhysicalOperation): {
	readonly table: string;
	readonly column: string;
} {
	const payload = payloadRecord(operation);
	if (typeof payload.table !== 'string' || typeof payload.column !== 'string') {
		throw new Error('toy operation missing table/column payload');
	}
	return { table: payload.table, column: payload.column };
}

function payloadRecord(operation: PhysicalOperation): Record<string, unknown> {
	if (!isRecord(operation.payload)) {
		throw new Error('toy operation payload must be an object');
	}
	return operation.payload;
}

function buildFingerprints(operation: PhysicalOperation): {
	readonly expectedBefore: FingerprintManifest;
	readonly expectedAfter: FingerprintManifest;
} {
	return {
		expectedBefore: fingerprint(
			payloadColumn(operation.payload, 'expectedBefore'),
		),
		expectedAfter: fingerprint(
			payloadColumn(operation.payload, 'expectedAfter'),
		),
	};
}

function evidenceObservation(
	request: ObservationRequest,
	context: ObservationContext,
	holds: boolean,
	value: JsonValue = { claims: [{ kind: request.kind, holds }] },
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId(
			`dbsp.toy.evidence:${request.kind}:${stableJson(request.scope)}:${stableJson(request.detail)}`,
		),
		issuer: TOY_RULE_ARTIFACT,
		request,
		result: { value },
		context,
		stability: 'connection-constant',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['toy-ddl'] },
	};
}

function detailString(
	detail: JsonValue | undefined,
	key: string,
): string | undefined {
	return isRecord(detail) && typeof detail[key] === 'string'
		? detail[key]
		: undefined;
}

function rowsHaveNoNulls(db: ToyDb, table: string, column: string): boolean {
	return (db.rows[table] ?? []).every(
		(row) => row[column] !== null && row[column] !== undefined,
	);
}

function requestHolds(db: ToyDb, request: ObservationRequest): boolean {
	const table = detailString(request.detail, 'table');
	const column = detailString(request.detail, 'column');
	if (!table || !column) {
		return false;
	}
	switch (request.kind) {
		case TOY_COLUMN_EXISTS:
			return currentColumn(db, table, column) !== undefined;
		case TOY_COLUMN_NO_NULL_VALUES:
			return rowsHaveNoNulls(db, table, column);
		case TOY_CHOICE_VALUE_VISIBLE: {
			const value = detailString(request.detail, 'value');
			return value
				? visibleChoiceValue(currentColumn(db, table, column), value)
				: false;
		}
		case TOY_CHOICE_VALUE_ABSENT: {
			const value = detailString(request.detail, 'value');
			return value
				? !visibleChoiceValue(currentColumn(db, table, column), value)
				: false;
		}
		default:
			return false;
	}
}

function createIssuer(db: ToyDb): ObservationIssuer {
	return {
		artifact: TOY_RULE_ARTIFACT,
		readContext: async (_target, context) => toyContext(context),
		execute: async (request, _target, context) =>
			evidenceObservation(
				request,
				toyContext(context),
				requestHolds(db, request),
			),
	};
}

function requiredSetRequiredObservations(
	match: ToyColumnMatch,
): readonly ObservationRequest[] {
	return [
		columnExistsRequest(match),
		noNullValuesRequest(match),
		...(match.defaultChoiceValue
			? [
					requestForFact(
						choiceFact(match.table, match.column, match.defaultChoiceValue),
					),
				]
			: []),
	];
}

function requiredChoiceAddObservations(
	match: ToyChoiceAddValueMatch,
): readonly ObservationRequest[] {
	return [
		columnExistsRequest(match),
		choiceValueRequest(TOY_CHOICE_VALUE_ABSENT, match),
	];
}

function evaluateRequests(
	requests: readonly ObservationRequest[],
	evidence: readonly EvidenceObservation[],
): RuleEvaluation {
	const obligations = requests.map((request) => obligationFor(request));
	const missing = requests.some(
		(request) => claimHolds(evidence, request) === undefined,
	);
	if (missing) {
		return { outcome: 'blocked', obligations, assumptions: [] };
	}
	const refuted = requests.some(
		(request) => claimHolds(evidence, request) !== true,
	);
	if (refuted) {
		return { outcome: 'inapplicable', obligations, assumptions: [] };
	}
	return { outcome: 'applicable', obligations, assumptions: [] };
}

function selectionRationale(rule: TransitionRule) {
	return {
		chosen: { id: rule.id, pack: rule.artifact },
		overRules: [],
		why: 'recognized toy transition rule',
	};
}

function createSetRequiredRule(): TransitionRule<ToyColumnMatch> {
	const rule: TransitionRule<ToyColumnMatch> = {
		id: TOY_SET_REQUIRED_RULE_ID,
		artifact: TOY_RULE_ARTIFACT,
		support: {
			engine: TOY_ENGINE,
			versions: [{ min: '1' }],
			requiredCapabilities: [TOY_SET_REQUIRED_CAPABILITY],
		},
		recognize(desired, current): RecognitionResult<ToyColumnMatch> {
			const match = setRequiredMatch(desired, current);
			return match ? { recognized: true, match } : { recognized: false };
		},
		requiredObservations: requiredSetRequiredObservations,
		declareComposition(match): TransitionFragmentComposition | undefined {
			if (!match.defaultChoiceValue) {
				return undefined;
			}
			const operation = setRequiredOperation(match);
			return {
				requires: [
					{
						opRef: operation.ref,
						fact: choiceFact(
							match.table,
							match.column,
							match.defaultChoiceValue,
						),
						needs: 'producer-after-commit',
					},
				],
			};
		},
		evaluate: (match, evidence) =>
			evaluateRequests(requiredSetRequiredObservations(match), evidence),
		generateCandidate(
			match,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const operation = setRequiredOperation(match);
			const composition = rule.declareComposition?.(
				match,
				toyContext(emptyContext()),
			);
			return {
				generatedBy: { id: rule.id, pack: rule.artifact },
				operations: [operation],
				...(composition ? { composition } : {}),
				obligations: evaluation.obligations.map((obligation) => ({
					...obligation,
					appliesTo: operation.ref,
				})),
				assumptions: evaluation.assumptions,
				guards: [],
				selectionRationale: selectionRationale(rule),
			};
		},
	};
	return rule;
}

function createChoiceAddValueRule(): TransitionRule<ToyChoiceAddValueMatch> {
	const rule: TransitionRule<ToyChoiceAddValueMatch> = {
		id: TOY_CHOICE_ADD_VALUE_RULE_ID,
		artifact: TOY_RULE_ARTIFACT,
		support: {
			engine: TOY_ENGINE,
			versions: [{ min: '1' }],
			requiredCapabilities: [TOY_CHOICE_ADD_VALUE_CAPABILITY],
		},
		recognize(desired, current): RecognitionResult<ToyChoiceAddValueMatch> {
			const match = choiceAddValueMatch(desired, current);
			return match ? { recognized: true, match } : { recognized: false };
		},
		requiredObservations: requiredChoiceAddObservations,
		declareComposition(match): TransitionFragmentComposition {
			const operation = choiceAddValueOperation(match);
			return {
				produces: [
					{
						opRef: operation.ref,
						fact: choiceFact(match.table, match.column, match.value),
						available: 'after-commit',
					},
				],
			};
		},
		evaluate: (match, evidence) =>
			evaluateRequests(requiredChoiceAddObservations(match), evidence),
		generateCandidate(
			match,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const operation = choiceAddValueOperation(match);
			const composition = rule.declareComposition?.(
				match,
				toyContext(emptyContext()),
			);
			return {
				generatedBy: { id: rule.id, pack: rule.artifact },
				operations: [operation],
				...(composition ? { composition } : {}),
				obligations: evaluation.obligations.map((obligation) => ({
					...obligation,
					appliesTo: operation.ref,
				})),
				assumptions: evaluation.assumptions,
				guards: [],
				selectionRationale: selectionRationale(rule),
			};
		},
	};
	return rule;
}

function emptyContext(): ObservationContext {
	return {
		engine: TOY_ENGINE,
		engineVersion: '1',
		databaseId: TOY_DATABASE,
		capabilities: [],
		privileges: [],
		sessionConfiguration: {},
		extensions: {},
	};
}

function isToyOperation(operation: PhysicalOperation): boolean {
	return (
		operation.operationKind.artifact.id === TOY_OPERATION_ARTIFACT.id &&
		operation.operationKind.artifact.version === TOY_OPERATION_ARTIFACT.version
	);
}

function createRuntime(db: ToyDb): OperationRuntime {
	return {
		artifact: TOY_OPERATION_ARTIFACT,
		supportsOperation: isToyOperation,
		effectsOf: operationEffects,
		buildFingerprints,
		checkout: async (): Promise<TransitionExecutionClient> => ({
			opaqueClient: db,
		}),
		release: () => undefined,
		writeIntentJournal: async () => undefined,
		begin: async () => undefined,
		setLockTimeout: async () => undefined,
		acquireLocks: async () => undefined,
		observeContext: async (_client, _operation, context) => toyContext(context),
		observeOperation: async (
			_client,
			operation,
			context,
			_phase,
			issuer,
		): Promise<OperationObservation> => {
			const { table, column } = operationColumnRef(operation);
			const current = currentColumn(db, table, column);
			if (!current) {
				throw new Error(`toy column ${table}.${column} does not exist`);
			}
			const match: ToyColumnMatch = {
				table,
				column,
				expectedBefore: payloadColumn(operation.payload, 'expectedBefore'),
				expectedAfter: payloadColumn(operation.payload, 'expectedAfter'),
			};
			const payload = payloadRecord(operation);
			const requests =
				operation.operationKind.name === TOY_CHOICE_ADD_VALUE_KIND.name
					? requiredChoiceAddObservations({
							...match,
							value: String(payload.value),
						})
					: requiredSetRequiredObservations({
							...match,
							...(typeof payload.defaultChoiceValue === 'string'
								? {
										defaultChoiceValue: payload.defaultChoiceValue,
									}
								: {}),
						});
			const observations: IssuedObservation[] = [];
			for (const request of requests) {
				observations.push(
					await issuer.execute(request, db, toyContext(context)),
				);
			}
			return {
				observations,
				fingerprint: fingerprint(columnPayload(current)),
			};
		},
		checkGuard: async (
			_client,
			_operation,
			guard,
			context,
		): Promise<GuardExecutionResult> => {
			const issuer = createIssuer(db);
			const baseRequest = {
				kind: guard.predicate.kind,
				scope: guard.predicate.scope,
			};
			const request: ObservationRequest =
				guard.predicate.detail === undefined
					? baseRequest
					: { ...baseRequest, detail: guard.predicate.detail };
			const observation = await issuer.execute(request, db, context);
			return {
				passed: requestHolds(db, request),
				observations: [observation],
				recovery: [],
			};
		},
		executeOperation: async (_client, operation) => {
			const { table, column } = operationColumnRef(operation);
			replaceColumn(
				db,
				table,
				column,
				columnFromPayload(payloadColumn(operation.payload, 'expectedAfter')),
			);
		},
		writeCompletionJournal: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined,
		writeObservedJournal: async () => undefined,
		isLockTimeout: () => false,
	};
}

function satisfiesToyChoiceValueVisibleFact(
	fact: TransitionCompositionFact,
	current: ModelIR,
	_context: ObservationContext,
): boolean {
	if (fact.kind !== TOY_CHOICE_VALUE_VISIBLE) {
		return false;
	}
	const table = detailString(fact.detail, 'table');
	const column = detailString(fact.detail, 'column');
	const value = detailString(fact.detail, 'value');
	return table && column && value
		? visibleChoiceValue(
				current.getTable(table)?.columns.find((entry) => entry.name === column),
				value,
			)
		: false;
}

export function toyChoiceDbType(values: readonly string[]): string {
	return toyChoice(values);
}

export function createToyTransitionPack(db: ToyDb): TransitionPack {
	const pack = {
		rules: [createSetRequiredRule(), createChoiceAddValueRule()],
		operationSemantics: [createRuntime(db)],
		issuer: createIssuer(db),
		compositionFactKinds: [TOY_CHOICE_VALUE_VISIBLE],
		satisfiesCompositionFact: (
			fact: TransitionCompositionFact,
			current: ModelIR,
			context: ObservationContext,
		) => satisfiesToyChoiceValueVisibleFact(fact, current, context),
	};
	return pack;
}
