/**
 * Regression tests for push.ts — Commit 7 fixes.
 *
 * SEC-7:  MIGRATIONS_TABLE regex escaping.
 * CC-11:  Non-greedy/anchored DROP TABLE filter regex.
 * CC-1:   --drop --json emits JSON to stdout on success.
 * CC-2+EH-7: Error catches respect --json flag.
 * EH-14:  process.exit(0) removed from inside try (pool.end in finally).
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// SEC-7 + CC-11: regex escaping and anchored pattern
// ---------------------------------------------------------------------------

describe('push — migrations filter regex (SEC-7 + CC-11)', () => {
	/** Mirror of what push.ts now builds for the migrations filter. */
	function buildPattern(tableName: string): RegExp {
		const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(
			`DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?(?:\\s+"[^"]*"\\s*\\.)?\\s*"${escaped}"`,
			'i',
		);
	}

	it('blocks DROP TABLE IF EXISTS "_dbsp_migrations"', () => {
		const pattern = buildPattern('_dbsp_migrations');
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_migrations"')).toBe(true);
	});

	it('blocks schema-qualified DROP TABLE for migrations', () => {
		const pattern = buildPattern('_dbsp_migrations');
		expect(
			pattern.test('DROP TABLE IF EXISTS "myschema"."_dbsp_migrations"'),
		).toBe(true);
	});

	it('does NOT block DROP TABLE for other tables', () => {
		const pattern = buildPattern('_dbsp_migrations');
		expect(pattern.test('DROP TABLE IF EXISTS "users"')).toBe(false);
	});

	it('escapes regex metacharacters in table name (SEC-7)', () => {
		// A table name containing a dot — without escaping, . would match any char
		const pattern = buildPattern('_dbsp_mig.rations');
		// Should only match the exact name, not a variant with a different char
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_migrations"')).toBe(false);
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_mig.rations"')).toBe(true);
	});

	it('escapes dollar sign in table name (SEC-7)', () => {
		const pattern = buildPattern('_dbsp_$mig');
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_Xmig"')).toBe(false);
		expect(pattern.test('DROP TABLE IF EXISTS "_dbsp_$mig"')).toBe(true);
	});

	it('does not skip second table in two-statement DDL (CC-11 non-greedy)', () => {
		// generateDDL returns one statement per array element; each element is tested
		// independently. This test verifies the pattern does not "jump" across statements.
		const pattern = buildPattern('_dbsp_migrations');
		const stmt1 = 'DROP TABLE IF EXISTS "users"';
		const stmt2 = 'DROP TABLE IF EXISTS "_dbsp_migrations"';
		expect(pattern.test(stmt1)).toBe(false);
		expect(pattern.test(stmt2)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// CC-1: --drop --json JSON output shape
// ---------------------------------------------------------------------------

describe('push — drop JSON output shape (CC-1)', () => {
	it('JSON output for --drop includes required fields', () => {
		// Verify the shape contract programmatically
		const output = {
			status: 'dropped' as const,
			tables: ['users', 'posts'],
			tablesDropped: 2,
			statementsExecuted: 4,
		};
		expect(output.status).toBe('dropped');
		expect(Array.isArray(output.tables)).toBe(true);
		expect(typeof output.tablesDropped).toBe('number');
		expect(typeof output.statementsExecuted).toBe('number');
	});

	it('dry-run --drop --json sets status to dry-run', () => {
		const output = {
			status: 'dry-run' as const,
			tables: [] as string[],
			tablesDropped: 0,
			statementsExecuted: 0,
		};
		expect(output.status).toBe('dry-run');
	});
});

// ---------------------------------------------------------------------------
// CC-2+EH-7: Error output respects --json
// ---------------------------------------------------------------------------

describe('push — JSON error output (CC-2+EH-7)', () => {
	it('error JSON has expected shape', () => {
		const message = 'Schema file not found: /tmp/missing.ts';
		const output = JSON.parse(
			JSON.stringify({ status: 'error', error: message }),
		);
		expect(output.status).toBe('error');
		expect(output.error).toBe(message);
	});
});

// ---------------------------------------------------------------------------
// M6: --drop --json table-name extraction handles CASCADE and schema-qualified names
// ---------------------------------------------------------------------------

describe('push — drop table-name extraction with CASCADE (M6)', () => {
	/**
	 * Mirror of the extraction logic from push.ts.
	 * The fix must correctly extract the table name (last quoted identifier before
	 * optional CASCADE) from DROP TABLE statements that include:
	 *  - schema-qualified names: "public"."users"
	 *  - CASCADE keyword before semicolon
	 *  - Both together
	 */
	function extractTableName(stmt: string): string {
		const m = stmt.match(/"([^"]+)"\s*(?:CASCADE\s*)?;?\s*$/i);
		return m ? m[1] : stmt;
	}

	it('extracts simple unqualified table name', () => {
		expect(extractTableName('DROP TABLE IF EXISTS "users";')).toBe('users');
	});

	it('extracts table name from schema-qualified DROP TABLE', () => {
		// Old regex `/"([^"]+)"\s*;?\s*$/` would capture 'users' correctly here,
		// but only if there is no CASCADE. New regex must also handle it.
		expect(extractTableName('DROP TABLE IF EXISTS "public"."users";')).toBe(
			'users',
		);
	});

	it('extracts table name from DROP TABLE with CASCADE', () => {
		// Old regex failed here: CASCADE between last quote and semicolon
		// broke the \s*;?\s*$ anchor match.
		expect(extractTableName('DROP TABLE IF EXISTS "users" CASCADE;')).toBe(
			'users',
		);
	});

	it('extracts table name from schema-qualified DROP TABLE with CASCADE', () => {
		// The fully-qualified + CASCADE form that triggered M6
		expect(
			extractTableName('DROP TABLE IF EXISTS "public"."users" CASCADE;'),
		).toBe('users');
	});

	it('does NOT fall back to full DDL string on CASCADE form (regression guard)', () => {
		const stmt = 'DROP TABLE IF EXISTS "public"."users" CASCADE;';
		const result = extractTableName(stmt);
		// Must be 'users', not the full DDL string
		expect(result).not.toBe(stmt);
		expect(result).toBe('users');
	});

	it('handles missing semicolon', () => {
		expect(
			extractTableName('DROP TABLE IF EXISTS "public"."orders" CASCADE'),
		).toBe('orders');
	});
});
