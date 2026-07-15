import type { ModelIR } from '../model-ir.js';
import type {
	AdvisoryObservation,
	AdvisoryObservationId,
	ApplicableAssessment,
	ApplyGuard,
	ApplyResult,
	Assumption,
	AssumptionId,
	ClaimId,
	Comparator,
	CompareOutcome,
	EvidenceId,
	EvidenceObservation,
	GuardedPlan,
	GuardedPlanStep,
	GuardPredicate,
	GuardProtocol,
	IssuedObservation,
	LockRequirement,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	ObservationResult,
	OperationEffects,
	OperationKindRef,
	OperationSemantics,
	OutcomeReason,
	PhysicalOperation,
	PlanAssessment,
	ProofClaim,
	ProofObligation,
	Proposition,
	ProvenPlanShape,
	ProvenPlanStep,
	RecognitionResult,
	RecoveryArtefact,
	ResourceAddress,
	RuleEvaluation,
	SemanticArtifactRef,
	SerializedProvenPlan,
	StepJournal,
	TargetBinding,
	TransitionCandidate,
	TransitionFragment,
	TransitionRule,
	UnsafeNativeFragment,
} from './index.js';

declare const advisoryObservation: AdvisoryObservation;
declare const advisoryObservationId: AdvisoryObservationId;
declare const applyGuard: ApplyGuard;
declare const applicableAssessment: ApplicableAssessment;
declare const assessment: PlanAssessment;
declare const assumption: Assumption;
declare const assumptionId: AssumptionId;
declare const claimId: ClaimId;
declare const comparator: Comparator;
declare const compareOutcome: CompareOutcome;
declare const currentModel: ModelIR;
declare const desiredModel: ModelIR;
declare const evidenceId: EvidenceId;
declare const evidenceObservation: EvidenceObservation;
declare const guardedPlan: GuardedPlan;
declare const guardedPlanStep: GuardedPlanStep;
declare const issuedObservation: IssuedObservation;
declare const observationContext: ObservationContext;
declare const observationRequest: ObservationRequest;
declare const operationEffects: OperationEffects;
declare const operationKindRef: OperationKindRef;
declare const physicalOperation: PhysicalOperation;
declare const proofObligation: ProofObligation;
declare const provenPlanShape: ProvenPlanShape;
declare const proposition: Proposition;
declare const resourceAddress: ResourceAddress;
declare const semanticArtifactRef: SemanticArtifactRef;
declare const serializedPlan: SerializedProvenPlan;
declare const transitionCandidate: TransitionCandidate;
declare const transitionFragment: TransitionFragment;
declare const transitionRule: TransitionRule;

declare function acceptsApplicableAssessment(
	assessment: ApplicableAssessment,
): void;
declare function acceptsApplyGuard(guard: ApplyGuard): void;
declare function acceptsApplyResult(result: ApplyResult): void;
declare function acceptsCompareOutcome(outcome: CompareOutcome): void;
declare function acceptsEvidenceSource(
	source: EvidenceObservation['source'],
): void;
declare function acceptsEvidenceStability(
	stability: EvidenceObservation['stability'],
): void;
declare function acceptsGuardPredicate(predicate: GuardPredicate): void;
declare function acceptsGuardProtocol(protocol: GuardProtocol): void;
declare function acceptsLockRequirement(requirement: LockRequirement): void;
declare function acceptsObservationContext(context: ObservationContext): void;
declare function acceptsObservationRequest(request: ObservationRequest): void;
declare function acceptsObservationResult(result: ObservationResult): void;
declare function acceptsOutcomeReason(reason: OutcomeReason): void;
declare function acceptsPhysicalOperation(operation: PhysicalOperation): void;
declare function acceptsPlanAssessment(assessment: PlanAssessment): void;
declare function acceptsProofClaim(claim: ProofClaim): void;
declare function acceptsProvenPlanShape(plan: ProvenPlanShape): void;
declare function acceptsProvenPlanStep(step: ProvenPlanStep): void;
declare function acceptsSerializedProvenPlan(plan: SerializedProvenPlan): void;
declare function acceptsProposition(proposition: Proposition): void;
declare function acceptsRecognitionResult<TMatch>(
	result: RecognitionResult<TMatch>,
): void;
declare function acceptsRecoveryArtefact(artefact: RecoveryArtefact): void;
declare function acceptsResourceAddress(address: ResourceAddress): void;
declare function acceptsRuleEvaluation(evaluation: RuleEvaluation): void;
declare function acceptsSemanticArtifactRef(ref: SemanticArtifactRef): void;
declare function acceptsStepGuards(guards: readonly ApplyGuard[]): void;
declare function acceptsStepJournal(journal: StepJournal): void;
declare function acceptsSupportedBy(
	supportedBy: ProofClaim['supportedBy'],
): void;
declare function acceptsTargetBinding(binding: TargetBinding): void;
declare function acceptsTransitionCandidate(
	candidate: TransitionCandidate,
): void;
declare function acceptsTransitionFragment(fragment: TransitionFragment): void;
declare function acceptsUnsafeNativeFragment(
	fragment: UnsafeNativeFragment,
): void;

