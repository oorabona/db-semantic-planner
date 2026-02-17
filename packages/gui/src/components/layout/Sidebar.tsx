import { Database, FolderOpen } from 'lucide-react';
import { FileTree } from '@/components/schema/FileTree';
import { SchemaTree } from '@/components/schema/SchemaTree';
import { useProjectStore } from '@/stores/project-store';

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
	const { mode, files } = useProjectStore();

	return (
		<div className="flex h-full flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
			{/* Project files section (project mode only) */}
			{mode === 'project' && (
				<>
					<div className="flex items-center gap-2 border-b border-[var(--sidebar-border)] px-3 py-2">
						<FolderOpen className="h-4 w-4 text-[var(--muted-foreground)]" />
						<span className="text-sm font-medium">Files</span>
					</div>
					<div className="flex-1 overflow-auto border-b border-[var(--sidebar-border)]">
						<FileTree files={files} onFileSelect={onFileSelect} />
					</div>
				</>
			)}

			{/* Schema tree section */}
			<div className="flex items-center gap-2 border-b border-[var(--sidebar-border)] px-3 py-2">
				<Database className="h-4 w-4 text-[var(--muted-foreground)]" />
				<span className="text-sm font-medium">Schema</span>
			</div>
			<div className="flex-1 overflow-auto">
				<SchemaTree
					onConnect={onConnect}
					schemaEditable={schemaEditable}
					onEditSchema={onEditSchema}
				/>
			</div>
		</div>
	);
}
