import { createHash } from 'node:crypto';
import type {
	ApplyPolicy,
	ApplyResult,
	Assumption,
	DurableIntentRecord,
	EvidenceId,
	FingerprintManifest,
	IssuedObservation,
	ObservationContext,
	OperationEffectAssessment,
	OutcomeReason,
	PlanAssessment,
	ProvenPlanShape,
	ProvenPlanStep,
	RecoveryArtefact,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionConnectionPool,
	TransitionJournalEvent,
	TransitionRunJournal,
	TrustRoot,
} from '@dbsp/types';
import {
	matchLiveObservationContext,
	matchObservationContextIdentity,
	matchRunObservationContext,
} from './context-match.js';
import { semanticArtifactId } from './ids.js';
import {
	isOperationRuntime,
	type OperationRuntime,
	type PackRegistry,
} from './registry.js';
import { stableJson } from './stable-json.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const RESUMER_ARTIFACT = {
	id: semanticArtifactId('dbsp.core.transition.resume'),
	version: '0.1.0',
};

export interface ResumeTransitionInput {
	readonly runId: string;
	readonly loadCurrent: (
		runId: string,
	) => Promise<TransitionRunJournal & { readonly plan: ProvenPlanShape }>;
	readonly readContext: (
		target: TransitionConnectionPool,
		run: TransitionRunJournal['run'],
	) => Promise<ObservationContext>;
	readonly policy: ApplyPolicy;
	readonly target: TransitionConnectionPool;
}

type StepEvents = {
	readonly intent?: TransitionJournalEvent & {
		readonly record: DurableIntentRecord;
	};
	readonly completion?: TransitionJournalEvent & {
		readonly record: TransactionalCompletionRecord;
	};
	readonly observed?: TransitionJournalEvent & { readonly record: StepJournal };
};

type GroupEventsResult =
	| {
			readonly ok: true;
			readonly grouped: ReadonlyMap<string, StepEvents>;
	  }
	| { readonly ok: false; readonly detail: string };

function sameTrustRoot(left: TrustRoot, right: TrustRoot): boolean {
	return stableJson(left) === stableJson(right);
}

function resourceIsWithin(
	resource: Assumption['scope'][number],
	parent: Assumption['scope'][number],
): boolean {
	if (stableJson(resource) === stableJson(parent)) {
		return true;
	}
	return (
		resource.engine === parent.engine &&
		resource.database === parent.database &&
		resource.schema === parent.schema &&
		(resource.qualifiedBy?.includes(parent.name) ?? false)
	);
}

function selectorMatchesResource(
	selector: NonNullable<ApplyPolicy['accepts'][number]['withinScope']>[number],
	resource: Assumption['scope'][number],
): boolean {
	if (selector.within && !resourceIsWithin(resource, selector.within)) {
		return false;
	}
	if (selector.kind && selector.kind !== resource.kind) {
		return false;
	}
	if (selector.schema && selector.schema !== resource.schema) {
		return false;
	}
	if (selector.name && selector.name !== resource.name) {
		return false;
	}
	return true;
}

function assumptionAccepted(
	assumption: Assumption,
	policy: ApplyPolicy,
): boolean {
	return policy.accepts.some((acceptance) => {
		if (acceptance.class !== assumption.class) {
			return false;
		}
		if (
			acceptance.fromTrustRoot &&
			!sameTrustRoot(acceptance.fromTrustRoot, assumption.asserter)
		) {
			return false;
		}
		if (assumption.scope.length === 0) {
			return !acceptance.withinScope || acceptance.withinScope.length === 0;
		}
		if (!acceptance.withinScope || acceptance.withinScope.length === 0) {
			return true;
		}
		return assumption.scope.every((resource) =>
			acceptance.withinScope?.some((selector) =>
				selectorMatchesResource(selector, resource),
			),
		);
	});
}

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function planEvidenceContext(
	plan: ProvenPlanShape,
): ObservationContext | undefined {
	return plan.observations.find(
		(observation) => observation.role === 'evidence',
	)?.context;
}

