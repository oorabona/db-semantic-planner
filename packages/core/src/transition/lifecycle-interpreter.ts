import {
	LEDGER_EVENT_KINDS,
	type LedgerAddress,
	type LedgerChainMember,
	type LedgerChainProjection,
	type LedgerClaimKind,
	type LedgerHome,
	type LedgerLifecycleGrammarColumn,
	type LedgerOpenClaim,
	type LedgerPayload,
	type LedgerReportedState,
	type LedgerStableState,
	type ProjectedLedgerChain,
	type UnprojectableChainReason,
	type UnprojectableLedgerChain,
} from '@dbsp/types';

/** Bump whenever the malformed-chain vocabulary or interpretation changes. */
export const LEDGER_PROJECTION_CODE_VERSION = 1 as const;

/**
 * The one closed grammar matrix. Later claim and token producers consume this
 * interpreter; they do not reconstruct lifecycle state from ledger spellings.
 */
export const LEDGER_LIFECYCLE_GRAMMAR: Readonly<
	Record<LedgerClaimKind, LedgerLifecycleGrammarColumn>
> = {
	intent: {
		claimKind: 'intent',
		opensFrom: ['unknown', 'managed', 'absent'],
		resolvesThrough: [
			'refused',
			'executing',
			'observed',
			'indeterminate',
			'resolved',
		],
	},
	'retire-intent': {
		claimKind: 'retire-intent',
		opensFrom: ['managed'],
		resolvesThrough: [
			'refused',
			'executing',
			'absent',
			'indeterminate',
			'resolved',
		],
	},
	'readdress-intent': {
		claimKind: 'readdress-intent',
		opensFrom: ['unknown', 'managed', 'absent'],
		resolvesThrough: ['refused', 'readdressed-to', 'readdressed-from'],
	},
	'adopt-intent': {
		claimKind: 'adopt-intent',
		opensFrom: ['unknown'],
		resolvesThrough: ['refused', 'adopt'],
	},
};

const CLAIM_KINDS = new Set<LedgerClaimKind>([
	'adopt-intent',
	'intent',
	'retire-intent',
	'readdress-intent',
]);

interface LifecycleFrame {
	readonly stableState: LedgerStableState;
	readonly openClaim?: LedgerOpenClaim;
}

type LifecycleStep =
	| { readonly kind: 'ok'; readonly frame: LifecycleFrame }
	| { readonly kind: 'invalid'; readonly detail: string };

export interface LedgerChainProjectionInput {
	readonly ledger: LedgerHome;
	readonly address: LedgerAddress;
	readonly events: readonly LedgerChainMember[];
}

function isLedgerEventKind(value: string): boolean {
	return (LEDGER_EVENT_KINDS as readonly string[]).includes(value);
}

function sameAddress(left: LedgerAddress, right: LedgerAddress): boolean {
	return (
		left.scope === right.scope &&
		left.engine === right.engine &&
		left.database === right.database &&
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.name === right.name &&
		sameOptionalAddress(left.parent, right.parent)
	);
}

function sameOptionalAddress(
	left: LedgerAddress['parent'],
	right: LedgerAddress['parent'],
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.engine === right.engine &&
		left.database === right.database &&
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.name === right.name &&
		sameOptionalAddress(left.parent, right.parent)
	);
}

function invalid(detail: string): LifecycleStep {
	return { kind: 'invalid', detail };
}

function requiresReadBack(
	event: LedgerChainMember,
	label: string,
): LifecycleStep | undefined {
	if (event.observed !== undefined) return undefined;
	return invalid(`${label} requires its supporting read-back`);
}

function opensClaim(
	stableState: LedgerStableState,
	event: LedgerChainMember,
): LifecycleStep {
	if (!CLAIM_KINDS.has(event.eventKind as LedgerClaimKind)) {
		return invalid(`event ${event.eventKind} cannot open a claim`);
	}
	const claimKind = event.eventKind as LedgerClaimKind;
	const column = LEDGER_LIFECYCLE_GRAMMAR[claimKind];
	if (!column.opensFrom.includes(stableState)) {
		return invalid(`${claimKind} cannot open from stable state ${stableState}`);
	}
	if (claimKind === 'readdress-intent' && !event.pairId) {
		return invalid('readdress-intent requires a pair id');
	}
	return {
		kind: 'ok',
		frame: {
			stableState,
			openClaim: {
				event,
				kind: claimKind,
				stableStateBeforeClaim: stableState,
				phase: 'claimed',
			},
		},
	};
}

