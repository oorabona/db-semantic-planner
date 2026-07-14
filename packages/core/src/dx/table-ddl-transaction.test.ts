import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapter.js';
import { wrapTablesProxyWithDDL } from './orm-instance.js';

describe('Transaction Safety Checks (DDL-TABLE-001)', () => {
	function makeTxAdapter(inTransaction = true) {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const generateVacuum = vi.fn().mockReturnValue('VACUUM users');
		const generateCreateIndex = vi.fn().mockReturnValue('CREATE INDEX idx');
		const generateDropIndex = vi.fn().mockReturnValue('DROP INDEX idx');
		const adapter = {
			executeDDL,
			inTransaction,
			execute: vi.fn(),
			compile: vi.fn(),
			executeRaw: vi.fn(),
			stream: vi.fn(),
			introspect: vi.fn(),
			transaction: vi.fn(),
			withSchema: vi.fn().mockReturnThis(),
			validateIdentifier: vi.fn(),
			generateVacuum,
			generateCreateIndex,
			generateDropIndex,
			generateDDL: vi.fn(),
			dbCasing: 'snake_case',
		} as unknown as Adapter<unknown>;
		return {
			adapter,
			executeDDL,
			generateVacuum,
			generateCreateIndex,
			generateDropIndex,
		};
	}

	const mockTable = {};

	it('throws when running VACUUM inside a transaction', async () => {
		const { adapter, executeDDL, generateVacuum } = makeTxAdapter(true);
		const tables = wrapTablesProxyWithDDL(
			{ users: mockTable },
			adapter,
			undefined,
		) as any;

		await expect(tables.users.vacuum()).rejects.toThrow(
			'VACUUM cannot run inside a transaction block',
		);
		expect(executeDDL).not.toHaveBeenCalled();
		expect(generateVacuum).not.toHaveBeenCalled();
	});

	it('refuses borrowed-client CREATE INDEX CONCURRENTLY at the core boundary', async () => {
		const { adapter, executeDDL, generateCreateIndex } = makeTxAdapter(true);
		const tables = wrapTablesProxyWithDDL(
			{ users: mockTable },
			adapter,
			undefined,
		) as any;

		await expect(
			tables.users.indexes.create({
				name: 'idx',
				columns: ['id'],
				concurrently: true,
			}),
		).rejects.toThrow(
			'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
		);
		expect(executeDDL).not.toHaveBeenCalled();
		expect(generateCreateIndex).not.toHaveBeenCalled();
	});

	it('throws when dropping index CONCURRENTLY inside a transaction', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeTxAdapter(true);
		const tables = wrapTablesProxyWithDDL(
			{ users: mockTable },
			adapter,
			undefined,
		) as any;

		await expect(
			tables.users.indexes.drop('idx', { concurrently: true }),
		).rejects.toThrow(
			'DROP INDEX CONCURRENTLY cannot run inside a transaction block',
		);
		expect(executeDDL).not.toHaveBeenCalled();
		expect(generateDropIndex).not.toHaveBeenCalled();
	});
});