function assessment(
	reason: OutcomeReason,
	lifecycle: PlanAssessment['lifecycle'],
	continuation: PlanAssessment['continuation'],
): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle,
		continuation,
		reasons: [reason],
	};
}

function completedAssessment(): PlanAssessment {
	return {
		decision: 'applicable',
		assurance: 'accepted-under-assumptions',
		lifecycle: 'completed',
		continuation: 'none',
		reasons: [
			{
				code: 'proven-applicable',
				claim: 'dbsp.transition.resume.completed' as never,
				scope: [],
			},
		],
	};
}

function contextMismatch(detail: string): ApplyResult {
	return {
		assessment: assessment(
			{
				code: 'context-mismatch',
				artifact: RESUMER_ARTIFACT,
				fact: { key: 'resume', value: detail },
				scope: [],
				detail,
			},
			'planned',
			'replan-required',
		),
		journals: [],
		observations: [],
	};
}

function unacceptedStepAssumption(
	plan: ProvenPlanShape,
	step: ProvenPlanStep,
	assumption: Assumption,
): ApplyResult {
	return {
		assessment: assessment(
			{
				code: 'uncomposable',
				fragments: plan.steps.map(
					(candidate) => candidate.selectionRationale.chosen,
				),
				assumption: assumption.id,
				scope: assumption.scope,
				detail: `resume policy did not accept assumption ${assumption.id} required by step ${step.stepId}`,
			},
			'planned',
			'replan-required',
		),
		journals: [],
		observations: [],
	};
}

function unacceptedPlanAssumption(
	plan: ProvenPlanShape,
	assumption: Assumption,
): ApplyResult {
	return {
		assessment: assessment(
			{
				code: 'uncomposable',
				fragments: plan.steps.map((step) => step.selectionRationale.chosen),
				assumption: assumption.id,
				scope: assumption.scope,
				detail: 'resume policy did not accept required plan assumption',
			},
			'planned',
			'replan-required',
		),
		journals: [],
		observations: [],
	};
}

function evidenceIds(
	observations: readonly IssuedObservation[],
): readonly EvidenceId[] {
	return observations
		.filter((observation) => observation.role === 'evidence')
		.map((observation) => observation.id);
}

function recordedAt(): string {
	return new Date().toISOString();
}

function fingerprintMatches(
	expected: FingerprintManifest,
	actual: FingerprintManifest,
): boolean {
	return expected.digest === actual.digest;
}

function eventRecordIsIntent(
	event: TransitionJournalEvent,
): event is TransitionJournalEvent & { readonly record: DurableIntentRecord } {
	return event.event === 'intent';
}

function eventRecordIsCompletion(
	event: TransitionJournalEvent,
): event is TransitionJournalEvent & {
	readonly record: TransactionalCompletionRecord;
} {
	return event.event === 'completion';
}

function eventRecordIsObserved(
	event: TransitionJournalEvent,
): event is TransitionJournalEvent & { readonly record: StepJournal } {
	return event.event === 'observed';
}

function sameOperationShape(
	step: ProvenPlanStep,
	event: TransitionJournalEvent,
): boolean {
	return (
		event.operationRef === step.operation.ref &&
		stableJson(event.operationKind) === stableJson(step.operation.operationKind)
	);
}

function validateIntentRecordIdentity(params: {
	readonly event: TransitionJournalEvent;
	readonly step: ProvenPlanStep;
	readonly record: DurableIntentRecord;
}): string | undefined {
	if (params.record.stepId !== params.event.stepId) {
		return `intent event for ${params.event.stepId} embeds record for ${params.record.stepId}`;
	}
	if (params.record.runId && params.record.runId !== params.event.runId) {
		return `intent record runId ${params.record.runId} does not match event runId ${params.event.runId}`;
	}
	if (params.record.run && params.record.run.runId !== params.event.runId) {
		return `intent record run metadata ${params.record.run.runId} does not match event runId ${params.event.runId}`;
	}
	if (params.record.operation.ref !== params.event.operationRef) {
		return `intent event operationRef ${params.event.operationRef} embeds operation ${params.record.operation.ref}`;
	}
	if (
		stableJson(params.record.operation.operationKind) !==
		stableJson(params.event.operationKind)
	) {
		return `intent event ${params.event.stepId} embeds a different operation kind`;
	}
	if (
		stableJson(params.record.operation) !== stableJson(params.step.operation)
	) {
		return `intent event ${params.event.stepId} embeds an operation that does not match the plan step`;
	}
	return undefined;
}

