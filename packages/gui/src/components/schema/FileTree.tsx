import {
	ChevronDown,
	ChevronRight,
	File,
	FileCode,
	Folder,
	Link2,
} from 'lucide-react';
import {
	type DragEvent,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useRef,
	useState,
} from 'react';
import {
	computeRenamedPath,
	extractFilename,
	validateRename,
} from '@/lib/file-operations';
import type {
	PairedTreeDir,
	PairedTreeFile,
	PairedTreeNode,
	PairedTreePair,
} from '@/lib/paired-tree';
import { FileTreeContextMenu, fileActions } from './FileTreeContextMenu';

// ── Props ────────────────────────────────────────────────────────

interface FileTreeProps {
	readonly files: readonly PairedTreeNode[];
	readonly onFileSelect: (filePath: string) => void;
	readonly onRenameFile?: (oldPath: string, newPath: string) => void;
	readonly onRemoveFile?: (path: string) => void;
	readonly onDeleteFile?: (path: string) => void;
	/** Optional search filter — case-insensitive filename match */
	readonly searchFilter?: string;
}

interface ContextMenuState {
	readonly x: number;
	readonly y: number;
	readonly path: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function getFileIcon(language: PairedTreeFile['language']) {
	switch (language) {
		case 'assert':
			return <FileCode className="h-4 w-4 text-amber-500" />;
		case 'dbsp':
			return <FileCode className="h-4 w-4 text-blue-500" />;
		case 'sql':
			return <File className="h-4 w-4 text-emerald-500" />;
		default:
			return <File className="h-4 w-4 text-[var(--muted-foreground)]" />;
	}
}

function nodeKey(node: PairedTreeNode): string {
	switch (node.type) {
		case 'file':
			return node.path;
		case 'pair':
			return `pair:${node.baseName}`;
		case 'dir':
			return node.path;
	}
}

/** Recursively filter tree nodes by case-insensitive name match */
function filterNodes(
	nodes: readonly PairedTreeNode[],
	filter: string,
): PairedTreeNode[] {
	const lc = filter.toLowerCase();
	const result: PairedTreeNode[] = [];
	for (const node of nodes) {
		switch (node.type) {
			case 'file':
				if (node.name.toLowerCase().includes(lc)) {
					result.push(node);
				}
				break;
			case 'pair':
				if (node.baseName.toLowerCase().includes(lc)) {
					result.push(node);
				}
				break;
			case 'dir': {
				const filtered = filterNodes(node.children, filter);
				if (filtered.length > 0) {
					result.push({ ...node, children: filtered });
				}
				break;
			}
		}
	}
	return result;
}

// ── Node Components ──────────────────────────────────────────────

function FileNode({
	file,
	depth,
	isRenaming,
	onFileSelect,
	onContextMenu,
	onStartRename,
	onCommitRename,
	onCancelRename,
}: {
	readonly file: PairedTreeFile;
	readonly depth: number;
	readonly isRenaming: boolean;
	readonly onFileSelect: (p: string) => void;
	readonly onContextMenu?: (path: string, e: MouseEvent) => void;
	readonly onStartRename?: () => void;
	readonly onCommitRename?: (newName: string) => void;
	readonly onCancelRename?: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);

	if (isRenaming) {
		return (
			<div
				className="flex items-center gap-1 px-1 py-0.5"
				style={{ paddingLeft: `${depth * 12 + 4}px` }}
			>
				<span className="h-3.5 w-3.5 shrink-0" />
				{getFileIcon(file.language)}
				<input
					ref={inputRef}
					type="text"
					className="flex-1 rounded border border-[var(--ring)] bg-[var(--input)] px-1 text-sm outline-none"
					defaultValue={file.name}
					data-testid="rename-input"
					aria-label="Rename file"
					// biome-ignore lint/a11y/noAutofocus: rename input intentionally focused for immediate editing
					autoFocus
					onBlur={(e) => {
						const val = e.currentTarget.value.trim();
						if (val && val !== file.name) {
							onCommitRename?.(val);
						} else {
							onCancelRename?.();
						}
					}}
					onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							const val = e.currentTarget.value.trim();
							if (val && val !== file.name) {
								onCommitRename?.(val);
							} else {
								onCancelRename?.();
							}
						} else if (e.key === 'Escape') {
							onCancelRename?.();
						}
					}}
				/>
			</div>
		);
	}

	return (
		<button
			type="button"
			className="flex w-full items-center gap-1 px-1 py-0.5 text-sm hover:bg-[var(--accent)] rounded"
			style={{ paddingLeft: `${depth * 12 + 4}px` }}
			onDoubleClick={() => onFileSelect(file.path)}
			onContextMenu={(e) => {
				if (onContextMenu) {
					e.preventDefault();
					onContextMenu(file.path, e);
				}
			}}
			onKeyDown={(e) => {
				if (e.key === 'F2' && onStartRename) {
					e.preventDefault();
					onStartRename();
				}
			}}
		>
			<span className="h-3.5 w-3.5 shrink-0" />
			{getFileIcon(file.language)}
			<span className="truncate">{file.name}</span>
		</button>
	);
}

