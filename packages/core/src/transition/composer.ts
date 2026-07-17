import type {
	GuardedPlanSegment,
	OperationEffectAssessment,
	PhysicalOperation,
	ResourceAddress,
	ResourceSelector,
	TransitionFragmentComposition,
} from '@dbsp/types';
import { stableJson } from './stable-json.js';

export interface CompositionOperation {
	readonly operation: PhysicalOperation;
	readonly effects: OperationEffectAssessment;
}

export interface OrderedCompositionOperation extends CompositionOperation {
	readonly dependsOn: readonly string[];
	readonly requiresCommitBefore: boolean;
}

export type CompositionResult =
	| {
			readonly ok: true;
			readonly operations: readonly OrderedCompositionOperation[];
			readonly segments: readonly GuardedPlanSegment[];
	  }
	| { readonly ok: false; readonly detail: string };

type DeclaredEdge = {
	readonly before: string;
	readonly after: string;
	readonly requiresCommitBetween: boolean;
	readonly reason: string;
};
type CompositionFact = NonNullable<
	TransitionFragmentComposition['produces']
>[number]['fact'];

function sameResource(left: ResourceAddress, right: ResourceAddress): boolean {
	return stableJson(left) === stableJson(right);
}

function resourceIsWithin(
	resource: ResourceAddress,
	parent: ResourceAddress,
): boolean {
	if (sameResource(resource, parent)) {
		return true;
	}
	return (
		resource.engine === parent.engine &&
		resource.database === parent.database &&
		resource.schema === parent.schema &&
		(resource.qualifiedBy?.includes(parent.name) ?? false)
	);
}

function resourcesIntersect(
	left: ResourceAddress,
	right: ResourceAddress,
): boolean {
	return (
		sameResource(left, right) ||
		resourceIsWithin(left, right) ||
		resourceIsWithin(right, left)
	);
}

function selectorDescribesResource(
	selector: ResourceSelector,
	resource: ResourceAddress,
): boolean {
	if (selector.kind && selector.kind !== resource.kind) {
		return false;
	}
	if (selector.schema && selector.schema !== resource.schema) {
		return false;
	}
	if (selector.name && selector.name !== resource.name) {
		return false;
	}
	if (selector.within && !resourceIsWithin(resource, selector.within)) {
		return false;
	}
	return true;
}

function selectorIsWithinResource(
	selector: ResourceSelector,
	resource: ResourceAddress,
): boolean {
	return selector.within
		? resourcesIntersect(selector.within, resource)
		: false;
}

function resourceIsWithinSelector(
	resource: ResourceAddress,
	selector: ResourceSelector,
): boolean {
	if (!selector.name) {
		return false;
	}
	if (selector.schema && selector.schema !== resource.schema) {
		return false;
	}
	return resource.qualifiedBy?.includes(selector.name) ?? false;
}

function selectorIntersectsResource(
	selector: ResourceSelector,
	resource: ResourceAddress,
): boolean {
	return (
		selectorDescribesResource(selector, resource) ||
		selectorIsWithinResource(selector, resource) ||
		resourceIsWithinSelector(resource, selector)
	);
}

function selectorFieldsCompatible(
	left: ResourceSelector,
	right: ResourceSelector,
): boolean {
	if (left.kind && right.kind && left.kind !== right.kind) {
		return false;
	}
	if (left.schema && right.schema && left.schema !== right.schema) {
		return false;
	}
	if (left.name && right.name && left.name !== right.name) {
		return false;
	}
	if (
		left.within &&
		right.within &&
		!resourcesIntersect(left.within, right.within)
	) {
		return false;
	}
	return true;
}

function selectorIntersectsSelector(
	left: ResourceSelector,
	right: ResourceSelector,
): boolean {
	return (
		stableJson(left) === stableJson(right) ||
		(left.within ? selectorIntersectsResource(right, left.within) : false) ||
		(right.within ? selectorIntersectsResource(left, right.within) : false) ||
		selectorFieldsCompatible(left, right)
	);
}

function writesIntersect(
	left: OperationEffectAssessment,
	right: OperationEffectAssessment,
): boolean {
	return left.effects.writes.some((leftWrite) =>
		right.effects.writes.some((rightWrite) =>
			selectorIntersectsSelector(leftWrite, rightWrite),
		),
	);
}

