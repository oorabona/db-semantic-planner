import { Database } from 'lucide-react';
import { SchemaTree } from '@/components/schema/SchemaTree';

interface SidebarProps {
	onConnect: () => void;
}

export function Sidebar({ onConnect }: SidebarProps) {
	return (
		<div className="flex h-full flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
			{/* Header */}
			<div className="flex items-center gap-2 border-b border-[var(--sidebar-border)] px-3 py-2">
				<Database className="h-4 w-4 text-[var(--muted-foreground)]" />
				<span className="text-sm font-medium">Schema</span>
			</div>

			{/* Schema tree */}
			<SchemaTree onConnect={onConnect} />
		</div>
	);
}
