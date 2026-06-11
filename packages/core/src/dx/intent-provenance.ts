import { unwrapExpressionValueIntent } from '@dbsp/types/internal';
import type { QueryIntent } from '../intent-ast.js';
import type { PlanReport } from '../planner.js';

function isObject(value: unknown): value is object {
	return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function stripExpressionValueProvenance(
	value: unknown,
	seen: WeakMap<object, unknown>,
): unknown {
	const unwrapped = unwrapExpressionValueIntent(value);
	if (unwrapped !== value) {
		return stripExpressionValueProvenance(unwrapped, seen);
	}

	if (Array.isArray(value)) {
		const cached = seen.get(value);
		if (cached) return cached;

		const stripped: unknown[] = [];
		seen.set(value, stripped);
		for (const item of value) {
			stripped.push(stripExpressionValueProvenance(item, seen));
		}
		return stripped;
	}

	if (!isPlainObject(value)) {
		return value;
	}

	const cached = seen.get(value);
	if (cached) return cached;

	const stripped: Record<string, unknown> = Object.create(null);
	seen.set(value, stripped);
	for (const key of Object.keys(value)) {
		stripped[key] = stripExpressionValueProvenance(value[key], seen);
	}
	return stripped;
}

export function stripIntentProvenance(intent: QueryIntent): QueryIntent {
	return stripExpressionValueProvenance(
		intent,
		new WeakMap<object, unknown>(),
	) as QueryIntent;
}

export function stripPlanReportProvenance(report: PlanReport): PlanReport {
	const stripped = stripExpressionValueProvenance(
		report,
		new WeakMap<object, unknown>(),
	) as PlanReport;

	return Object.freeze({
		...stripped,
		decisions: Object.freeze(stripped.decisions.slice()),
		warnings: Object.freeze(stripped.warnings.slice()),
		ctes: Object.freeze(stripped.ctes.slice()),
		metadata: Object.freeze({ ...stripped.metadata }),
	});
}
