import type {
	ApplyPolicy,
	Assumption,
	ResourceAddress,
	ResourceSelector,
	TrustRoot,
} from '@dbsp/types';
import { stableJson } from './stable-json.js';

export function sameTrustRoot(left: TrustRoot, right: TrustRoot): boolean {
	return stableJson(left) === stableJson(right);
}

export function sameResource(
	left: ResourceAddress,
	right: ResourceAddress,
): boolean {
	return stableJson(left) === stableJson(right);
}

export function resourceIsWithin(
	resource: ResourceAddress,
	parent: ResourceAddress,
): boolean {
	if (sameResource(resource, parent)) {
		return true;
	}
	if (
		resource.engine !== parent.engine ||
		resource.database !== parent.database
	) {
		return false;
	}
	if (parent.kind === 'database') {
		return true;
	}
	if (parent.kind === 'schema') {
		return resource.schema === parent.name;
	}
	if (resource.schema !== parent.schema) {
		return false;
	}
	return resource.qualifiedBy?.includes(parent.name) ?? false;
}

export function selectorMatchesResource(
	selector: ResourceSelector,
	resource: ResourceAddress,
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

export function resourceScopeCovers(
	scope: readonly ResourceAddress[],
	required: readonly ResourceAddress[],
): boolean {
	return required.every((resource) =>
		scope.some((covering) => resourceIsWithin(resource, covering)),
	);
}

export function assumptionAccepted(
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
