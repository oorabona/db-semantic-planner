import { ListTree } from "lucide-react";
import type { SchemaIndex } from "@/stores/schema-store";

interface IndexNodeProps {
	index: SchemaIndex;
}

export function IndexNode({ index }: IndexNodeProps) {
	return (
		<div className="flex items-center gap-1.5 py-0.5 pl-8 pr-2 text-xs hover:bg-accent/50">
			<ListTree className="h-3 w-3 shrink-0 text-muted-foreground" />
			<span className="text-muted-foreground">
				{index.name ?? index.columns.join(", ")}
			</span>
			{index.unique && (
				<span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
					UNIQUE
				</span>
			)}
		</div>
	);
}
