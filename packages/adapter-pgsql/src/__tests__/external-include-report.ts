import type { PlanReport } from '@dbsp/types';
/** A spread copy deliberately loses the issuing registry authority. */
export function asExternalReport(report: PlanReport): PlanReport {
	return { ...report };
}
