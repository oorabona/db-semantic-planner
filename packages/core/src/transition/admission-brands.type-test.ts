import type { ClaimToken } from '@dbsp/types';
import type { ValidatedManagedStepManifest } from './validation.js';

// @ts-expect-error A manifest is branded by validation, not object shape.
const forgedManifest: ValidatedManagedStepManifest = { steps: [] };

// @ts-expect-error OBL-AUTH2: claim-token construction is private to admission.
const forgedClaimToken: ClaimToken = {};

void [forgedManifest, forgedClaimToken];
