import { join } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { FileCode, Loader2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isSupportedFile } from '@/lib/drag-drop';
import type { SchemaSelection } from './wizard-types';

// ── Props ────────────────────────────────────────────────────────

interface WizardFilesStepProps {
	readonly folderPath: string;
	readonly files: readonly string[];
	readonly schemaSelection: SchemaSelection;
	readonly onToggleFile: (path: string) => void;
	readonly onSetFiles: (paths: string[]) => void;
	readonly onSchemaSelectionChange: (selection: SchemaSelection) => void;
}

// ── Folder scanner ───────────────────────────────────────────────

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.next',
	'.turbo',
	'target',
]);

async function scanFolder(folderPath: string): Promise<string[]> {
	const results: string[] = [];

	async function walk(dir: string, prefix: string) {
		try {
			const entries = await readDir(dir);
			for (const entry of entries) {
				if (!entry.name) continue;
				const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
				const fullPath = await join(dir, entry.name);

				if (entry.isDirectory) {
					if (!SKIP_DIRS.has(entry.name)) {
						await walk(fullPath, relPath);
					}
				} else if (isSupportedFile(entry.name)) {
					results.push(relPath);
				}
			}
		} catch {
			// SC-15: skip unreadable directories (permission errors)
		}
	}

	await walk(folderPath, '');
	return results.sort();
}

// ── Component ────────────────────────────────────────────────────

export function WizardFilesStep({
	folderPath,
	files,
	schemaSelection,
	onToggleFile,
	onSetFiles,
	onSchemaSelectionChange,
}: WizardFilesStepProps) {
	const [scanning, setScanning] = useState(false);
	const [discovered, setDiscovered] = useState<string[]>([]);
	const [hasScanned, setHasScanned] = useState(false);

	useEffect(() => {
		if (!folderPath || hasScanned) return;

		let cancelled = false;

		setScanning(true);
		scanFolder(folderPath).then((found) => {
			if (cancelled) return;
			setDiscovered(found);
			onSetFiles(found); // all checked by default
			setScanning(false);
			setHasScanned(true);
		});

		return () => {
			cancelled = true;
		};
	}, [folderPath, hasScanned, onSetFiles]);

	return (
		<div className="space-y-6">
			<div>
				<h3 className="text-base font-medium">Files & Schema</h3>
				<p className="mt-1 text-sm text-muted-foreground">
					Select which files to include in the project.
				</p>
			</div>

			{/* File list */}
			<div>
				<div className="mb-2 flex items-center gap-2 text-sm font-medium">
					<Search className="h-4 w-4" />
					<span>Discovered files</span>
					{scanning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
				</div>

				{scanning ? (
					<p className="text-sm text-muted-foreground">Scanning folder...</p>
				) : discovered.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No .dbsp or .sql files found in this folder.
					</p>
				) : (
					<div
						className="max-h-[160px] space-y-1 overflow-y-auto rounded-md border p-2"
						data-testid="file-list"
					>
						{discovered.map((path) => (
							<label
								key={path}
								className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent"
							>
								<input
									type="checkbox"
									checked={files.includes(path)}
									onChange={() => onToggleFile(path)}
									className="rounded border-muted-foreground"
								/>
								<FileCode className="h-3.5 w-3.5 shrink-0 text-blue-500" />
								<span className="truncate">{path}</span>
							</label>
						))}
					</div>
				)}
			</div>

			{/* Schema selection */}
			<div>
				<h4 className="mb-2 text-sm font-medium">Schema configuration</h4>
				<div className="space-y-2" data-testid="schema-selection">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="radio"
							name="schema"
							checked={schemaSelection === 'generate'}
							onChange={() => onSchemaSelectionChange('generate')}
						/>
						<span>Generate from database introspection</span>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="radio"
							name="schema"
							checked={
								schemaSelection !== 'generate' && schemaSelection !== 'skip'
							}
							onChange={() => onSchemaSelectionChange('auto')}
						/>
						<span>Select existing file (auto-detect)</span>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="radio"
							name="schema"
							checked={schemaSelection === 'skip'}
							onChange={() => onSchemaSelectionChange('skip')}
						/>
						<span>Skip — configure later</span>
					</label>
				</div>
			</div>
		</div>
	);
}