function PairNode({
	pair,
	depth,
	renamingPath,
	onFileSelect,
	onContextMenu,
	onStartRename,
	onCommitRename,
	onCancelRename,
}: {
	readonly pair: PairedTreePair;
	readonly depth: number;
	readonly renamingPath: string | null;
	readonly onFileSelect: (p: string) => void;
	readonly onContextMenu?: (path: string, e: MouseEvent) => void;
	readonly onStartRename?: (path: string) => void;
	readonly onCommitRename?: (path: string, newName: string) => void;
	readonly onCancelRename?: () => void;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div>
			<button
				type="button"
				className="flex w-full items-center gap-1 px-1 py-0.5 text-sm hover:bg-[var(--accent)] rounded"
				style={{ paddingLeft: `${depth * 12 + 4}px` }}
				onClick={() => setExpanded(!expanded)}
				onDoubleClick={() => onFileSelect(pair.dbsp.path)}
				onContextMenu={(e) => {
					if (onContextMenu) {
						e.preventDefault();
						onContextMenu(pair.dbsp.path, e);
					}
				}}
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0" />
				)}
				<Link2 className="h-4 w-4 shrink-0 text-violet-500" />
				<span className="truncate">{pair.baseName}</span>
			</button>
			{expanded && (
				<div>
					<FileNode
						file={pair.dbsp}
						depth={depth + 1}
						isRenaming={renamingPath === pair.dbsp.path}
						onFileSelect={onFileSelect}
						onContextMenu={onContextMenu}
						onStartRename={
							onStartRename ? () => onStartRename(pair.dbsp.path) : undefined
						}
						onCommitRename={
							onCommitRename
								? (name) => onCommitRename(pair.dbsp.path, name)
								: undefined
						}
						onCancelRename={onCancelRename}
					/>
					<FileNode
						file={pair.assert}
						depth={depth + 1}
						isRenaming={renamingPath === pair.assert.path}
						onFileSelect={onFileSelect}
						onContextMenu={onContextMenu}
						onStartRename={
							onStartRename ? () => onStartRename(pair.assert.path) : undefined
						}
						onCommitRename={
							onCommitRename
								? (name) => onCommitRename(pair.assert.path, name)
								: undefined
						}
						onCancelRename={onCancelRename}
					/>
				</div>
			)}
		</div>
	);
}

