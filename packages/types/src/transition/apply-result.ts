import type { PlanAssessment } from './assessment.js';
import type { RecoveryArtefact } from './guard.js';
import type { IssuedObservation } from './observation.js';
import type { ProvenGuardProtocol, StepJournal } from './plan.js';

export interface ApplyResult {
	readonly assessment: PlanAssessment;
	readonly journals: readonly StepJournal[];
	readonly observations: readonly IssuedObservation[];
	readonly recovery?: readonly {
		readonly stepId: string;
		readonly protocol: ProvenGuardProtocol['kind'];
		readonly artefact: RecoveryArtefact;
	}[];
}
