import { describe, expect, it } from 'vitest';
import { generateCreateIndexSQL } from '../ddl/index-operations.js';

describe('SQL Injection Checks (DDL-TABLE-001)', () => {
	it('throws when creating index with unsafe WITH options', () => {
		expect(() =>
			generateCreateIndexSQL('users', {
				name: 'idx',
				columns: ['id'],
				with: { 'fillfactor = 10; DROP TABLE users; --': 1 },
			}),
		).toThrow(/Invalid storage parameter identifier/);
	});
});