function validateCompletionRecordIdentity(params: {
	readonly event: TransitionJournalEvent;
	readonly record: TransactionalCompletionRecord;
}): string | undefined {
	if (params.record.stepId !== params.event.stepId) {
		return `completion event for ${params.event.stepId} embeds record for ${params.record.stepId}`;
	}
	if (params.record.runId && params.record.runId !== params.event.runId) {
		return `completion record runId ${params.record.runId} does not match event runId ${params.event.runId}`;
	}
	return undefined;
}

function validateObservedRecordIdentity(params: {
	readonly event: TransitionJournalEvent;
	readonly step: ProvenPlanStep;
	readonly record: StepJournal;
}): string | undefined {
	const intentMismatch = validateIntentRecordIdentity({
		event: params.event,
		step: params.step,
		record: params.record.intent,
	});
	if (intentMismatch) {
		return intentMismatch;
	}
	const completion = params.record.transactionalCompletion;
	if (completion) {
		const completionMismatch = validateCompletionRecordIdentity({
			event: params.event,
			record: completion,
		});
		if (completionMismatch) {
			return completionMismatch;
		}
	}
	const observedOutcome = params.record.observedOutcome;
	if (observedOutcome && observedOutcome.stepId !== params.event.stepId) {
		return `observed event for ${params.event.stepId} embeds observed outcome for ${observedOutcome.stepId}`;
	}
	return undefined;
}

function validateJournalEventIdentity(params: {
	readonly event: TransitionJournalEvent;
	readonly runId: string;
	readonly stepById: ReadonlyMap<string, ProvenPlanStep>;
}): string | undefined {
	if (params.event.runId !== params.runId) {
		return `journal event runId ${params.event.runId} does not match run ${params.runId}`;
	}
	const step = params.stepById.get(params.event.stepId);
	if (!step) {
		return `journal event references missing step ${params.event.stepId}`;
	}
	if (!sameOperationShape(step, params.event)) {
		return `journal event ${params.event.stepId} operation identity does not match the plan step`;
	}
	if (eventRecordIsIntent(params.event)) {
		return validateIntentRecordIdentity({
			event: params.event,
			step,
			record: params.event.record,
		});
	}
	if (eventRecordIsCompletion(params.event)) {
		return validateCompletionRecordIdentity({
			event: params.event,
			record: params.event.record,
		});
	}
	if (eventRecordIsObserved(params.event)) {
		return validateObservedRecordIdentity({
			event: params.event,
			step,
			record: params.event.record,
		});
	}
	return `journal event ${params.event.stepId} has unknown event type ${params.event.event}`;
}

function groupEvents(
	events: readonly TransitionJournalEvent[],
	runId: string,
	stepById: ReadonlyMap<string, ProvenPlanStep>,
): GroupEventsResult {
	const grouped = new Map<string, StepEvents>();
	for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
		const identityMismatch = validateJournalEventIdentity({
			event,
			runId,
			stepById,
		});
		if (identityMismatch) {
			return { ok: false, detail: identityMismatch };
		}
		const current = grouped.get(event.stepId) ?? {};
		if (eventRecordIsIntent(event)) {
			grouped.set(event.stepId, { ...current, intent: event });
			continue;
		}
		if (eventRecordIsCompletion(event)) {
			grouped.set(event.stepId, { ...current, completion: event });
			continue;
		}
		if (eventRecordIsObserved(event)) {
			grouped.set(event.stepId, { ...current, observed: event });
		}
	}
	return { ok: true, grouped };
}