function resolveStableState(
	claim: LedgerOpenClaim,
	event: LedgerChainMember,
): LedgerStableState {
	if (claim.kind === 'intent')
		return event.observed === undefined
			? claim.stableStateBeforeClaim
			: 'managed';
	return event.observed === undefined ? 'absent' : 'managed';
}

/** Interprets exactly one terminal-to-next lifecycle edge. */
export function interpretLedgerLifecycle(
	frame: LifecycleFrame,
	event: LedgerChainMember,
): LifecycleStep {
	if (frame.openClaim === undefined && event.eventKind === 'released') {
		// LedgerEventKind is closed at fourteen spellings and has no
		// release-intent member. Until unit 13 supplies its claim protocol,
		// released is the atomic managed-to-unknown event in that vocabulary.
		if (frame.stableState !== 'managed')
			return invalid('released requires a managed stable state');
		return { kind: 'ok', frame: { stableState: 'unknown' } };
	}
	if (frame.openClaim === undefined)
		return opensClaim(frame.stableState, event);

	const claim = frame.openClaim;
	const allowed = LEDGER_LIFECYCLE_GRAMMAR[claim.kind].resolvesThrough;
	if (!allowed.includes(event.eventKind)) {
		return invalid(
			`${event.eventKind} is not in the ${claim.kind} resolution column`,
		);
	}

	switch (event.eventKind) {
		case 'refused':
			if (claim.phase === 'indeterminate')
				return invalid('refused cannot close an indeterminate claim');
			return { kind: 'ok', frame: { stableState: frame.stableState } };
		case 'executing':
			if (claim.phase !== 'claimed')
				return invalid('executing may follow only a newly opened claim');
			return {
				kind: 'ok',
				frame: {
					stableState: frame.stableState,
					openClaim: { ...claim, phase: 'executing' },
				},
			};
		case 'observed': {
			const readBack = requiresReadBack(event, 'observed');
			if (readBack) return readBack;
			if (claim.phase === 'indeterminate')
				return invalid('observed cannot close an indeterminate claim');
			return { kind: 'ok', frame: { stableState: 'managed' } };
		}
		case 'absent':
			if (claim.phase === 'indeterminate')
				return invalid('absent cannot close an indeterminate claim');
			return { kind: 'ok', frame: { stableState: 'absent' } };
		case 'indeterminate':
			if (claim.phase === 'indeterminate')
				return invalid('indeterminate may be appended only once');
			return {
				kind: 'ok',
				frame: {
					stableState: frame.stableState,
					openClaim: { ...claim, phase: 'indeterminate' },
				},
			};
		case 'resolved': {
			if (claim.phase !== 'indeterminate')
				return invalid('resolved closes only an indeterminate claim');
			// A payload establishes managed. An absence read-back has no catalogue
			// shape to persist in LedgerChainMember, so its stable outcome is the
			// non-managed arm of the originating claim column.
			return {
				kind: 'ok',
				frame: { stableState: resolveStableState(claim, event) },
			};
		}
		case 'adopt': {
			const readBack = requiresReadBack(event, 'adopt');
			if (readBack) return readBack;
			return { kind: 'ok', frame: { stableState: 'managed' } };
		}
		case 'readdressed-to':
			if (claim.stableStateBeforeClaim !== 'managed')
				return invalid('readdressed-to resolves only the managed source');
			if (event.pairId !== claim.event.pairId)
				return invalid('readdressed-to pair id does not match its claim');
			return { kind: 'ok', frame: { stableState: 'unknown' } };
		case 'readdressed-from': {
			const readBack = requiresReadBack(event, 'readdressed-from');
			if (readBack) return readBack;
			if (claim.stableStateBeforeClaim === 'managed')
				return invalid('readdressed-from resolves only an unoccupied target');
			if (event.pairId !== claim.event.pairId)
				return invalid('readdressed-from pair id does not match its claim');
			return { kind: 'ok', frame: { stableState: 'managed' } };
		}
		case 'released':
			return { kind: 'ok', frame: { stableState: 'unknown' } };
		default:
			return invalid(`${event.eventKind} cannot resolve a claim`);
	}
}

