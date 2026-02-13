import { ChevronRight, Table2 } from "lucide-react";
import { useSchemaStore, type SchemaTable } from "@/stores/schema-store";
import { ColumnNode } from "./ColumnNode";
import { IndexNode } from "./IndexNode";

interface TableNodeProps {
	table: SchemaTable;
}

export function TableNode({ table }: TableNodeProps) {
	const expanded = useSchemaStore((s) => s.expanded);
	const toggleExpanded = useSchemaStore((s) => s.toggleExpanded);

	const tableNodeId = `table:${table.name}`;
	const columnsNodeId = `table:${table.name}:columns`;
	const indexesNodeId = `table:${table.name}:indexes`;

	const isTableExpanded = expanded.has(tableNodeId);
	const isColumnsExpanded = expanded.has(columnsNodeId);
	const isIndexesExpanded = expanded.has(indexesNodeId);

	return (
		<div>
			{/* Table row */}
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm hover:bg-accent"
				onClick={() => toggleExpanded(tableNodeId)}
			>
				<ChevronRight
					className={`h-3.5 w-3.5 shrink-0 transition-transform ${
						isTableExpanded ? "rotate-90" : ""
					}`}
				/>
				<Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">{table.name}</span>
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">
					{table.columns.length}
				</span>
			</button>

			{/* Expanded: Columns + Indexes sections */}
			{isTableExpanded && (
				<div className="ml-2">
					{/* Columns section */}
					<button
						type="button"
						className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/50"
						onClick={() => toggleExpanded(columnsNodeId)}
					>
						<ChevronRight
							className={`h-3 w-3 shrink-0 transition-transform ${
								isColumnsExpanded ? "rotate-90" : ""
							}`}
						/>
						<span>Columns ({table.columns.length})</span>
					</button>

					{isColumnsExpanded &&
						table.columns.map((col) => (
							<ColumnNode key={col.name} column={col} table={table} />
						))}

					{/* Indexes section (only if indexes exist) */}
					{table.indexes.length > 0 && (
						<>
							<button
								type="button"
								className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/50"
								onClick={() => toggleExpanded(indexesNodeId)}
							>
								<ChevronRight
									className={`h-3 w-3 shrink-0 transition-transform ${
										isIndexesExpanded ? "rotate-90" : ""
									}`}
								/>
								<span>Indexes ({table.indexes.length})</span>
							</button>

							{isIndexesExpanded &&
								table.indexes.map((idx) => (
									<IndexNode
										key={idx.name ?? idx.columns.join(",")}
										index={idx}
									/>
								))}
						</>
					)}
				</div>
			)}
		</div>
	);
}