function latestIntent(
	step: ProvenPlanStep,
	events: StepEvents | undefined,
): DurableIntentRecord {
	return (
		events?.intent?.record ??
		events?.observed?.record.intent ?? {
			stepId: step.stepId,
			operation: step.operation,
			recordedAt: recordedAt(),
		}
	);
}

function resumeRequiredResult(params: {
	readonly step: ProvenPlanStep;
	readonly completed: readonly StepJournal[];
	readonly observations: readonly IssuedObservation[];
	readonly recovery?: readonly RecoveryArtefact[];
}): ApplyResult {
	const hasCompleted = params.completed.length > 0;
	return {
		assessment: assessment(
			{
				code: 'resume-required',
				stepId: params.step.stepId,
				recovery: params.recovery ?? [],
				scope: [],
				detail:
					'remaining work is known after reconciliation; re-prove from the observed state before applying it',
			},
			hasCompleted ? 'partially-applied' : 'planned',
			'resume-possible',
		),
		journals: params.completed,
		observations: params.observations,
	};
}

function unknownResult(params: {
	readonly step: ProvenPlanStep;
	readonly completed: readonly StepJournal[];
	readonly observations: readonly IssuedObservation[];
	readonly journal?: StepJournal;
	readonly detail?: string;
}): ApplyResult {
	const journals = params.journal
		? [...params.completed, params.journal]
		: params.completed;
	return {
		assessment: assessment(
			{
				code: 'unknown-step-result',
				stepId: params.step.stepId,
				operationKind: params.step.operation.operationKind,
				operationRef: params.step.operation.ref,
				scope: [],
				...(params.detail ? { detail: params.detail } : {}),
			},
			'outcome-unknown',
			'human-intervention-required',
		),
		journals,
		observations: params.observations,
	};
}

function stoppedJournalResult(params: {
	readonly plan: ProvenPlanShape;
	readonly step: ProvenPlanStep;
	readonly journal: StepJournal;
	readonly completed: readonly StepJournal[];
	readonly observations: readonly IssuedObservation[];
}): ApplyResult {
	const hasCompleted = params.completed.length > 0;
	switch (params.journal.outcome) {
		case 'guard-timeout':
			return {
				assessment: assessment(
					{
						code: 'guard-timeout',
						stepId: params.step.stepId,
						operationKind: params.step.operation.operationKind,
						operationRef: params.step.operation.ref,
						scope: [],
					},
					hasCompleted ? 'partially-applied' : 'planned',
					hasCompleted ? 'resume-possible' : 'replan-required',
				),
				journals: [...params.completed, params.journal],
				observations: params.observations,
			};
		case 'guard-failed':
			return {
				assessment: assessment(
					{
						code: 'guard-failed',
						stepId: params.step.stepId,
						operationKind: params.step.operation.operationKind,
						operationRef: params.step.operation.ref,
						scope: [],
						recovery: params.journal.recovery ?? [],
					},
					hasCompleted ? 'partially-applied' : 'planned',
					hasCompleted ? 'resume-possible' : 'replan-required',
				),
				journals: [...params.completed, params.journal],
				observations: params.observations,
			};
		case 'operation-failed-not-applied':
			return {
				assessment: assessment(
					{
						code: 'operation-failed-not-applied',
						stepId: params.step.stepId,
						operationKind: params.step.operation.operationKind,
						operationRef: params.step.operation.ref,
						scope: [],
						detail:
							'journal reports a rolled-back operation failure; no work from that segment was completed',
					},
					hasCompleted ? 'partially-applied' : 'planned',
					hasCompleted ? 'resume-possible' : 'replan-required',
				),
				journals: [...params.completed, params.journal],
				observations: params.observations,
			};
		case 'partially-applied':
			return {
				assessment: assessment(
					{
						code: 'partially-applied',
						stepId: params.step.stepId,
						operationKind: params.step.operation.operationKind,
						operationRef: params.step.operation.ref,
						scope: [],
						...(params.journal.recovery
							? { recovery: params.journal.recovery }
							: {}),
						detail:
							'journal reports a partial outcome; recovery requires a human or adapter-proven repair action',
					},
					'partially-applied',
					'human-intervention-required',
				),
				journals: [...params.completed, params.journal],
				observations: params.observations,
			};
		case 'unknown-step-result':
		case 'context-mismatch':
			return unknownResult({
				step: params.step,
				completed: params.completed,
				observations: params.observations,
				journal: params.journal,
				detail: `journal reports ${params.journal.outcome}`,
			});
		case 'completed':
			throw new Error('completed journal passed to stoppedJournalResult');
	}
}

