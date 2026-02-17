/**
 * TanStack Table wrapper with virtual scrolling for query results.
 * Features: row virtualization, auto-column sizing, column virtualization for wide tables.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellRenderer } from './CellRenderer';

interface DataTableProps {
	columns: string[];
	rows: ReadonlyArray<Record<string, unknown>>;
	/** Called when user scrolls within threshold of the bottom. */
	onScrollNearEnd?: () => void;
}

const ROW_HEIGHT = 32;
/** Distance from bottom (px) at which infinite scroll triggers */
const SCROLL_THRESHOLD = 200;
/** Minimum column width in pixels */
const MIN_COL_WIDTH = 60;
/** Maximum column width in pixels */
const MAX_COL_WIDTH = 400;
/** Approximate character width in px for the monospace font at text-xs (12px) */
const CHAR_WIDTH = 7.2;
/** Padding inside each cell (px-3 = 12px each side) */
const CELL_PADDING = 24;
/** Number of sample rows to measure for auto-sizing */
const SAMPLE_SIZE = 50;
/** Column count threshold above which column virtualization is enabled */
const COL_VIRTUALIZE_THRESHOLD = 15;

// ── Auto-column sizing ───────────────────────────────────────────

/**
 * Estimate column width from header name + sample row values.
 * Measures the widest value string in the first N rows, clamped to [MIN, MAX].
 */
function estimateColumnWidth(
	col: string,
	rows: ReadonlyArray<Record<string, unknown>>,
): number {
	let maxLen = col.length;

	const sampleRows =
		rows.length > SAMPLE_SIZE ? rows.slice(0, SAMPLE_SIZE) : rows;
	for (const row of sampleRows) {
		const val = row[col];
		if (val == null) continue;
		const str = typeof val === 'string' ? val : JSON.stringify(val);
		// Only measure first 60 chars (long values get ellipsis anyway)
		const len = Math.min(str.length, 60);
		if (len > maxLen) maxLen = len;
	}

	const width = maxLen * CHAR_WIDTH + CELL_PADDING;
	return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
}

// ── Component ────────────────────────────────────────────────────

