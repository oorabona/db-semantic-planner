/**
 * AST Comparison Utilities for Roundtrip Testing
 *
 * Provides utilities to compare PostgreSQL AST structures
 * for verifying deparse → parse → deparse roundtrips.
 */

import type { ParseResult } from '@pgsql/types';
import { deparseSync, parseSync } from 'pgsql-parser';

interface CompareResult {
	readonly equal: boolean;
	readonly differences: readonly string[];
}

/**
 * Normalize an AST for comparison by removing location info
 * and sorting object keys deterministically.
 */
function normalizeAST(node: unknown): unknown {
	if (node === null || node === undefined) {
		return node;
	}

	if (Array.isArray(node)) {
		return node.map(normalizeAST);
	}

	if (typeof node === 'object') {
		const obj = node as Record<string, unknown>;
		const normalized: Record<string, unknown> = {};

		// Sort keys for deterministic comparison
		const keys = Object.keys(obj).sort();

		for (const key of keys) {
			// Skip location fields (they're not semantically relevant)
			if (key === 'location' || key === 'stmt_len' || key === 'stmt_location') {
				continue;
			}

			normalized[key] = normalizeAST(obj[key]);
		}

		return normalized;
	}

	return node;
}

/**
 * Compare two AST nodes deeply, ignoring locations
 */
export function compareAST(
	a: unknown,
	b: unknown,
	path = 'root',
): CompareResult {
	const differences: string[] = [];

	function compare(nodeA: unknown, nodeB: unknown, currentPath: string): void {
		const normalizedA = normalizeAST(nodeA);
		const normalizedB = normalizeAST(nodeB);

		// Handle nulls/undefined
		if (normalizedA === null || normalizedA === undefined) {
			if (normalizedB !== null && normalizedB !== undefined) {
				differences.push(
					`${currentPath}: left is null/undefined, right is ${typeof normalizedB}`,
				);
			}
			return;
		}

		if (normalizedB === null || normalizedB === undefined) {
			differences.push(
				`${currentPath}: left is ${typeof normalizedA}, right is null/undefined`,
			);
			return;
		}

		// Handle primitives
		if (typeof normalizedA !== 'object' || typeof normalizedB !== 'object') {
			if (normalizedA !== normalizedB) {
				differences.push(
					`${currentPath}: ${JSON.stringify(normalizedA)} !== ${JSON.stringify(normalizedB)}`,
				);
			}
			return;
		}

		// Handle arrays
		if (Array.isArray(normalizedA) && Array.isArray(normalizedB)) {
			if (normalizedA.length !== normalizedB.length) {
				differences.push(
					`${currentPath}: array length ${normalizedA.length} !== ${normalizedB.length}`,
				);
				return;
			}

			for (let i = 0; i < normalizedA.length; i++) {
				compare(normalizedA[i], normalizedB[i], `${currentPath}[${i}]`);
			}
			return;
		}

		if (Array.isArray(normalizedA) !== Array.isArray(normalizedB)) {
			differences.push(`${currentPath}: array mismatch`);
			return;
		}

		// Handle objects
		const objA = normalizedA as Record<string, unknown>;
		const objB = normalizedB as Record<string, unknown>;
		const keysA = Object.keys(objA).sort();
		const keysB = Object.keys(objB).sort();

		// Check for missing keys
		for (const key of keysA) {
			if (!(key in objB)) {
				differences.push(`${currentPath}.${key}: missing in right`);
			}
		}

		for (const key of keysB) {
			if (!(key in objA)) {
				differences.push(`${currentPath}.${key}: missing in left`);
			}
		}

		// Compare common keys
		for (const key of keysA) {
			if (key in objB) {
				compare(objA[key], objB[key], `${currentPath}.${key}`);
			}
		}
	}

	compare(a, b, path);

	return {
		equal: differences.length === 0,
		differences,
	};
}

/**
 * Perform a roundtrip test: SQL → parse → deparse → parse → compare ASTs
 */
export function roundtripTest(sql: string): {
	original: ParseResult;
	reparsed: ParseResult;
	comparison: CompareResult;
	originalSQL: string;
	deparseSQL: string;
} {
	// Parse original SQL
	const original = parseSync(sql);

	// Deparse to SQL
	const deparseSQL = deparseSync(original);

	// Reparse deparsed SQL
	const reparsed = parseSync(deparseSQL);

	// Compare ASTs
	const comparison = compareAST(original, reparsed);

	return {
		original,
		reparsed,
		comparison,
		originalSQL: sql,
		deparseSQL,
	};
}

/**
 * Assert that a SQL string survives roundtrip without semantic changes
 */
export function assertRoundtrip(sql: string): void {
	const result = roundtripTest(sql);

	if (!result.comparison.equal) {
		throw new Error(
			`Roundtrip failed for: ${sql}\n` +
				`Deparsed to: ${result.deparseSQL}\n` +
				`Differences:\n  ${result.comparison.differences.join('\n  ')}`,
		);
	}
}

/**
 * Compare two SQL strings by parsing both and comparing ASTs
 */
export function compareSQLByAST(sql1: string, sql2: string): CompareResult {
	try {
		const parsed1 = parseSync(sql1);
		const parsed2 = parseSync(sql2);
		return compareAST(parsed1, parsed2);
	} catch (e) {
		return {
			equal: false,
			differences: [
				`Parse error: ${e instanceof Error ? e.message : String(e)}`,
			],
		};
	}
}
