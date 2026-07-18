import type {
	EvidenceObservation,
	JsonValue,
	ObservationContext,
	ObservationRequest,
	ProofObligation,
	Proposition,
	ResourceAddress,
} from '@dbsp/types';
import { matchLiveObservationContext } from './context-match.js';
import { stableJson } from './stable-json.js';

type BooleanEvidenceClaim = {
	readonly kind: string;
	readonly holds: boolean;
	readonly scope?: readonly ResourceAddress[];
	readonly detail?: JsonValue;
	readonly proposition?: unknown;
};

export type EvidenceConclusion =
	| 'established'
	| 'undischarged'
	| 'refuted'
	| 'conflicted';

export type EvidenceEntailmentResult = {
	readonly conclusion: EvidenceConclusion;
	readonly supportedBy: readonly EvidenceObservation[];
};

function isJsonObject(
	value: unknown,
): value is Readonly<Record<string, unknown>> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
	return stableJson(left) === stableJson(right);
}

function sameScope(
	left: readonly ResourceAddress[],
	right: readonly ResourceAddress[],
): boolean {
	return sameJson(left, right);
}

function sameProposition(left: Proposition, right: Proposition): boolean {
	return (
		left.kind === right.kind &&
		sameScope(left.scope, right.scope) &&
		sameJson(left.detail, right.detail)
	);
}

export function observationRequestForProposition(
	proposition: Proposition,
): ObservationRequest {
	return proposition.detail === undefined
		? {
				kind: proposition.kind,
				scope: proposition.scope,
			}
		: {
				kind: proposition.kind,
				scope: proposition.scope,
				detail: proposition.detail,
			};
}

export function sameObservationRequest(
	left: ObservationRequest,
	right: ObservationRequest,
): boolean {
	return (
		left.kind === right.kind &&
		sameScope(left.scope, right.scope) &&
		sameJson(left.detail, right.detail)
	);
}

function normalizeResourceForContext(
	resource: ResourceAddress,
	context: ObservationContext,
): ResourceAddress {
	return {
		...resource,
		database:
			resource.database === 'model' ? context.databaseId : resource.database,
		...(resource.schema == null &&
		context.targetSchema &&
		resource.kind !== 'engine'
			? { schema: context.targetSchema }
			: {}),
	};
}

function normalizeScopeForContext(
	scope: readonly ResourceAddress[],
	context: ObservationContext,
): readonly ResourceAddress[] {
	return scope.map((resource) =>
		normalizeResourceForContext(resource, context),
	);
}

function normalizeRequestDetailForContext(
	detail: ObservationRequest['detail'],
	context: ObservationContext,
): ObservationRequest['detail'] {
	if (!isJsonObject(detail)) {
		return detail;
	}
	if (
		'schema' in detail &&
		(detail.schema === null || detail.schema === undefined) &&
		context.targetSchema
	) {
		return { ...detail, schema: context.targetSchema };
	}
	return detail;
}

export function normalizeObservationRequestForContext(
	request: ObservationRequest,
	context: ObservationContext,
): ObservationRequest {
	const scope = normalizeScopeForContext(request.scope, context);
	const detail = normalizeRequestDetailForContext(request.detail, context);
	return detail === undefined
		? { kind: request.kind, scope }
		: { kind: request.kind, scope, detail };
}

export function normalizePropositionForContext(
	proposition: Proposition,
	context: ObservationContext,
): Proposition {
	const request = normalizeObservationRequestForContext(
		observationRequestForProposition(proposition),
		context,
	);
	return request.detail === undefined
		? { kind: request.kind, scope: request.scope }
		: { kind: request.kind, scope: request.scope, detail: request.detail };
}

export function sameObservationRequestInContext(
	left: ObservationRequest,
	right: ObservationRequest,
	context?: ObservationContext,
): boolean {
	if (!context) {
		return sameObservationRequest(left, right);
	}
	return sameObservationRequest(
		normalizeObservationRequestForContext(left, context),
		normalizeObservationRequestForContext(right, context),
	);
}

function resourceMatchesRequestedScope(
	requested: ResourceAddress,
	observed: ResourceAddress,
	context?: ObservationContext,
): boolean {
	const left = context
		? normalizeResourceForContext(requested, context)
		: requested;
	const right = context
		? normalizeResourceForContext(observed, context)
		: observed;
	return (
		left.engine === right.engine &&
		left.database === right.database &&
		left.kind === right.kind &&
		left.name === right.name &&
		sameJson(left.qualifiedBy, right.qualifiedBy) &&
		left.schema === right.schema
	);
}

