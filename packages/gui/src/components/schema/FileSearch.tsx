import { Search, X } from 'lucide-react';
import { useProjectStore } from '@/stores/project-store';

export function FileSearch() {
	const fileSearchFilter = useProjectStore((s) => s.fileSearchFilter);
	const setFileSearchFilter = useProjectStore((s) => s.setFileSearchFilter);

	return (
		<div className="relative px-2 py-1.5">
			<Search className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="text"
				value={fileSearchFilter}
				onChange={(e) => setFileSearchFilter(e.target.value)}
				placeholder="Filter files..."
				className="w-full rounded border bg-background py-1 pl-7 pr-7 text-xs outline-none focus:border-ring"
			/>
			{fileSearchFilter && (
				<button
					type="button"
					onClick={() => setFileSearchFilter('')}
					className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}
