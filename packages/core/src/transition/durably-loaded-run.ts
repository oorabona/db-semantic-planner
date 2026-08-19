import type { TransitionRunMetadata } from '@dbsp/types';

declare const durablyLoadedRunBrand: unique symbol;

/**
 * Core-minted evidence that run metadata passed the execution entry boundary.
 * Its nominal member prevents accidental structural construction; the private
 * record keeps the runtime check meaningful when JavaScript is the caller.
 */
export interface DurablyLoadedRun {
	readonly metadata: Readonly<TransitionRunMetadata>;
	readonly [durablyLoadedRunBrand]: 'dbsp-durably-loaded-run';
}

const durablyLoadedRuns = new WeakSet<object>();

function frozenMetadata(
	run: TransitionRunMetadata,
): Readonly<TransitionRunMetadata> {
	return Object.freeze({ ...run });
}

/** Internal mint used only by the two core execution boundaries. */
export function mintDurablyLoadedRun(
	run: TransitionRunMetadata,
): DurablyLoadedRun {
	const witness = Object.freeze({
		metadata: frozenMetadata(run),
	}) as DurablyLoadedRun;
	durablyLoadedRuns.add(witness);
	return witness;
}

/** Runtime authenticity check for trusted internal consumers. */
export function isDurablyLoadedRun(value: unknown): value is DurablyLoadedRun {
	return (
		value != null &&
		(typeof value === 'object' || typeof value === 'function') &&
		durablyLoadedRuns.has(value as object)
	);
}