function writesIntersectReadsOrLocks(
	writer: OperationEffectAssessment,
	user: OperationEffectAssessment,
): boolean {
	return writer.effects.writes.some(
		(write) =>
			user.effects.reads.some((read) =>
				selectorIntersectsSelector(write, read),
			) ||
			user.effects.locks.some((lock) =>
				selectorIntersectsResource(write, lock.resource),
			),
	);
}

function effectsInteract(
	left: OperationEffectAssessment,
	right: OperationEffectAssessment,
): boolean {
	return (
		writesIntersect(left, right) ||
		writesIntersectReadsOrLocks(left, right) ||
		writesIntersectReadsOrLocks(right, left)
	);
}

function hasContextMutation(entry: CompositionOperation): boolean {
	return entry.effects.effects.contextMutations.length > 0;
}

function stepId(operation: PhysicalOperation): string {
	return `step:${operation.ref}`;
}

function commitBoundaryBefore(
	commitBoundary: CompositionOperation['effects']['effects']['execution']['commitBoundary'],
): boolean {
	return commitBoundary === 'before' || commitBoundary === 'before-and-after';
}

function commitBoundaryAfter(
	commitBoundary: CompositionOperation['effects']['effects']['execution']['commitBoundary'],
): boolean {
	return commitBoundary === 'after' || commitBoundary === 'before-and-after';
}

function segmentTransaction(
	current: GuardedPlanSegment['transaction'] | undefined,
	next: GuardedPlanSegment['transaction'],
): GuardedPlanSegment['transaction'] {
	if (current === 'requires-new' || next === 'requires-new') {
		return 'requires-new';
	}
	if (current === 'forbids-transaction' || next === 'forbids-transaction') {
		return 'forbids-transaction';
	}
	return 'joins-current';
}

function composeSegments(
	operations: readonly OrderedCompositionOperation[],
): readonly GuardedPlanSegment[] {
	const segments: GuardedPlanSegment[] = [];
	let current:
		| {
				segmentId: string;
				stepIds: string[];
				transaction: GuardedPlanSegment['transaction'];
				commitBoundaryBefore: boolean;
				commitBoundaryAfter: boolean;
		  }
		| undefined;
	let nextSegmentHasBoundaryBefore = false;

	const flush = (commitAfter: boolean) => {
		if (!current) {
			return;
		}
		current.commitBoundaryAfter = current.commitBoundaryAfter || commitAfter;
		segments.push({
			segmentId: current.segmentId,
			stepIds: [...current.stepIds],
			transaction: current.transaction,
			commitBoundaryBefore: current.commitBoundaryBefore,
			commitBoundaryAfter: current.commitBoundaryAfter,
		});
		nextSegmentHasBoundaryBefore = current.commitBoundaryAfter;
		current = undefined;
	};

	for (const entry of operations) {
		const execution = entry.effects.effects.execution;
		const startsNewSegment =
			entry.requiresCommitBefore ||
			execution.transaction === 'requires-new' ||
			execution.transaction === 'forbids-transaction' ||
			commitBoundaryBefore(execution.commitBoundary) ||
			current?.transaction === 'forbids-transaction';
		if (current && startsNewSegment) {
			flush(true);
		}
		if (!current) {
			current = {
				segmentId: `segment:${segments.length}`,
				stepIds: [],
				transaction: execution.transaction,
				commitBoundaryBefore: nextSegmentHasBoundaryBefore,
				commitBoundaryAfter: false,
			};
			nextSegmentHasBoundaryBefore = false;
		} else {
			current.transaction = segmentTransaction(
				current.transaction,
				execution.transaction,
			);
		}
		current.stepIds.push(stepId(entry.operation));
		if (
			execution.transaction === 'forbids-transaction' ||
			commitBoundaryAfter(execution.commitBoundary)
		) {
			flush(true);
		}
	}
	flush(false);
	return segments;
}

type ConstraintBuildResult =
	| {
			readonly ok: true;
			readonly dependents: ReadonlyMap<string, Set<string>>;
			readonly dependencyRefs: ReadonlyMap<string, Set<string>>;
			readonly commitEdges: ReadonlySet<string>;
			readonly declaredPairs: ReadonlySet<string>;
	  }
	| { readonly ok: false; readonly detail: string };

