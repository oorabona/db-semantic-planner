import { Command } from 'cmdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Command as CmdDef, commandRegistry } from '@/lib/commands';
import './command-palette.css';

export interface ProjectFile {
	/** Relative path from project root */
	path: string;
	/** File name for display */
	name: string;
}

interface CommandPaletteProps {
	/** Project files for fuzzy search (empty in standalone mode) */
	files?: ProjectFile[];
	/** Called when a file is selected */
	onFileSelect?: (file: ProjectFile) => void;
}

/**
 * Command Palette — Cmd+K to open.
 * - Default mode: fuzzy file search (project mode) or commands (standalone)
 * - Type ">" prefix to switch to command mode
 */
export function CommandPalette({
	files = [],
	onFileSelect,
}: CommandPaletteProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState('');

	const isCommandMode = search.startsWith('>');
	const commandSearch = isCommandMode ? search.slice(1).trim() : '';

	// Listen for Cmd+K / Ctrl+K
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((prev) => !prev);
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	// Reset search when palette opens
	useEffect(() => {
		if (open) setSearch('');
	}, [open]);

	// Also listen for view.command_palette menu event via registry
	useEffect(() => {
		const cmd = commandRegistry.get('view.command_palette');
		if (!cmd) {
			commandRegistry.register({
				id: 'view.command_palette',
				label: 'Command Palette',
				shortcut: '⌘K',
				category: 'view',
				handler: () => setOpen(true),
			});
		}
	}, []);

	const enabledCommands = useMemo(
		() =>
			commandRegistry
				.getEnabled()
				.filter((c) => c.id !== 'view.command_palette'),
		// Re-compute when search changes (when conditions may depend on state)
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[search, open],
	);

	const handleCommandSelect = useCallback((cmdId: string) => {
		commandRegistry.execute(cmdId);
		setOpen(false);
	}, []);

	const handleFileSelect = useCallback(
		(file: ProjectFile) => {
			onFileSelect?.(file);
			setOpen(false);
		},
		[onFileSelect],
	);

	const hasFiles = files.length > 0;

	return (
		<Command.Dialog
			open={open}
			onOpenChange={setOpen}
			label="Command Palette"
			className="dbsp-command-palette"
			filter={(value, search) => {
				// Strip ">" prefix so command mode search works
				const q = search.startsWith('>') ? search.slice(1).trim() : search;
				if (!q) return 1;
				return value.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
			}}
		>
			<Command.Input
				value={search}
				onValueChange={setSearch}
				placeholder={
					hasFiles
						? 'Search files... (type > for commands)'
						: 'Type a command...'
				}
				autoFocus
			/>
			<Command.List>
				<Command.Empty>No results found.</Command.Empty>

				{/* Command mode (> prefix) or standalone (no files) */}
				{(isCommandMode || !hasFiles) && (
					<CommandItems
						commands={enabledCommands}
						search={commandSearch}
						onSelect={handleCommandSelect}
					/>
				)}

				{/* File mode (no > prefix, has files) */}
				{!isCommandMode && hasFiles && (
					<Command.Group heading="Files">
						{files.map((file) => (
							<Command.Item
								key={file.path}
								value={file.path}
								keywords={[file.name]}
								onSelect={() => handleFileSelect(file)}
							>
								<span className="dbsp-palette-file-name">{file.name}</span>
								<span className="dbsp-palette-file-path">{file.path}</span>
							</Command.Item>
						))}
					</Command.Group>
				)}
			</Command.List>
		</Command.Dialog>
	);
}

function CommandItems({
	commands,
	search: _search,
	onSelect,
}: {
	commands: CmdDef[];
	search: string;
	onSelect: (id: string) => void;
}) {
	const categories = useMemo(() => {
		const groups = new Map<string, CmdDef[]>();
		for (const cmd of commands) {
			const cat = cmd.category;
			const list = groups.get(cat) ?? [];
			list.push(cmd);
			groups.set(cat, list);
		}
		return groups;
	}, [commands]);

	return (
		<>
			{Array.from(categories.entries()).map(([category, cmds]) => (
				<Command.Group
					key={category}
					heading={category.charAt(0).toUpperCase() + category.slice(1)}
				>
					{cmds.map((cmd) => (
						<Command.Item
							key={cmd.id}
							value={cmd.label}
							keywords={[cmd.id]}
							onSelect={() => onSelect(cmd.id)}
						>
							<span className="dbsp-palette-label">{cmd.label}</span>
							{cmd.shortcut && (
								<span className="dbsp-palette-shortcut">{cmd.shortcut}</span>
							)}
						</Command.Item>
					))}
				</Command.Group>
			))}
		</>
	);
}
