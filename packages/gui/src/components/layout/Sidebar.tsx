import { Database } from "lucide-react";

export function Sidebar() {
	return (
		<div className="flex h-full flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
			{/* Header */}
			<div className="flex items-center gap-2 border-b border-[var(--sidebar-border)] px-3 py-2">
				<Database className="h-4 w-4 text-[var(--muted-foreground)]" />
				<span className="text-sm font-medium">Schema</span>
			</div>

			{/* Placeholder content */}
			<div className="flex flex-1 items-center justify-center p-4">
				<p className="text-center text-sm text-[var(--muted-foreground)]">
					Connect to a database to explore its schema
				</p>
			</div>
		</div>
	);
}