type DeclaredEdgesResult =
	| { readonly ok: true; readonly edges: readonly DeclaredEdge[] }
	| { readonly ok: false; readonly detail: string };

function edgeKey(before: string, after: string): string {
	return stableJson([before, after]);
}

function unorderedEdgeKey(left: string, right: string): string {
	return stableJson([left, right].sort());
}

export function transitionCompositionFactKey(fact: CompositionFact): string {
	return stableJson({
		kind: fact.kind,
		resource: fact.resource,
		detail: fact.detail,
	});
}

function addConstraint(
	dependents: Map<string, Set<string>>,
	dependencyRefs: Map<string, Set<string>>,
	commitEdges: Set<string>,
	declaredPairs: Set<string>,
	edge: DeclaredEdge,
): void {
	dependents.get(edge.before)?.add(edge.after);
	dependencyRefs.get(edge.after)?.add(edge.before);
	declaredPairs.add(unorderedEdgeKey(edge.before, edge.after));
	if (edge.requiresCommitBetween) {
		commitEdges.add(edgeKey(edge.before, edge.after));
	}
}

function declaredEdges(
	declarations: readonly TransitionFragmentComposition[],
	knownRefs: ReadonlySet<string>,
	options: { readonly allowExternalRequirements: boolean },
): DeclaredEdgesResult {
	const edges: DeclaredEdge[] = [];
	const producersByFact = new Map<
		string,
		{
			readonly opRef: string;
			readonly available: 'after-operation' | 'after-commit';
		}[]
	>();

	for (const declaration of declarations) {
		for (const producer of declaration.produces ?? []) {
			if (!knownRefs.has(producer.opRef)) {
				return {
					ok: false,
					detail: `composition producer ${producer.opRef} references an unknown operation`,
				};
			}
			const key = transitionCompositionFactKey(producer.fact);
			const bucket = producersByFact.get(key) ?? [];
			bucket.push({
				opRef: producer.opRef,
				available: producer.available,
			});
			producersByFact.set(key, bucket);
		}
	}

	for (const declaration of declarations) {
		for (const requirement of declaration.requires ?? []) {
			if (!knownRefs.has(requirement.opRef)) {
				return {
					ok: false,
					detail: `composition requirement ${requirement.opRef} references an unknown operation`,
				};
			}
			const matches =
				producersByFact.get(transitionCompositionFactKey(requirement.fact)) ??
				[];
			if (matches.length === 0) {
				if (options.allowExternalRequirements) {
					continue;
				}
				return {
					ok: false,
					detail: `unsatisfied composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
				};
			}
			if (matches.length > 1) {
				return {
					ok: false,
					detail: `ambiguous composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
				};
			}
			const producer = matches[0];
			if (!producer) {
				return {
					ok: false,
					detail: `unsatisfied composition requirement ${requirement.opRef} requires ${requirement.fact.kind}`,
				};
			}
			edges.push({
				before: producer.opRef,
				after: requirement.opRef,
				requiresCommitBetween:
					requirement.needs === 'producer-after-commit' ||
					producer.available === 'after-commit',
				reason: `composition requirement ${requirement.fact.kind}`,
			});
		}

		for (const order of declaration.order ?? []) {
			if (!knownRefs.has(order.before)) {
				return {
					ok: false,
					detail: `composition order ${order.before} -> ${order.after} references an unknown before operation`,
				};
			}
			if (!knownRefs.has(order.after)) {
				return {
					ok: false,
					detail: `composition order ${order.before} -> ${order.after} references an unknown after operation`,
				};
			}
			edges.push({
				before: order.before,
				after: order.after,
				requiresCommitBetween: order.requiresCommitBetween === true,
				reason: order.reason,
			});
		}
	}

	return { ok: true, edges };
}

