import type {
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
	EquivalenceContext,
	IssuedObservation,
	ModelIR,
	ObservationContext,
	OutcomeReason,
	PlanAssessment,
	ResourceAddress,
	StepJournal,
	TransitionCandidate,
	TransitionConnectionPool,
} from '@dbsp/types';
import { createApplier } from './applier.js';
import { createComparator } from './comparator.js';
import { claimId } from './ids.js';
import { createProver } from './prover.js';
import type { PackRegistry } from './registry.js';
import { stableJson } from './stable-json.js';
import {
	chooseReadyCandidate,
	preflightStagedComposition,
	projectCompareToSingleCandidate,
} from './staging.js';

export interface StagedTransitionInput {
	readonly desired: ModelIR;
	readonly loadCurrent: () => Promise<ModelIR>;
	readonly readContext: () => Promise<ObservationContext>;
	readonly target: TransitionConnectionPool;
	readonly policy: ApplyPolicy;
	readonly maxIterations?: number;
}

export interface StagedTransitionOrchestrator {
	applyStagedTransition(input: StagedTransitionInput): Promise<ApplyResult>;
}

function uniqueResources(
	resources: readonly ResourceAddress[],
): readonly ResourceAddress[] {
	const byKey = new Map<string, ResourceAddress>();
	for (const resource of resources) {
		byKey.set(stableJson(resource), resource);
	}
	return [...byKey.values()];
}

function candidateResources(
	candidates: readonly TransitionCandidate[],
): readonly ResourceAddress[] {
	return uniqueResources(
		candidates.flatMap((candidate) =>
			candidate.obligations.flatMap((obligation) => [...obligation.scope]),
		),
	);
}

function equivalenceContextFromObservation(
	context: ObservationContext,
): EquivalenceContext {
	return {
		engine: context.engine,
		...(context.databaseId ? { databaseId: context.databaseId } : {}),
		...(context.targetSchema ? { targetSchema: context.targetSchema } : {}),
		...(context.searchPath ? { searchPath: context.searchPath } : {}),
	};
}

function blockedAssessment(reason: OutcomeReason): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle: 'planned',
		continuation: 'replan-required',
		reasons: [reason],
	};
}

function unsupportedAssessment(
	detail: string,
	changes: readonly ResourceAddress[],
): PlanAssessment {
	return blockedAssessment({
		code: 'unsupported-transition',
		changes,
		scope: changes,
		detail,
	});
}

function compareBlockedAssessment(compare: CompareOutcome): PlanAssessment {
	switch (compare.kind) {
		case 'unsupported':
			return unsupportedAssessment(
				'compare returned an unsupported transition',
				compare.changes,
			);
		case 'ambiguous':
			return blockedAssessment({
				code: 'ambiguous-rule',
				candidates: compare.candidates,
				scope: [],
				detail: 'compare returned ambiguous transition rules',
			});
		case 'unknown': {
			const obligation = compare.obligations[0];
			if (obligation) {
				return blockedAssessment({
					code: 'insufficient-evidence',
					obligation,
					scope: obligation.scope,
					detail: 'compare returned unknown transition recognition',
				});
			}
			return unsupportedAssessment(
				'compare returned unknown transition recognition',
				[],
			);
		}
		case 'uncomposable':
			return blockedAssessment({
				code: 'uncomposable',
				fragments: compare.candidates.map((candidate) => candidate.rule),
				scope: candidateResources(compare.candidates),
				detail: compare.detail,
			});
		case 'transitions':
			return unsupportedAssessment(
				'transition compare contained no candidate to stage',
				candidateResources(compare.candidates),
			);
		case 'no-drift':
			return noDriftAssessment();
	}
}

function obligationResources(
	obligations: readonly { readonly scope: readonly ResourceAddress[] }[],
): readonly ResourceAddress[] {
	return uniqueResources(
		obligations.flatMap((obligation) => [...obligation.scope]),
	);
}

function convergenceProvenAssessment(
	compare: Extract<CompareOutcome, { readonly kind: 'unknown' }>,
): PlanAssessment {
	return unsupportedAssessment(
		'post-apply convergence proof returned an executable plan for remaining drift; staged transition orchestration did not recognize a stageable transition candidate',
		obligationResources(compare.obligations),
	);
}

function noDriftAssessment(): PlanAssessment {
	return {
		decision: 'applicable',
		assurance: 'established',
		lifecycle: 'completed',
		continuation: 'none',
		reasons: [
			{
				code: 'proven-applicable',
				claim: claimId('dbsp.transition.claim.no-drift'),
				scope: [],
				detail: 'no drift remains after staged transition orchestration',
			},
		],
	};
}

function hasAppliedWork(journals: readonly StepJournal[]): boolean {
	return journals.some((journal) =>
		['completed', 'partially-applied', 'unknown-step-result'].includes(
			journal.outcome,
		),
	);
}

