import type {
	ExecutionContract,
	ExecutionRequirement,
	ProvenPlanShape,
} from '@dbsp/types';
import { EXECUTION_CONTRACT_VERSION } from '@dbsp/types';
import type { InProcessProvenPlan } from './index.js';
import { mintInProcessPlan } from './minting.js';
import { stableJson } from './stable-json.js';

export type ExecutionContractValidation =
	| { readonly ok: true; readonly contract: ExecutionContract }
	| { readonly ok: false; readonly detail: string };

/**
 * The one ordering rule for execution-contract requirements. Construction uses
 * it to make fresh contracts canonical; validation uses it to verify durable
 * input has not been reordered.
 */
function canonicalRequirements(
	requirements: readonly ExecutionRequirement[],
): readonly ExecutionRequirement[] {
	const ordered = [...requirements].sort((left, right) => {
		const leftJson = stableJson(left);
		const rightJson = stableJson(right);
		return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
	});
	return ordered.filter(
		(requirement, index) =>
			index === 0 || stableJson(requirement) !== stableJson(ordered[index - 1]),
	);
}

function compareNamespaceIdentity(
	left: { readonly name: string; readonly oid: string },
	right: { readonly name: string; readonly oid: string },
): number {
	return left.name < right.name
		? -1
		: left.name > right.name
			? 1
			: left.oid < right.oid
				? -1
				: left.oid > right.oid
					? 1
					: 0;
}

function canonicalNamespaces(
	namespaces: readonly { readonly name: string; readonly oid: string }[],
): readonly { readonly name: string; readonly oid: string }[] {
	const ordered = [...namespaces].sort(compareNamespaceIdentity);
	return ordered.filter(
		(namespace, index) =>
			index === 0 ||
			compareNamespaceIdentity(namespace, ordered[index - 1] ?? namespace) !==
				0,
	);
}

/** Construct a fresh versioned contract whose requirements are canonical. */
export function createExecutionContract(
	requirements: readonly ExecutionRequirement[],
): ExecutionContract {
	return {
		version: EXECUTION_CONTRACT_VERSION,
		requirements: canonicalRequirements(requirements),
	};
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function validRequirement(
	requirement: unknown,
): requirement is ExecutionRequirement {
	if (
		requirement === null ||
		typeof requirement !== 'object' ||
		Array.isArray(requirement)
	)
		return false;
	const value = requirement as Record<string, unknown>;
	if (
		!nonEmpty(value.kind) ||
		!['must-match', 'set-and-verify', 'must-satisfy', 'provenance'].includes(
			value.mode as string,
		)
	)
		return false;
	switch (value.kind) {
		case 'postgresql.physical-target': {
			if (
				!(
					value.mode === 'must-match' &&
					nonEmpty(value.systemIdentifier) &&
					nonEmpty(value.databaseOid) &&
					Array.isArray(value.namespaces) &&
					value.namespaces.length > 0 &&
					value.namespaces.every(
						(item) =>
							item !== null &&
							typeof item === 'object' &&
							nonEmpty((item as Record<string, unknown>).name) &&
							nonEmpty((item as Record<string, unknown>).oid),
					)
				)
			)
				return false;
			const namespaces = value.namespaces as readonly {
				readonly name: string;
				readonly oid: string;
			}[];
			return (
				stableJson(namespaces) ===
					stableJson(canonicalNamespaces(namespaces)) &&
				new Set(namespaces.map((namespace) => namespace.name)).size ===
					namespaces.length
			);
		}
		case 'postgresql.engine-version':
			return (
				value.mode === 'must-satisfy' &&
				nonEmpty(value.stepId) &&
				(value.minServerVersionNum === undefined ||
					Number.isInteger(value.minServerVersionNum)) &&
				(value.maxServerVersionNum === undefined ||
					Number.isInteger(value.maxServerVersionNum))
			);
		case 'postgresql.authority':
			return (
				value.mode === 'must-satisfy' &&
				['schema-usage', 'table-alter', 'type-alter'].includes(
					value.action as string,
				) &&
				nonEmpty(value.schema) &&
				(value.action === 'schema-usage' || nonEmpty(value.object))
			);
		case 'postgresql.session-setting':
			return (
				(value.mode === 'set-and-verify' || value.mode === 'provenance') &&
				[
					'standard_conforming_strings',
					'search_path',
					'client_encoding',
					'TimeZone',
				].includes(value.setting as string) &&
				nonEmpty(value.value) &&
				(value.mode !== 'set-and-verify' ||
					(value.setting === 'standard_conforming_strings' &&
						value.value === 'on') ||
					(value.setting === 'client_encoding' && value.value === 'UTF8'))
			);
		default:
			return false;
	}
}

/** Fail closed for malformed, future, or non-canonical persisted contracts. */
export function validateExecutionContract(
	value: unknown,
): ExecutionContractValidation {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return {
			ok: false,
			detail: 'plan is missing an execution contract; re-plan before execution',
		};
	const contract = value as ExecutionContract;
	if (contract.version !== EXECUTION_CONTRACT_VERSION)
		return {
			ok: false,
			detail: `execution contract version ${String(contract.version)} is unsupported`,
		};
	if (
		!Array.isArray(contract.requirements) ||
		contract.requirements.length === 0
	)
		return { ok: false, detail: 'execution contract has no requirements' };
	if (!contract.requirements.every(validRequirement))
		return {
			ok: false,
			detail: 'execution contract contains an unknown requirement kind or mode',
		};
	const canonical = canonicalRequirements(contract.requirements);
	if (stableJson(canonical) !== stableJson(contract.requirements))
		return {
			ok: false,
			detail: 'execution contract requirements are not canonically ordered',
		};
	return { ok: true, contract };
}

/** Attach a planning-time-only contract to a fresh immutable durable plan. */
export function bindExecutionContract(
	plan: InProcessProvenPlan,
	contract: ExecutionContract,
): InProcessProvenPlan {
	const validation = validateExecutionContract(contract);
	if (!validation.ok) throw new Error(validation.detail);
	// Do not JSON-clone here. Minting accepts explicit plain-data values such as
	// undefined, NaN, Infinity, and -0; JSON would silently alter them before the
	// digest is calculated. Persistence performs its own lossless JSONB gate.
	return mintInProcessPlan({
		...plan,
		executionContract: validation.contract,
	} as ProvenPlanShape);
}
