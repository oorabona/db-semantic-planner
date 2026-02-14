import { Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { DatabaseType, SslMode } from '@/stores/connection-store';

export interface ConnectionFormData {
	name: string;
	type: DatabaseType;
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	schema: string;
	sslMode: SslMode;
}

const DEFAULT_PORTS: Record<DatabaseType, number> = {
	postgresql: 5432,
	mysql: 3306,
	sqlite: 0,
	mssql: 1433,
};

const DEFAULT_FORM: ConnectionFormData = {
	name: '',
	type: 'postgresql',
	host: 'localhost',
	port: 5432,
	database: '',
	user: 'postgres',
	password: '',
	schema: 'public',
	sslMode: 'prefer',
};

interface ConnectionDialogProps {
	open: boolean;
	onClose: () => void;
	onConnect: (data: ConnectionFormData) => void;
	onTest: (data: ConnectionFormData) => void;
	onSave: (data: ConnectionFormData) => void;
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
	initial?: Partial<ConnectionFormData>;
	testing?: boolean;
	connecting?: boolean;
	testResult?: { ok: boolean; message: string } | null;
}

export function ConnectionDialog({
	open,
	onClose,
	onConnect,
	onTest,
	onSave,
	onDiscover,
	onListSchemas,
	initial,
	testing = false,
	connecting = false,
	testResult = null,
}: ConnectionDialogProps) {
	const [form, setForm] = useState<ConnectionFormData>({
		...DEFAULT_FORM,
		...initial,
	});

	// Discovery state
	const [discovering, setDiscovering] = useState(false);
	const [databases, setDatabases] = useState<string[]>([]);
	const [schemas, setSchemas] = useState<string[]>([]);
	const [loadingSchemas, setLoadingSchemas] = useState(false);
	const [discoverError, setDiscoverError] = useState<string | null>(null);
	const [discovered, setDiscovered] = useState(false);

	if (!open) return null;

	const update = <K extends keyof ConnectionFormData>(
		field: K,
		value: ConnectionFormData[K],
	) => setForm((prev) => ({ ...prev, [field]: value }));

	const credentialsValid =
		form.host.trim() !== '' &&
		form.user.trim() !== '' &&
		form.port > 0 &&
		form.port <= 65535;

	const isValid = credentialsValid && form.database.trim() !== '';

	const handleDiscover = async () => {
		setDiscovering(true);
		setDiscoverError(null);
		setDatabases([]);
		setSchemas([]);
		setDiscovered(false);
		try {
			const result = await onDiscover({
				host: form.host,
				port: form.port,
				user: form.user,
				password: form.password,
				sslMode: form.sslMode,
			});
			setDatabases(result.databases);
			setDiscovered(true);
			// Auto-select first database if form.database is empty
			const first = result.databases[0];
			if (first != null && form.database.trim() === '') {
				update('database', first);
				// Auto-fetch schemas for the first database
				fetchSchemas(first);
			} else if (
				result.databases.length > 0 &&
				result.databases.includes(form.database)
			) {
				// Current database is in the list, fetch schemas for it
				fetchSchemas(form.database);
			}
		} catch (err) {
			setDiscoverError(err instanceof Error ? err.message : 'Discovery failed');
		} finally {
			setDiscovering(false);
		}
	};

	const fetchSchemas = async (database: string) => {
		setLoadingSchemas(true);
		setSchemas([]);
		try {
			const result = await onListSchemas({
				host: form.host,
				port: form.port,
				user: form.user,
				password: form.password,
				sslMode: form.sslMode,
				database,
			});
			setSchemas(result.schemas);
			// Auto-select 'public' if available
			if (result.schemas.includes('public')) {
				update('schema', 'public');
			} else {
				const firstSchema = result.schemas[0];
				if (firstSchema != null) {
					update('schema', firstSchema);
				}
			}
		} catch {
			// Schema fetch failed silently — user can still type manually
		} finally {
			setLoadingSchemas(false);
		}
	};

	const handleDatabaseChange = (database: string) => {
		update('database', database);
		if (discovered) {
			fetchSchemas(database);
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
		>
			<div
				className="w-[520px] rounded-lg border p-6 shadow-lg"
				style={{ backgroundColor: 'var(--background, #fff)' }}
			>
				<h2 className="mb-4 text-lg font-semibold">New Connection</h2>

				{/* ── Top panel: Credentials ──────────────────────── */}
				<div className="grid gap-3">
					{/* Name + Type */}
					<div className="grid grid-cols-2 gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor="conn-name">Name</Label>
							<Input
								id="conn-name"
								placeholder="My Database"
								value={form.name}
								onChange={(e) => update('name', e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="conn-type">Type</Label>
							<Select
								id="conn-type"
								value={form.type}
								onChange={(e) => {
									const t = e.target.value as DatabaseType;
									update('type', t);
									update('port', DEFAULT_PORTS[t] ?? 5432);
								}}
							>
								<option value="postgresql">PostgreSQL</option>
								<option value="mysql" disabled>
									MySQL (coming soon)
								</option>
								<option value="mssql" disabled>
									SQL Server (coming soon)
								</option>
								<option value="sqlite" disabled>
									SQLite (coming soon)
								</option>
							</Select>
						</div>
					</div>

					{/* Host + Port */}
					<div className="grid grid-cols-3 gap-2">
						<div className="col-span-2 grid gap-1.5">
							<Label htmlFor="conn-host">Host</Label>
							<Input
								id="conn-host"
								value={form.host}
								onChange={(e) => update('host', e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="conn-port">Port</Label>
							<Input
								id="conn-port"
								type="number"
								value={form.port}
								onChange={(e) =>
									update('port', Number.parseInt(e.target.value, 10) || 5432)
								}
							/>
						</div>
					</div>

					{/* User + Password */}
					<div className="grid grid-cols-2 gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor="conn-user">User</Label>
							<Input
								id="conn-user"
								value={form.user}
								onChange={(e) => update('user', e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="conn-pass">Password</Label>
							<Input
								id="conn-pass"
								type="password"
								value={form.password}
								onChange={(e) => update('password', e.target.value)}
							/>
						</div>
					</div>

					{/* SSL Mode */}
					<div className="grid grid-cols-2 gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor="conn-ssl">SSL Mode</Label>
							<Select
								id="conn-ssl"
								value={form.sslMode}
								onChange={(e) => update('sslMode', e.target.value as SslMode)}
							>
								<option value="disable">Disable</option>
								<option value="allow">Allow</option>
								<option value="prefer">Prefer</option>
								<option value="require">Require</option>
								<option value="verify-full">Verify Full</option>
							</Select>
						</div>
						<div className="flex items-end">
							<Button
								variant="outline"
								size="sm"
								className="w-full"
								onClick={handleDiscover}
								disabled={!credentialsValid || discovering}
							>
								{discovering ? (
									<>
										<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
										Discovering...
									</>
								) : (
									<>
										<Search className="mr-1.5 h-3.5 w-3.5" />
										Discover
									</>
								)}
							</Button>
						</div>
					</div>
				</div>

				{/* ── Separator ───────────────────────────────────── */}
				<div className="my-4 border-t" />

				{/* ── Bottom panel: Database + Schema selection ───── */}
				<div className="grid gap-3">
					<div className="grid grid-cols-2 gap-2">
						{/* Database */}
						<div className="grid gap-1.5">
							<Label htmlFor="conn-db">Database</Label>
							{discovered && databases.length > 0 ? (
								<Select
									id="conn-db"
									value={form.database}
									onChange={(e) => handleDatabaseChange(e.target.value)}
								>
									{databases.map((db) => (
										<option key={db} value={db}>
											{db}
										</option>
									))}
								</Select>
							) : (
								<Input
									id="conn-db"
									placeholder={
										discovered
											? 'No databases found'
											: 'Click Discover or type manually'
									}
									value={form.database}
									onChange={(e) => update('database', e.target.value)}
								/>
							)}
						</div>

						{/* Schema */}
						<div className="grid gap-1.5">
							<Label htmlFor="conn-schema">
								Schema
								{loadingSchemas && (
									<Loader2 className="ml-1 inline h-3 w-3 animate-spin" />
								)}
							</Label>
							{discovered && schemas.length > 0 ? (
								<Select
									id="conn-schema"
									value={form.schema}
									onChange={(e) => update('schema', e.target.value)}
								>
									{schemas.map((s) => (
										<option key={s} value={s}>
											{s}
										</option>
									))}
								</Select>
							) : (
								<Input
									id="conn-schema"
									value={form.schema}
									onChange={(e) => update('schema', e.target.value)}
								/>
							)}
						</div>
					</div>

					{/* Discover hint */}
					{!discovered && (
						<p className="text-xs text-muted-foreground">
							Fill credentials above and click <strong>Discover</strong> to list
							available databases and schemas, or type them manually.
						</p>
					)}
				</div>

				{/* ── Status messages ─────────────────────────────── */}
				{discoverError && (
					<div
						className="mt-3 rounded-md p-2 text-sm"
						style={{
							backgroundColor: 'rgba(220, 38, 38, 0.1)',
							color: '#dc2626',
						}}
					>
						{discoverError}
					</div>
				)}

				{testResult && (
					<div
						className="mt-3 rounded-md p-2 text-sm"
						style={{
							backgroundColor: testResult.ok
								? 'rgba(34, 197, 94, 0.1)'
								: 'rgba(220, 38, 38, 0.1)',
							color: testResult.ok ? '#16a34a' : '#dc2626',
						}}
					>
						{testResult.message}
					</div>
				)}

				{/* ── Actions ─────────────────────────────────────── */}
				<div className="mt-4 flex justify-between">
					<Button
						variant="outline"
						size="sm"
						onClick={() => onTest(form)}
						disabled={!isValid || testing || connecting}
					>
						{testing ? 'Testing...' : 'Test Connection'}
					</Button>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => onSave(form)}
							disabled={!isValid || form.name.trim() === ''}
						>
							Save
						</Button>
						<Button
							size="sm"
							onClick={() => onConnect(form)}
							disabled={!isValid || connecting}
						>
							{connecting ? 'Connecting...' : 'Connect'}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
