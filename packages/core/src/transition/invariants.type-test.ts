import type {
	ApplicableAssessment,
	ApplyPolicy,
	CompareOutcome,
	GuardedPlan,
	InapplicableAssessment,
	ObservationContext,
	ObservationIssuer,
	PlanAssessment,
	ProofClaim,
	SemanticArtifactRef,
	TransitionConnectionPool,
	TransitionQueryClient,
} from '@dbsp/types';
import type {
	Applier,
	EstablishedProofClaim,
	InProcessProvenPlan,
	ProveOutcome,
	Prover,
	SerializedProvenPlan,
} from './index.js';

declare const applicableAssessment: ApplicableAssessment;
declare const applyPolicy: ApplyPolicy;
declare const applier: Applier;
declare const assessment: PlanAssessment;
declare const compareOutcome: CompareOutcome;
declare const guardedPlan: GuardedPlan;
declare const observationContext: ObservationContext;
declare const observationIssuer: ObservationIssuer;
declare const provenPlan: InProcessProvenPlan;
declare const semanticArtifactRef: SemanticArtifactRef;
declare const serializedPlan: SerializedProvenPlan;
declare const executionTarget: TransitionConnectionPool;
declare const borrowedClient: TransitionQueryClient;

declare const blockedOutcome: Extract<
	ProveOutcome,
	{ readonly kind: 'blocked' }
>;
declare const inapplicableAssessment: InapplicableAssessment;
declare const inapplicableOutcome: Extract<
	ProveOutcome,
	{ readonly kind: 'inapplicable' }
>;
declare const establishedClaim: EstablishedProofClaim;
declare const undischargedClaim: ProofClaim & {
	readonly derivedBy: { readonly conclusion: 'undischarged' };
};

// @ts-expect-error A plain guarded plan is not a core-minted proven plan.
const _guardedPlanAsProvenPlan: InProcessProvenPlan = guardedPlan;

applier.apply(
	{
		// @ts-expect-error A plain guarded plan cannot reach apply.
		plan: guardedPlan,
		assessment: applicableAssessment,
	},
	applyPolicy,
	executionTarget,
);

applier.apply(
	{
		// @ts-expect-error Serialized audit plans are not apply credentials.
		plan: serializedPlan,
		assessment: applicableAssessment,
	},
	applyPolicy,
	executionTarget,
);

applier.apply(
	{ plan: provenPlan, assessment: applicableAssessment },
	applyPolicy,
	executionTarget,
);

applier.apply(
	{
		plan: provenPlan,
		assessment: {
			decision: 'applicable',
			// @ts-expect-error Apply only accepts established applicable assessments.
			assurance: 'unproven',
			lifecycle: 'planned',
			continuation: 'none',
			reasons: [],
		},
	},
	applyPolicy,
	executionTarget,
);

// @ts-expect-error A blocked prove outcome has no proven plan to apply.
applier.apply(blockedOutcome, applyPolicy, executionTarget);

// @ts-expect-error An inapplicable prove outcome has no proven plan to apply.
applier.apply(inapplicableOutcome, applyPolicy, executionTarget);

const _inapplicableOutcome: ProveOutcome = {
	kind: 'inapplicable',
	assessment: inapplicableAssessment,
};

// @ts-expect-error A proven outcome must carry an applicable assessment.
const _provenOutcomeWithBlockedAssessment: ProveOutcome = {
	kind: 'proven',
	plan: provenPlan,
	assessment,
};

// @ts-expect-error Proven applicable outcomes cannot remain unproven.
const _provenOutcomeWithUnprovenAssessment: ProveOutcome = {
	kind: 'proven',
	plan: provenPlan,
	assessment: {
		decision: 'applicable',
		assurance: 'unproven',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [],
	},
};

const _provenNoDriftOutcome: ProveOutcome = {
	kind: 'no-drift',
	claim: establishedClaim,
	assessment: applicableAssessment,
};

const _noDriftWithUndischargedClaim: ProveOutcome = {
	kind: 'no-drift',
	// @ts-expect-error Proven no-drift outcomes carry an established proof claim.
	claim: undischargedClaim,
	assessment: applicableAssessment,
};

declare const prover: Prover;

prover.prove(compareOutcome, executionTarget, observationContext);

// @ts-expect-error A checked-out client is not an execution target; runtime owns checkout/release.
prover.prove(compareOutcome, borrowedClient, observationContext);

applier.apply(
	{ plan: provenPlan, assessment: applicableAssessment },
	applyPolicy,
	// @ts-expect-error A checked-out client is not an execution target; runtime owns checkout/release.
	borrowedClient,
);

// @ts-expect-error Provers consume the whole compare outcome, not just fragments.
prover.prove([], executionTarget, observationContext);

// @ts-expect-error Provers are judgement producers and own an artifact.
const _proverWithoutArtifact: Prover = {
	prove: async () => ({ kind: 'blocked', assessment }),
};

// @ts-expect-error Appliers are judgement producers and own an artifact.
const _applierWithoutArtifact: Applier = {
	apply: async () => ({ assessment, journals: [], observations: [] }),
};

const _proverWithArtifact: Prover = {
	artifact: semanticArtifactRef,
	prove: async () => ({ kind: 'blocked', assessment }),
};
