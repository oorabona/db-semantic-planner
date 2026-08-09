import type { AdmittedPermit } from './transition/outcome-protocol.js';

// @ts-expect-error An admission permit is minted only by live adapter admission.
const forgedPermit: AdmittedPermit = {};

void forgedPermit;
