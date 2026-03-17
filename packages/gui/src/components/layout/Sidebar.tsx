import { open } from '@tauri-apps/plugin-dialog';
import { Database, FolderOpen, PlugZap, Plus } from 'lucide-react';
import { SidebarConnectionPanel } from '@/components/connection/SidebarConnectionPanel';
import { FileSearch } from '@/components/schema/FileSearch';
import { FileTree } from '@/components/schema/FileTree';
import { SchemaTree } from '@/components/schema/SchemaTree';
import { useProjectStore } from '@/stores/project-store';
import { CollapsibleSection } from './CollapsibleSection';

interface SidebarProps {
	onConnect: () => void;
	onFileSelect: (filePath: string) => void;
	schemaEditable?: boolean;
	onEditSchema?: () => void;
}

export function Sidebar({
	onConnect,
	onFileSelect,
	schemaEditable,
	onEditSchema,
}: SidebarProps) {
	const {
		mode,
		files,
		addFile,
		removeFile,
		deleteFile,
		renameFile,
		fileSearchFilter,
	} = useProjectStore();

	const handleAddFile = async () => {
		const selected = await open({
			multiple: true,
			filters: [{ name: 'DBSP Files', extensions: ['dbsp', 'sql'] }],
		});
		if (selected) {
			for (const path of selected) {
				await addFile(path);
			}
		}
	};

	return (
		<div className="flex h-full flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
			{mode === 'project' && (
				<CollapsibleSection
					title="Files"
					icon={FolderOpen}
					action={
						<button
							type="button"
							className="rounded p-0.5 hover:bg-[var(--accent)]"
							onClick={handleAddFile}
							title="Add file to project"
						>
							<Plus className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
						</button>
					}
				>
					<FileSearch />
					<FileTree
						files={files}
						onFileSelect={onFileSelect}
						onRenameFile={renameFile}
						onRemoveFile={removeFile}
						onDeleteFile={deleteFile}
						searchFilter={fileSearchFilter}
					/>
				</CollapsibleSection>
			)}

			<CollapsibleSection title="Connections" icon={PlugZap}>
				<SidebarConnectionPanel onNewConnection={onConnect} />
			</CollapsibleSection>

			<CollapsibleSection title="Schema" icon={Database}>
				<SchemaTree
					schemaEditable={schemaEditable}
					onEditSchema={onEditSchema}
				/>
			</CollapsibleSection>
		</div>
	);
}