// @ts-expect-error Advisory observations are not durable evidence.
acceptsSupportedBy([advisoryObservationId]);

acceptsStepGuards(guardedPlanStep.guards);

// @ts-expect-error A non-impossible guard protocol cannot be unbindable.
acceptsGuardProtocol({
	kind: 'lock-and-check',
	onFailureLeaves: [],
	binding: { kind: 'unbindable' },
});

acceptsGuardProtocol({
	kind: 'lock-and-check',
	onFailureLeaves: [],
	binding: { kind: 'stable-identity', bound: [], identityClaim: claimId },
	// @ts-expect-error Guard protocols do not carry discharge state.
	discharged: true,
});

acceptsGuardProtocol({
	kind: 'lock-and-check',
	onFailureLeaves: [{ kind: 'invalid-index', resource: resourceAddress }],
	binding: { kind: 'stable-identity', bound: [], identityClaim: claimId },
});

acceptsGuardProtocol({
	kind: 'impossible',
	onFailureLeaves: [],
	binding: { kind: 'unbindable' },
});

// @ts-expect-error Apply guards do not carry discharge state.
applyGuard.discharged;

// @ts-expect-error Guarded plan steps do not carry discharge state.
guardedPlanStep.discharged;

// @ts-expect-error Evidence observations cannot come from data probes.
acceptsEvidenceSource('data-probe');

// @ts-expect-error Evidence observations cannot come from user assertions.
acceptsEvidenceSource('user-assertion');

// @ts-expect-error Evidence observations cannot be historical-only rehearsal output.
acceptsEvidenceStability('historical-only');

// @ts-expect-error A plan assessment is structured, not a scalar verdict.
acceptsPlanAssessment(true);

// @ts-expect-error The assurance, lifecycle, and continuation axes are required.
acceptsPlanAssessment({
	decision: 'applicable',
	reasons: [],
});

// @ts-expect-error Artifact id and version are separate fields; id is branded and version is required.
acceptsSemanticArtifactRef({ id: 'x@1' });

acceptsApplicableAssessment(applicableAssessment);

acceptsApplicableAssessment({
	// @ts-expect-error Applicable assessments cannot be blocked.
	decision: 'blocked',
	assurance: 'established',
	lifecycle: 'planned',
	continuation: 'none',
	reasons: [],
});

acceptsApplicableAssessment({
	decision: 'applicable',
	// @ts-expect-error Applicable assessments cannot remain unproven.
	assurance: 'unproven',
	lifecycle: 'planned',
	continuation: 'none',
	reasons: [],
});

const _provenPlanShapeIsSerializableGuardedPlan: GuardedPlan = provenPlanShape;
acceptsSerializedProvenPlan(serializedPlan);

