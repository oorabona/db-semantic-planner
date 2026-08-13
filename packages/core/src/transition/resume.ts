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
	TransitionJournalEvent,
	TransitionRunJournal,
} from '@dbsp/types';
import {
	matchLiveObservationContext,
	matchObservationContextIdentity,
	matchRunObservationContext,
} from './context-match.js';
import { validateExecutionContract } from './execution-contract.js';
import { semanticArtifactId } from './ids.js';
import { transitionPlanDigest } from './plan-digest.js';
import {
	isOperationRuntime,
	type PackRegistry,
	type TransitionExecutionClient,
} from './registry.js';
import { assumptionAccepted } from './resource-scope.js';
import { stableJson } from './stable-json.js';
import {
	acquireTransitionTargetLease,
	isExclusiveTransitionTarget,
	isTransitionLessor,
	type TransitionLease,
	type TransitionReadTarget,
	transitionLessorRejectionAssessment,
} from './transition-lessor.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const RESUMER_ARTIFACT = {
	id: semanticArtifactId('dbsp.core.transition.resume'),
	version: '0.1.0',
};

export interface ResumeTransitionInput {
	readonly journal: VerifiedRecoveryJournal;
	readonly readContext: (
		target: TransitionReadTarget,
		run: TransitionRunJournal['run'],
	) => Promise<ObservationContext>;
	readonly policy?: ApplyPolicy;
	readonly target: TransitionReadTarget;
	readonly admitRecovery?: import('./index.js').TransitionRecoveryAdmission;
}

/**
 * A frozen journal whose run identity, durable digest, external review digest,
 * and plan structure were verified together. The WeakSet is the runtime brand:
 * callers may cast a lookalike, but recovery will not accept it.
 */
export type VerifiedRecoveryJournal = TransitionRunJournal & {
	readonly plan: ProvenPlanShape;
};

export type RecoveryJournalLoadResult =
	| { readonly ok: true; readonly journal: VerifiedRecoveryJournal }
	| {
			readonly ok: false;
			readonly code:
				| 'load-failed'
				| 'run-id-mismatch'
				| 'plan-digest-mismatch'
				| 'plan-invalid'
				| 'event-invalid';
			readonly detail: string;
	  };

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

const verifiedRecoveryJournals = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

function snapshotLoadedRun<T>(value: T): T {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error('loaded transition journal is not JSON serializable');
	}
	return deepFreeze(JSON.parse(serialized) as T);
}