function DirNode({
	dir,
	depth,
	renamingPath,
	onFileSelect,
	onContextMenu,
	onStartRename,
	onCommitRename,
	onCancelRename,
}: {
	readonly dir: PairedTreeDir;
	readonly depth: number;
	readonly renamingPath: string | null;
	readonly onFileSelect: (p: string) => void;
	readonly onContextMenu?: (path: string, e: MouseEvent) => void;
	readonly onStartRename?: (path: string) => void;
	readonly onCommitRename?: (path: string, newName: string) => void;
	readonly onCancelRename?: () => void;
}) {
	const [expanded, setExpanded] = useState(true);

	return (
		<div>
			<button
				type="button"
				className="flex w-full items-center gap-1 px-1 py-0.5 text-sm hover:bg-[var(--accent)] rounded"
				style={{ paddingLeft: `${depth * 12 + 4}px` }}
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0" />
				)}
				<Folder className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
				<span className="truncate">{dir.name}</span>
			</button>
			{expanded && (
				<div>
					{dir.children.map((child) => (
						<TreeNode
							key={nodeKey(child)}
							node={child}
							depth={depth + 1}
							renamingPath={renamingPath}
							onFileSelect={onFileSelect}
							onContextMenu={onContextMenu}
							onStartRename={onStartRename}
							onCommitRename={onCommitRename}
							onCancelRename={onCancelRename}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ── Dispatcher ───────────────────────────────────────────────────

function TreeNode({
	node,
	depth,
	renamingPath,
	onFileSelect,
	onContextMenu,
	onStartRename,
	onCommitRename,
	onCancelRename,
}: {
	readonly node: PairedTreeNode;
	readonly depth: number;
	readonly renamingPath: string | null;
	readonly onFileSelect: (p: string) => void;
	readonly onContextMenu?: (path: string, e: MouseEvent) => void;
	readonly onStartRename?: (path: string) => void;
	readonly onCommitRename?: (path: string, newName: string) => void;
	readonly onCancelRename?: () => void;
}) {
	switch (node.type) {
		case 'file':
			return (
				<FileNode
					file={node}
					depth={depth}
					isRenaming={renamingPath === node.path}
					onFileSelect={onFileSelect}
					onContextMenu={onContextMenu}
					onStartRename={
						onStartRename ? () => onStartRename(node.path) : undefined
					}
					onCommitRename={
						onCommitRename
							? (name) => onCommitRename(node.path, name)
							: undefined
					}
					onCancelRename={onCancelRename}
				/>
			);
		case 'pair':
			return (
				<PairNode
					pair={node}
					depth={depth}
					renamingPath={renamingPath}
					onFileSelect={onFileSelect}
					onContextMenu={onContextMenu}
					onStartRename={onStartRename}
					onCommitRename={onCommitRename}
					onCancelRename={onCancelRename}
				/>
			);
		case 'dir':
			return (
				<DirNode
					dir={node}
					depth={depth}
					renamingPath={renamingPath}
					onFileSelect={onFileSelect}
					onContextMenu={onContextMenu}
					onStartRename={onStartRename}
					onCommitRename={onCommitRename}
					onCancelRename={onCancelRename}
				/>
			);
	}
}

// ── FileTree ─────────────────────────────────────────────────────

export function FileTree({
	files,
	onFileSelect,
	onRenameFile,
	onRemoveFile,
	onDeleteFile,
	searchFilter,
}: FileTreeProps) {
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [renamingPath, setRenamingPath] = useState<string | null>(null);

	const handleContextMenu = useCallback((path: string, e: MouseEvent) => {
		setMenu({ x: e.clientX, y: e.clientY, path });
	}, []);

	const handleDragOver = useCallback((e: DragEvent) => {
		e.preventDefault();
		setIsDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: DragEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setIsDragOver(false);
		}
	}, []);

	const handleDrop = useCallback(() => {
		setIsDragOver(false);
	}, []);

	const handleStartRename = useCallback((path: string) => {
		setRenamingPath(path);
	}, []);

	const handleCommitRename = useCallback(
		(path: string, newName: string) => {
			const currentName = extractFilename(path);
			const result = validateRename(currentName, newName);
			if (!result.valid) {
				setRenamingPath(null);
				return;
			}
			const newPath = computeRenamedPath(path, newName);
			setRenamingPath(null);
			onRenameFile?.(path, newPath);
		},
		[onRenameFile],
	);

	const handleCancelRename = useCallback(() => {
		setRenamingPath(null);
	}, []);

	const displayNodes = searchFilter?.trim()
		? filterNodes(files, searchFilter.trim())
		: files;

	if (files.length === 0) {
		return (
			<div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
				No files in project
			</div>
		);
	}

	if (displayNodes.length === 0) {
		return (
			<div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
				No matching files
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop zone — drag events only, no keyboard interaction needed
		<div
			className={`flex flex-col overflow-auto py-1 ${isDragOver ? 'ring-2 ring-inset ring-[var(--ring)] bg-[var(--accent)]/30' : ''}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{displayNodes.map((node) => (
				<TreeNode
					key={nodeKey(node)}
					node={node}
					depth={0}
					renamingPath={renamingPath}
					onFileSelect={onFileSelect}
					onContextMenu={handleContextMenu}
					onStartRename={onRenameFile ? handleStartRename : undefined}
					onCommitRename={onRenameFile ? handleCommitRename : undefined}
					onCancelRename={handleCancelRename}
				/>
			))}
			{menu && (
				<FileTreeContextMenu
					position={{ x: menu.x, y: menu.y }}
					actions={fileActions(menu.path, {
						onRenameFile: onRenameFile
							? () => handleStartRename(menu.path)
							: undefined,
						onRemoveFile,
						onDeleteFile,
					})}
					onClose={() => setMenu(null)}
				/>
			)}
		</div>
	);
}
