import { describe, expect, it } from 'vitest';
import type { EngineEvent } from './engine-types.js';
import { isInsideStringLiteral, ReplEngine } from './repl-engine.js';

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
		expect(state.outputLayout).toBe('full');
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

	it('ignores comment-only lines', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('# This is a comment');
		await engine.submit('  # Indented comment');

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

	it('subscribes and unsubscribes listeners', async () => {
		const engine = createEngine();
		const events: EngineEvent[] = [];

		const unsub = engine.on((e) => events.push(e));
		await engine.submit('.clear');
		expect(events.some((e) => e.type === 'clear')).toBe(true);
		const countAfterFirst = events.length;

		unsub();
		await engine.submit('.clear');
		expect(events).toHaveLength(countAfterFirst); // No new events after unsub
	});

	it('cleans up on destroy', async () => {
		const engine = createEngine();
		await engine.destroy();

		expect(engine.getState().connected).toBe(false);
	});

	// --- Panel commands (.show <view>) ---

	it('emits show-panel for .show sql', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show sql');
		expect(events).toContainEqual({ type: 'show-panel', view: 'sql' });
	});

	it('emits show-panel for .show plan', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show plan');
		expect(events).toContainEqual({ type: 'show-panel', view: 'plan' });
	});

	it('emits show-panel for .show results', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show results');
		expect(events).toContainEqual({ type: 'show-panel', view: 'results' });
	});

	it('emits show-panel for .show params', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show params');
		expect(events).toContainEqual({ type: 'show-panel', view: 'params' });
	});

	it('emits show-panel for .show dump', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show dump');
		expect(events).toContainEqual({ type: 'show-panel', view: 'dump' });
	});

	it('shows available views for .show without argument', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show');
		const info = events.find(
			(e) =>
				e.type === 'info' &&
				'message' in e &&
				e.message.includes('Inspection panel'),
		);
		expect(info).toBeDefined();
	});

	it('rejects invalid .show view', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.show invalid');
		const error = events.find(
			(e) =>
				e.type === 'error' &&
				'message' in e &&
				e.message.includes('Unknown panel view'),
		);
		expect(error).toBeDefined();
	});

	it('emits close-panel for .close command', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.close');
		expect(events).toContainEqual({ type: 'close-panel' });
	});

	// --- Layout commands ---

	it('changes layout with .layout compact', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.layout compact');

		expect(engine.getState().outputLayout).toBe('compact');
		expect(events).toContainEqual({
			type: 'layout-change',
			layout: 'compact',
		});
	});

	it('shows current layout without argument', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.layout');
		const info = events.find(
			(e) =>
				e.type === 'info' &&
				'message' in e &&
				e.message.includes('Output layout'),
		);
		expect(info).toBeDefined();
	});

	it('rejects invalid layout', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.layout invalid');
		const error = events.find(
			(e) =>
				e.type === 'error' &&
				'message' in e &&
				e.message.includes('Unknown layout'),
		);
		expect(error).toBeDefined();
	});

	// --- Plan verbosity commands ---

	it('defaults planVerbosity to normal', () => {
		const engine = createEngine();
		expect(engine.getState().planVerbosity).toBe('normal');
	});

	it('changes plan verbosity with .plan verbose', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.plan verbose');

		expect(engine.getState().planVerbosity).toBe('verbose');
		expect(events.some((e) => e.type === 'state-change')).toBe(true);
		expect(
			events.some(
				(e) =>
					e.type === 'info' && 'message' in e && e.message.includes('verbose'),
			),
		).toBe(true);
	});

	it('changes plan verbosity with .plan compact', async () => {
		const engine = createEngine();

		await engine.submit('.plan compact');

		expect(engine.getState().planVerbosity).toBe('compact');
	});

	it('shows current plan verbosity without argument', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.plan');

		const info = events.find(
			(e) =>
				e.type === 'info' &&
				'message' in e &&
				e.message.includes('Plan verbosity'),
		);
		expect(info).toBeDefined();
	});

	it('rejects invalid plan verbosity', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.plan invalid');

		const error = events.find(
			(e) =>
				e.type === 'error' &&
				'message' in e &&
				e.message.includes('Invalid plan verbosity'),
		);
		expect(error).toBeDefined();
		expect(engine.getState().planVerbosity).toBe('normal');
	});

	it('persists plan verbosity across queries', async () => {
		const engine = createEngine();

		await engine.submit('.plan verbose');
		expect(engine.getState().planVerbosity).toBe('verbose');

		// Submit NQL query — verbosity should remain
		const events = collectEvents(engine);
		await engine.submit('users');

		expect(engine.getState().planVerbosity).toBe('verbose');
		// Should still produce a query-result
		expect(events.some((e) => e.type === 'query-result')).toBe(true);
	});

	// --- Plan field pass-through ---

	it('.plan is independent of .layout', async () => {
		const engine = createEngine();

		// Arrange: set layout to compact and plan to verbose
		await engine.submit('.layout compact');
		await engine.submit('.plan verbose');

		// Assert: both coexist independently
		expect(engine.getState().outputLayout).toBe('compact');
		expect(engine.getState().planVerbosity).toBe('verbose');

		// Change layout back — plan verbosity unaffected
		await engine.submit('.layout full');
		expect(engine.getState().planVerbosity).toBe('verbose');
	});

	it('handleNql produces plan with strategy and structure', async () => {
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('users');

		const queryEvent = events.find((e) => e.type === 'query-result');
		expect(queryEvent).toBeDefined();
		if (queryEvent?.type === 'query-result') {
			const plan = queryEvent.result.plan;
			// Plan may or may not be populated depending on schema complexity
			if (plan) {
				expect(plan.strategy).toBe('NQL v2');
				expect(typeof plan.rootTable).toBe('string');
				expect(Array.isArray(plan.decisions)).toBe(true);
				expect(Array.isArray(plan.warnings)).toBe(true);
				expect(typeof plan.cteCount).toBe('number');
				expect(typeof plan.planningTimeMs).toBe('number');
				// Metadata pass-through (new fields)
				if (plan.metadata) {
					expect(typeof plan.metadata.relationsAnalyzed).toBe('number');
					expect(typeof plan.metadata.isAmbiguous).toBe('boolean');
				}
				// CTE details (new fields)
				if (plan.ctes) {
					for (const c of plan.ctes) {
						expect(typeof c.name).toBe('string');
						expect(typeof c.purpose).toBe('string');
					}
				}
				// Decision extended fields (new fields)
				for (const d of plan.decisions) {
					expect(typeof d.type).toBe('string');
					expect(typeof d.context).toBe('string');
					expect(typeof d.choice).toBe('string');
					expect(typeof d.reasoning).toBe('string');
					if (d.alternatives !== undefined) {
						expect(Array.isArray(d.alternatives)).toBe(true);
					}
					if (d.decisionId !== undefined) {
						expect(typeof d.decisionId).toBe('string');
					}
					if (d.foreignKey !== undefined) {
						expect(
							typeof d.foreignKey === 'string' || Array.isArray(d.foreignKey),
						).toBe(true);
					}
				}
				// Warning extended fields (new fields)
				for (const w of plan.warnings) {
					expect(typeof w.message).toBe('string');
					if (w.code !== undefined) {
						expect(typeof w.code).toBe('string');
					}
					if (w.relatedDecision !== undefined) {
						expect(typeof w.relatedDecision).toBe('string');
					}
				}
			}
		}
	});
});

