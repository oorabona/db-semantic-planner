/**
 * TanStack Table wrapper with virtual scrolling for query results.
 */

import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { CellRenderer } from './CellRenderer';

interface DataTableProps {
	columns: string[];
	rows: ReadonlyArray<Record<string, unknown>>;
}

const ROW_HEIGHT = 32;

export function DataTable({ columns, rows }: DataTableProps) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const parentRef = useRef<HTMLDivElement>(null);

	const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
		() =>
			columns.map((col) => ({
				accessorKey: col,
				header: col,
				cell: ({ getValue }) => <CellRenderer value={getValue()} />,
				size: 150,
			})),
		[columns],
	);

	const table = useReactTable({
		data: rows as Record<string, unknown>[],
		columns: columnDefs,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	const { rows: tableRows } = table.getRowModel();

	const virtualizer = useVirtualizer({
		count: tableRows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20,
	});

	return (
		<div ref={parentRef} className="flex-1 overflow-auto">
			<table className="w-full border-collapse text-xs">
				<thead className="sticky top-0 z-10 bg-muted">
					{table.getHeaderGroups().map((headerGroup) => (
						<tr key={headerGroup.id}>
							{headerGroup.headers.map((header) => (
								<th
									key={header.id}
									className="cursor-pointer select-none border-b px-3 py-1.5 text-left font-medium text-muted-foreground hover:bg-accent/50"
									style={{ width: header.getSize() }}
									onClick={header.column.getToggleSortingHandler()}
								>
									<span className="flex items-center gap-1">
										{flexRender(
											header.column.columnDef.header,
											header.getContext(),
										)}
										{{
											asc: <ArrowUp className="h-3 w-3" />,
											desc: <ArrowDown className="h-3 w-3" />,
										}[header.column.getIsSorted() as string] ?? null}
									</span>
								</th>
							))}
						</tr>
					))}
				</thead>
				<tbody
					style={{
						height: `${virtualizer.getTotalSize()}px`,
						position: 'relative',
					}}
				>
					{virtualizer.getVirtualItems().map((virtualRow) => {
						const row = tableRows[virtualRow.index]!;
						return (
							<tr
								key={row.id}
								className="border-b hover:bg-accent/30"
								style={{
									height: `${ROW_HEIGHT}px`,
									position: 'absolute',
									top: 0,
									transform: `translateY(${virtualRow.start}px)`,
									width: '100%',
									display: 'table-row',
								}}
							>
								{row.getVisibleCells().map((cell) => (
									<td
										key={cell.id}
										className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1"
										style={{ maxWidth: cell.column.getSize() }}
									>
										{flexRender(cell.column.columnDef.cell, cell.getContext())}
									</td>
								))}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
