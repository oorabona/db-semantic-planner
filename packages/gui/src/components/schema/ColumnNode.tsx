import { PkIcon, FkIcon, TypeIcon } from "./icons";
import type { SchemaColumn, SchemaTable } from "@/stores/schema-store";
import { isPrimaryKey, isForeignKey, getFkTarget } from "@/stores/schema-store";

interface ColumnNodeProps {
	column: SchemaColumn;
	table: SchemaTable;
}

export function ColumnNode({ column, table }: ColumnNodeProps) {
	const pk = isPrimaryKey(table, column.name);
	const fk = isForeignKey(table, column.name);
	const fkTarget = fk ? getFkTarget(table, column.name) : null;

	return (
		<div className="flex items-center gap-1.5 py-0.5 pl-8 pr-2 text-xs hover:bg-accent/50">
			{/* Icon: PK > FK > Type */}
			{pk ? (
				<PkIcon className="h-3 w-3 shrink-0" />
			) : fk ? (
				<FkIcon className="h-3 w-3 shrink-0" />
			) : (
				<TypeIcon type={column.type} className="h-3 w-3 shrink-0 text-muted-foreground" />
			)}

			{/* Column name */}
			<span className={pk ? "font-medium" : ""}>{column.name}</span>

			{/* Type badge */}
			<span className="ml-auto shrink-0 text-muted-foreground">
				{column.originalDbType ?? column.type}
			</span>

			{/* Nullable indicator */}
			{!column.nullable && !pk && (
				<span className="shrink-0 text-orange-400" title="NOT NULL">
					!
				</span>
			)}

			{/* FK target tooltip */}
			{fkTarget && (
				<span
					className="shrink-0 text-blue-400"
					title={`→ ${fkTarget.table}.${fkTarget.column}`}
				>
					→
				</span>
			)}
		</div>
	);
}
