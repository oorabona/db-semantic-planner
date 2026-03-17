import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

interface CollapsibleSectionProps {
	readonly title: string;
	readonly icon: LucideIcon;
	readonly children: ReactNode;
	readonly defaultOpen?: boolean;
	/** Optional action element rendered at the right of the header */
	readonly action?: ReactNode;
}

export function CollapsibleSection({
	title,
	icon: Icon,
	children,
	defaultOpen = true,
	action,
}: CollapsibleSectionProps) {
	const [open, setOpen] = useState(defaultOpen);

	return (
		<div className={`flex flex-col ${open ? 'min-h-0 flex-1' : ''}`}>
			<div className="flex shrink-0 items-center border-b border-[var(--sidebar-border)]">
				<button
					type="button"
					className="flex flex-1 items-center gap-2 px-3 py-2 hover:bg-[var(--accent)]"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
				>
					{open ? (
						<ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
					)}
					<Icon className="h-4 w-4 text-[var(--muted-foreground)]" />
					<span className="text-sm font-medium">{title}</span>
				</button>
				{action && <div className="flex items-center px-2">{action}</div>}
			</div>
			{open && <div className="min-h-0 flex-1 overflow-auto">{children}</div>}
		</div>
	);
}