transitionRule.generateCandidate(undefined, {
	// @ts-expect-error A blocked rule evaluation cannot generate operations.
	outcome: 'blocked',
	obligations: [],
	assumptions: [],
});

transitionRule.generateCandidate(undefined, {
	// @ts-expect-error An inapplicable rule evaluation cannot generate operations.
	outcome: 'inapplicable',
	obligations: [],
	assumptions: [],
});

acceptsRuleEvaluation({
	outcome: 'inapplicable',
	obligations: [proofObligation],
	assumptions: [assumption],
});

// @ts-expect-error Rule evaluation only sees durable evidence.
transitionRule.evaluate(undefined, [advisoryObservation], []);

transitionRule.evaluate(
	undefined,
	[evidenceObservation],
	[advisoryObservation],
);
transitionRule.recognize(desiredModel, currentModel);

type TypedMatch = { readonly operationRef: string };
declare const typedRule: TransitionRule<TypedMatch>;

const typedRecognition = typedRule.recognize(desiredModel, currentModel);
if (typedRecognition.recognized) {
	typedRule.requiredObservations(typedRecognition.match);
	typedRule.evaluate(typedRecognition.match, [evidenceObservation], []);
	typedRule.generateCandidate(typedRecognition.match, {
		outcome: 'applicable',
		obligations: [],
		assumptions: [],
	});
}

typedRule.requiredObservations({
	// @ts-expect-error Transition rule match values flow into later rule phases.
	wrong: 'shape',
});

// @ts-expect-error Observation contexts must name capabilities and privileges.
acceptsObservationContext({
	engine: 'postgresql',
	engineVersion: '17',
	databaseId: 'db',
	sessionConfiguration: {},
	extensions: {},
});

declare const observationIssuer: ObservationIssuer;

// @ts-expect-error Observation execution receives the observation context.
observationIssuer.execute(observationRequest, {});

comparator.compare(desiredModel, currentModel);

// @ts-expect-error Observation issuers are judgement producers and own an artifact.
const _observationIssuerWithoutArtifact: ObservationIssuer = {
	execute: async () => issuedObservation,
};

// @ts-expect-error Comparators are judgement producers and own an artifact.
const _comparatorWithoutArtifact: Comparator = {
	compare: () => ({ kind: 'no-drift', claimedInvariant: proposition }),
};

// @ts-expect-error Operation semantics are judgement producers and own an artifact.
const _operationSemanticsWithoutArtifact: OperationSemantics = {
	effectsOf: () => ({ effects: operationEffects, restsOn: [assumption] }),
};

const _operationSemanticsReturningBareEffects: OperationSemantics = {
	artifact: semanticArtifactRef,
	// @ts-expect-error effectsOf records the pack-semantics assumptions it rests on.
	effectsOf: () => operationEffects,
};

// @ts-expect-error Transition rules are judgement producers and own an artifact.
const _transitionRuleWithoutArtifact: TransitionRule = {
	id: 'rule',
	support: { engine: 'postgresql', versions: [], requiredCapabilities: [] },
	recognize: () => ({ recognized: true, match: undefined }),
	requiredObservations: () => [],
	evaluate: () => ({ outcome: 'applicable', obligations: [], assumptions: [] }),
	generateCandidate: () => transitionFragment,
};

// @ts-expect-error Transition fragments retain assumptions from rule evaluation.
acceptsTransitionFragment({
	generatedBy: { id: 'rule', pack: semanticArtifactRef },
	operations: [],
	obligations: [],
	guards: [],
	selectionRationale: {
		chosen: { id: 'rule', pack: semanticArtifactRef },
		overRules: [],
		why: 'only rule',
	},
});

// @ts-expect-error Physical operations need a fragment-local ref.
acceptsPhysicalOperation({
	operationKind: operationKindRef,
	payload: null,
});