function schemaMatchesRequested(
	requested: unknown,
	observed: unknown,
	context?: ObservationContext,
): boolean {
	if (sameJson(requested, observed)) {
		return true;
	}
	return (
		(requested == null && observed == null) ||
		(requested == null &&
			typeof observed === 'string' &&
			context?.targetSchema === observed)
	);
}

function detailMatchesRequested(
	requested: ObservationRequest['detail'],
	observed: ObservationRequest['detail'],
	context?: ObservationContext,
): boolean {
	const left = context
		? normalizeRequestDetailForContext(requested, context)
		: requested;
	const right = context
		? normalizeRequestDetailForContext(observed, context)
		: observed;
	if (sameJson(left, right)) {
		return true;
	}
	if (!isJsonObject(left) || !isJsonObject(right)) {
		return false;
	}
	for (const [key, value] of Object.entries(left)) {
		const observedValue = right[key];
		if (
			key === 'schema' &&
			schemaMatchesRequested(value, observedValue, context)
		) {
			continue;
		}
		if (!sameJson(value, observedValue)) {
			return false;
		}
	}
	for (const key of Object.keys(right)) {
		if (!(key in left)) {
			return false;
		}
	}
	return true;
}

export function observationRequestMatchesInContext(
	requested: ObservationRequest,
	observed: ObservationRequest,
	context?: ObservationContext,
): boolean {
	return (
		requested.kind === observed.kind &&
		requested.scope.length === observed.scope.length &&
		requested.scope.every((resource, index) =>
			resourceMatchesRequestedScope(
				resource,
				observed.scope[index] as ResourceAddress,
				context,
			),
		) &&
		detailMatchesRequested(requested.detail, observed.detail, context)
	);
}

type ConcreteIdentity = ReadonlyMap<string, ReadonlySet<string>>;

const DETAIL_TARGET_IDENTITY_FIELDS = new Set([
	'database',
	'engine',
	'index',
	'label',
	'logicalId',
	'name',
	'object',
	'schema',
	'table',
	'column',
	'constraint',
	'type',
]);

function identityKey(value: unknown): string {
	return stableJson(value);
}

function addConcreteIdentityValue(
	identity: Map<string, Set<string>>,
	field: string,
	value: unknown,
): void {
	if (value === null || value === undefined) {
		return;
	}
	let values = identity.get(field);
	if (!values) {
		values = new Set<string>();
		identity.set(field, values);
	}
	values.add(identityKey(value));
}

function addSchemaIdentityValue(
	identity: Map<string, Set<string>>,
	value: unknown,
	context: ObservationContext,
): void {
	const schema =
		value === null || value === undefined ? context.targetSchema : value;
	addConcreteIdentityValue(identity, 'schema', schema);
}

function addDatabaseIdentityValue(
	identity: Map<string, Set<string>>,
	value: unknown,
	context: ObservationContext,
): void {
	const database = value === 'model' ? context.databaseId : value;
	addConcreteIdentityValue(identity, 'database', database);
}

function addResourceIdentity(
	identity: Map<string, Set<string>>,
	resource: ResourceAddress,
	context: ObservationContext,
): void {
	addConcreteIdentityValue(identity, 'engine', resource.engine);
	addDatabaseIdentityValue(identity, resource.database, context);
	if (
		resource.schema !== undefined ||
		(resource.kind !== 'engine' &&
			resource.kind !== 'database' &&
			context.targetSchema)
	) {
		addSchemaIdentityValue(identity, resource.schema, context);
	}

	switch (resource.kind) {
		case 'engine':
		case 'database':
			return;
		case 'schema':
			addConcreteIdentityValue(identity, 'schema', resource.name);
			return;
		case 'table':
			addConcreteIdentityValue(identity, 'resourceKind', resource.kind);
			addConcreteIdentityValue(identity, 'table', resource.name);
			break;
		case 'column':
			addConcreteIdentityValue(identity, 'resourceKind', resource.kind);
			addConcreteIdentityValue(identity, 'column', resource.name);
			if (resource.qualifiedBy?.[0]) {
				addConcreteIdentityValue(identity, 'table', resource.qualifiedBy[0]);
			}
			break;
		case 'check-constraint':
		case 'constraint':
			addConcreteIdentityValue(identity, 'resourceKind', resource.kind);
			addConcreteIdentityValue(identity, 'constraint', resource.name);
			if (resource.qualifiedBy?.[0]) {
				addConcreteIdentityValue(identity, 'table', resource.qualifiedBy[0]);
			}
			break;
		case 'index':
			addConcreteIdentityValue(identity, 'resourceKind', resource.kind);
			addConcreteIdentityValue(identity, 'index', resource.name);
			if (resource.qualifiedBy?.[0]) {
				addConcreteIdentityValue(identity, 'table', resource.qualifiedBy[0]);
			}
			break;
		case 'type':
			addConcreteIdentityValue(identity, 'resourceKind', resource.kind);
			addConcreteIdentityValue(identity, 'type', resource.name);
			break;
		default:
			addConcreteIdentityValue(identity, 'resourceKind', resource.kind);
			addConcreteIdentityValue(identity, 'name', resource.name);
			if (resource.qualifiedBy) {
				addConcreteIdentityValue(identity, 'qualifiedBy', resource.qualifiedBy);
			}
	}
}

