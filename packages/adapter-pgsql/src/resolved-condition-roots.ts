/** The adapter compiles a HAVING, CASE WHEN or FILTER root only from what core recorded for it. */
import type { WhereIntent } from '@dbsp/types';

const LABELS = {
	having: 'HAVING',
	'case-when': 'CASE WHEN',
	filter: 'FILTER',
} as const;

/**
 * When core recorded every condition root of the plan (`rootsResolved`), a root
 * compiles from its resolved entry or, if core left it to the local route
 * because it holds a query-local body, through that route. Any other root is a
 * defect: it is refused instead of being lowered locally. Checked once per root,
 * at the entry that compiles it, never at its nested nodes.
 */
export function assertConditionRootRecorded(
	intent: WhereIntent,
	ctx: {
		readonly rootsResolved?: boolean;
		readonly resolvedConditions?: ReadonlyMap<WhereIntent, unknown>;
		readonly localConditions?: ReadonlySet<WhereIntent>;
	},
	position: keyof typeof LABELS,
): void {
	if (ctx.rootsResolved !== true) return;
	if (ctx.resolvedConditions?.has(intent)) return;
	if (ctx.localConditions?.has(intent)) return;
	throw new Error(
		`A ${LABELS[position]} condition reached the adapter without its resolved form.`,
	);
}