describe('isInsideStringLiteral', () => {
	it('should return false for bang outside string', () => {
		expect(isInsideStringLiteral("insert into users set name = 'John'!")).toBe(
			false,
		);
	});

	it('should return true for bang inside string literal', () => {
		expect(isInsideStringLiteral("insert into users set name = 'John!'")).toBe(
			true,
		);
	});

	it('should return false for bang after closed string with bang inside', () => {
		expect(isInsideStringLiteral("insert into users set name = 'John!'!")).toBe(
			false,
		);
	});

	it('should return false for no string literals', () => {
		expect(isInsideStringLiteral('update users set active = true!')).toBe(
			false,
		);
	});

	it('should handle escaped quotes (doubled single quotes)', () => {
		expect(
			isInsideStringLiteral("insert into users set name = 'O''Brien'!"),
		).toBe(false);
	});

	it('should return true when bang is inside string with escaped quotes', () => {
		expect(
			isInsideStringLiteral("insert into users set name = 'O''Brien!'"),
		).toBe(true);
	});

	it('should handle multiple string literals', () => {
		expect(
			isInsideStringLiteral(
				"insert into users set name = 'Alice', email = 'alice@test.com'!",
			),
		).toBe(false);
	});
});

// ============================================================================
// Item 3 regression: failing dot-commands must emit 'error' event, not 'info'
// ============================================================================
//
// Handlers that return { output: '❌ ...' } without setting success/error used
// to cause the engine to emit 'info' → batch mapEventsToBatchResult → success:true
// → process.exit(0) even though the command failed.
//
// The fix in processDotCommand (repl-engine.ts) detects '❌'-prefixed output and
// emits 'error' so mapEventsToBatchResult sets success:false → process.exit(1).

describe('ReplEngine dot-command error propagation — batch exit-code regression (item 3)', () => {
	function createEngine(overrides = {}) {
		const model = {
			tables: new Map([
				[
					'users',
					{
						name: 'users',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
						primaryKey: ['id'],
					},
				],
			]),
			relations: new Map(),
		};
		const schema = {
			model: model as any,
			tableNames: ['users'],
			schemaPath: 'test.schema.ts',
		};
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

	it('emits error event for a failing .import (no argument) so batch mode exits non-zero', async () => {
		// .import without an argument returns { output: '❌ Usage: .import <file.sql>' }
		// — no `error` or `success` field set. Before the fix the engine emitted 'info'
		// (success:true); after the fix it emits 'error' (success:false).
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.import');

		const errorEvent = events.find((e) => e.type === 'error');
		const infoEvent = events.find(
			(e) => e.type === 'info' && 'message' in e && e.message.startsWith('❌'),
		);

		expect(errorEvent).toBeDefined();
		expect(infoEvent).toBeUndefined();
	});

	it('illustration (not a regression lock): old predicate would emit info for ❌ output', () => {
		// This test is DOCUMENTATION only — it reimplements both predicates inline
		// and stays GREEN on revert. The actual regression locks are the async
		// .import→error test above and the two flipped assertions in
		// repl-engine.coverage.test.ts (lines ~762 and ~900).
		const result = { output: '❌ Usage: .import <file.sql>' };

		// Old condition: only checks result.error — would be false → 'info' (the bug)
		const oldEmitsError = !!result.error;
		expect(oldEmitsError).toBe(false);

		// New condition: also checks output prefix — is true → 'error' (the fix)
		const newEmitsError = !!result.error || result.output.startsWith('❌');
		expect(newEmitsError).toBe(true);
	});

	it('does not emit error for a successful dot-command', async () => {
		// .tables succeeds — must still emit 'info', not 'error'
		const engine = createEngine();
		const events = collectEvents(engine);

		await engine.submit('.tables');

		const errorEvent = events.find((e) => e.type === 'error');
		expect(errorEvent).toBeUndefined();
		const infoEvent = events.find((e) => e.type === 'info');
		expect(infoEvent).toBeDefined();
	});
});
