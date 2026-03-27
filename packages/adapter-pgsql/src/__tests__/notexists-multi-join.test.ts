/**
 * NOTEXISTS-MULTI-JOIN: Multi-hop JOINs inside EXISTS / NOT EXISTS subqueries.
 *
 * Feature: notExists('callee_calls', {
 *   include: { calleeFile: { join: 'inner' }, calleeProject: { join: 'inner' } },
 *   where: eq('calleeProject.status', 'active')
 * })
 * generates:
 *   NOT EXISTS (
 *     SELECT 1 FROM callee_calls AS callee_calls_exists_0
 *     INNER JOIN files AS calleeFile ON callee_calls_exists_0.file_id = calleeFile.id
 *     INNER JOIN projects AS calleeProject ON calleeFile.project_id = calleeProject.id
 *     WHERE callee_calls_exists_0.callee_id = symbols.id
 *       AND calleeProject.status = $1
 *   )
 *
 * Schema (3-level chain):
 *   symbols: id (PK), name
 *   files: id (PK), path, project_id (FK→projects, as 'calleeProject')
 *   projects: id (PK), status, name, team_id (FK→teams, as 'calleeTeam')
 *   teams: id (PK), name
 *   callee_calls: id (PK), callee_id (FK→symbols, as 'calleeSymbol'), file_id (FK→files, as 'calleeFile')
 */

