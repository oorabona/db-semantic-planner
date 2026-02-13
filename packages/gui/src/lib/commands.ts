import type { LucideIcon } from 'lucide-react';
import { type MenuId, setMenuItemEnabled } from './menu';

export interface Command {
	/** Unique command identifier, e.g. "file.save", "connection.new" */
	id: string;
	/** Display label in palette and menu */
	label: string;
	/** Keyboard shortcut display string, e.g. "⌘S" */
	shortcut?: string;
	/** Lucide icon for palette display */
	icon?: LucideIcon;
	/** Execute the command */
	handler: () => void;
	/** Return false to disable the command (checked reactively) */
	when?: () => boolean;
	/** Category for palette grouping */
	category: 'file' | 'edit' | 'view' | 'connection' | 'help';
	/** If set, this command corresponds to a native menu item */
	menuId?: MenuId;
}

type CommandListener = (commandId: string) => void;

class CommandRegistryImpl {
	private commands = new Map<string, Command>();
	private listeners: CommandListener[] = [];

	register(command: Command): void {
		this.commands.set(command.id, command);
	}

	registerAll(commands: Command[]): void {
		for (const cmd of commands) {
			this.register(cmd);
		}
	}

	get(id: string): Command | undefined {
		return this.commands.get(id);
	}

	getAll(): Command[] {
		return Array.from(this.commands.values());
	}

	getEnabled(): Command[] {
		return this.getAll().filter((cmd) => !cmd.when || cmd.when());
	}

	getByCategory(category: Command['category']): Command[] {
		return this.getAll().filter((cmd) => cmd.category === category);
	}

	execute(id: string): boolean {
		const cmd = this.commands.get(id);
		if (!cmd) return false;
		if (cmd.when && !cmd.when()) return false;
		cmd.handler();
		for (const listener of this.listeners) {
			listener(id);
		}
		return true;
	}

	isEnabled(id: string): boolean {
		const cmd = this.commands.get(id);
		if (!cmd) return false;
		return !cmd.when || cmd.when();
	}

	onExecute(listener: CommandListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/**
	 * Sync the enabled/disabled state of all menu-backed commands
	 * to the native Tauri menu. Should be called after state changes.
	 */
	async syncMenuState(): Promise<void> {
		const promises: Promise<void>[] = [];
		for (const cmd of this.commands.values()) {
			if (cmd.menuId) {
				const enabled = !cmd.when || cmd.when();
				promises.push(setMenuItemEnabled(cmd.menuId, enabled));
			}
		}
		await Promise.all(promises);
	}

	/** @internal — test-only: clear all registered commands and listeners */
	_reset(): void {
		this.commands.clear();
		this.listeners.length = 0;
	}
}

/** Singleton command registry — source of truth for menu + palette */
export const commandRegistry = new CommandRegistryImpl();
