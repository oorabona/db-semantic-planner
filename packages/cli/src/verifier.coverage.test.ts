// @ts-nocheck — coverage test
/**
 * Coverage tests for verifier.ts — targets uncovered branches.
 *
 * Branches covered:
 * - branch 0[1]: CHANGE_TO_DRIFT ?? fallback for unknown change kind
 * - branch 6[0]: formatVerifyResult with info-only issues
 */

import { describe, expect, it } from 'vitest';
import { formatVerifyResult, verifyFromDiff } from './verifier.js';

describe('verifier coverage', () => {
	it('should format result with info-only issues', () => {
		// Create a diff with only drop_column changes (severity: info)
		const diff = {
			changes: [
				{
					kind: 'drop_column',
					table: 'users',
					column: 'legacy_field',
					destructive: false,
					details: 'DROP COLUMN "legacy_field" from "users"',
				},
				{
					kind: 'drop_index',
					table: 'users',
					destructive: false,
					details: 'DROP INDEX "idx_legacy" from "users"',
				},
			],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 1, altered: 0 },
				indexes: { added: 0, dropped: 1 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		};

		const result = verifyFromDiff(diff, ['users'], ['users']);
		const output = formatVerifyResult(result);

		// Should be valid (no errors)
		expect(output).toContain('Schema matches database');
		// Should contain info section
		expect(output).toContain('2 info:');
	});

	it('should use fallback mapping for unknown change kind', () => {
		// Force an unknown change kind (defensive branch)
		const diff = {
			changes: [
				{
					kind: 'unknown_future_kind',
					table: 'x',
					destructive: false,
					details: 'Some future change',
				},
			],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		};

		const result = verifyFromDiff(diff, [], []);

		// Fallback: severity=warning, type=type_mismatch
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].severity).toBe('warning');
		expect(result.issues[0].type).toBe('type_mismatch');
	});
});