function aggregateAssessment(
	assessment: PlanAssessment,
	journals: readonly StepJournal[],
): PlanAssessment {
	if (!hasAppliedWork(journals) || assessment.decision === 'applicable') {
		return assessment;
	}
	return {
		...assessment,
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle: 'partially-applied',
		continuation: 'resume-possible',
	};
}

function resultWithAggregate(
	assessment: PlanAssessment,
	journals: readonly StepJournal[],
	observations: readonly IssuedObservation[],
	recovery?: ApplyResult['recovery'],
): ApplyResult {
	return {
		assessment: aggregateAssessment(assessment, journals),
		journals,
		observations,
		...(recovery ? { recovery } : {}),
	};
}

function candidateProgressKey(entry: {
	readonly candidate: TransitionCandidate;
	readonly opRefs: readonly string[];
}): string {
	return entry.opRefs.length > 0
		? stableJson({ opRefs: entry.opRefs })
		: stableJson({
				rule: entry.candidate.rule,
				match: entry.candidate.match,
			});
}

function completedJournalRefs(
	journals: readonly StepJournal[],
): readonly string[] {
	return journals
		.filter((journal) => journal.outcome === 'completed')
		.map((journal) => journal.intent.operation.ref);
}

export function createStagedTransitionOrchestrator(
	registry: PackRegistry,
): StagedTransitionOrchestrator {
	const comparator = createComparator(registry);
	const prover = createProver(registry);
	const applier = createApplier(registry);
	return {
		async applyStagedTransition(
			input: StagedTransitionInput,
		): Promise<ApplyResult> {
			const journals: StepJournal[] = [];
			const observations: IssuedObservation[] = [];
			const completedProgress = new Set<string>();
			const maxIterations = input.maxIterations ?? 32;

			for (let iteration = 0; iteration < maxIterations; iteration += 1) {
				const context = await input.readContext();
				const current = await input.loadCurrent();
				const compare = comparator.compare(
					input.desired,
					current,
					equivalenceContextFromObservation(context),
				);
				if (
					compare.kind === 'no-drift' ||
					(compare.kind === 'transitions' && compare.candidates.length === 0)
				) {
					return {
						assessment: noDriftAssessment(),
						journals,
						observations,
					};
				}
				if (compare.kind !== 'transitions') {
					if (compare.kind === 'unknown' && hasAppliedWork(journals)) {
						const proof = await prover.prove(compare, input.target, context);
						switch (proof.kind) {
							case 'no-drift':
								return {
									assessment: noDriftAssessment(),
									journals,
									observations,
								};
							case 'blocked':
							case 'inapplicable':
								return resultWithAggregate(
									proof.assessment,
									journals,
									observations,
								);
							case 'proven':
								return resultWithAggregate(
									convergenceProvenAssessment(compare),
									journals,
									observations,
								);
						}
					}
					return resultWithAggregate(
						compareBlockedAssessment(compare),
						journals,
						observations,
					);
				}

				const preflight = preflightStagedComposition(registry, {
					compare,
					current,
					context,
				});
				if (preflight.kind === 'unsupported-transition') {
					return resultWithAggregate(
						preflight.assessment,
						journals,
						observations,
					);
				}

				const ready = chooseReadyCandidate(preflight);
				const progressKey = candidateProgressKey(ready);
				if (completedProgress.has(progressKey)) {
					return resultWithAggregate(
						unsupportedAssessment(
							'staged transition did not converge; the same ready candidate remained after a completed apply',
							candidateResources(compare.candidates),
						),
						journals,
						observations,
					);
				}

				const segmentCompare = projectCompareToSingleCandidate(compare, ready);
				const proof = await prover.prove(segmentCompare, input.target, context);
				if (proof.kind !== 'proven') {
					return resultWithAggregate(proof.assessment, journals, observations);
				}

				const applyResult = await applier.apply(
					{ plan: proof.plan, assessment: proof.assessment },
					input.policy,
					input.target,
				);
				journals.push(...applyResult.journals);
				observations.push(...applyResult.observations);

				if (
					applyResult.assessment.decision !== 'applicable' ||
					applyResult.assessment.lifecycle !== 'completed'
				) {
					return resultWithAggregate(
						applyResult.assessment,
						journals,
						observations,
						applyResult.recovery,
					);
				}
				for (const ref of completedJournalRefs(applyResult.journals)) {
					completedProgress.add(stableJson({ opRefs: [ref] }));
				}
				completedProgress.add(progressKey);
			}

			return resultWithAggregate(
				unsupportedAssessment(
					`staged transition did not converge within ${maxIterations} iterations`,
					[],
				),
				journals,
				observations,
			);
		},
	};
}
