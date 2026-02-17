import { AlertTriangle, Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSchema } from '@/hooks/useSchema';
import { getFilteredTables, useSchemaStore } from '@/stores/schema-store';
import { useSidecarStore } from '@/stores/sidecar-store';
import { SchemaSearch } from './SchemaSearch';
import { TableNode } from './TableNode';

interface SchemaTreeProps {
	onConnect: () => void;
}

export function SchemaTree({ onConnect }: SchemaTreeProps) {
	const { schema, loading, error, refresh } = useSchema();
	const searchFilter = useSchemaStore((s) => s.searchFilter);
	const filteredTables = getFilteredTables(schema, searchFilter);
	const sidecarStatus = useSidecarStore((s) => s.status);
	const sidecarError = useSidecarStore((s) => s.error);

	// Sidecar not running — show specific error with restart hint
	if (sidecarStatus === 'stopped' && sidecarError) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
				<AlertTriangle className="h-5 w-5 text-red-500" />
				<span className="text-center text-xs font-medium text-red-500">
					Sidecar failed to start
				</span>
				<span className="text-center text-[10px] text-muted-foreground">
					{sidecarError}
				</span>
				<span className="text-center text-[10px] text-muted-foreground">
					Check the console (F12) for details, then restart the app.
				</span>
			</div>
		);
	}

	// Sidecar booting
	if (
		sidecarStatus === 'spawning' ||
		sidecarStatus === 'handshaking' ||
		sidecarStatus === 'restarting'
	) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				<span className="text-xs text-muted-foreground">
					Starting sidecar...
				</span>
			</div>
		);
	}

	// Loading state
	if (loading) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				<span className="text-xs text-muted-foreground">Loading schema...</span>
			</div>
		);
	}

	// Error state (schema-level, sidecar is running)
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
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
				<PlugZap className="h-8 w-8 text-muted-foreground/50" />
				<p className="text-center text-sm text-muted-foreground">
					Connect to a database to explore its schema
				</p>
				<Button size="sm" onClick={onConnect}>
					Connect
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			{/* Search + header */}
			<div className="border-b">
				<div className="flex items-center justify-between px-2 py-1">
					<span className="text-xs text-muted-foreground">
						{filteredTables.length} table
						{filteredTables.length !== 1 ? 's' : ''}
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
						{searchFilter ? 'No tables match filter' : 'No tables found'}
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