function addRequestDetailIdentity(
	identity: Map<string, Set<string>>,
	detail: ObservationRequest['detail'],
	context: ObservationContext,
): void {
	if (!isJsonObject(detail)) {
		return;
	}
	for (const [field, value] of Object.entries(detail)) {
		if (!DETAIL_TARGET_IDENTITY_FIELDS.has(field)) {
			continue;
		}
		if (field === 'schema') {
			addSchemaIdentityValue(identity, value, context);
		} else if (field === 'database') {
			addDatabaseIdentityValue(identity, value, context);
		} else {
			addConcreteIdentityValue(identity, field, value);
		}
	}
}

function concreteIdentityForRequest(
	request: ObservationRequest,
	context: ObservationContext,
): ConcreteIdentity {
	const identity = new Map<string, Set<string>>();
	for (const resource of request.scope) {
		addResourceIdentity(identity, resource, context);
	}
	addRequestDetailIdentity(identity, request.detail, context);
	return identity;
}

function concreteIdentityMismatch(
	requested: ConcreteIdentity,
	observed: ConcreteIdentity,
	options: { readonly ignoreResourceKind?: boolean } = {},
): string | undefined {
	for (const [field, requestedValues] of requested) {
		if (options.ignoreResourceKind && field === 'resourceKind') {
			continue;
		}
		const observedValues = observed.get(field);
		if (!observedValues || observedValues.size === 0) {
			return field;
		}
		for (const requestedValue of requestedValues) {
			if (!observedValues.has(requestedValue)) {
				return field;
			}
		}
		for (const observedValue of observedValues) {
			if (!requestedValues.has(observedValue)) {
				return field;
			}
		}
	}
	const requestedSchemas = requested.get('schema');
	const observedSchemas = observed.get('schema');
	if (
		(!requestedSchemas || requestedSchemas.size === 0) &&
		observedSchemas &&
		observedSchemas.size > 0
	) {
		return 'schema';
	}
	return undefined;
}

function concreteIdentityIsEmpty(identity: ConcreteIdentity): boolean {
	for (const values of identity.values()) {
		if (values.size > 0) {
			return false;
		}
	}
	return true;
}

const SPECIFIC_TARGET_FIELDS = new Set([
	'column',
	'constraint',
	'index',
	'label',
	'logicalId',
	'object',
	'type',
]);

function hasSpecificTargetField(identity: ConcreteIdentity): boolean {
	for (const field of SPECIFIC_TARGET_FIELDS) {
		if ((identity.get(field)?.size ?? 0) > 0) {
			return true;
		}
	}
	return false;
}

export function observationRequestTargetsSameConcreteIdentity(
	requested: ObservationRequest,
	observed: ObservationRequest,
	context: ObservationContext,
): boolean {
	const requestedIdentity = concreteIdentityForRequest(requested, context);
	if (concreteIdentityIsEmpty(requestedIdentity)) {
		return observationRequestMatchesInContext(requested, observed, context);
	}
	return (
		requested.kind === observed.kind &&
		concreteIdentityMismatch(
			requestedIdentity,
			concreteIdentityForRequest(observed, context),
		) === undefined
	);
}

function observationRequestBindsPropositionTarget(
	observed: ObservationRequest,
	proposition: Proposition,
	context: ObservationContext,
): boolean {
	const requestedIdentity = concreteIdentityForRequest(
		observationRequestForProposition(proposition),
		context,
	);
	if (concreteIdentityIsEmpty(requestedIdentity)) {
		return observationRequestMatchesInContext(
			observationRequestForProposition(proposition),
			observed,
			context,
		);
	}
	return (
		concreteIdentityMismatch(
			requestedIdentity,
			concreteIdentityForRequest(observed, context),
			{ ignoreResourceKind: hasSpecificTargetField(requestedIdentity) },
		) === undefined
	);
}

function sameResource(left: ResourceAddress, right: ResourceAddress): boolean {
	return sameJson(left, right);
}

