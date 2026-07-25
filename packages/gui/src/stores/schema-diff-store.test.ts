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
	autocommitSQL: [],
	mainSQL: [
		'ALTER TABLE "users" ADD COLUMN "email" text;',
		'DROP TABLE "legacy_logs";',
	],
	downSQL: [
		'ALTER TABLE "users" DROP COLUMN "email";',
		'CREATE TABLE "legacy_logs" ();',
	],
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
	autocommitSQL: [],
	mainSQL: ['CREATE INDEX "idx_orders_date" ON "orders" ("created_at");'],
	downSQL: ['DROP INDEX "idx_orders_date";'],
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

	it('setLoading sets loading=true and clears error', () => {
		useSchemaDiffStore.getState().setError('previous error');
		useSchemaDiffStore.getState().setLoading();
		const state = useSchemaDiffStore.getState();
		expect(state.loading).toBe(true);
		expect(state.error).toBeNull();
	});

	it('setDiff stores result and clears loading and error', () => {
		useSchemaDiffStore.getState().setLoading();
		useSchemaDiffStore.getState().setDiff(mockDiff);
		const state = useSchemaDiffStore.getState();
		expect(state.diff).toBe(mockDiff);
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();
	});

	it('setError stores error and clears loading and diff', () => {
		useSchemaDiffStore.getState().setLoading();
		useSchemaDiffStore.getState().setDiff(mockDiff);
		useSchemaDiffStore.getState().setError('Connection refused');
		const state = useSchemaDiffStore.getState();
		expect(state.error).toBe('Connection refused');
		expect(state.loading).toBe(false);
		expect(state.diff).toBeNull();
	});

	it('clear resets all state', () => {
		useSchemaDiffStore.getState().setLoading();
		useSchemaDiffStore.getState().setDiff(mockDiff);
		useSchemaDiffStore.getState().clear();
		const state = useSchemaDiffStore.getState();
		expect(state.diff).toBeNull();
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();
	});

	// ── State transitions ───────────────────────────────────────────

	it('loading → setDiff transition', () => {
		useSchemaDiffStore.getState().setLoading();
		expect(useSchemaDiffStore.getState().loading).toBe(true);

		useSchemaDiffStore.getState().setDiff(mockDiffSafe);
		const state = useSchemaDiffStore.getState();
		expect(state.loading).toBe(false);
		expect(state.diff).toBe(mockDiffSafe);
		expect(state.error).toBeNull();
	});

	it('loading → setError transition', () => {
		useSchemaDiffStore.getState().setLoading();
		expect(useSchemaDiffStore.getState().loading).toBe(true);

		useSchemaDiffStore.getState().setError('Schema file not found');
		const state = useSchemaDiffStore.getState();
		expect(state.loading).toBe(false);
		expect(state.diff).toBeNull();
		expect(state.error).toBe('Schema file not found');
	});
});
