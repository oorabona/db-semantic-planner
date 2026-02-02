import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from './engine-types.js';
import { ReplEngine } from './repl-engine.js';

/**
 * Minimal schema for testing (no DB needed).
 * Uses a compile-only path — tests only engine state/events, not SQL output.
 */
function createTestSchema() {
	const model = {
		tables: new Map([
			[
				'users',
				{
					name: 'users',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'name', type: 'text', nullable: false },
					],
					primaryKey: ['id'],
				},
			],
		]),
		relations: new Map(),
	};

	return {
		model: model as any,
		tableNames: ['users'],
		schemaPath: 'test.schema.ts',
	};
}

describe('ReplEngine', () => {
	function createEngine(overrides = {}) {
		const schema = createTestSchema();
		return new ReplEngine({
			schema: schema as any,
			schemaPath: 'test.schema.ts',
			...overrides,
		});
	}

	function collectEvents(engine: ReplEngine): EngineEvent[] {
		const events: EngineEvent[] = [];
		engine.on((e) => events.push(e));
		return events;
	}

	it('starts with default state', () => {
		const engine = createEngine();
		const state = engine.getState();

		expect(state.mode).toBe('natural');
		expect(state.execMode).toBe(false);
		expect(state.connected).toBe(false);
		expect(state.explainMode).toBe(false);
		expect(state.parseMode).toBe(false);
		expect(state.aliasingMode).toBe('always');
		expect(state.includeStrategy).toBe('auto');
		expect(state.dialect).toBe('postgresql');
		expect(state.outputMode).toBe('json');
	});

	it('respects initial config', () => {
		const engine = createEngine({
			initialParseMode: true,
			initialExecMode: true,
			initialSchemaName: 'tenant_1',
			dbCasing: 'snake_case' as const,
		});
		const state = engine.getState();

		expect(state.parseMode).toBe(true);
		expect(state.execMode).toBe(true);
		expect(state.schemaName).toBe('tenant_1');
		expect(state.dbCasing).toBe('snake_case');
	});

	it('ignores empty input', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('');
		await engine.submit('   ');

		expect(events).toHaveLength(0);
	});

	it('emits exit on .exit command', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.exit');

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe('exit');
	});

	it('emits exit on .quit command', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.quit');

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe('exit');
	});

	it('emits clear on .clear command', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.clear');

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe('clear');
	});

	it('emits SHOW_HELP on .help command', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.help');

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ type: 'info', message: 'SHOW_HELP' });
	});

	it('emits show-history on .history command', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.history');

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe('show-history');
	});

	it('toggles aliasing mode with .aliasing', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		expect(engine.getState().aliasingMode).toBe('always');

		await engine.submit('.aliasing');

		expect(engine.getState().aliasingMode).toBe('onCollision');
		expect(events.some((e) => e.type === 'state-change')).toBe(true);
		expect(events.some((e) => e.type === 'info')).toBe(true);
	});

	it('changes strategy with .strategy', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.strategy cte');

		expect(engine.getState().includeStrategy).toBe('cte');
		expect(events.some((e) => e.type === 'state-change')).toBe(true);
	});

	it('rejects unavailable strategy for dialect', async () => {
		const engine = createEngine();

		// Set dialect to sqlite first (no lateral support)
		await engine.submit('.dialect sqlite');

		const events = collectEvents(engine);
		await engine.submit('.strategy lateral');

		expect(engine.getState().includeStrategy).not.toBe('lateral');
		expect(events.some((e) => e.type === 'error')).toBe(true);
	});

	it('changes dialect with .dialect', async () => {
		const engine = createEngine();

		await engine.submit('.dialect mysql');

		expect(engine.getState().dialect).toBe('mysql');
	});

	it('rejects unknown dialect', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.dialect oracle');

		expect(events.some((e) => e.type === 'error')).toBe(true);
		expect(engine.getState().dialect).toBe('postgresql');
	});

	it('shows strategy info without argument', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.strategy');

		expect(events.some((e) => e.type === 'info')).toBe(true);
	});

	it('handles dot commands via dot-commands.ts', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.tables');

		expect(events.some((e) => e.type === 'info')).toBe(true);
	});

	it('emits error for empty query content', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('!'); // Mode escape with empty content

		expect(events.some((e) => e.type === 'error')).toBe(true);
	});

	it('handles raw SQL in sql mode', async () => {
		const engine = createEngine();

		// Switch to SQL mode
		await engine.submit('.sql');
		const events = collectEvents(engine);

		await engine.submit('SELECT 1');

		expect(events.some((e) => e.type === 'query-result')).toBe(true);
		const queryEvent = events.find((e) => e.type === 'query-result');
		if (queryEvent?.type === 'query-result') {
			expect(queryEvent.result.sql).toBe('SELECT 1');
			expect(queryEvent.result.plan?.strategy).toBe('RAW_SQL');
		}
	});

	it('subscribes and unsubscribes listeners', () => {
		const engine = createEngine();
		const events: EngineEvent[] = [];

		const unsub = engine.on((e) => events.push(e));
		engine['emit']({ type: 'clear' });
		expect(events).toHaveLength(1);

		unsub();
		engine['emit']({ type: 'clear' });
		expect(events).toHaveLength(1); // No new event after unsub
	});

	it('cleans up on destroy', async () => {
		const engine = createEngine();
		await engine.destroy();

		expect(engine.getState().connected).toBe(false);
	});
});
