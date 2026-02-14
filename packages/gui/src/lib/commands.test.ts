import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Command, commandRegistry } from './commands';
import { MENU_IDS } from './menu';

// Mock Tauri APIs (needed by menu.ts -> setMenuItemEnabled)
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(),
}));

function makeCommand(overrides: Partial<Command> = {}): Command {
	return {
		id: 'test.cmd',
		label: 'Test Command',
		category: 'file',
		handler: vi.fn(),
		...overrides,
	};
}

describe('CommandRegistry', () => {
	beforeEach(() => {
		// Clear registry between tests by re-registering nothing
		// (Registry is singleton, so we access internal state indirectly)
		// Register fresh commands per test
	});

	describe('register / get', () => {
		it('should register and retrieve a command by id', () => {
			// Arrange
			const cmd = makeCommand({ id: 'test.register' });

			// Act
			commandRegistry.register(cmd);

			// Assert
			expect(commandRegistry.get('test.register')).toBe(cmd);
		});

		it('should return undefined for unknown id', () => {
			expect(commandRegistry.get('nonexistent.id')).toBeUndefined();
		});

		it('should registerAll from an array', () => {
			const cmds = [
				makeCommand({ id: 'batch.a' }),
				makeCommand({ id: 'batch.b' }),
				makeCommand({ id: 'batch.c' }),
			];

			commandRegistry.registerAll(cmds);

			expect(commandRegistry.get('batch.a')).toBe(cmds[0]);
			expect(commandRegistry.get('batch.b')).toBe(cmds[1]);
			expect(commandRegistry.get('batch.c')).toBe(cmds[2]);
		});
	});

	describe('getAll / getByCategory', () => {
		it('should return all registered commands', () => {
			commandRegistry.register(makeCommand({ id: 'all.x', category: 'edit' }));
			const all = commandRegistry.getAll();
			expect(all.some((c) => c.id === 'all.x')).toBe(true);
		});

		it('should filter by category', () => {
			commandRegistry.register(
				makeCommand({ id: 'cat.help1', category: 'help' }),
			);
			commandRegistry.register(
				makeCommand({ id: 'cat.file1', category: 'file' }),
			);

			const helpCmds = commandRegistry.getByCategory('help');
			expect(helpCmds.some((c) => c.id === 'cat.help1')).toBe(true);
			expect(helpCmds.some((c) => c.id === 'cat.file1')).toBe(false);
		});
	});

	describe('execute', () => {
		it('should call handler when command exists and is enabled', () => {
			// Arrange
			const handler = vi.fn();
			commandRegistry.register(makeCommand({ id: 'exec.ok', handler }));

			// Act
			const result = commandRegistry.execute('exec.ok');

			// Assert
			expect(result).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it('should return false for unknown command', () => {
			expect(commandRegistry.execute('unknown.cmd')).toBe(false);
		});

		it('should not execute when when() returns false', () => {
			const handler = vi.fn();
			commandRegistry.register(
				makeCommand({
					id: 'exec.disabled',
					handler,
					when: () => false,
				}),
			);

			const result = commandRegistry.execute('exec.disabled');

			expect(result).toBe(false);
			expect(handler).not.toHaveBeenCalled();
		});

		it('should execute when when() returns true', () => {
			const handler = vi.fn();
			commandRegistry.register(
				makeCommand({
					id: 'exec.enabled',
					handler,
					when: () => true,
				}),
			);

			const result = commandRegistry.execute('exec.enabled');

			expect(result).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});
	});

	describe('when conditions', () => {
		it('should reflect dynamic when state in isEnabled', () => {
			let enabled = false;
			commandRegistry.register(
				makeCommand({
					id: 'when.dynamic',
					when: () => enabled,
				}),
			);

			// Initially disabled
			expect(commandRegistry.isEnabled('when.dynamic')).toBe(false);

			// State changes
			enabled = true;
			expect(commandRegistry.isEnabled('when.dynamic')).toBe(true);
		});

		it('should filter disabled commands from getEnabled', () => {
			commandRegistry.register(
				makeCommand({
					id: 'filter.disabled',
					when: () => false,
				}),
			);
			commandRegistry.register(
				makeCommand({
					id: 'filter.enabled',
					when: () => true,
				}),
			);

			const enabled = commandRegistry.getEnabled();
			expect(enabled.some((c) => c.id === 'filter.enabled')).toBe(true);
			expect(enabled.some((c) => c.id === 'filter.disabled')).toBe(false);
		});

		it('should treat commands without when as always enabled', () => {
			commandRegistry.register(makeCommand({ id: 'no.when' }));

			expect(commandRegistry.isEnabled('no.when')).toBe(true);
		});
	});

	describe('onExecute listener', () => {
		it('should notify listeners on execute', () => {
			// Arrange
			const listener = vi.fn();
			commandRegistry.register(makeCommand({ id: 'listen.test' }));
			commandRegistry.onExecute(listener);

			// Act
			commandRegistry.execute('listen.test');

			// Assert
			expect(listener).toHaveBeenCalledWith('listen.test');
		});

		it('should return an unlisten function', () => {
			const listener = vi.fn();
			commandRegistry.register(makeCommand({ id: 'listen.unsub' }));
			const unlisten = commandRegistry.onExecute(listener);

			unlisten();
			commandRegistry.execute('listen.unsub');

			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('syncMenuState', () => {
		it('should call setMenuItemEnabled for menu-backed commands', async () => {
			// Arrange
			const { invoke } = await import('@tauri-apps/api/core');
			vi.mocked(invoke).mockResolvedValue(undefined);

			commandRegistry.register(
				makeCommand({
					id: 'sync.save',
					menuId: MENU_IDS.FILE_SAVE,
					when: () => true,
				}),
			);

			// Act
			await commandRegistry.syncMenuState();

			// Assert
			expect(invoke).toHaveBeenCalledWith('update_menu_item', {
				id: 'file.save',
				enabled: true,
			});
		});

		it('should disable menu items when when() returns false', async () => {
			const { invoke } = await import('@tauri-apps/api/core');
			vi.mocked(invoke).mockResolvedValue(undefined);

			commandRegistry.register(
				makeCommand({
					id: 'sync.export',
					menuId: MENU_IDS.FILE_EXPORT_CSV,
					when: () => false,
				}),
			);

			await commandRegistry.syncMenuState();

			expect(invoke).toHaveBeenCalledWith('update_menu_item', {
				id: 'file.export_csv',
				enabled: false,
			});
		});
	});
});
