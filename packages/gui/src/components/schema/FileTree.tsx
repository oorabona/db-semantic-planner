import {
	ChevronDown,
	ChevronRight,
	File,
	FileCode,
	Folder,
} from 'lucide-react';
import { useState } from 'react';
import type { ProjectFile } from '@/stores/project-store';

// ── Props ────────────────────────────────────────────────────────

interface FileTreeProps {
	files: readonly ProjectFile[];
	onFileSelect: (filePath: string) => void;
}

interface FileTreeNodeProps {
	file: ProjectFile;
	depth: number;
	onFileSelect: (filePath: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

function getFileIcon(name: string) {
	if (name.endsWith('.assert.dbsp'))
		return <FileCode className="h-4 w-4 text-amber-500" />;
	if (name.endsWith('.dbsp'))
		return <FileCode className="h-4 w-4 text-blue-500" />;
	if (name.endsWith('.sql'))
		return <File className="h-4 w-4 text-emerald-500" />;
	return <File className="h-4 w-4 text-[var(--muted-foreground)]" />;
}

// ── FileTreeNode ─────────────────────────────────────────────────

function FileTreeNode({ file, depth, onFileSelect }: FileTreeNodeProps) {
	const [expanded, setExpanded] = useState(true); // auto-expand

	if (file.isDirectory) {
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
					<span className="truncate">{file.name}</span>
				</button>
				{expanded && file.children && (
					<div>
						{file.children.map((child) => (
							<FileTreeNode
								key={child.path}
								file={child}
								depth={depth + 1}
								onFileSelect={onFileSelect}
							/>
						))}
					</div>
				)}
			</div>
		);
	}

	return (
		<button
			type="button"
			className="flex w-full items-center gap-1 px-1 py-0.5 text-sm hover:bg-[var(--accent)] rounded"
			style={{ paddingLeft: `${depth * 12 + 4}px` }}
			onDoubleClick={() => onFileSelect(file.path)}
		>
			<span className="h-3.5 w-3.5 shrink-0" /> {/* spacer for alignment */}
			{getFileIcon(file.name)}
			<span className="truncate">{file.name}</span>
		</button>
	);
}

// ── FileTree ─────────────────────────────────────────────────────

export function FileTree({ files, onFileSelect }: FileTreeProps) {
	if (files.length === 0) {
		return (
			<div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
				No .dbsp files found
			</div>
		);
	}

	return (
		<div className="flex flex-col overflow-auto py-1">
			{files.map((file) => (
				<FileTreeNode
					key={file.path}
					file={file}
					depth={0}
					onFileSelect={onFileSelect}
				/>
			))}
		</div>
	);
}
