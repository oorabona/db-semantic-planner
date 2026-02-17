import { FolderOpen, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RecentProject } from '@/lib/app-db';

interface RecentProjectsDialogProps {
	readonly open: boolean;
	readonly onClose: () => void;
	readonly projects: readonly RecentProject[];
	readonly onOpen: (path: string) => void;
	readonly onRemove: (path: string) => void;
}

function formatDate(timestamp: number): string {
	const d = new Date(timestamp);
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

export function RecentProjectsDialog({
	open,
	onClose,
	projects,
	onOpen,
	onRemove,
}: RecentProjectsDialogProps) {
	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop */}
			<div
				role="presentation"
				className="absolute inset-0 bg-black/50"
				onClick={onClose}
				onKeyDown={(e) => e.key === 'Escape' && onClose()}
			/>

			{/* Dialog */}
			<div className="relative w-[480px] overflow-hidden rounded-lg border bg-background shadow-xl">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<span className="text-sm font-medium">Recent Projects</span>
					<button
						type="button"
						className="rounded p-0.5 hover:bg-[var(--accent)]"
						onClick={onClose}
						data-testid="recent-close"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="max-h-[400px] overflow-y-auto">
					{projects.length === 0 ? (
						<div className="px-4 py-8 text-center text-sm text-muted-foreground">
							No recent projects
						</div>
					) : (
						<ul className="divide-y">
							{projects.map((p) => (
								<li
									key={p.path}
									className="group flex items-center gap-2 px-4 py-2 hover:bg-[var(--accent)]"
								>
									<button
										type="button"
										className="flex min-w-0 flex-1 items-center gap-2 text-left"
										onClick={() => onOpen(p.path)}
										data-testid={`recent-project-${p.folderName}`}
									>
										<FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{p.name}
											</div>
											<div className="truncate text-xs text-muted-foreground">
												{p.path}
											</div>
										</div>
										<span className="shrink-0 text-xs text-muted-foreground">
											{formatDate(p.lastOpenedAt)}
										</span>
									</button>
									<Button
										variant="ghost"
										size="sm"
										className="h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											onRemove(p.path);
										}}
										title="Remove from recent"
										data-testid={`recent-remove-${p.folderName}`}
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
