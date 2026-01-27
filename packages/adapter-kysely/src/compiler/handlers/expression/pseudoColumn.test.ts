/**
 * Unit tests for pseudo-column handler helpers.
 *
 * Tests the pure functions used by the pseudoColumn expression handler:
 * - findMatchingPseudo: match traversal keyword → PseudoColumnMetadata
 * - isRecursiveKeyword: detect ascendant/descendant keywords
 * - isParentTraversal: determine JOIN direction (FK→PK vs PK→FK)
 */

import type { PseudoColumnMetadata } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	findMatchingPseudo,
	isParentTraversal,
	isRecursiveKeyword,
} from './pseudoColumn.js';

// ─── Fixtures ──────────────────────────────────────────────────

/** Default roles (parent/child/ascendant/descendant) */
const defaultPseudo: PseudoColumnMetadata = {
	table: 'employees',
	foreignKeyColumn: 'parent_id',
	targetColumn: 'id',
	parentRole: 'parent',
	childRole: 'child',
	ascendantKeyword: 'ascendant',
	descendantKeyword: 'descendant',
};

/** Custom roles (manager/directReports/managementChain/allReports) */
const managerPseudo: PseudoColumnMetadata = {
	table: 'employees',
	foreignKeyColumn: 'manager_id',
	targetColumn: 'id',
	parentRole: 'manager',
	childRole: 'directReports',
	ascendantKeyword: 'managementChain',
	descendantKeyword: 'allReports',
};

const pseudoColumns = [defaultPseudo, managerPseudo];

// ─── findMatchingPseudo ────────────────────────────────────────

describe('findMatchingPseudo', () => {
	describe('without explicit role', () => {
		it('matches parentRole keyword', () => {
			expect(findMatchingPseudo(pseudoColumns, 'parent')).toBe(defaultPseudo);
		});

		it('matches childRole keyword', () => {
			expect(findMatchingPseudo(pseudoColumns, 'child')).toBe(defaultPseudo);
		});

		it('matches ascendantKeyword', () => {
			expect(findMatchingPseudo(pseudoColumns, 'ascendant')).toBe(
				defaultPseudo,
			);
		});

		it('matches descendantKeyword', () => {
			expect(findMatchingPseudo(pseudoColumns, 'descendant')).toBe(
				defaultPseudo,
			);
		});

		it('matches custom parentRole (manager)', () => {
			expect(findMatchingPseudo(pseudoColumns, 'manager')).toBe(managerPseudo);
		});

		it('matches custom childRole (directReports)', () => {
			expect(findMatchingPseudo(pseudoColumns, 'directReports')).toBe(
				managerPseudo,
			);
		});

		it('matches custom ascendantKeyword (managementChain)', () => {
			expect(findMatchingPseudo(pseudoColumns, 'managementChain')).toBe(
				managerPseudo,
			);
		});

		it('matches custom descendantKeyword (allReports)', () => {
			expect(findMatchingPseudo(pseudoColumns, 'allReports')).toBe(
				managerPseudo,
			);
		});

		it('is case-insensitive', () => {
			expect(findMatchingPseudo(pseudoColumns, 'PARENT')).toBe(defaultPseudo);
			expect(findMatchingPseudo(pseudoColumns, 'Manager')).toBe(managerPseudo);
		});

		it('returns undefined for unknown keyword', () => {
			expect(findMatchingPseudo(pseudoColumns, 'supervisor')).toBeUndefined();
		});

		it('returns undefined for empty list', () => {
			expect(findMatchingPseudo([], 'parent')).toBeUndefined();
		});
	});

	describe('with explicit role', () => {
		it('matches explicit role against parentRole', () => {
			expect(findMatchingPseudo(pseudoColumns, 'parent', 'parent')).toBe(
				defaultPseudo,
			);
		});

		it('matches explicit role against childRole', () => {
			expect(
				findMatchingPseudo(pseudoColumns, 'anything', 'directReports'),
			).toBe(managerPseudo);
		});

		it('matches keyword even when role is provided', () => {
			expect(findMatchingPseudo(pseudoColumns, 'manager', 'someRole')).toBe(
				managerPseudo,
			);
		});

		it('is case-insensitive with role', () => {
			expect(findMatchingPseudo(pseudoColumns, 'x', 'MANAGER')).toBe(
				managerPseudo,
			);
		});
	});
});

// ─── isRecursiveKeyword ────────────────────────────────────────

describe('isRecursiveKeyword', () => {
	it('detects default ascendant keyword', () => {
		expect(isRecursiveKeyword('ascendant', defaultPseudo)).toBe(true);
	});

	it('detects default descendant keyword', () => {
		expect(isRecursiveKeyword('descendant', defaultPseudo)).toBe(true);
	});

	it('detects custom ascendant keyword (managementChain)', () => {
		expect(isRecursiveKeyword('managementChain', managerPseudo)).toBe(true);
	});

	it('detects custom descendant keyword (allReports)', () => {
		expect(isRecursiveKeyword('allReports', managerPseudo)).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isRecursiveKeyword('ASCENDANT', defaultPseudo)).toBe(true);
		expect(isRecursiveKeyword('ManagementChain', managerPseudo)).toBe(true);
	});

	it('returns false for non-recursive keywords', () => {
		expect(isRecursiveKeyword('parent', defaultPseudo)).toBe(false);
		expect(isRecursiveKeyword('child', defaultPseudo)).toBe(false);
		expect(isRecursiveKeyword('manager', managerPseudo)).toBe(false);
		expect(isRecursiveKeyword('directReports', managerPseudo)).toBe(false);
	});

	it('returns false for unknown keyword', () => {
		expect(isRecursiveKeyword('unknown', defaultPseudo)).toBe(false);
	});
});

// ─── isParentTraversal ─────────────────────────────────────────

describe('isParentTraversal', () => {
	it('detects default parent traversal', () => {
		expect(isParentTraversal('parent', defaultPseudo)).toBe(true);
	});

	it('detects default ascendant as parent direction', () => {
		expect(isParentTraversal('ascendant', defaultPseudo)).toBe(true);
	});

	it('detects custom parent traversal (manager)', () => {
		expect(isParentTraversal('manager', managerPseudo)).toBe(true);
	});

	it('detects custom ascendant as parent direction (managementChain)', () => {
		expect(isParentTraversal('managementChain', managerPseudo)).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isParentTraversal('PARENT', defaultPseudo)).toBe(true);
		expect(isParentTraversal('Manager', managerPseudo)).toBe(true);
	});

	it('returns false for child direction', () => {
		expect(isParentTraversal('child', defaultPseudo)).toBe(false);
		expect(isParentTraversal('descendant', defaultPseudo)).toBe(false);
		expect(isParentTraversal('directReports', managerPseudo)).toBe(false);
		expect(isParentTraversal('allReports', managerPseudo)).toBe(false);
	});

	it('returns false for unknown keyword', () => {
		expect(isParentTraversal('unknown', defaultPseudo)).toBe(false);
	});
});
