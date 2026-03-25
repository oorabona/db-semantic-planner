import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapter.js';
import { wrapTablesProxyWithDDL } from './orm-instance.js';

describe('Transaction Safety Checks (DDL-TABLE-001)', () => {
function makeTxAdapter(inTransaction = true) {
const executeDDL = vi.fn().mockResolvedValue(undefined);
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
generateDDL: vi.fn(),
dbCasing: 'snake_case',
} as unknown as Adapter<unknown>;
return { adapter, executeDDL };
}

const mockTable = {};

it('throws when running VACUUM inside a transaction', async () => {
const { adapter, executeDDL } = makeTxAdapter(true);
const tables = wrapTablesProxyWithDDL({ users: mockTable }, adapter, undefined) as any;

await expect(tables.users.vacuum()).rejects.toThrow(
'VACUUM cannot run inside a transaction block'
);
expect(executeDDL).not.toHaveBeenCalled();
});

it('throws when creating index CONCURRENTLY inside a transaction', async () => {
const { adapter, executeDDL } = makeTxAdapter(true);
const tables = wrapTablesProxyWithDDL({ users: mockTable }, adapter, undefined) as any;

await expect(tables.users.indexes.create({ 
name: 'idx', columns: ['id'], concurrently: true 
})).rejects.toThrow('CREATE INDEX CONCURRENTLY cannot run inside a transaction block');
expect(executeDDL).not.toHaveBeenCalled();
});

it('throws when dropping index CONCURRENTLY inside a transaction', async () => {
const { adapter, executeDDL } = makeTxAdapter(true);
const tables = wrapTablesProxyWithDDL({ users: mockTable }, adapter, undefined) as any;

await expect(tables.users.indexes.drop('idx', { concurrently: true }))
.rejects.toThrow('DROP INDEX CONCURRENTLY cannot run inside a transaction block');
expect(executeDDL).not.toHaveBeenCalled();
});
});
