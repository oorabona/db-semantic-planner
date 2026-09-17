import { beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDiffResult } from '@/lib/ipc';
import { useSchemaDiffStore } from './schema-diff-store';

// ── Mock data ───────────────────────────────────────────────────────

const mockDiff: SchemaDiffResult = {
	changes: [
		{
			kind: 'column_added',
			table: 'users',
			column: 'email',
			destructive: false,
			details: 'Column "email" (text) added to "users"',
		},
		{
			kind: 'table_dropped',
			table: 'legacy_logs',
			destructive: true,
			details: 'Table "legacy_logs" dropped',
		},
	],
	hasDestructive: true,
	summary: {
		tables: { added: 0, dropped: 1 },
		columns: { added: 1, dropped: 0, altered: 0 },
		indexes: { added: 0, dropped: 0 },
		constraints: { added: 0, dropped: 0, altered: 0 },
	},
	upSQL: [
		'ALTER TABLE "users" ADD COLUMN "email" text;',
		'DROP TABLE "legacy_logs";',
	],
	downSQL: [
		'ALTER TABLE "users" DROP COLUMN "email";',
		'CREATE TABLE "legacy_logs" ();',
	],
	warnings: [],
};

const mockDiffSafe: SchemaDiffResult = {
	changes: [
		{
			kind: 'index_added',
			table: 'orders',
			destructive: false,
			details: 'Index "idx_orders_date" added to "orders"',
		},
	],
	hasDestructive: false,
	summary: {
		tables: { added: 0, dropped: 0 },
		columns: { added: 0, dropped: 0, altered: 0 },
		indexes: { added: 1, dropped: 0 },
		constraints: { added: 0, dropped: 0, altered: 0 },
	},
	upSQL: ['CREATE INDEX "idx_orders_date" ON "orders" ("created_at");'],
	downSQL: ['DROP INDEX "idx_orders_date";'],
	warnings: [],
};

// ── Store tests ─────────────────────────────────────────────────────

beforeEach(() => {
	useSchemaDiffStore.getState().clear();
});

describe('useSchemaDiffStore', () => {
	it('starts with empty state', () => {
		const state = useSchemaDiffStore.getState();
		expect(state.diff).toBeNull();
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();
	});

	it('startComparison sets loading=true and clears error', () => {
		const firstRequest = useSchemaDiffStore.getState().startComparison();
		useSchemaDiffStore.getState().setError(firstRequest, 'previous error');
		useSchemaDiffStore.getState().startComparison();
		const state = useSchemaDiffStore.getState();
		expect(state.loading).toBe(true);
		expect(state.error).toBeNull();
	});

	it('setDiff stores its source connection and clears loading and error', () => {
		const requestId = useSchemaDiffStore.getState().startComparison();
		useSchemaDiffStore.getState().setDiff(requestId, 'connection-a', mockDiff);
		const state = useSchemaDiffStore.getState();
		expect(state.diff).toEqual({
			connectionId: 'connection-a',
			result: mockDiff,
		});
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();
	});

	it('setError stores error and clears loading and diff', () => {
		const requestId = useSchemaDiffStore.getState().startComparison();
		useSchemaDiffStore.getState().setDiff(requestId, 'connection-a', mockDiff);
		useSchemaDiffStore.getState().setError(requestId, 'Connection refused');
		const state = useSchemaDiffStore.getState();
		expect(state.error).toBe('Connection refused');
		expect(state.loading).toBe(false);
		expect(state.diff).toBeNull();
	});

	it('clear resets all state', () => {
		const requestId = useSchemaDiffStore.getState().startComparison();
		useSchemaDiffStore.getState().setDiff(requestId, 'connection-a', mockDiff);
		useSchemaDiffStore.getState().clear();
		const state = useSchemaDiffStore.getState();
		expect(state.diff).toBeNull();
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();
	});

	it('invalidates a comparison that settles after clear', () => {
		const requestId = useSchemaDiffStore.getState().startComparison();
		useSchemaDiffStore.getState().clear();
		useSchemaDiffStore.getState().setDiff(requestId, 'connection-a', mockDiff);

		expect(useSchemaDiffStore.getState().diff).toBeNull();
	});

	// ── State transitions ───────────────────────────────────────────

	it('loading → setDiff transition', () => {
		const requestId = useSchemaDiffStore.getState().startComparison();
		expect(useSchemaDiffStore.getState().loading).toBe(true);

		useSchemaDiffStore
			.getState()
			.setDiff(requestId, 'connection-a', mockDiffSafe);
		const state = useSchemaDiffStore.getState();
		expect(state.loading).toBe(false);
		expect(state.diff).toEqual({
			connectionId: 'connection-a',
			result: mockDiffSafe,
		});
		expect(state.error).toBeNull();
	});

	it('loading → setError transition', () => {
		const requestId = useSchemaDiffStore.getState().startComparison();
		expect(useSchemaDiffStore.getState().loading).toBe(true);

		useSchemaDiffStore.getState().setError(requestId, 'Schema file not found');
		const state = useSchemaDiffStore.getState();
		expect(state.loading).toBe(false);
		expect(state.diff).toBeNull();
		expect(state.error).toBe('Schema file not found');
	});

	it('keeps the later result when an earlier comparison settles last', () => {
		const earlierRequest = useSchemaDiffStore.getState().startComparison();
		const laterRequest = useSchemaDiffStore.getState().startComparison();

		useSchemaDiffStore
			.getState()
			.setDiff(laterRequest, 'connection-b', mockDiffSafe);
		useSchemaDiffStore
			.getState()
			.setDiff(earlierRequest, 'connection-a', mockDiff);
		useSchemaDiffStore
			.getState()
			.setError(earlierRequest, 'earlier request failed');

		const state = useSchemaDiffStore.getState();
		expect(state.diff).toEqual({
			connectionId: 'connection-b',
			result: mockDiffSafe,
		});
		expect(state.error).toBeNull();
		expect(state.loading).toBe(false);
	});
});