function resourceCovers(
	carrier: ResourceAddress,
	target: ResourceAddress,
): boolean {
	if (sameResource(carrier, target)) {
		return true;
	}
	return (
		carrier.engine === target.engine &&
		carrier.database === target.database &&
		carrier.schema === target.schema &&
		(target.qualifiedBy?.includes(carrier.name) ?? false)
	);
}

function scopeCarriesProposition(
	carrier: readonly ResourceAddress[],
	target: readonly ResourceAddress[],
): boolean {
	return target.every((resource) =>
		carrier.some((candidate) => resourceCovers(candidate, resource)),
	);
}

function propositionFromClaim(
	claim: BooleanEvidenceClaim,
): Proposition | undefined {
	const proposition = claim.proposition;
	if (isJsonObject(proposition)) {
		const kind = proposition.kind;
		const scope = proposition.scope;
		if (typeof kind === 'string' && Array.isArray(scope)) {
			return proposition.detail === undefined
				? {
						kind,
						scope: scope as readonly ResourceAddress[],
					}
				: {
						kind,
						scope: scope as readonly ResourceAddress[],
						detail: proposition.detail as JsonValue,
					};
		}
	}
	if (claim.scope) {
		return claim.detail === undefined
			? { kind: claim.kind, scope: claim.scope }
			: { kind: claim.kind, scope: claim.scope, detail: claim.detail };
	}
	if (claim.detail !== undefined) {
		return { kind: claim.kind, scope: [], detail: claim.detail };
	}
	return undefined;
}

function requestEnvelopeEntailsProposition(
	request: ObservationRequest,
	claim: BooleanEvidenceClaim,
	proposition: Proposition,
): boolean {
	if (claim.kind !== proposition.kind) {
		return false;
	}
	if (request.kind === proposition.kind) {
		return observationRequestMatchesInContext(
			observationRequestForProposition(proposition),
			request,
		);
	}
	return (
		sameJson(request.detail, proposition.detail) &&
		scopeCarriesProposition(request.scope, proposition.scope)
	);
}

export function claimEntailsProposition(params: {
	readonly evidence: EvidenceObservation;
	readonly claim: BooleanEvidenceClaim;
	readonly proposition: Proposition;
	readonly expectedContext?: ObservationContext;
}): boolean {
	const proposition = params.expectedContext
		? normalizePropositionForContext(params.proposition, params.expectedContext)
		: params.proposition;
	if (params.claim.kind !== proposition.kind) {
		return false;
	}
	if (
		!observationRequestBindsPropositionTarget(
			params.evidence.request,
			proposition,
			params.expectedContext ?? params.evidence.context,
		)
	) {
		return false;
	}
	const claimProposition = propositionFromClaim(params.claim);
	if (claimProposition) {
		const scope =
			claimProposition.scope.length === 0
				? params.evidence.request.scope
				: claimProposition.scope;
		const raw =
			claimProposition.detail === undefined
				? { kind: claimProposition.kind, scope }
				: {
						kind: claimProposition.kind,
						scope,
						detail: claimProposition.detail,
					};
		const normalized = params.expectedContext
			? normalizePropositionForContext(raw, params.expectedContext)
			: raw;
		return sameProposition(normalized, proposition);
	}
	return requestEnvelopeEntailsProposition(
		params.expectedContext
			? normalizeObservationRequestForContext(
					params.evidence.request,
					params.expectedContext,
				)
			: params.evidence.request,
		params.claim,
		proposition,
	);
}

export function evidenceBooleanClaims(
	evidence: EvidenceObservation,
): readonly BooleanEvidenceClaim[] {
	const value = evidence.result.value;
	if (!isJsonObject(value)) {
		return [];
	}
	const claims = value.claims;
	if (Array.isArray(claims)) {
		return claims.flatMap((claim) => {
			if (!isJsonObject(claim)) {
				return [];
			}
			return typeof claim.kind === 'string' && typeof claim.holds === 'boolean'
				? [
						{
							kind: claim.kind,
							holds: claim.holds,
							...(Array.isArray(claim.scope)
								? { scope: claim.scope as readonly ResourceAddress[] }
								: {}),
							...(claim.detail !== undefined
								? { detail: claim.detail as JsonValue }
								: {}),
							...('proposition' in claim
								? { proposition: claim.proposition }
								: {}),
						} as BooleanEvidenceClaim,
					]
				: [];
		});
	}
	if (typeof value.holds === 'boolean') {
		return [
			evidence.request.detail === undefined
				? {
						kind: evidence.request.kind,
						holds: value.holds,
						scope: evidence.request.scope,
					}
				: {
						kind: evidence.request.kind,
						holds: value.holds,
						scope: evidence.request.scope,
						detail: evidence.request.detail,
					},
		];
	}
	return [];
}