import { and, createOrm, eq, exists, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema — 4-level chain: symbols → callee_calls → files → projects → teams
// ---------------------------------------------------------------------------

const testSchema = schema({
	teams: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	projects: {
		id: { type: 'integer', primaryKey: true },
		status: { type: 'text' },
		name: { type: 'text' },
		team_id: ref('teams', { as: 'calleeTeam', inverse: 'projects' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
		project_id: ref('projects', { as: 'calleeProject', inverse: 'files' }),
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	callee_calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'calleeSymbol', inverse: 'callee_calls' }),
		file_id: ref('files', { as: 'calleeFile', inverse: 'callee_calls' }),
	},
});

function buildAdapter() {
	return createPgsqlCompileOnlyAdapter({ model: testSchema.model });
}

/** Normalize whitespace for SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// SC-01: Two JOINs inside NOT EXISTS — correct FK chaining
// ---------------------------------------------------------------------------

describe('SC-01: Two JOINs inside NOT EXISTS', () => {
	it('produces NOT EXISTS with two INNER JOINs and correct FK on second hop', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls', {
				include: {
					calleeFile: { join: 'inner' },
					calleeProject: { join: 'inner' },
				},
			}),
		});

		const normalized = ws(sql);

		// Must be NOT EXISTS
		expect(normalized).toMatch(/NOT\s*\(?\s*EXISTS/i);

		// FROM callee_calls (root of subquery)
		expect(normalized).toMatch(/FROM\s+"?callee_calls"?/i);

		// First hop: JOIN files AS calleeFile ON callee_calls.file_id = calleeFile.id
		expect(normalized).toMatch(/JOIN\s+"?files"?\s+AS\s+"?calleeFile"?/i);
		expect(normalized).toContain('file_id');

		// Second hop: JOIN projects AS calleeProject ON calleeFile.project_id = calleeProject.id
		expect(normalized).toMatch(/JOIN\s+"?projects"?\s+AS\s+"?calleeProject"?/i);
		// The ON for second hop must reference calleeFile (intermediate alias), not root callee_calls alias
		expect(normalized).toContain('calleeFile');
		expect(normalized).toContain('project_id');
	});
});

// ---------------------------------------------------------------------------
// SC-02: WHERE conditions referencing both joined tables
// ---------------------------------------------------------------------------

describe('SC-02: WHERE conditions reference multiple joined aliases', () => {
	it('conditions on both calleeFile and calleeProject are emitted correctly', () => {
		const adapter = buildAdapter();

		const { sql, parameters } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls', {
				include: {
					calleeFile: { join: 'inner' },
					calleeProject: { join: 'inner' },
				},
				where: and(
					eq('calleeFile.path', '/src/main.ts'),
					eq('calleeProject.status', 'active'),
				),
			}),
		});

		const normalized = ws(sql);

		expect(normalized).toMatch(/NOT\s*\(?\s*EXISTS/i);
		expect(normalized).toMatch(/JOIN\s+"?files"?/i);
		expect(normalized).toMatch(/JOIN\s+"?projects"?/i);

		// Both WHERE parameters bound
		expect(parameters).toContain('/src/main.ts');
		expect(parameters).toContain('active');
	});
});

// ---------------------------------------------------------------------------
// SC-03: Three JOINs (3-hop chain)
// ---------------------------------------------------------------------------

describe('SC-03: Three JOINs (3-hop chain)', () => {
	it('chains callee_calls → files → projects → teams with correct FK at each hop', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls', {
				include: {
					calleeFile: { join: 'inner' },
					calleeProject: { join: 'inner' },
					calleeTeam: { join: 'inner' },
				},
			}),
		});

		const normalized = ws(sql);

		expect(normalized).toMatch(/NOT\s*\(?\s*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?callee_calls"?/i);

		// Hop 1: callee_calls → files
		expect(normalized).toMatch(/JOIN\s+"?files"?\s+AS\s+"?calleeFile"?/i);

		// Hop 2: files → projects (ON calleeFile.project_id = calleeProject.id)
		expect(normalized).toMatch(/JOIN\s+"?projects"?\s+AS\s+"?calleeProject"?/i);
		expect(normalized).toContain('project_id');

		// Hop 3: projects → teams (ON calleeProject.team_id = calleeTeam.id)
		expect(normalized).toMatch(/JOIN\s+"?teams"?\s+AS\s+"?calleeTeam"?/i);
		expect(normalized).toContain('team_id');
	});
});

// ---------------------------------------------------------------------------
// SC-04: Single JOIN regression — same behavior as NOTEXISTS-JOIN
// ---------------------------------------------------------------------------

describe('SC-04: Single JOIN regression', () => {
	it('single-include notExists still works after the multi-hop fix', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls', {
				include: { calleeFile: { join: 'inner' } },
				where: eq('calleeFile.path', '/test'),
			}),
		});

		const normalized = ws(sql);

		expect(normalized).toMatch(/NOT\s*\(?\s*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?callee_calls"?/i);
		expect(normalized).toMatch(/JOIN\s+"?files"?\s+AS\s+"?calleeFile"?/i);

		// Only ONE join present
		const joinMatches = normalized.match(/\bJOIN\b/gi) ?? [];
		expect(joinMatches.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// SC-05: No include — plain NOT EXISTS regression
// ---------------------------------------------------------------------------

describe('SC-05: No include — plain NOT EXISTS', () => {
	it('notExists without include produces no JOINs', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls', {
				where: eq('callee_id', 99),
			}),
		});

		const normalized = ws(sql);

		expect(normalized).toMatch(/NOT\s*\(?\s*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?callee_calls"?/i);
		expect(normalized).not.toMatch(/\bJOIN\b/i);
	});
});

// ---------------------------------------------------------------------------
// SC-06: FK fallback without ModelIR (no model in ctx)
// ---------------------------------------------------------------------------

describe('SC-06: FK fallback without ModelIR', () => {
	it('multi-join without ModelIR falls back to convention and still emits JOINs', () => {
		// No model passed → FK derivation convention applies (relation_id)
		const adapter = createPgsqlCompileOnlyAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls', {
				include: {
					calleeFile: { join: 'inner' },
					calleeProject: { join: 'inner' },
				},
			}),
		});

		const normalized = ws(sql);

		// Both JOINs present even without ModelIR
		expect(normalized).toMatch(/NOT\s*\(?\s*EXISTS/i);
		expect(normalized).toMatch(/JOIN/i);
		const joinMatches = normalized.match(/\bJOIN\b/gi) ?? [];
		expect(joinMatches.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// SC-07: exists() (positive) with multi-join
// ---------------------------------------------------------------------------

describe('SC-07: exists() with multi-join', () => {
	it('exists() with two includes produces EXISTS (not NOT EXISTS) with correct JOINs', () => {
		const adapter = buildAdapter();
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = orm
			.select('symbols')
			.where(
				exists('callee_calls', {
					include: {
						calleeFile: { join: 'inner' },
						calleeProject: { join: 'inner' },
					},
					where: eq('calleeProject.status', 'active'),
				}),
			)
			.dump();

		const normalized = ws(dump.sql);

		// Must be EXISTS, NOT NOT EXISTS
		expect(normalized).toMatch(/\bEXISTS\b/i);
		expect(normalized).not.toMatch(/NOT\s*\(?\s*EXISTS/i);

		// Both JOINs present
		expect(normalized).toMatch(/JOIN\s+"?files"?\s+AS\s+"?calleeFile"?/i);
		expect(normalized).toMatch(/JOIN\s+"?projects"?\s+AS\s+"?calleeProject"?/i);

		// Second hop ON references calleeFile (intermediate alias)
		expect(normalized).toContain('calleeFile');
		expect(normalized).toContain('project_id');
	});
});
