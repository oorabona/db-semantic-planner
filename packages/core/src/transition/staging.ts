import type {
	CompareOutcome,
	ModelIR,
	ObservationContext,
	PlanAssessment,
	ResourceAddress,
	TransitionCandidate,
	TransitionFragmentComposition,
} from '@dbsp/types';
import {
	transitionCompareCurrentModel,
	withTransitionCompareCurrentModel,
} from './comparator.js';
import { transitionCompositionFactKey } from './composer.js';
import type { PackRegistry } from './registry.js';
import { stableJson } from './stable-json.js';

type TransitionCompare = Extract<
	CompareOutcome,
	{ readonly kind: 'transitions' }
>;
type CompositionProducer = NonNullable<
	TransitionFragmentComposition['produces']
>[number];
type CompositionRequirement = NonNullable<
	TransitionFragmentComposition['requires']
>[number];

export interface StagedCompositionCandidate {
	readonly candidate: TransitionCandidate;
	readonly index: number;
	readonly composition?: TransitionFragmentComposition;
	readonly opRefs: readonly string[];
}

export type StagedCompositionPreflight =
	| {
			readonly kind: 'provable-in-stages';
			readonly ready: readonly StagedCompositionCandidate[];
			readonly pending: readonly StagedCompositionCandidate[];
			readonly detail?: string;
	  }
	| {
			readonly kind: 'unsupported-transition';
			readonly assessment: PlanAssessment;
	  };

export interface StagedCompositionPreflightInput {
	readonly compare: TransitionCompare;
	readonly current: ModelIR;
	readonly context: ObservationContext;
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

function unsupportedAssessment(
	detail: string,
	changes: readonly ResourceAddress[],
): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle: 'planned',
		continuation: 'replan-required',
		reasons: [
			{
				code: 'unsupported-transition',
				changes,
				scope: changes,
				detail,
			},
		],
	};
}

function unsupported(
	detail: string,
	candidates: readonly TransitionCandidate[],
	extraChanges: readonly ResourceAddress[] = [],
): StagedCompositionPreflight {
	const changes = uniqueResources([
		...candidateResources(candidates),
		...extraChanges,
	]);
	return {
		kind: 'unsupported-transition',
		assessment: unsupportedAssessment(detail, changes),
	};
}

function ambiguousRule(
	detail: string,
	candidates: readonly TransitionCandidate[],
): StagedCompositionPreflight {
	return {
		kind: 'unsupported-transition',
		assessment: {
			decision: 'blocked',
			assurance: 'unproven',
			lifecycle: 'planned',
			continuation: 'replan-required',
			reasons: [
				{
					code: 'ambiguous-rule',
					candidates: candidates.map((candidate) => candidate.rule),
					scope: candidateResources(candidates),
					detail,
				},
			],
		},
	};
}

function compositionOpRefs(
	composition: TransitionFragmentComposition | undefined,
): readonly string[] {
	return [
		...(composition?.produces ?? []).map((producer) => producer.opRef),
		...(composition?.requires ?? []).map((requirement) => requirement.opRef),
		...(composition?.order ?? []).flatMap((order) => [
			order.before,
			order.after,
		]),
	].filter((value, index, values) => values.indexOf(value) === index);
}

function requirementNeedsCommit(
	requirement: CompositionRequirement,
	producer: CompositionProducer,
): boolean {
	return (
		requirement.needs === 'producer-after-commit' ||
		producer.available === 'after-commit'
	);
}