function completedJournal(
	intent: DurableIntentRecord,
	completion: TransactionalCompletionRecord | undefined,
	observations: readonly IssuedObservation[],
): StepJournal {
	const observedOutcome = {
		stepId: intent.stepId,
		observations: evidenceIds(observations),
		recordedAt: recordedAt(),
	};
	return completion
		? {
				intent,
				outcome: 'completed',
				transactionalCompletion: completion,
				observedOutcome,
			}
		: {
				intent,
				outcome: 'completed',
				observedOutcome,
			};
}

type ObservationAttempt =
	| {
			readonly ok: true;
			readonly observations: readonly IssuedObservation[];
			readonly fingerprint: FingerprintManifest;
			readonly client: Awaited<ReturnType<OperationRuntime['checkout']>>;
			readonly runtime: OperationRuntime;
	  }
	| {
			readonly ok: false;
			readonly detail: string;
	  };

async function observeStep(
	registry: PackRegistry,
	step: ProvenPlanStep,
	target: TransitionConnectionPool,
	baseContext: ObservationContext,
	phase: 'before' | 'after',
): Promise<ObservationAttempt> {
	const resolution = registry.resolveOperation(step.operation);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics)) {
		return { ok: false, detail: 'operation runtime missing' };
	}
	const runtime = resolution.semantics;
	const issuer = registry.resolveIssuer(step.operation.operationKind.artifact);
	if (!issuer) {
		return { ok: false, detail: 'operation observation issuer missing' };
	}
	let client: Awaited<ReturnType<OperationRuntime['checkout']>> | undefined;
	try {
		client = await runtime.checkout(target);
		let context = await runtime.observeContext(
			client,
			step.operation,
			baseContext,
		);
		context = registry.contextWithDerivedCapabilities(context);
		const liveContextMatch = matchLiveObservationContext({
			expected: baseContext,
			actual: context,
		});
		if (!liveContextMatch.ok) {
			await runtimeSafeRelease(runtime, client);
			return { ok: false, detail: liveContextMatch.detail };
		}
		const observed = await runtime.observeOperation(
			client,
			step.operation,
			context,
			phase,
			issuer,
		);
		return {
			ok: true,
			observations: observed.observations,
			fingerprint: observed.fingerprint,
			client,
			runtime,
		};
	} catch (error) {
		if (client) {
			await runtimeSafeRelease(
				resolution.ok && isOperationRuntime(resolution.semantics)
					? resolution.semantics
					: undefined,
				client,
				error,
			);
		}
		return {
			ok: false,
			detail: error instanceof Error ? error.message : 'observation failed',
		};
	}
}

async function runtimeSafeRelease(
	runtime: OperationRuntime | undefined,
	client: Awaited<ReturnType<OperationRuntime['checkout']>>,
	error?: unknown,
): Promise<void> {
	if (!runtime) {
		return;
	}
	try {
		await runtime.release(client, error);
	} catch {
		// Resume reconciliation outcome must not be masked by cleanup.
	}
}

async function releaseObservedAttempt(
	attempt: ObservationAttempt,
	error?: unknown,
): Promise<void> {
	if (attempt.ok) {
		await runtimeSafeRelease(attempt.runtime, attempt.client, error);
	}
}

async function writeObserved(
	attempt: ObservationAttempt,
	journal: StepJournal,
): Promise<void> {
	if (!attempt.ok) {
		return;
	}
	await attempt.runtime.writeObservedJournal(attempt.client, journal);
}

