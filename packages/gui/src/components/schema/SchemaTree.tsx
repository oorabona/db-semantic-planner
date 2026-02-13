import { RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { useSchema } from "@/hooks/useSchema";
import { useSchemaStore, getFilteredTables } from "@/stores/schema-store";
import { SchemaSearch } from "./SchemaSearch";
import { TableNode } from "./TableNode";

export function SchemaTree() {
	const { schema, loading, error, refresh } = useSchema();
	const searchFilter = useSchemaStore((s) => s.searchFilter);
	const filteredTables = getFilteredTables(schema, searchFilter);

	// Loading state
	if (loading) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				<span className="text-xs text-muted-foreground">
					Loading schema...
				</span>
			</div>
		);
	}

	// Error state
	if (error) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
				<AlertTriangle className="h-5 w-5 text-red-500" />
				<span className="text-center text-xs text-red-500">{error}</span>
				<button
					type="button"
					onClick={refresh}
					className="text-xs text-blue-500 hover:underline"
				>
					Retry
				</button>
			</div>
		);
	}

	// No schema loaded (disconnected)
	if (!schema) {
		return (
			<div className="flex flex-1 items-center justify-center p-4">
				<p className="text-center text-sm text-muted-foreground">
					Connect to a database to explore its schema
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			{/* Search + header */}
			<div className="border-b">
				<div className="flex items-center justify-between px-2 py-1">
					<span className="text-xs text-muted-foreground">
						{filteredTables.length} table{filteredTables.length !== 1 ? "s" : ""}
					</span>
					<button
						type="button"
						onClick={refresh}
						className="rounded p-0.5 hover:bg-accent"
						title="Refresh schema"
					>
						<RefreshCw className="h-3 w-3 text-muted-foreground" />
					</button>
				</div>
				<SchemaSearch />
			</div>

			{/* Table list */}
			<div className="flex-1 overflow-y-auto">
				{filteredTables.length === 0 ? (
					<div className="p-4 text-center text-xs text-muted-foreground">
						{searchFilter ? "No tables match filter" : "No tables found"}
					</div>
				) : (
					filteredTables.map((table) => (
						<TableNode key={table.name} table={table} />
					))
				)}
			</div>

			{/* Warnings */}
			{schema.warnings.length > 0 && (
				<div className="border-t px-2 py-1">
					{schema.warnings.map((w) => (
						<div
							key={w}
							className="flex items-start gap-1 text-[10px] text-yellow-500"
						>
							<AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0" />
							<span>{w}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
