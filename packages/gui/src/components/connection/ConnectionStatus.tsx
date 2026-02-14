import { AlertCircle, Database, Loader2, Unplug } from 'lucide-react';
import type { ConnectionStatus as Status } from '@/stores/connection-store';

interface ConnectionStatusProps {
	status: Status;
	database?: string;
	schema?: string;
	host?: string;
	error?: string | null;
	onReconnect?: () => void;
}

const STATUS_CONFIG: Record<
	Status,
	{ icon: typeof Database; label: string; className: string }
> = {
	disconnected: {
		icon: Unplug,
		label: 'Disconnected',
		className: 'text-muted-foreground',
	},
	connecting: {
		icon: Loader2,
		label: 'Connecting...',
		className: 'text-yellow-500',
	},
	connected: {
		icon: Database,
		label: 'Connected',
		className: 'text-green-500',
	},
	error: {
		icon: AlertCircle,
		label: 'Error',
		className: 'text-red-500',
	},
};

export function ConnectionStatus({
	status,
	database,
	schema,
	host,
	error,
	onReconnect,
}: ConnectionStatusProps) {
	const config = STATUS_CONFIG[status];
	const Icon = config.icon;
	const animate = status === 'connecting' ? 'animate-spin' : '';

	return (
		<div className="flex items-center gap-2 text-xs">
			<Icon className={`h-3.5 w-3.5 ${config.className} ${animate}`} />
			{status === 'connected' && database ? (
				<span>
					<span className="font-medium">{database}</span>
					{schema && schema !== 'public' && (
						<span className="text-muted-foreground">.{schema}</span>
					)}
					{host && <span className="text-muted-foreground"> @ {host}</span>}
				</span>
			) : (
				<span className={config.className}>{config.label}</span>
			)}
			{status === 'error' && error && (
				<span className="truncate text-red-500" title={error}>
					{error}
				</span>
			)}
			{(status === 'error' || status === 'disconnected') && onReconnect && (
				<button
					type="button"
					className="text-xs text-blue-500 hover:underline"
					onClick={onReconnect}
				>
					Reconnect
				</button>
			)}
		</div>
	);
}