export function preflightStagedComposition(
	registry: PackRegistry,
	input: StagedCompositionPreflightInput,
): StagedCompositionPreflight {
	const entries: StagedCompositionCandidate[] = [];
	const ownerByOpRef = new Map<string, StagedCompositionCandidate>();
	for (const [index, candidate] of input.compare.candidates.entries()) {
		const rule = registry.resolveRule(candidate.rule);
		if (!rule) {
			return unsupported(
				`transition rule ${candidate.rule.id} did not resolve`,
				input.compare.candidates,
			);
		}
		let composition: TransitionFragmentComposition | undefined;
		try {
			composition = rule.declareComposition?.(candidate.match, input.context);
		} catch (error) {
			return unsupported(
				error instanceof Error
					? error.message
					: 'transition composition declaration failed',
				input.compare.candidates,
			);
		}
		const entry: StagedCompositionCandidate = {
			candidate,
			index,
			...(composition ? { composition } : {}),
			opRefs: compositionOpRefs(composition),
		};
		for (const opRef of entry.opRefs) {
			if (ownerByOpRef.has(opRef)) {
				return unsupported(
					`duplicate composition operation ref ${opRef}`,
					input.compare.candidates,
				);
			}
			ownerByOpRef.set(opRef, entry);
		}
		entries.push(entry);
	}

	const producersByFact = new Map<
		string,
		readonly {
			readonly entry: StagedCompositionCandidate;
			readonly producer: CompositionProducer;
		}[]
	>();
	for (const entry of entries) {
		for (const producer of entry.composition?.produces ?? []) {
			const owner = ownerByOpRef.get(producer.opRef);
			if (owner !== entry) {
				return unsupported(
					`composition producer ${producer.opRef} references an unknown operation`,
					input.compare.candidates,
					[producer.fact.resource],
				);
			}
			const key = transitionCompositionFactKey(producer.fact);
			producersByFact.set(key, [
				...(producersByFact.get(key) ?? []),
				{ entry, producer },
			]);
		}
	}

	const pendingByIndex = new Map<number, Set<number>>();
	let declaredRequirementCount = 0;
	for (const entry of entries) {
		for (const requirement of entry.composition?.requires ?? []) {
			declaredRequirementCount += 1;
			const owner = ownerByOpRef.get(requirement.opRef);
			if (owner !== entry) {
				return unsupported(
					`composition requirement ${requirement.opRef} references an unknown operation`,
					input.compare.candidates,
					[requirement.fact.resource],
				);
			}
			if (
				registry.satisfiesCompositionFact(
					requirement.fact,
					input.current,
					input.context,
				)
			) {
				continue;
			}
			const producers =
				producersByFact.get(transitionCompositionFactKey(requirement.fact)) ??
				[];
			if (producers.length === 0) {
				return unsupported(
					`unsatisfied composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
					input.compare.candidates,
					[requirement.fact.resource],
				);
			}
			if (producers.length > 1) {
				return ambiguousRule(
					`ambiguous composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
					input.compare.candidates,
				);
			}
			const producer = producers[0];
			if (!producer || producer.entry === entry) {
				return unsupported(
					`composition requirement ${requirement.opRef} is not staged by a prior producer`,
					input.compare.candidates,
					[requirement.fact.resource],
				);
			}
			if (!requirementNeedsCommit(requirement, producer.producer)) {
				return unsupported(
					`composition requirement ${requirement.opRef} does not declare a producer-commit edge`,
					input.compare.candidates,
					[requirement.fact.resource],
				);
			}
			const producerIndexes = pendingByIndex.get(entry.index) ?? new Set();
			producerIndexes.add(producer.entry.index);
			pendingByIndex.set(entry.index, producerIndexes);
		}
	}

	const ready = entries.filter((entry) => !pendingByIndex.has(entry.index));
	const pending = entries.filter((entry) => pendingByIndex.has(entry.index));

	if (input.compare.candidates.length > 1 && declaredRequirementCount === 0) {
		return unsupported(
			'multi-candidate transition has no declared composition dependency',
			input.compare.candidates,
		);
	}
	for (const [candidateIndex, producerIndexes] of pendingByIndex) {
		if (producerIndexes.size !== 1) {
			const candidate = entries[candidateIndex];
			return unsupported(
				`staged candidate ${
					candidate?.candidate.rule.id ?? candidateIndex
				} does not have exactly one producer`,
				input.compare.candidates,
			);
		}
	}
	if (input.compare.candidates.length > 1 && pending.length > 0) {
		const producerIndexes = new Set(
			[...pendingByIndex.values()].flatMap((indexes) => [...indexes]),
		);
		const disconnectedReady = ready.filter(
			(entry) => !producerIndexes.has(entry.index),
		);
		if (disconnectedReady.length > 0) {
			return unsupported(
				'multi-candidate transition contains an unconnected ready candidate',
				input.compare.candidates,
			);
		}
	}
	if (ready.length === 0) {
		return unsupported(
			'staged transition has no ready candidate',
			input.compare.candidates,
		);
	}

	return {
		kind: 'provable-in-stages',
		ready,
		pending,
		...(pending.length > 0
			? { detail: 'transition is provable in stages' }
			: {}),
	};
}

export function chooseReadyCandidate(
	preflight: Extract<
		StagedCompositionPreflight,
		{ readonly kind: 'provable-in-stages' }
	>,
): StagedCompositionCandidate {
	const candidate = [...preflight.ready].sort(
		(left, right) => left.index - right.index,
	)[0];
	if (!candidate) {
		throw new Error('staged composition preflight has no ready candidate');
	}
	return candidate;
}

export function projectCompareToSingleCandidate(
	compare: TransitionCompare,
	entry: StagedCompositionCandidate,
): TransitionCompare {
	if (compare.candidates[entry.index] !== entry.candidate) {
		throw new Error('ready candidate does not belong to the supplied compare');
	}
	const projected: TransitionCompare = {
		kind: 'transitions',
		candidates: [entry.candidate],
		obligations: entry.candidate.obligations,
	};
	const current = transitionCompareCurrentModel(compare);
	return current
		? withTransitionCompareCurrentModel(projected, current)
		: projected;
}
