import type { CheckConstraintIR } from '@dbsp/types';
import { stableJson } from './stable-json.js';

export type CheckSetEntry = Pick<
	CheckConstraintIR,
	'name' | 'expression' | 'notValid'
>;

export type CheckDelta =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'add-check';
			readonly check: CheckSetEntry;
			readonly expectedBefore: readonly CheckSetEntry[];
			readonly expectedAfter: readonly CheckSetEntry[];
	  }
	| {
			readonly kind: 'expression-mismatch';
			readonly desired: CheckSetEntry;
			readonly current: CheckSetEntry;
			readonly expectedBefore: readonly CheckSetEntry[];
			readonly expectedAfter: readonly CheckSetEntry[];
	  }
	| { readonly kind: 'unsupported' };

const CHECK_NOT_VALID_SUFFIX =
	/^(?<clause>\s*CHECK\s*\(.*\)(?:\s+NO\s+INHERIT)?)\s+NOT\s+VALID\s*$/isu;
const CHECK_NO_INHERIT_SUFFIX =
	/^\s*CHECK\s*\(.*\)\s+NO\s+INHERIT(?:\s+NOT\s+VALID)?\s*$/isu;

function normalizedCheck(check: CheckConstraintIR): CheckSetEntry {
	return {
		name: check.name,
		expression: check.expression,
		...(check.notValid !== undefined ? { notValid: check.notValid } : {}),
	};
}

function isNotValid(check: CheckSetEntry): boolean {
	return (
		check.notValid === true ||
		CHECK_NOT_VALID_SUFFIX.test(check.expression.trim())
	);
}

function isNoInherit(check: CheckSetEntry): boolean {
	return CHECK_NO_INHERIT_SUFFIX.test(check.expression.trim());
}

function hasUnsupportedShape(check: CheckSetEntry): boolean {
	return isNotValid(check) || isNoInherit(check);
}

function byName(left: CheckSetEntry, right: CheckSetEntry): number {
	return left.name.localeCompare(right.name);
}

function sortedChecks(
	checks: readonly CheckConstraintIR[] | undefined,
): readonly CheckSetEntry[] {
	return [...(checks ?? [])].map(normalizedCheck).sort(byName);
}

function hasDuplicateNames(checks: readonly CheckSetEntry[]): boolean {
	return new Set(checks.map((check) => check.name)).size !== checks.length;
}

function checkKeySet(checks: readonly CheckSetEntry[]): ReadonlySet<string> {
	return new Set(checks.map((check) => check.name));
}

// Shared by the core comparator and adapter add-check rule; keep this as the
// single table CHECK classifier.
export function checkDelta(
	desiredChecks: readonly CheckConstraintIR[] | undefined,
	currentChecks: readonly CheckConstraintIR[] | undefined,
): CheckDelta {
	const desired = sortedChecks(desiredChecks);
	const current = sortedChecks(currentChecks);
	if (stableJson(desired) === stableJson(current)) {
		return { kind: 'none' };
	}
	if (hasDuplicateNames(desired) || hasDuplicateNames(current)) {
		return { kind: 'unsupported' };
	}
	if ([...desired, ...current].some(hasUnsupportedShape)) {
		return { kind: 'unsupported' };
	}

	const desiredNames = checkKeySet(desired);
	const currentNames = checkKeySet(current);
	const added = desired.filter((check) => !currentNames.has(check.name));
	const removed = current.filter((check) => !desiredNames.has(check.name));

	if (removed.length > 0) {
		return { kind: 'unsupported' };
	}
	if (added.length > 1) {
		return { kind: 'unsupported' };
	}

	const mismatches = desired.flatMap((desiredCheck) => {
		const currentCheck = current.find(
			(candidate) => candidate.name === desiredCheck.name,
		);
		return currentCheck && stableJson(desiredCheck) !== stableJson(currentCheck)
			? [{ desired: desiredCheck, current: currentCheck }]
			: [];
	});
	if (mismatches.length > 1) {
		return { kind: 'unsupported' };
	}
	const mismatch = mismatches[0];
	if (mismatch) {
		if (added.length > 0) {
			return { kind: 'unsupported' };
		}
		return {
			kind: 'expression-mismatch',
			desired: mismatch.desired,
			current: mismatch.current,
			expectedBefore: current,
			expectedAfter: desired,
		};
	}

	const check = added[0];
	if (!check) {
		return { kind: 'unsupported' };
	}
	return {
		kind: 'add-check',
		check,
		expectedBefore: current,
		expectedAfter: desired,
	};
}
