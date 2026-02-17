/**
 * Step 3 — Connections: manage 0..N database connections with environment labels.
 *
 * Reuses ConnectionDialog for each connection form. Allows adding, editing, and
 * removing connections. Auto-detects active connection from standalone mode.
 */
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
	ConnectionDialog,
	type ConnectionFormData,
} from '@/components/connection/ConnectionDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SslMode } from '@/stores/connection-store';
import type { WizardConnection } from './wizard-types';

interface WizardConnectionsStepProps {
	connections: readonly WizardConnection[];
	onAdd: (formData: ConnectionFormData, environment?: string) => void;
	onRemove: (id: string) => void;
	onUpdateEnvironment: (id: string, env: string) => void;
	/** Callbacks for ConnectionDialog functionality. */
	onDiscover: (params: {
		host: string;
		port: number;
		user: string;
		password: string;
		sslMode: SslMode;
	}) => Promise<{ databases: string[] }>;
	onListSchemas: (params: {
		host: string;
		port: number;
		user: string;
		password: string;
		sslMode: SslMode;
		database: string;
	}) => Promise<{ schemas: string[] }>;
	onTest: (data: ConnectionFormData) => void;
	testing?: boolean;
	testResult?: { ok: boolean; message: string } | null;
}

export function WizardConnectionsStep({
	connections,
	onAdd,
	onRemove,
	onUpdateEnvironment,
	onDiscover,
	onListSchemas,
	onTest,
	testing = false,
	testResult = null,
}: WizardConnectionsStepProps) {
	const [dialogOpen, setDialogOpen] = useState(false);

	const handleSave = (data: ConnectionFormData) => {
		onAdd(data);
		setDialogOpen(false);
	};

	return (
		<div className="space-y-4">
			<h3 className="text-lg font-semibold">Connections</h3>
			<p className="text-muted-foreground text-sm">
				Add database connections for this project. Each connection can be
				labelled with an environment (dev, staging, prod).
			</p>

			{/* Connection list */}
			{connections.length > 0 && (
				<div className="space-y-2 pt-2">
					{connections.map((conn) => (
						<ConnectionCard
							key={conn.id}
							connection={conn}
							onRemove={() => onRemove(conn.id)}
							onUpdateEnvironment={(env) => onUpdateEnvironment(conn.id, env)}
						/>
					))}
				</div>
			)}

			{/* Add connection button */}
			<Button
				type="button"
				variant="outline"
				onClick={() => setDialogOpen(true)}
				className="w-full"
				data-testid="add-connection"
			>
				<Plus className="mr-2 h-4 w-4" />
				Add Connection
			</Button>

			{/* Zero connections warning */}
			{connections.length === 0 && (
				<div
					className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3"
					data-testid="zero-connections-warning"
				>
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
					<div>
						<p className="text-sm font-medium">No connections configured</p>
						<p className="text-muted-foreground text-xs">
							Only NQL plan execution will be available — the results tab will
							be disabled until a connection is added.
						</p>
					</div>
				</div>
			)}

			{/* Connection dialog (reused from standalone flow) */}
			<ConnectionDialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				onConnect={handleSave}
				onTest={onTest}
				onSave={handleSave}
				onDiscover={onDiscover}
				onListSchemas={onListSchemas}
				testing={testing}
				testResult={testResult}
			/>
		</div>
	);
}

// ── Connection Card ──────────────────────────────────────────────

function ConnectionCard({
	connection,
	onRemove,
	onUpdateEnvironment,
}: {
	connection: WizardConnection;
	onRemove: () => void;
	onUpdateEnvironment: (env: string) => void;
}) {
	const { formData, environment } = connection;
	const summary = `${formData.user}@${formData.host}:${formData.port}/${formData.database}`;

	return (
		<div className="flex items-center gap-2 rounded-md border p-3">
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">
					{formData.name || formData.database}
				</p>
				<p className="text-muted-foreground truncate text-xs">{summary}</p>
			</div>
			<div className="flex items-center gap-2">
				<div className="grid gap-1">
					<Label htmlFor={`env-${connection.id}`} className="sr-only">
						Environment
					</Label>
					<Input
						id={`env-${connection.id}`}
						value={environment}
						onChange={(e) => onUpdateEnvironment(e.target.value)}
						placeholder="Environment"
						className="h-7 w-24 text-xs"
						data-testid={`env-input-${connection.id}`}
					/>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onRemove}
					className="h-7 w-7 p-0"
					data-testid={`remove-${connection.id}`}
				>
					<Trash2 className="h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}
