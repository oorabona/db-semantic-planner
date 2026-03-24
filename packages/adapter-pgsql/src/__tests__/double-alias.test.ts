/**
 * DOUBLE-ALIAS regression tests
 *
 * When two includes resolve to the same table with the same relation name
 * (e.g., include('def.file') + include('file')), both would previously generate
 * a JOIN alias of 'file', causing PostgreSQL error:
 *   "table name "file" specified more than once"
 *
 * The compiler must deduplicate aliases by suffixing with _N.
 */

import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

/**
 * Schema under test:
 *   variable_uses  --file_id-->  files        (direct relation 'file')
 *   variable_uses  --def_id--->  variable_defs
 *   variable_defs  --file_id-->  files        (nested: 'def.file', alias also 'file')
 */

describe('DOUBLE-ALIAS: duplicate join aliases are deduplicated', () => {
	it('single include("file") uses alias "file" without suffix', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'variable_uses',
			decisions: [
				{ type: 'select', column: 'id' },
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'file',
					relationName: 'file',
					targetTable: 'files',
					sourceTable: 'variable_uses',
					sourceColumn: 'file_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['path'],
					columnAliases: { path: 'file.path' },
				},
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('join');
		expect(sql).toContain('files');

		// The alias 'file' should appear without a numeric suffix
		expect(sql).toMatch(/files\s+as\s+file\b/i);
		expect(sql).not.toMatch(/files\s+as\s+file_1\b/i);
	});

	it('include("def.file") + include("file") produces two JOINs with distinct aliases', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'variable_uses',
			decisions: [
				{ type: 'select', column: 'id' },
				// First hop: variable_uses -> variable_defs (relation 'def')
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'def',
					relationName: 'def',
					targetTable: 'variable_defs',
					sourceTable: 'variable_uses',
					sourceColumn: 'def_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['name'],
					columnAliases: { name: 'def.name' },
				},
				// Second hop: variable_defs -> files (relation 'file', first usage)
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'file',
					relationName: 'file',
					targetTable: 'files',
					sourceTable: 'variable_defs',
					sourceColumn: 'file_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['path'],
					columnAliases: { path: 'def.file.path' },
				},
				// Direct: variable_uses -> files (relation 'file', SAME alias -> becomes file_1)
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'file',
					relationName: 'file',
					targetTable: 'files',
					sourceTable: 'variable_uses',
					sourceColumn: 'file_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['path'],
					columnAliases: { path: 'file.path' },
				},
			],
		};

		// Must NOT throw "table name specified more than once"
		expect(() => compilePlan(plan)).not.toThrow();

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// At least 3 joins: def, file (from def.file), file_1 (direct)
		const joinMatches = sql.match(/\bjoin\b/gi) ?? [];
		expect(joinMatches.length).toBeGreaterThanOrEqual(3);

		// Both original and suffixed alias must appear
		expect(sql).toMatch(/files\s+as\s+file\b/i);
		expect(sql).toMatch(/files\s+as\s+file_1\b/i);

		// Two distinct JOINs to the files table
		const filesMatches = sql.match(/\bfiles\b/gi) ?? [];
		expect(filesMatches.length).toBeGreaterThanOrEqual(2);
	});

	it('three includes with same alias get incremental suffixes: file, file_1, file_2', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'root_table',
			decisions: [
				{ type: 'select', column: 'id' },
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'file',
					relationName: 'file',
					targetTable: 'files',
					sourceTable: 'root_table',
					sourceColumn: 'file_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['path'],
				},
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'file',
					relationName: 'file',
					targetTable: 'files',
					sourceTable: 'root_table',
					sourceColumn: 'file2_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['path'],
				},
				{
					type: 'includeStrategy',
					choice: 'join',
					relation: 'file',
					relationName: 'file',
					targetTable: 'files',
					sourceTable: 'root_table',
					sourceColumn: 'file3_id',
					targetColumn: 'id',
					relationType: 'belongsTo',
					columns: ['path'],
				},
			],
		};

		expect(() => compilePlan(plan)).not.toThrow();

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/files\s+as\s+file\b/i);
		expect(sql).toMatch(/files\s+as\s+file_1\b/i);
		expect(sql).toMatch(/files\s+as\s+file_2\b/i);

		const filesMatches = sql.match(/\bfiles\b/gi) ?? [];
		expect(filesMatches.length).toBeGreaterThanOrEqual(3);
	});
});
