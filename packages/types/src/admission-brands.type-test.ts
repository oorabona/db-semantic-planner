import type { DestructiveAuthorityPermit } from './transition/destructive-authority.js';
import type { AdmittedPermit } from './transition/outcome-protocol.js';

// @ts-expect-error An admission permit is minted only by live adapter admission.
const forgedPermit: AdmittedPermit = {};

// @ts-expect-error OBL-AUTH7: destructive authority is interpreter-minted.
const forgedDestructivePermit: DestructiveAuthorityPermit = {};

void [forgedPermit, forgedDestructivePermit];