// @ts-expect-error Apply guards must name the operation ref they protect.
acceptsApplyGuard({
	predicate: { kind: 'predicate', scope: [] },
	protocol: {
		kind: 'lock-and-check',
		onFailureLeaves: [],
		binding: { kind: 'stable-identity', bound: [], identityClaim: claimId },
	},
	phase: 'before-operation',
});

acceptsProvenPlanStep({
	...guardedPlanStep,
	guards: [
		{
			...applyGuard,
			protocol: {
				kind: 'lock-and-check',
				onFailureLeaves: [],
				binding: {
					kind: 'stable-identity',
					bound: [],
					identityClaim: claimId,
				},
			},
		},
	],
});

acceptsProvenPlanShape({
	...guardedPlan,
	steps: [
		{
			...guardedPlanStep,
			guards: [
				{
					...applyGuard,
					protocol: {
						kind: 'engine-validated',
						onFailureLeaves: [],
						binding: {
							kind: 'stable-identity',
							bound: [],
							identityClaim: claimId,
						},
					},
				},
			],
		},
	],
});

acceptsProvenPlanStep({
	...guardedPlanStep,
	guards: [
		{
			...applyGuard,
			protocol: {
				// @ts-expect-error Proven plan guards cannot be impossible.
				kind: 'impossible',
				onFailureLeaves: [],
				binding: {
					kind: 'stable-identity',
					bound: [],
					identityClaim: claimId,
				},
			},
		},
	],
});

acceptsResourceAddress({
	engine: 'postgresql',
	database: 'db',
	kind: 'table',
	name: 'users',
	// @ts-expect-error Resource addresses cannot launder a raw stable identity.
	identity: 'raw-identity',
});

// @ts-expect-error Stable identity bindings must reference a proof claim.
acceptsTargetBinding({ kind: 'stable-identity', bound: [] });

acceptsPhysicalOperation({
	ref: 'op',
	operationKind: operationKindRef,
	// @ts-expect-error Physical operation payloads are JSON-safe.
	payload: { fn: () => true },
});

// @ts-expect-error Observation request detail is JSON-safe.
acceptsObservationRequest({ kind: 'probe', scope: [], detail: () => true });

// @ts-expect-error Observation result values are JSON-safe.
acceptsObservationResult({ value: () => true });

// @ts-expect-error Proposition detail is JSON-safe.
acceptsProposition({ kind: 'claim', scope: [], detail: () => true });

// @ts-expect-error Guard predicate detail is JSON-safe.
acceptsGuardPredicate({ kind: 'guard', scope: [], detail: () => true });

const _recognitionWithNativeDetail: RecognitionResult<unknown> = {
	recognized: true,
	match: undefined,
	// @ts-expect-error Recognition results expose typed matches, not detail payloads.
	detail: () => true,
};

// @ts-expect-error Recognized rule results must carry the typed match.
acceptsRecognitionResult<TypedMatch>({ recognized: true });

// @ts-expect-error Unsafe native fragments must carry the assumption that permits them.
acceptsUnsafeNativeFragment({
	kind: 'unsafe-native',
	category: 'scalar',
	text: 'now()',
});

// @ts-expect-error Unsafe native fragments must name their grammatical slot.
acceptsUnsafeNativeFragment({
	kind: 'unsafe-native',
	text: 'now()',
	assumption: assumptionId,
});

acceptsUnsafeNativeFragment({
	kind: 'unsafe-native',
	category: 'statement',
	text: 'create index concurrently idx on users (email)',
	assumption: assumptionId,
});

// @ts-expect-error Claim derivation is retained on proof claims.
acceptsProofClaim({
	id: claimId,
	proposition,
	scope: [],
	supportedBy: [evidenceId],
	assumes: [assumptionId],
	semantics: [semanticArtifactRef],
});