/** Load exactly once, snapshot and freeze the complete durable evidence set. */
export async function loadVerifiedRecoveryJournal(
	runId: string,
	expectedPlanDigest: string,
	loadCurrent: (
		runId: string,
	) => Promise<TransitionRunJournal & { readonly plan: ProvenPlanShape }>,
): Promise<RecoveryJournalLoadResult> {
	let loaded: TransitionRunJournal & { readonly plan: ProvenPlanShape };
	try {
		loaded = snapshotLoadedRun(await loadCurrent(runId));
	} catch (error) {
		return {
			ok: false,
			code: 'load-failed',
			detail: `transition run ${runId} could not be loaded: ${errorDetail(error)}`,
		};
	}
	if (loaded.run.runId !== runId) {
		return {
			ok: false,
			code: 'run-id-mismatch',
			detail: 'loaded journal run id does not match requested run id',
		};
	}
	let observedPlanDigest: string;
	try {
		observedPlanDigest = transitionPlanDigest(loaded.plan);
	} catch (error) {
		return {
			ok: false,
			code: 'plan-invalid',
			detail: `loaded plan could not be digested: ${errorDetail(error)}`,
		};
	}
	if (observedPlanDigest !== expectedPlanDigest) {
		return {
			ok: false,
			code: 'plan-digest-mismatch',
			detail: 'reviewed plan digest does not match the loaded plan',
		};
	}
	if (loaded.run.planDigest !== observedPlanDigest) {
		return {
			ok: false,
			code: 'plan-invalid',
			detail: 'loaded plan digest does not match run metadata',
		};
	}
	try {
		const diagnostic = validateTransitionRelationalInvariants({
			kind: 'plan',
			plan: loaded.plan,
		});
		if (!diagnostic.ok) {
			return { ok: false, code: 'plan-invalid', detail: diagnostic.detail };
		}
	} catch (error) {
		return {
			ok: false,
			code: 'plan-invalid',
			detail: `loaded plan could not be validated: ${errorDetail(error)}`,
		};
	}
	const stepById = new Map(
		loaded.plan.steps.map((step) => [step.stepId, step]),
	);
	const events = groupEvents(loaded.events, loaded.run.runId, stepById);
	if (!events.ok) {
		return { ok: false, code: 'event-invalid', detail: events.detail };
	}
	verifiedRecoveryJournals.add(loaded);
	return { ok: true, journal: loaded };
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
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

/**
 * Every refusal here concerns a run that was already durable, and none of them
 * can read what that run did: the journal could not be loaded, or it was loaded
 * and could not be interpreted, so its completion events — if any — were never
 * validated. `planned` would assert that nothing happened, which is exactly what
 * is unknown. Only a journal that validated and proved itself empty may claim
 * that. The continuation stays `replan-required` rather than `resume-possible`:
 * corrupt or unreadable durable data does not repair itself on retry, whereas
 * replanning observes live state and is safe whatever the earlier run did.
 */
function contextMismatch(
	detail: string,
	journals: readonly StepJournal[] = [],
	observations: readonly IssuedObservation[] = [],
): ApplyResult {
	return {
		assessment: assessment(
			{
				code: 'context-mismatch',
				artifact: RESUMER_ARTIFACT,
				fact: { key: 'resume', value: detail },
				scope: [],
				detail,
			},
			'outcome-unknown',
			'replan-required',
		),
		journals,
		observations,
	};
}

/** The recovery-admission phase owns target-read failures. */
function recoveryReadFailure(detail: string): ApplyResult {
	return {
		...contextMismatch(detail),
		recoveryOutcome: 'recovery-read-failed',
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

function orderedPlanSteps(
	plan: ProvenPlanShape,
	stepById: ReadonlyMap<string, ProvenPlanStep>,
): readonly ProvenPlanStep[] {
	return plan.segments.flatMap((segment) =>
		segment.stepIds
			.map((stepId) => stepById.get(stepId))
			.filter((step): step is ProvenPlanStep => step !== undefined),
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

type StepObservation =
	| {
			readonly ok: true;
			readonly observations: readonly IssuedObservation[];
			readonly fingerprint: FingerprintManifest;
			/** Journal this observation on the same session it was observed from. */
			readonly writeJournal: (journal: StepJournal) => Promise<void>;
	  }
	| {
			readonly ok: false;
			readonly detail: string;
	  };

async function withObservedStep<T>(
	registry: PackRegistry,
	step: ProvenPlanStep,
	target: TransitionReadTarget,
	baseContext: ObservationContext,
	phase: 'before' | 'after',
	use: (observation: StepObservation) => Promise<T>,
): Promise<T> {
	const resolution = registry.resolveOperation(step.operation);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics)) {
		return use({ ok: false, detail: 'operation runtime missing' });
	}
	const runtime = resolution.semantics;
	const issuer = registry.resolveIssuer(step.operation.operationKind.artifact);
	if (!issuer) {
		return use({ ok: false, detail: 'operation observation issuer missing' });
	}
	let lease: TransitionLease | undefined;
	let failed = false;
	let failure: unknown;
	try {
		let observation: StepObservation;
		try {
			lease = await acquireTransitionTargetLease(target);
			const client: TransitionExecutionClient = {
				opaqueClient: lease.session,
				markClientCompromised: () => undefined,
			};
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
				observation = { ok: false, detail: liveContextMatch.detail };
			} else {
				const observed = await runtime.observeOperation(
					client,
					step.operation,
					context,
					phase,
					issuer,
				);
				observation = {
					ok: true,
					observations: observed.observations,
					fingerprint: observed.fingerprint,
					writeJournal: async (journal) =>
						runtime.writeObservedJournal(client, journal),
				};
			}
		} catch (error) {
			failed = true;
			failure = error;
			observation = {
				ok: false,
				detail: errorDetail(error),
			};
		}
		try {
			return await use(observation);
		} catch (error) {
			failed = true;
			failure = error;
			throw error;
		}
	} finally {
		if (lease) {
			await lease.release(failed ? { error: failure } : undefined);
		}
	}
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

function isExecutionAdmissionAssumption(assumption: Assumption): boolean {
	// This gates a fresh durable apply, which `resume` never performs. Recovery
	// must still report the observed state of an already-recorded intent; CLI
	// recovery separately verifies its durable authorization before calling here.
	return assumption.class === 'non-transactional-segment';
}

async function resumeTransitionRunInternal(
	registry: PackRegistry,
	input: ResumeTransitionInput,
	runId: string,
	completed: StepJournal[],
	observations: IssuedObservation[],
): Promise<ApplyResult> {
	if (!verifiedRecoveryJournals.has(input.journal)) {
		return contextMismatch(
			'recovery journal was not loaded and verified by the durable boundary',
		);
	}
	const loaded = input.journal;
	if (loaded.run.runId !== runId) {
		return contextMismatch(
			'loaded journal run id does not match requested run id',
		);
	}
	const stepById = new Map(
		loaded.plan.steps.map((step) => [step.stepId, step]),
	);
	// Event identity is durable evidence, so validate it before interpreting any
	// authorization. A malformed non-empty stream is never a pristine run.
	const groupedResult = groupEvents(loaded.events, loaded.run.runId, stepById);
	if (!groupedResult.ok) {
		return contextMismatch(groupedResult.detail);
	}
	const grouped = groupedResult.grouped;
	if (loaded.events.length === 0) {
		const firstStep = orderedPlanSteps(loaded.plan, stepById)[0];
		if (!firstStep) {
			return {
				assessment: completedAssessment(),
				journals: [],
				observations: [],
			};
		}
		return resumeRequiredResult({
			step: firstStep,
			completed: [],
			observations: [],
		});
	}
	const contract = input.admitRecovery
		? validateExecutionContract(loaded.plan.executionContract)
		: undefined;
	if (contract && !contract.ok) {
		return contextMismatch(
			`recovery admission contract is invalid: ${contract.detail}`,
		);
	}
	const evidenceContext = planEvidenceContext(loaded.plan);
	if (!evidenceContext) {
		return contextMismatch('loaded plan contains no durable evidence context');
	}
	const referencedAssumptions = new Set<string>();
	if (!input.policy) {
		return contextMismatch('attempted recovery has no durable authorization');
	}
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
			!isExecutionAdmissionAssumption(assumption) &&
			!assumptionAccepted(assumption, input.policy)
		) {
			return unacceptedPlanAssumption(loaded.plan, assumption);
		}
	}

	if (
		!isTransitionLessor(input.target) &&
		!isExclusiveTransitionTarget(input.target)
	) {
		// Resume accepts journaled outcomes only after re-observing them through the
		// target, so grouped records alone are not honest result journals here.
		return {
			assessment: transitionLessorRejectionAssessment(
				RESUMER_ARTIFACT,
				loaded.events.length === 0 ? 'planned' : 'outcome-unknown',
			),
			journals: [],
			observations: [],
		};
	}
	// Same contract as the loader above, and for the same reason: a resume that
	// cannot read the live database must return a blocked assessment, not reject
	// its promise. Wrapping only the loader made "database unreachable" behave
	// differently depending on which call the outage landed on.
	let baseContext: ObservationContext;
	try {
		if (input.admitRecovery) {
			if (!contract?.ok)
				return contextMismatch('recovery admission contract is unavailable');
			const admitted = await input.admitRecovery(
				input.target,
				contract.contract,
			);
			if (!admitted.ok) return recoveryReadFailure(admitted.detail);
			baseContext = admitted.context;
		} else {
			baseContext = await input.readContext(input.target, loaded.run);
		}
	} catch (error) {
		return recoveryReadFailure(
			`transition run ${runId} target context could not be read: ${errorDetail(error)}`,
		);
	}
	if (!input.admitRecovery) {
		const runContextMatch = matchRunObservationContext({
			run: loaded.run,
			actual: baseContext,
		});
		if (!runContextMatch.ok) return contextMismatch(runContextMatch.detail);
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
	}
	const operationEffectsByRef = new Map<string, OperationEffectAssessment>();
	for (const step of loaded.plan.steps) {
		const effectsResolution = registry.resolveOperation(step.operation);
		if (!effectsResolution.ok) {
			return contextMismatch(effectsResolution.detail);
		}
		// `effectsOf` belongs to a pack, so it is third-party code reached with a
		// plan and a context this process did not mint. It gets the same treatment.
		try {
			operationEffectsByRef.set(
				step.operation.ref,
				effectsResolution.semantics.effectsOf(step.operation, baseContext),
			);
		} catch (error) {
			return contextMismatch(
				`operation ${step.operation.ref} effects could not be resolved: ${errorDetail(error)}`,
			);
		}
	}
	let semanticDiagnostic: ReturnType<
		typeof validateTransitionRelationalInvariants
	>;
	try {
		semanticDiagnostic = validateTransitionRelationalInvariants({
			kind: 'plan',
			plan: loaded.plan,
			operationEffectsByRef,
		});
	} catch (error) {
		return contextMismatch(
			`loaded plan could not be semantically validated: ${errorDetail(error)}`,
		);
	}
	if (!semanticDiagnostic.ok) {
		return contextMismatch(
			`loaded plan failed semantic invariant validation: ${semanticDiagnostic.detail}`,
		);
	}
	const orderedSteps = orderedPlanSteps(loaded.plan, stepById);

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
			const after = await withObservedStep(
				registry,
				step,
				input.target,
				baseContext,
				'after',
				async (observation) => {
					if (
						!observation.ok ||
						!fingerprintMatches(step.expectedAfter, observation.fingerprint)
					) {
						return {
							kind: 'unmatched' as const,
							detail: observation.ok
								? 'current fingerprint no longer matches expectedAfter'
								: observation.detail,
						};
					}
					const journal =
						observedJournal?.outcome === 'completed'
							? observedJournal
							: completedJournal(intent, completion, observation.observations);
					if (!observedJournal) {
						await observation.writeJournal(journal);
					}
					return {
						kind: 'completed' as const,
						observations: observation.observations,
						journal,
					};
				},
			);
			if (after.kind === 'completed') {
				observations.push(...after.observations);
				completed.push(after.journal);
				continue;
			}
			return unknownResult({
				step,
				completed,
				observations,
				detail: after.detail,
			});
		}

		if (transactional) {
			const before = await withObservedStep(
				registry,
				step,
				input.target,
				baseContext,
				'before',
				async (observation) => ({
					kind:
						observation.ok &&
						fingerprintMatches(step.expectedBefore, observation.fingerprint)
							? ('resume-required' as const)
							: ('unmatched' as const),
					observations: observation.ok ? observation.observations : [],
				}),
			);
			if (before.kind === 'resume-required') {
				observations.push(...before.observations);
				return resumeRequiredResult({
					step,
					completed,
					observations,
				});
			}
			const after = await withObservedStep(
				registry,
				step,
				input.target,
				baseContext,
				'after',
				async (observation) => {
					if (
						!observation.ok ||
						!fingerprintMatches(step.expectedAfter, observation.fingerprint)
					) {
						return { kind: 'unmatched' as const };
					}
					const journal = completedJournal(
						intent,
						undefined,
						observation.observations,
					);
					await observation.writeJournal(journal);
					return {
						kind: 'completed' as const,
						observations: observation.observations,
						journal,
					};
				},
			);
			if (after.kind === 'completed') {
				observations.push(...after.observations);
				completed.push(after.journal);
				continue;
			}
			return unknownResult({
				step,
				completed,
				observations,
				detail:
					'transactional intent had no completion and current state matches neither expectedBefore nor expectedAfter',
			});
		}

		const after = await withObservedStep(
			registry,
			step,
			input.target,
			baseContext,
			'after',
			async (observation) => {
				if (
					!observation.ok ||
					!fingerprintMatches(step.expectedAfter, observation.fingerprint)
				) {
					return { kind: 'unmatched' as const };
				}
				const journal = completedJournal(
					intent,
					undefined,
					observation.observations,
				);
				await observation.writeJournal(journal);
				return {
					kind: 'completed' as const,
					observations: observation.observations,
					journal,
				};
			},
		);
		if (after.kind === 'completed') {
			observations.push(...after.observations);
			completed.push(after.journal);
			continue;
		}
		const before = await withObservedStep(
			registry,
			step,
			input.target,
			baseContext,
			'before',
			async (observation) => ({
				kind:
					observation.ok &&
					fingerprintMatches(step.expectedBefore, observation.fingerprint)
						? ('resume-required' as const)
						: ('unmatched' as const),
				observations: observation.ok ? observation.observations : [],
			}),
		);
		if (before.kind === 'resume-required') {
			observations.push(...before.observations);
			return resumeRequiredResult({
				step,
				completed,
				observations,
			});
		}
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

export async function resumeTransitionRun(
	registry: PackRegistry,
	input: ResumeTransitionInput,
): Promise<ApplyResult> {
	const completed: StepJournal[] = [];
	const observations: IssuedObservation[] = [];
	const runId = input.journal.run.runId;
	// For ordinary failures--an unreachable database, a throwing pack, or a rejected
	// journal write--this boundary returns a blocked assessment with steps reconciled
	// so far rather than rejecting. Inputs engineered to throw from caller-owned
	// accessors are outside this contract: that caller already executes in-process.
	try {
		return await resumeTransitionRunInternal(
			registry,
			input,
			runId,
			completed,
			observations,
		);
	} catch (error) {
		return contextMismatch(
			`transition run ${runId} could not be resumed: ${errorDetail(error)}`,
			completed,
			observations,
		);
	}
}
