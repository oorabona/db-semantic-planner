import type { ValidatedManagedStepManifest } from './validation.js';

// @ts-expect-error A manifest is branded by validation, not object shape.
const forgedManifest: ValidatedManagedStepManifest = { steps: [] };

void forgedManifest;