// @ts-expect-error Established claims carry no assumptions.
acceptsProofClaim({
	id: claimId,
	proposition,
	scope: [],
	supportedBy: [evidenceId],
	assumes: [assumptionId],
	semantics: [semanticArtifactRef],
	derivedBy: {
		semantics: semanticArtifactRef,
		inputs: [evidenceId],
		proposition,
		conclusion: 'established',
	},
});

// @ts-expect-error Established-under-assumptions claims name at least one assumption.
acceptsProofClaim({
	id: claimId,
	proposition,
	scope: [],
	supportedBy: [evidenceId],
	assumes: [],
	semantics: [semanticArtifactRef],
	derivedBy: {
		semantics: semanticArtifactRef,
		inputs: [evidenceId],
		proposition,
		conclusion: 'established-under-assumptions',
	},
});

acceptsProofClaim({
	id: claimId,
	proposition,
	scope: [],
	supportedBy: [evidenceId],
	assumes: [],
	semantics: [semanticArtifactRef],
	derivedBy: {
		semantics: semanticArtifactRef,
		inputs: [evidenceId],
		proposition,
		conclusion: 'established',
	},
});

acceptsProofClaim({
	id: claimId,
	proposition,
	scope: [],
	supportedBy: [evidenceId],
	assumes: [],
	semantics: [semanticArtifactRef],
	derivedBy: {
		semantics: semanticArtifactRef,
		inputs: [evidenceId],
		proposition,
		conclusion: 'established',
	},
	// @ts-expect-error Proof claims derive their conclusion from derivedBy.
	conclusion: 'refuted',
});

acceptsLockRequirement({
	resource: resourceAddress,
	mode: 'access-exclusive',
	// @ts-expect-error Lock max wait is bounded by a number, not prose.
	maxWaitMs: 'forever',
});

acceptsLockRequirement({
	resource: resourceAddress,
	mode: 'access-exclusive',
	// @ts-expect-error Lock ordering is numeric.
	order: 'first',
});

acceptsStepJournal({
	outcome: 'unknown-step-result',
	// @ts-expect-error Durable intent journal records are timestamped.
	intent: { stepId: 'step', operation: physicalOperation },
});

acceptsStepJournal({
	outcome: 'completed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	// @ts-expect-error Transactional completion journal records are timestamped.
	transactionalCompletion: { stepId: 'step', committedWithDdl: true },
});

acceptsStepJournal({
	outcome: 'guard-failed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	// @ts-expect-error Observed outcome journal records are timestamped.
	observedOutcome: { stepId: 'step', observations: [] },
});

acceptsStepJournal({
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	// @ts-expect-error Step journal outcomes are constrained to resumable states.
	outcome: 'failed',
});

acceptsStepJournal({
	outcome: 'completed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	transactionalCompletion: {
		stepId: 'step',
		committedWithDdl: true,
		recordedAt: 't1',
	},
});

acceptsStepJournal({
	outcome: 'completed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	observedOutcome: {
		stepId: 'step',
		observations: [evidenceId],
		recordedAt: 't1',
	},
});

// @ts-expect-error Completed steps require transactional or observed completion evidence.
acceptsStepJournal({
	outcome: 'completed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
});

acceptsStepJournal({
	outcome: 'guard-failed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	observedOutcome: {
		stepId: 'step',
		observations: [evidenceId],
		recordedAt: 't1',
	},
	recovery: [{ kind: 'invalid-index', resource: resourceAddress }],
});

acceptsStepJournal({
	outcome: 'context-mismatch',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	observedOutcome: {
		stepId: 'step',
		observations: [evidenceId],
		recordedAt: 't1',
	},
});

acceptsStepJournal({
	outcome: 'partially-applied',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	observedOutcome: {
		stepId: 'step',
		observations: [evidenceId],
		recordedAt: 't1',
	},
});

// @ts-expect-error Guard failures require an observed outcome.
acceptsStepJournal({
	outcome: 'guard-failed',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
});

