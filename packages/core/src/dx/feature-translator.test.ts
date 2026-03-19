import { describe, expect, it } from 'vitest';
import type {
	DDLFeatureElementMap,
	DialectCapabilities,
	EnumIR,
	FeatureTranslator,
	IndexIR,
	SequenceIR,
	TranslationContext,
} from '@dbsp/types';
import { POSTGRESQL_CAPABILITIES } from '../dialects/index.js';

describe('FeatureTranslator interface (CAPS-005)', () => {
	const pgContext: TranslationContext = {
		schemaName: 'public',
		tableName: 'users',
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	};

	// SC-13: FeatureTranslator interface is usable — translator returns SQL
	describe('when a mock translator translates an enum', () => {
		it('should return dialect-specific SQL strings', () => {
			// Arrange
			const mockEnumTranslator: FeatureTranslator<'enum'> = {
				feature: 'enum',
				translate(element: DDLFeatureElementMap['enum'], _context: TranslationContext): string[] | null {
					const values = element.values.map((v) => `'${v}'`).join(', ');
					return [`CREATE TYPE "${element.name}" AS ENUM (${values})`];
				},
			};

			const enumIR: EnumIR = {
				name: 'status',
				values: ['active', 'inactive', 'pending'],
			};

			// Act
			const result = mockEnumTranslator.translate(enumIR, pgContext);

			// Assert
			expect(result).toEqual([
				"CREATE TYPE \"status\" AS ENUM ('active', 'inactive', 'pending')",
			]);
		});
	});

	// SC-14: Translator returning null falls through to skip
	describe('when a translator returns null', () => {
		it('should indicate the feature should be skipped (use default behavior)', () => {
			// Arrange
			const skipTranslator: FeatureTranslator<'sequence'> = {
				feature: 'sequence',
				translate(_element: DDLFeatureElementMap['sequence'], _context: TranslationContext): string[] | null {
					return null; // fall through — skip this feature
				},
			};

			const seqIR: SequenceIR = {
				name: 'users_id_seq',
				startWith: 1,
				incrementBy: 1,
			};

			// Act
			const result = skipTranslator.translate(seqIR, pgContext);

			// Assert
			expect(result).toBeNull();
		});
	});

	// Type-safety test: DDLFeatureElementMap enforces correct element types
	describe('type-safe element map', () => {
		it('should enforce correct element type per feature', () => {
			// Arrange — index translator receives IndexIR, not EnumIR
			const indexMethodTranslator: FeatureTranslator<'indexMethod'> = {
				feature: 'indexMethod',
				translate(element: DDLFeatureElementMap['indexMethod'], _context: TranslationContext): string[] | null {
					if (!element.method || element.method === 'btree') return null;
					const cols = element.columns.join(', ');
					return [`CREATE INDEX USING ${element.method} ON (${cols})`];
				},
			};

			const indexIR: IndexIR = {
				name: 'idx_users_search',
				columns: ['name'],
				method: 'gin',
			};

			// Act
			const result = indexMethodTranslator.translate(indexIR, pgContext);

			// Assert
			expect(result).toEqual(['CREATE INDEX USING gin ON (name)']);
		});

		it('should work with comment feature element type', () => {
			// Arrange
			const commentTranslator: FeatureTranslator<'comment'> = {
				feature: 'comment',
				translate(element: DDLFeatureElementMap['comment'], _context: TranslationContext): string[] | null {
					if (element.target === 'table') {
						return [`COMMENT ON TABLE "${element.name}" IS '${element.comment}'`];
					}
					return [`COMMENT ON COLUMN "${element.name}" IS '${element.comment}'`];
				},
			};

			const commentElement: DDLFeatureElementMap['comment'] = {
				target: 'table',
				name: 'users',
				comment: 'Main users table',
			};

			// Act
			const result = commentTranslator.translate(commentElement, pgContext);

			// Assert
			expect(result).toEqual(["COMMENT ON TABLE \"users\" IS 'Main users table'"]);
		});
	});

	// TranslationContext provides dialect capabilities
	describe('TranslationContext', () => {
		it('should provide dialect capabilities for conditional translation', () => {
			// Arrange — translator checks capabilities before translating
			const conditionalTranslator: FeatureTranslator<'enum'> = {
				feature: 'enum',
				translate(element: DDLFeatureElementMap['enum'], context: TranslationContext): string[] | null {
					if (context.dialectCapabilities.supportsDDLEnumTypes) {
						return [`CREATE TYPE "${element.name}" AS ENUM ()`];
					}
					// Fall back to CHECK constraint
					return null;
				},
			};

			const enumIR: EnumIR = { name: 'role', values: ['admin', 'user'] };

			// Act — PG supports enums
			const pgResult = conditionalTranslator.translate(enumIR, pgContext);

			// Act — adapter without enum support
			const limitedContext: TranslationContext = {
				dialectCapabilities: {
					...POSTGRESQL_CAPABILITIES,
					supportsDDLEnumTypes: undefined,
				} as DialectCapabilities,
			};
			const limitedResult = conditionalTranslator.translate(enumIR, limitedContext);

			// Assert
			expect(pgResult).toEqual(['CREATE TYPE "role" AS ENUM ()']);
			expect(limitedResult).toBeNull();
		});
	});
});