function buildConstraints(
	operations: readonly CompositionOperation[],
	declarations: readonly TransitionFragmentComposition[],
): ConstraintBuildResult {
	const dependents = new Map<string, Set<string>>();
	const dependencyRefs = new Map<string, Set<string>>();
	const commitEdges = new Set<string>();
	const declaredPairs = new Set<string>();
	for (const entry of operations) {
		dependents.set(entry.operation.ref, new Set());
		dependencyRefs.set(entry.operation.ref, new Set());
	}

	if (operations.length > 1 && operations.some(hasContextMutation)) {
		return {
			ok: false,
			detail:
				'composition contains contextMutations without an explicit context dependency proof',
		};
	}

	const knownRefs = new Set(operations.map((entry) => entry.operation.ref));
	const edges = declaredEdges(declarations, knownRefs, {
		allowExternalRequirements: operations.length === 1,
	});
	if (!edges.ok) {
		return edges;
	}
	for (const edge of edges.edges) {
		addConstraint(dependents, dependencyRefs, commitEdges, declaredPairs, edge);
	}

	for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
		const left = operations[leftIndex];
		if (!left) {
			continue;
		}
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < operations.length;
			rightIndex += 1
		) {
			const right = operations[rightIndex];
			if (!right) {
				continue;
			}
			const leftRef = left.operation.ref;
			const rightRef = right.operation.ref;
			if (
				effectsInteract(left.effects, right.effects) &&
				!declaredPairs.has(unorderedEdgeKey(leftRef, rightRef))
			) {
				return {
					ok: false,
					detail: `unproven interaction between ${leftRef} and ${rightRef} — declare an order`,
				};
			}
		}
	}

	return {
		ok: true,
		dependents,
		dependencyRefs,
		commitEdges,
		declaredPairs,
	};
}

function ambiguousOrderDetail(refs: readonly string[]): string {
	return `composition order is ambiguous — siblings ${refs.join(', ')} are unordered`;
}

export function composeOperations(
	operations: readonly CompositionOperation[],
	declarations: readonly TransitionFragmentComposition[] = [],
): CompositionResult {
	if (operations.length === 0) {
		return { ok: false, detail: 'missing operations' };
	}
	const byRef = new Map<string, CompositionOperation>();
	const refOrder = new Map<string, number>();
	for (const [index, entry] of operations.entries()) {
		if (byRef.has(entry.operation.ref)) {
			return {
				ok: false,
				detail: `duplicate operation ref ${entry.operation.ref}`,
			};
		}
		byRef.set(entry.operation.ref, entry);
		refOrder.set(entry.operation.ref, index);
		if (
			operations.length > 1 &&
			entry.effects.effects.externalEffects.couldNotAccountFor.length > 0
		) {
			return {
				ok: false,
				detail: `operation ${entry.operation.ref} has unaccounted external effects`,
			};
		}
	}

	const constraints = buildConstraints(operations, declarations);
	if (!constraints.ok) {
		return constraints;
	}
	const { dependents, dependencyRefs, commitEdges } = constraints;
	const indegree = new Map<string, number>();
	for (const entry of operations) {
		indegree.set(
			entry.operation.ref,
			dependencyRefs.get(entry.operation.ref)?.size ?? 0,
		);
	}

	const ordered: OrderedCompositionOperation[] = [];
	const emitted = new Set<string>();
	let ready = operations
		.filter((entry) => indegree.get(entry.operation.ref) === 0)
		.map((entry) => entry.operation.ref);
	while (ordered.length < operations.length) {
		if (ready.length === 0) {
			return {
				ok: false,
				detail: 'composition dependency cycle detected',
			};
		}
		if (ready.length > 1) {
			return {
				ok: false,
				detail: ambiguousOrderDetail(ready),
			};
		}

		const ref = ready[0];
		if (!ref) {
			return {
				ok: false,
				detail: 'composition dependency cycle detected',
			};
		}
		ready = [];
		const entry = byRef.get(ref);
		if (!entry) {
			return {
				ok: false,
				detail: `composition references unknown operation ${ref}`,
			};
		}
		const dependencies = [...(dependencyRefs.get(ref) ?? [])].sort(
			(left, right) => (refOrder.get(left) ?? 0) - (refOrder.get(right) ?? 0),
		);
		ordered.push({
			...entry,
			dependsOn: dependencies,
			requiresCommitBefore: dependencies.some((dependency) =>
				commitEdges.has(edgeKey(dependency, ref)),
			),
		});
		emitted.add(ref);
		for (const dependent of dependents.get(ref) ?? []) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0 && !emitted.has(dependent)) {
				ready.push(dependent);
			}
		}
		ready = ready.sort(
			(left, right) => (refOrder.get(left) ?? 0) - (refOrder.get(right) ?? 0),
		);
	}

	return {
		ok: true,
		operations: ordered,
		segments: composeSegments(ordered),
	};
}
