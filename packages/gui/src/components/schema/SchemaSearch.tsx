import { Search, X } from "lucide-react";
import { useSchemaStore } from "@/stores/schema-store";

export function SchemaSearch() {
	const searchFilter = useSchemaStore((s) => s.searchFilter);
	const setSearchFilter = useSchemaStore((s) => s.setSearchFilter);

	return (
		<div className="relative px-2 py-1.5">
			<Search className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="text"
				value={searchFilter}
				onChange={(e) => setSearchFilter(e.target.value)}
				placeholder="Filter tables..."
				className="w-full rounded border bg-background py-1 pl-7 pr-7 text-xs outline-none focus:border-ring"
			/>
			{searchFilter && (
				<button
					type="button"
					onClick={() => setSearchFilter("")}
					className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}
