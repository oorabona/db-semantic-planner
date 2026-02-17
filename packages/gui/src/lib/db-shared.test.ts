/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type Database,
	openDatabase,
	openDatabaseSafe,
	setDatabaseFactory,
} from './db-shared';

function createMockDb(): Database {
	return {
		execute: vi.fn().mockResolvedValue({ lastInsertId: 0, rowsAffected: 0 }),
		select: vi.fn().mockResolvedValue([]),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

afterEach(() => {
	setDatabaseFactory(null);
});

describe('openDatabase', () => {
	it('throws if no factory configured', async () => {
		await expect(openDatabase('sqlite:test.db')).rejects.toThrow(
			'No database factory configured',
		);
	});

	it('delegates to factory', async () => {
		const mockDb = createMockDb();
		const factory = vi.fn().mockResolvedValue(mockDb);
		setDatabaseFactory(factory);

		const db = await openDatabase('sqlite:test.db');

		expect(factory).toHaveBeenCalledWith('sqlite:test.db');
		expect(db).toBe(mockDb);
	});
});

describe('openDatabaseSafe', () => {
	it('returns healthy database on success', async () => {
		const mockDb = createMockDb();
		setDatabaseFactory(vi.fn().mockResolvedValue(mockDb));

		const db = await openDatabaseSafe('sqlite:test.db');
		expect(db).toBe(mockDb);
		expect(mockDb.execute).toHaveBeenCalledWith('SELECT 1');
	});

	it('calls onCorrupt and retries on failure', async () => {
		const corruptDb = createMockDb();
		(corruptDb.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('database disk image is malformed'),
		);

		const freshDb = createMockDb();
		let callCount = 0;
		const factory = vi.fn().mockImplementation(async () => {
			callCount++;
			return callCount === 1 ? corruptDb : freshDb;
		});
		setDatabaseFactory(factory);

		const onCorrupt = vi.fn();
		const db = await openDatabaseSafe('sqlite:test.db', onCorrupt);

		expect(onCorrupt).toHaveBeenCalledWith('sqlite:test.db');
		expect(db).toBe(freshDb);
	});

	it('throws if both attempts fail', async () => {
		const factory = vi.fn().mockRejectedValue(new Error('disk full'));
		setDatabaseFactory(factory);

		await expect(openDatabaseSafe('sqlite:test.db')).rejects.toThrow(
			'Failed to open database',
		);
	});
});
