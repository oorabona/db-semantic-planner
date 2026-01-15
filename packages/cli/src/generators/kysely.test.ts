import type { ResolvedSchema } from '@dbsp/schema';
import { describe, expect, it } from 'vitest';
import { generateKysely } from './kysely.js';

describe('generateKysely', () => {
	const sampleSchema: ResolvedSchema = {
		tables: {
			users: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string', nullable: false },
				email: { type: 'string', unique: true },
				bio: { type: 'text', nullable: true },
				age: { type: 'integer' },
				balance: { type: 'decimal' },
				active: { type: 'boolean' },
				createdAt: { type: 'timestamp', default: 'now()' },
				updatedAt: { type: 'timestamp' },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
				title: { type: 'string' },
				content: { type: 'text', nullable: true },
				authorId: { type: 'uuid', references: { table: 'users' } },
				metadata: { type: 'jsonb', nullable: true },
				viewCount: { type: 'bigint', default: '0' },
			},
		},
		relations: {},
		hints: {},
		conventions: {
			fkPattern: '{singular}Id',
			pluralize: true,
			timestamps: ['createdAt', 'updatedAt'],
		},
	};

	describe('DB interface', () => {
		it('generates DB interface with all tables', () => {
			const result = generateKysely(sampleSchema);

			expect(result.dbInterface).toContain('export interface DB {');
			expect(result.dbInterface).toContain('users: UsersTable;');
			expect(result.dbInterface).toContain('posts: PostsTable;');
		});

		it('imports table types', () => {
			const result = generateKysely(sampleSchema);

			expect(result.dbInterface).toContain('import type {');
			expect(result.dbInterface).toContain('UsersTable,');
			expect(result.dbInterface).toContain('PostsTable,');
			expect(result.dbInterface).toContain("} from './types.js';");
		});
	});

	describe('table types', () => {
		it('imports Kysely types', () => {
			const result = generateKysely(sampleSchema);

			expect(result.tableTypes).toContain(
				"import type { Generated, ColumnType } from 'kysely';",
			);
		});

		it('generates interface for each table', () => {
			const result = generateKysely(sampleSchema);

			expect(result.tableTypes).toContain('export interface UsersTable {');
			expect(result.tableTypes).toContain('export interface PostsTable {');
		});

		it('uses Generated<T> for primary key', () => {
			const result = generateKysely(sampleSchema);

			expect(result.tableTypes).toContain('id: Generated<string>;');
		});

		it('uses Generated<T> for columns with default', () => {
			const result = generateKysely(sampleSchema);

			// viewCount has default: '0'
			expect(result.tableTypes).toContain('viewCount: Generated<bigint>;');
		});

		it('uses ColumnType for timestamp columns', () => {
			const result = generateKysely(sampleSchema);

			// createdAt has default, so insert type includes undefined
			expect(result.tableTypes).toContain(
				'createdAt: ColumnType<Date, Date | string | undefined, Date | string>;',
			);

			// updatedAt has no default
			expect(result.tableTypes).toContain(
				'updatedAt: ColumnType<Date, Date | string, Date | string>;',
			);
		});

		it('uses nullable types for nullable columns', () => {
			const result = generateKysely(sampleSchema);

			expect(result.tableTypes).toContain('bio: string | null;');
			expect(result.tableTypes).toContain('content: string | null;');
			expect(result.tableTypes).toContain('metadata: unknown | null;');
		});

		it('maps column types correctly', () => {
			const result = generateKysely(sampleSchema);

			// uuid → string
			expect(result.tableTypes).toContain('authorId: string;');

			// integer → number
			expect(result.tableTypes).toContain('age: number;');

			// decimal → string (for precision)
			expect(result.tableTypes).toContain('balance: string;');

			// boolean → boolean
			expect(result.tableTypes).toContain('active: boolean;');

			// jsonb → unknown
			expect(result.tableTypes).toMatch(/metadata: unknown \| null/);
		});
	});

	describe('edge cases', () => {
		it('handles snake_case table names', () => {
			const schema: ResolvedSchema = {
				tables: {
					user_profiles: {
						id: { type: 'uuid', primaryKey: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
				},
			};

			const result = generateKysely(schema);

			expect(result.dbInterface).toContain('user_profiles: UserProfilesTable;');
			expect(result.tableTypes).toContain(
				'export interface UserProfilesTable {',
			);
		});

		it('handles nullable primary key (unusual but valid)', () => {
			const schema: ResolvedSchema = {
				tables: {
					weird: {
						id: { type: 'uuid', primaryKey: true, nullable: true },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
				},
			};

			const result = generateKysely(schema);

			expect(result.tableTypes).toContain('id: Generated<string | null>;');
		});

		it('handles all column types', () => {
			const schema: ResolvedSchema = {
				tables: {
					all_types: {
						uuid_col: { type: 'uuid' },
						string_col: { type: 'string' },
						text_col: { type: 'text' },
						integer_col: { type: 'integer' },
						bigint_col: { type: 'bigint' },
						decimal_col: { type: 'decimal' },
						boolean_col: { type: 'boolean' },
						timestamp_col: { type: 'timestamp' },
						date_col: { type: 'date' },
						time_col: { type: 'time' },
						json_col: { type: 'json' },
						jsonb_col: { type: 'jsonb' },
					},
				},
				relations: {},
				hints: {},
				conventions: {
					fkPattern: '{singular}Id',
					pluralize: true,
					timestamps: [],
				},
			};

			const result = generateKysely(schema);

			expect(result.tableTypes).toContain('uuid_col: string;');
			expect(result.tableTypes).toContain('string_col: string;');
			expect(result.tableTypes).toContain('text_col: string;');
			expect(result.tableTypes).toContain('integer_col: number;');
			expect(result.tableTypes).toContain('bigint_col: bigint;');
			expect(result.tableTypes).toContain('decimal_col: string;');
			expect(result.tableTypes).toContain('boolean_col: boolean;');
			expect(result.tableTypes).toContain('timestamp_col: Date;');
			expect(result.tableTypes).toContain('date_col: Date;');
			expect(result.tableTypes).toContain('time_col: string;');
			expect(result.tableTypes).toContain('json_col: unknown;');
			expect(result.tableTypes).toContain('jsonb_col: unknown;');
		});
	});
});