function stepAssumption(
	plan: ProvenPlanShape,
	assumptionId: string,
): Assumption | undefined {
	return plan.assumptions.find((assumption) => assumption.id === assumptionId);
}

function validatePolicyForStep(
	plan: ProvenPlanShape,
	step: ProvenPlanStep,
	policy: ApplyPolicy,
): ApplyResult | undefined {
	for (const assumptionId of step.restsOnAssumptions) {
		const assumption = stepAssumption(plan, assumptionId);
		if (assumption && !assumptionAccepted(assumption, policy)) {
			return unacceptedStepAssumption(plan, step, assumption);
		}
	}
	return undefined;
}

export async function resumeTransitionRun(
	registry: PackRegistry,
	input: ResumeTransitionInput,
): Promise<ApplyResult> {
	const loaded = await input.loadCurrent(input.runId);
	if (loaded.run.runId !== input.runId) {
		return contextMismatch(
			'loaded journal run id does not match requested run id',
		);
	}
	if (loaded.run.planDigest !== digest(loaded.plan)) {
		return contextMismatch('loaded plan digest does not match run metadata');
	}
	const diagnostic = validateTransitionRelationalInvariants({
		kind: 'plan',
		plan: loaded.plan,
	});
	if (!diagnostic.ok) {
		return contextMismatch(
			`loaded plan failed invariant validation: ${diagnostic.detail}`,
		);
	}
	const evidenceContext = planEvidenceContext(loaded.plan);
	if (!evidenceContext) {
		return contextMismatch('loaded plan contains no durable evidence context');
	}
	const baseContext = await input.readContext(input.target, loaded.run);
	const runContextMatch = matchRunObservationContext({
		run: loaded.run,
		actual: baseContext,
	});
	if (!runContextMatch.ok) {
		return contextMismatch(runContextMatch.detail);
	}
	const evidenceIdentityMatch = matchObservationContextIdentity({
		expected: baseContext,
		actual: evidenceContext,
		label: 'loaded plan evidence context',
	});
	if (!evidenceIdentityMatch.ok) {
		return contextMismatch(
			`loaded plan evidence context does not match run proof context: ${evidenceIdentityMatch.detail}`,
		);
	}
	const operationEffectsByRef = new Map<string, OperationEffectAssessment>();
	for (const step of loaded.plan.steps) {
		const effectsResolution = registry.resolveOperation(step.operation);
		if (!effectsResolution.ok) {
			return contextMismatch(effectsResolution.detail);
		}
		operationEffectsByRef.set(
			step.operation.ref,
			effectsResolution.semantics.effectsOf(step.operation, baseContext),
		);
	}
	const semanticDiagnostic = validateTransitionRelationalInvariants({
		kind: 'plan',
		plan: loaded.plan,
		operationEffectsByRef,
	});
	if (!semanticDiagnostic.ok) {
		return contextMismatch(
			`loaded plan failed semantic invariant validation: ${semanticDiagnostic.detail}`,
		);
	}

	const referencedAssumptions = new Set<string>();
	for (const step of loaded.plan.steps) {
		for (const assumptionId of step.restsOnAssumptions) {
			referencedAssumptions.add(assumptionId);
		}
		const policyFailure = validatePolicyForStep(
			loaded.plan,
			step,
			input.policy,
		);
		if (policyFailure) {
			return policyFailure;
		}
	}
	for (const assumption of loaded.plan.assumptions) {
		if (
			!referencedAssumptions.has(assumption.id) &&
			!assumptionAccepted(assumption, input.policy)
		) {
			return unacceptedPlanAssumption(loaded.plan, assumption);
		}
	}

	const stepById = new Map(
		loaded.plan.steps.map((step) => [step.stepId, step]),
	);
	const groupedResult = groupEvents(loaded.events, loaded.run.runId, stepById);
	if (!groupedResult.ok) {
		return contextMismatch(groupedResult.detail);
	}
	const grouped = groupedResult.grouped;
	const orderedSteps = loaded.plan.segments.flatMap((segment) =>
		segment.stepIds.map((stepId) => stepById.get(stepId)).filter(Boolean),
	) as ProvenPlanStep[];
	const completed: StepJournal[] = [];
	const observations: IssuedObservation[] = [];

	for (const step of orderedSteps) {
		const events = grouped.get(step.stepId);
		if (!events?.intent && !events?.observed) {
			return resumeRequiredResult({
				step,
				completed,
				observations,
			});
		}
		const intent = latestIntent(step, events);
		const observedJournal = events?.observed?.record;
		if (observedJournal && observedJournal.outcome !== 'completed') {
			return stoppedJournalResult({
				plan: loaded.plan,
				step,
				journal: observedJournal,
				completed,
				observations,
			});
		}

		const completion = events?.completion?.record;
		const effects = operationEffectsByRef.get(step.operation.ref);
		if (!effects) {
			return unknownResult({
				step,
				completed,
				observations,
				detail: 'operation effects missing',
			});
		}
		const transactional =
			effects.effects.execution.transaction !== 'forbids-transaction';

		if (observedJournal?.outcome === 'completed' || completion) {
			const after = await observeStep(
				registry,
				step,
				input.target,
				baseContext,
				'after',
			);
			if (
				after.ok &&
				fingerprintMatches(step.expectedAfter, after.fingerprint)
			) {
				observations.push(...after.observations);
				const journal =
					observedJournal?.outcome === 'completed'
						? observedJournal
						: completedJournal(intent, completion, after.observations);
				if (!observedJournal) {
					await writeObserved(after, journal);
				}
				await releaseObservedAttempt(after);
				completed.push(journal);
				continue;
			}
			await releaseObservedAttempt(after);
			return unknownResult({
				step,
				completed,
				observations,
				detail: after.ok
					? 'current fingerprint no longer matches expectedAfter'
					: after.detail,
			});
		}

		if (transactional) {
			const before = await observeStep(
				registry,
				step,
				input.target,
				baseContext,
				'before',
			);
			if (
				before.ok &&
				fingerprintMatches(step.expectedBefore, before.fingerprint)
			) {
				observations.push(...before.observations);
				await releaseObservedAttempt(before);
				return resumeRequiredResult({
					step,
					completed,
					observations,
				});
			}
			await releaseObservedAttempt(before);
			const after = await observeStep(
				registry,
				step,
				input.target,
				baseContext,
				'after',
			);
			if (
				after.ok &&
				fingerprintMatches(step.expectedAfter, after.fingerprint)
			) {
				observations.push(...after.observations);
				const journal = completedJournal(intent, undefined, after.observations);
				await writeObserved(after, journal);
				await releaseObservedAttempt(after);
				completed.push(journal);
				continue;
			}
			await releaseObservedAttempt(after);
			return unknownResult({
				step,
				completed,
				observations,
				detail:
					'transactional intent had no completion and current state matches neither expectedBefore nor expectedAfter',
			});
		}

		const after = await observeStep(
			registry,
			step,
			input.target,
			baseContext,
			'after',
		);
		if (after.ok && fingerprintMatches(step.expectedAfter, after.fingerprint)) {
			observations.push(...after.observations);
			const journal = completedJournal(intent, undefined, after.observations);
			await writeObserved(after, journal);
			await releaseObservedAttempt(after);
			completed.push(journal);
			continue;
		}
		await releaseObservedAttempt(after);
		const before = await observeStep(
			registry,
			step,
			input.target,
			baseContext,
			'before',
		);
		if (
			before.ok &&
			fingerprintMatches(step.expectedBefore, before.fingerprint)
		) {
			observations.push(...before.observations);
			await releaseObservedAttempt(before);
			return resumeRequiredResult({
				step,
				completed,
				observations,
			});
		}
		await releaseObservedAttempt(before);
		return unknownResult({
			step,
			completed,
			observations,
			detail:
				'non-atomic intent had no completion and adapter observation could not classify it as completed or absent',
		});
	}

	return {
		assessment: completedAssessment(),
		journals: completed,
		observations,
	};
}