function requestMatchesObligation(
	obligation: ProofObligation,
	request: ObservationRequest,
	expectedContext?: ObservationContext,
): boolean {
	const dischargeable = obligation.dischargeableBy ?? [];
	return dischargeable.some((candidate) =>
		expectedContext
			? observationRequestTargetsSameConcreteIdentity(
					candidate,
					request,
					expectedContext,
				)
			: observationRequestMatchesInContext(candidate, request),
	);
}

function evidenceContextMatches(
	evidence: EvidenceObservation,
	expectedContext?: ObservationContext,
): boolean {
	if (!transactionSnapshotContextMatches(evidence, expectedContext)) {
		return false;
	}
	return (
		!expectedContext ||
		matchLiveObservationContext({
			expected: expectedContext,
			actual: evidence.context,
			label: 'evidence observation context',
		}).ok
	);
}

function hasTransactionBinding(context: ObservationContext): boolean {
	return (
		typeof context.transaction === 'string' &&
		context.transaction.trim().length > 0
	);
}

function transactionSnapshotContextMatches(
	evidence: EvidenceObservation,
	expectedContext?: ObservationContext,
): boolean {
	if (evidence.stability !== 'transaction-snapshot') {
		return true;
	}
	return (
		expectedContext !== undefined &&
		hasTransactionBinding(evidence.context) &&
		hasTransactionBinding(expectedContext) &&
		evidence.context.transaction === expectedContext.transaction
	);
}

function conclusionKey(params: {
	readonly evidence: EvidenceObservation;
	readonly proposition: Proposition;
	readonly expectedContext?: ObservationContext;
}): string {
	const context = params.expectedContext;
	const propositionRequest = observationRequestForProposition(
		params.proposition,
	);
	return stableJson({
		request: context
			? normalizeObservationRequestForContext(propositionRequest, context)
			: propositionRequest,
		proposition: params.proposition,
		context: context ?? params.evidence.context,
	});
}

export function concludeEvidenceForObligation(params: {
	readonly obligation: ProofObligation;
	readonly evidence: readonly EvidenceObservation[];
	readonly expectedContext?: ObservationContext;
}): EvidenceEntailmentResult {
	const proposition = params.expectedContext
		? normalizePropositionForContext(
				params.obligation.proposition,
				params.expectedContext,
			)
		: params.obligation.proposition;
	const requestMatches = params.evidence.filter(
		(item) =>
			requestMatchesObligation(
				params.obligation,
				item.request,
				params.expectedContext,
			) && evidenceContextMatches(item, params.expectedContext),
	);
	const entailing: {
		readonly evidence: EvidenceObservation;
		readonly holds: boolean;
		readonly key: string;
	}[] = [];
	for (const item of requestMatches) {
		for (const claim of evidenceBooleanClaims(item)) {
			if (
				claimEntailsProposition({
					evidence: item,
					claim,
					proposition,
					...(params.expectedContext
						? { expectedContext: params.expectedContext }
						: {}),
				})
			) {
				entailing.push({
					evidence: item,
					holds: claim.holds,
					key: conclusionKey({
						evidence: item,
						proposition,
						...(params.expectedContext
							? { expectedContext: params.expectedContext }
							: {}),
					}),
				});
			}
		}
	}
	const grouped = new Map<
		string,
		{
			readonly trueEvidence: EvidenceObservation[];
			readonly falseEvidence: EvidenceObservation[];
		}
	>();
	for (const item of entailing) {
		const current = grouped.get(item.key) ?? {
			trueEvidence: [],
			falseEvidence: [],
		};
		if (item.holds) {
			current.trueEvidence.push(item.evidence);
		} else {
			current.falseEvidence.push(item.evidence);
		}
		grouped.set(item.key, current);
	}
	for (const group of grouped.values()) {
		if (group.trueEvidence.length > 0 && group.falseEvidence.length > 0) {
			return {
				conclusion: 'conflicted',
				supportedBy: [...group.trueEvidence, ...group.falseEvidence],
			};
		}
	}
	const trueEvidence = entailing
		.filter((item) => item.holds)
		.map((item) => item.evidence);
	if (trueEvidence.length > 0) {
		return { conclusion: 'established', supportedBy: trueEvidence };
	}
	const falseEvidence = entailing
		.filter((item) => !item.holds)
		.map((item) => item.evidence);
	if (falseEvidence.length > 0) {
		return { conclusion: 'refuted', supportedBy: falseEvidence };
	}
	return { conclusion: 'undischarged', supportedBy: requestMatches };
}