export function DataTable({ columns, rows, onScrollNearEnd }: DataTableProps) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const parentRef = useRef<HTMLDivElement>(null);

	// ── Infinite scroll: detect scroll near bottom ─────────────
	const onScrollNearEndRef = useRef(onScrollNearEnd);
	onScrollNearEndRef.current = onScrollNearEnd;

	const handleScroll = useCallback(() => {
		const el = parentRef.current;
		if (!el || !onScrollNearEndRef.current) return;
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distFromBottom < SCROLL_THRESHOLD) {
			onScrollNearEndRef.current();
		}
	}, []);

	useEffect(() => {
		const el = parentRef.current;
		if (!el || !onScrollNearEnd) return;
		el.addEventListener('scroll', handleScroll, { passive: true });
		return () => el.removeEventListener('scroll', handleScroll);
	}, [onScrollNearEnd, handleScroll]);

	const useColumnVirtualization = columns.length > COL_VIRTUALIZE_THRESHOLD;

	// Estimate widths from the first batch only — skip recalc on fetchMore.
	// Re-measure when columns change (new query).
	const columnWidths = useMemo(
		() => columns.map((col) => estimateColumnWidth(col, rows)),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- rows intentionally excluded: only first batch matters
		[columns],
	);

	const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
		() =>
			columns.map((col, i) => ({
				accessorKey: col,
				header: col,
				cell: ({ getValue }) => <CellRenderer value={getValue()} />,
				size: columnWidths[i] ?? 150,
			})),
		[columns, columnWidths],
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
	const allColumns = table.getAllColumns();

	// ── Row virtualizer (always active) ──────────────────────────

	const rowVirtualizer = useVirtualizer({
		count: tableRows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20,
	});

	const virtualRows = rowVirtualizer.getVirtualItems();
	const totalRowSize = rowVirtualizer.getTotalSize();

	const paddingTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
	const paddingBottom =
		virtualRows.length > 0
			? totalRowSize - (virtualRows[virtualRows.length - 1]?.end ?? 0)
			: 0;

	// ── Column virtualizer (only for wide tables) ────────────────

	const colVirtualizer = useVirtualizer({
		horizontal: true,
		count: useColumnVirtualization ? allColumns.length : 0,
		getScrollElement: () => parentRef.current,
		estimateSize: (i) => columnWidths[i] ?? 150,
		overscan: 3,
	});

	// Visible column indices (all if not virtualizing, subset if virtualizing)
	const visibleColIndices = useColumnVirtualization
		? colVirtualizer.getVirtualItems().map((v) => v.index)
		: columns.map((_, i) => i);

	const totalColSize = useColumnVirtualization
		? colVirtualizer.getTotalSize()
		: columnWidths.reduce((sum, w) => sum + w, 0);

	const colPaddingLeft =
		useColumnVirtualization && colVirtualizer.getVirtualItems().length > 0
			? (colVirtualizer.getVirtualItems()[0]?.start ?? 0)
			: 0;

	const colPaddingRight =
		useColumnVirtualization && colVirtualizer.getVirtualItems().length > 0
			? totalColSize -
				(colVirtualizer.getVirtualItems()[
					colVirtualizer.getVirtualItems().length - 1
				]?.end ?? 0)
			: 0;

	return (
		<div ref={parentRef} className="flex-1 overflow-auto">
			<table
				className="border-collapse text-xs"
				style={{ width: `${totalColSize}px` }}
			>
				<thead className="sticky top-0 z-10 bg-muted">
					{table.getHeaderGroups().map((headerGroup) => (
						<tr key={headerGroup.id}>
							{colPaddingLeft > 0 && (
								<th
									style={{ width: `${colPaddingLeft}px`, padding: 0 }}
									aria-hidden
								/>
							)}
							{visibleColIndices.map((colIdx) => {
								const header = headerGroup.headers[colIdx];
								if (!header) return null;
								return (
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
								);
							})}
							{colPaddingRight > 0 && (
								<th
									style={{ width: `${colPaddingRight}px`, padding: 0 }}
									aria-hidden
								/>
							)}
						</tr>
					))}
				</thead>
				<tbody>
					{paddingTop > 0 && (
						<tr>
							<td
								colSpan={
									visibleColIndices.length +
									(colPaddingLeft > 0 ? 1 : 0) +
									(colPaddingRight > 0 ? 1 : 0)
								}
								style={{ height: `${paddingTop}px` }}
							/>
						</tr>
					)}
					{virtualRows.map((virtualRow) => {
						const row = tableRows[virtualRow.index];
						if (!row) return null;
						const visibleCells = row.getVisibleCells();
						return (
							<tr
								key={row.id}
								className="border-b hover:bg-accent/30"
								style={{ height: `${ROW_HEIGHT}px` }}
							>
								{colPaddingLeft > 0 && (
									<td
										style={{ width: `${colPaddingLeft}px`, padding: 0 }}
										aria-hidden
									/>
								)}
								{visibleColIndices.map((colIdx) => {
									const cell = visibleCells[colIdx];
									if (!cell) return null;
									return (
										<td
											key={cell.id}
											className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1"
											style={{ maxWidth: cell.column.getSize() }}
										>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext(),
											)}
										</td>
									);
								})}
								{colPaddingRight > 0 && (
									<td
										style={{ width: `${colPaddingRight}px`, padding: 0 }}
										aria-hidden
									/>
								)}
							</tr>
						);
					})}
					{paddingBottom > 0 && (
						<tr>
							<td
								colSpan={
									visibleColIndices.length +
									(colPaddingLeft > 0 ? 1 : 0) +
									(colPaddingRight > 0 ? 1 : 0)
								}
								style={{ height: `${paddingBottom}px` }}
							/>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
