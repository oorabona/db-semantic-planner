import { describe, expect, it } from 'vitest';
import { classifyGeneratedMutation } from './destructive-classification.js';
import type { ChangeKind } from './schema-diff.js';

type FrozenClassification =
	| ReturnType<typeof classifyGeneratedMutation>
	| 'refuses';

const FROZEN_CHANGE_KIND_CLASSIFICATIONS: Readonly<
	Record<ChangeKind, FrozenClassification>
> = {
	create_table: 'non-destructive',
	drop_table: 'removal',
	readdress_table: 'paired-readdress',
	add_column: 'non-destructive',
	drop_column: 'removal',
	alter_column_type: 'data-destructive',
	alter_column_nullable: 'non-destructive',
	alter_column_default: 'non-destructive',
	alter_column_unique: 'non-destructive',
	add_primary_key: 'non-destructive',
	drop_primary_key: 'removal',
	add_foreign_key: 'non-destructive',
	drop_foreign_key: 'removal',
	alter_foreign_key: 'removal',
	validate_constraint: 'non-destructive',
	create_index: 'non-destructive',
	drop_index: 'removal',
	add_check_constraint: 'non-destructive',
	drop_check_constraint: 'removal',
	create_enum: 'non-destructive',
	alter_enum_add_value: 'non-destructive',
	drop_enum: 'removal',
	alter_column_collation: 'non-destructive',
	alter_column_identity: 'non-destructive',
	add_comment: 'refuses',
	drop_comment: 'refuses',
	create_extension: 'non-destructive',
	drop_extension: 'removal',
	create_sequence: 'non-destructive',
	alter_sequence: 'non-destructive',
	drop_sequence: 'removal',
	enable_rls: 'refuses',
	disable_rls: 'refuses',
	create_policy: 'refuses',
	drop_policy: 'refuses',
};

describe('generated mutation destructive classification', () => {
	it('OBL-LIFE3: uses the frozen ChangeKind mapping and reserves the default for unknown kinds', () => {
		for (const [kind, expected] of Object.entries(
			FROZEN_CHANGE_KIND_CLASSIFICATIONS,
		) as [ChangeKind, FrozenClassification][]) {
			if (expected === 'refuses')
				expect(() => classifyGeneratedMutation(kind)).toThrow(
					'non-declarable changes have no execution classification',
				);
			else expect(classifyGeneratedMutation(kind)).toBe(expected);
		}
		expect(classifyGeneratedMutation('future_unclassified_kind')).toBe(
			'data-destructive',
		);
	});
});
