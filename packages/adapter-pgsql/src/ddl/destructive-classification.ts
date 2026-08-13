import type { ChangeKind } from './schema-diff.js';

/** EFF-04's closed generated-mutation result domain. */
export type GeneratedMutationClassification =
	| 'non-destructive'
	| 'removal'
	| 'data-destructive'
	/** A table rename is executed only by the paired re-address protocol. */
	| 'paired-readdress';

const NON_DESTRUCTIVE_KINDS: ReadonlySet<ChangeKind> = new Set([
	'create_table',
	'add_column',
	'alter_column_nullable',
	'alter_column_default',
	'alter_column_unique',
	'add_primary_key',
	'add_foreign_key',
	'validate_constraint',
	'create_index',
	'add_check_constraint',
	'create_enum',
	'alter_enum_add_value',
	'alter_column_collation',
	'alter_column_identity',
	'create_extension',
	'create_sequence',
	'alter_sequence',
]);

const REMOVAL_KINDS: ReadonlySet<ChangeKind> = new Set([
	'drop_table',
	'drop_column',
	'drop_primary_key',
	'drop_foreign_key',
	'alter_foreign_key',
	'drop_index',
	'drop_check_constraint',
	'drop_enum',
	'drop_extension',
	'drop_sequence',
]);

/**
 * Total, fail-closed classifier for generator mutations. `string` is deliberate:
 * a newly-added ChangeKind cannot silently become safe before this table names it.
 */
export function classifyGeneratedMutation(
	kind: ChangeKind | string,
	change?: { readonly destructive?: boolean },
): GeneratedMutationClassification {
	// A re-address has two ledger chains, two identities and a paired terminal.
	// It is neither a generic safe mutation nor a destructive fallback.
	if (kind === 'readdress_table') return 'paired-readdress';
	if (
		kind === 'enable_rls' ||
		kind === 'disable_rls' ||
		kind === 'create_policy' ||
		kind === 'drop_policy' ||
		kind === 'add_comment' ||
		kind === 'drop_comment'
	)
		throw new Error(
			`generator planning refuses ${kind}: non-declarable changes have no execution classification`,
		);
	// The ChangeKind names both directions of a unique alteration.  Its
	// producer carries the direction, so removing the backing constraint is a
	// removal rather than the formerly unsafe non-destructive default.
	if (kind === 'alter_column_unique' && change?.destructive === true)
		return 'removal';
	if (REMOVAL_KINDS.has(kind as ChangeKind)) return 'removal';
	if (NON_DESTRUCTIVE_KINDS.has(kind as ChangeKind)) return 'non-destructive';
	// alter_column_type is deliberately here: it must be proven non-lossy by a
	// later authority reader; otherwise a type rewrite destroys stored values.
	return 'data-destructive';
}

export function isGeneratedMutationDestructive(
	kind: ChangeKind | string,
	change?: { readonly destructive?: boolean },
): boolean {
	const classification = classifyGeneratedMutation(kind, change);
	return (
		classification !== 'non-destructive' &&
		classification !== 'paired-readdress'
	);
}

/** All removal statements remain generator-only; no transition operation maps one. */
export function refusesRecordedPlanRemoval(
	kind: ChangeKind | string,
	change?: { readonly destructive?: boolean },
): boolean {
	return classifyGeneratedMutation(kind, change) === 'removal';
}
