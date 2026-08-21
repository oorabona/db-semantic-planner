import type { ApplyResult } from '@dbsp/types';
import type { DurableApplyResult } from './index.js';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: false
		: false;
type Expect<T extends true> = T;

type MismatchedRecoveryRequiredResult = Omit<
	ApplyResult,
	'unresolvedOutcome' | 'durableOutcome'
> & {
	readonly unresolvedOutcome: {
		readonly kind: 'recovery-required';
		readonly claimId: 'claim-1';
		readonly detail: 'claim remains open';
	};
	readonly durableOutcome: 'completed';
};

type _RecoveryRequiredCannotPairWithCompleted = Expect<
	Equal<
		MismatchedRecoveryRequiredResult extends DurableApplyResult ? true : false,
		false
	>
>;
