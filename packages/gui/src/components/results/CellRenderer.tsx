/**
 * Type-aware cell renderer for query result data.
 * All content rendered via React text nodes (XSS-safe).
 */
import { Check, Copy, X } from 'lucide-react';

interface CellRendererProps {
	value: unknown;
	columnType?: string | undefined;
}

export function CellRenderer({ value, columnType }: CellRendererProps) {
	// NULL
	if (value == null) {
		return <span className="italic text-muted-foreground">NULL</span>;
	}

	// Boolean
	if (typeof value === 'boolean') {
		return value ? (
			<Check className="h-4 w-4 text-green-500" />
		) : (
			<X className="h-4 w-4 text-red-400" />
		);
	}

	// BigInt (comes as string from sidecar)
	if (columnType === 'bigint' || columnType === 'int8') {
		return <span className="font-mono text-right">{String(value)}</span>;
	}

	// Number
	if (typeof value === 'number') {
		return <span className="text-right tabular-nums">{value}</span>;
	}

	// UUID
	if (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	) {
		return (
			<span className="font-mono text-xs" title={value}>
				{value.slice(0, 8)}...
			</span>
		);
	}

	// JSON/JSONB (object or array)
	if (typeof value === 'object') {
		const json = JSON.stringify(value);
		const truncated = json.length > 80 ? `${json.slice(0, 77)}...` : json;
		return (
			<span className="font-mono text-xs" title={json}>
				{truncated}
			</span>
		);
	}

	// Bytea (base64 string marker)
	if (typeof value === 'string' && columnType === 'bytea') {
		const size = Math.ceil((value.length * 3) / 4);
		return (
			<span className="flex items-center gap-1">
				<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
					binary {size}B
				</span>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground"
					onClick={() => navigator.clipboard.writeText(value)}
					title="Copy Base64"
				>
					<Copy className="h-3 w-3" />
				</button>
			</span>
		);
	}

	// Default: plain text (XSS-safe via React text node)
	return <span>{String(value)}</span>;
}