// @ts-expect-error Unknown step results carry only durable intent.
acceptsStepJournal({
	outcome: 'unknown-step-result',
	intent: { stepId: 'step', operation: physicalOperation, recordedAt: 't0' },
	observedOutcome: {
		stepId: 'step',
		observations: [evidenceId],
		recordedAt: 't1',
	},
});

acceptsRecoveryArtefact({ kind: 'invalid-index', resource: resourceAddress });

acceptsRecoveryArtefact({
	kind: 'invalid-index',
	resource: resourceAddress,
	// @ts-expect-error Protocol-time recovery artefacts are not linked to a step.
	producedBy: { stepId: 'step', protocol: 'lock-and-check' },
});

acceptsApplyResult({
	assessment,
	journals: [],
	observations: [],
	recovery: [
		{
			stepId: 'step',
			protocol: 'lock-and-check',
			artefact: { kind: 'invalid-index', resource: resourceAddress },
		},
	],
});

acceptsApplyResult({
	assessment,
	journals: [],
	observations: [],
	recovery: [
		{
			stepId: 'step',
			// @ts-expect-error Applied recovery cannot name an impossible protocol.
			protocol: 'impossible',
			artefact: { kind: 'invalid-index', resource: resourceAddress },
		},
	],
});

acceptsApplyResult({
	assessment,
	journals: [],
	observations: [],
	recovery: [
		{
			stepId: 'step',
			protocol: 'lock-and-check',
			// @ts-expect-error Apply recovery links one produced artefact with the producing step and protocol.
			artefacts: [{ kind: 'invalid-index', resource: resourceAddress }],
		},
	],
});

// @ts-expect-error Insufficient evidence reasons require the missing obligation.
acceptsOutcomeReason({
	code: 'insufficient-evidence',
	detail: 'missing proof',
	scope: [],
});

// @ts-expect-error Context mismatch reasons require a mismatched artifact/fact.
acceptsOutcomeReason({
	code: 'context-mismatch',
	detail: 'wrong context',
	scope: [],
});

// @ts-expect-error Unsupported transition reasons name the unsupported changes.
acceptsOutcomeReason({
	code: 'unsupported-transition',
	detail: 'no rule',
	scope: [],
});

// @ts-expect-error Ambiguous rule reasons name the candidate rules.
acceptsOutcomeReason({
	code: 'ambiguous-rule',
	detail: 'multiple rules',
	scope: [],
});

// @ts-expect-error Compare results are discriminated; empty arrays are not an outcome.
acceptsCompareOutcome({ fragments: [], obligations: [], assumptions: [] });

// @ts-expect-error Transition compare outcomes carry candidates, not fragments.
acceptsCompareOutcome({ kind: 'transitions', fragments: [], obligations: [] });

// @ts-expect-error Transition candidates carry their required observations.
acceptsTransitionCandidate({
	rule: { id: 'rule', pack: semanticArtifactRef },
	match: undefined,
	obligations: [],
	selectionRationale: {
		chosen: { id: 'rule', pack: semanticArtifactRef },
		overRules: [],
		why: 'only rule',
	},
});

acceptsCompareOutcome({
	kind: 'transitions',
	candidates: [transitionCandidate],
	obligations: [proofObligation],
});

// @ts-expect-error Even no-drift compare outcomes carry a claimed invariant.
acceptsCompareOutcome({ kind: 'no-drift' });

acceptsCompareOutcome({ kind: 'no-drift', claimedInvariant: proposition });

acceptsCompareOutcome({
	kind: 'no-drift',
	// @ts-expect-error No-drift compare outcomes expose claimedInvariant, not proof evidence.
	claim: proposition,
});

acceptsCompareOutcome({
	kind: 'ambiguous',
	candidates: [{ id: 'rule', pack: semanticArtifactRef }],
});

acceptsCompareOutcome({
	kind: 'ambiguous',
	// @ts-expect-error Ambiguous compare outcomes carry structured candidate rules.
	detail: 'multiple rules',
});