function unprojectable(
	input: LedgerChainProjectionInput,
	reason: UnprojectableChainReason,
): UnprojectableLedgerChain {
	return {
		kind: 'unprojectable-ledger-chain',
		ledger: input.ledger,
		address: input.address,
		events: input.events,
		reason,
		codeVersion: LEDGER_PROJECTION_CODE_VERSION,
	};
}

function reportState(frame: LifecycleFrame): LedgerReportedState {
	if (frame.openClaim === undefined) return { kind: frame.stableState };
	return frame.openClaim.phase === 'indeterminate'
		? {
				kind: 'blocked',
				stableState: frame.stableState,
				claim: frame.openClaim,
			}
		: {
				kind: 'pending',
				stableState: frame.stableState,
				claim: frame.openClaim,
			};
}

function projected(
	input: LedgerChainProjectionInput,
	frame: LifecycleFrame,
	declaration: LedgerPayload | undefined,
	observation: LedgerPayload | undefined,
): ProjectedLedgerChain {
	return {
		kind: 'projected-ledger-chain',
		ledger: input.ledger,
		address: input.address,
		events: input.events,
		stableState: frame.stableState,
		...(frame.openClaim === undefined ? {} : { openClaim: frame.openClaim }),
		reportedState: reportState(frame),
		...(declaration === undefined ? {} : { declaration }),
		...(observation === undefined ? {} : { observation }),
	};
}

/**
 * Projects a whole address chain without using insertion order. Malformed
 * chains deliberately return a structured value so mutation callers fail
 * closed while readers retain the evidence needed to diagnose it.
 */
export function projectLedgerChain(
	input: LedgerChainProjectionInput,
): LedgerChainProjection {
	const byId = new Map<string, LedgerChainMember>();
	const children = new Map<string | undefined, LedgerChainMember[]>();
	for (const event of input.events) {
		if (!sameAddress(input.address, event.address))
			return unprojectable(input, {
				code: 'address-mismatch',
				eventId: event.eventId,
			});
		if (!isLedgerEventKind(event.eventKind))
			return unprojectable(input, {
				code: 'unknown-event-kind',
				eventId: event.eventId,
				eventKind: event.eventKind,
			});
		if (byId.has(event.eventId))
			return unprojectable(input, {
				code: 'duplicate-event-id',
				eventId: event.eventId,
			});
		byId.set(event.eventId, event);
		const siblings = children.get(event.predecessor) ?? [];
		siblings.push(event);
		children.set(event.predecessor, siblings);
	}

	for (const event of input.events) {
		if (event.predecessor !== undefined && !byId.has(event.predecessor)) {
			return unprojectable(input, {
				code: 'missing-predecessor',
				eventId: event.eventId,
				predecessor: event.predecessor,
			});
		}
	}

	for (const [predecessor, siblings] of children) {
		if (siblings.length > 1)
			return unprojectable(input, {
				code: 'fork',
				...(predecessor === undefined ? {} : { predecessor }),
				eventIds: siblings.map((event) => event.eventId),
			});
	}

	const roots = children.get(undefined) ?? [];
	if (roots.length > 1)
		return unprojectable(input, {
			code: 'fork',
			eventIds: roots.map((event) => event.eventId),
		});
	if (input.events.length > 0 && roots.length === 0)
		return unprojectable(input, {
			code: 'cycle',
			eventIds: input.events.map((event) => event.eventId),
		});

	let frame: LifecycleFrame = { stableState: 'unknown' };
	let declaration: LedgerPayload | undefined;
	let observation: LedgerPayload | undefined;
	let current = roots[0];
	const visited = new Set<string>();
	while (current !== undefined) {
		if (visited.has(current.eventId))
			return unprojectable(input, {
				code: 'cycle',
				eventIds: [...visited, current.eventId],
			});
		visited.add(current.eventId);
		const step = interpretLedgerLifecycle(frame, current);
		if (step.kind === 'invalid')
			return unprojectable(input, {
				code: 'invalid-lifecycle-edge',
				eventId: current.eventId,
				detail: step.detail,
			});
		frame = step.frame;
		if (current.declared !== undefined) declaration = current.declared;
		if (current.observed !== undefined) observation = current.observed;
		current = children.get(current.eventId)?.[0];
	}

	if (visited.size !== input.events.length)
		return unprojectable(input, {
			code: 'cycle',
			eventIds: input.events
				.filter((event) => !visited.has(event.eventId))
				.map((event) => event.eventId),
		});
	return projected(input, frame, declaration, observation);
}
