import type { AdmittedOutcomeClaim } from '@dbsp/types';
import {
	type ApprovalScopeVerdict,
	type DigestBindingVerdict,
	type LiveAdmissionVerdict,
	mintAdmittedPermit,
	type ValidatedManifestVerdict,
} from './outcome-protocol.js';

declare const claim: AdmittedOutcomeClaim;
declare const digestBinding: DigestBindingVerdict;
declare const validatedManifest: ValidatedManifestVerdict;
declare const approvalScope: ApprovalScopeVerdict;
declare const liveAdmission: LiveAdmissionVerdict;

// @ts-expect-error A permit cannot omit the digest-binding verdict.
mintAdmittedPermit(claim, validatedManifest, approvalScope, liveAdmission);
// @ts-expect-error A permit cannot omit the validated-manifest verdict.
mintAdmittedPermit(claim, digestBinding, approvalScope, liveAdmission);
// @ts-expect-error A permit cannot omit the approval-scope verdict.
mintAdmittedPermit(claim, digestBinding, validatedManifest, liveAdmission);
// @ts-expect-error A permit cannot omit the live-admission verdict.
mintAdmittedPermit(claim, digestBinding, validatedManifest, approvalScope);

// @ts-expect-error Digest binding verdicts are module-private brands.
const forgedDigestBinding: DigestBindingVerdict = {};
// @ts-expect-error Validated manifest verdicts are module-private brands.
const forgedValidatedManifest: ValidatedManifestVerdict = {};
// @ts-expect-error Approval scope verdicts are module-private brands.
const forgedApprovalScope: ApprovalScopeVerdict = {};
// @ts-expect-error Live admission verdicts are module-private brands.
const forgedLiveAdmission: LiveAdmissionVerdict = {};

void [
	forgedDigestBinding,
	forgedValidatedManifest,
	forgedApprovalScope,
	forgedLiveAdmission,
];
