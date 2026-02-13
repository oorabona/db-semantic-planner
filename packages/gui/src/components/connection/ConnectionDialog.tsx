import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { SslMode } from "@/stores/connection-store";

export interface ConnectionFormData {
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	schema: string;
	sslMode: SslMode;
}

const DEFAULT_FORM: ConnectionFormData = {
	name: "",
	host: "localhost",
	port: 5432,
	database: "",
	user: "postgres",
	password: "",
	schema: "public",
	sslMode: "prefer",
};

interface ConnectionDialogProps {
	open: boolean;
	onClose: () => void;
	onConnect: (data: ConnectionFormData) => void;
	onTest: (data: ConnectionFormData) => void;
	onSave: (data: ConnectionFormData) => void;
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
	initial,
	testing = false,
	connecting = false,
	testResult = null,
}: ConnectionDialogProps) {
	const [form, setForm] = useState<ConnectionFormData>({
		...DEFAULT_FORM,
		...initial,
	});

	if (!open) return null;

	const update = <K extends keyof ConnectionFormData>(
		field: K,
		value: ConnectionFormData[K],
	) => setForm((prev) => ({ ...prev, [field]: value }));

	const isValid =
		form.host.trim() !== "" &&
		form.database.trim() !== "" &&
		form.user.trim() !== "" &&
		form.port > 0 &&
		form.port <= 65535;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div className="w-[480px] rounded-lg border bg-background p-6 shadow-lg">
				<h2 className="mb-4 text-lg font-semibold">New Connection</h2>

				<div className="grid gap-3">
					{/* Connection Name */}
					<div className="grid gap-1.5">
						<Label htmlFor="conn-name">Name</Label>
						<Input
							id="conn-name"
							placeholder="My Database"
							value={form.name}
							onChange={(e) => update("name", e.target.value)}
						/>
					</div>

					{/* Host + Port */}
					<div className="grid grid-cols-3 gap-2">
						<div className="col-span-2 grid gap-1.5">
							<Label htmlFor="conn-host">Host</Label>
							<Input
								id="conn-host"
								value={form.host}
								onChange={(e) => update("host", e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="conn-port">Port</Label>
							<Input
								id="conn-port"
								type="number"
								value={form.port}
								onChange={(e) =>
									update("port", Number.parseInt(e.target.value, 10) || 5432)
								}
							/>
						</div>
					</div>

					{/* Database */}
					<div className="grid gap-1.5">
						<Label htmlFor="conn-db">Database</Label>
						<Input
							id="conn-db"
							value={form.database}
							onChange={(e) => update("database", e.target.value)}
						/>
					</div>

					{/* User + Password */}
					<div className="grid grid-cols-2 gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor="conn-user">User</Label>
							<Input
								id="conn-user"
								value={form.user}
								onChange={(e) => update("user", e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="conn-pass">Password</Label>
							<Input
								id="conn-pass"
								type="password"
								value={form.password}
								onChange={(e) => update("password", e.target.value)}
							/>
						</div>
					</div>

					{/* Schema + SSL */}
					<div className="grid grid-cols-2 gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor="conn-schema">Schema</Label>
							<Input
								id="conn-schema"
								value={form.schema}
								onChange={(e) => update("schema", e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="conn-ssl">SSL Mode</Label>
							<Select
								id="conn-ssl"
								value={form.sslMode}
								onChange={(e) => update("sslMode", e.target.value as SslMode)}
							>
								<option value="disable">Disable</option>
								<option value="allow">Allow</option>
								<option value="prefer">Prefer</option>
								<option value="require">Require</option>
								<option value="verify-full">Verify Full</option>
							</Select>
						</div>
					</div>
				</div>

				{/* Test result */}
				{testResult && (
					<div
						className={`mt-3 rounded-md p-2 text-sm ${testResult.ok ? "bg-green-950 text-green-400" : "bg-red-950 text-red-400"}`}
					>
						{testResult.message}
					</div>
				)}

				{/* Actions */}
				<div className="mt-4 flex justify-between">
					<Button
						variant="outline"
						size="sm"
						onClick={() => onTest(form)}
						disabled={!isValid || testing || connecting}
					>
						{testing ? "Testing..." : "Test Connection"}
					</Button>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => onSave(form)}
							disabled={!isValid || form.name.trim() === ""}
						>
							Save
						</Button>
						<Button
							size="sm"
							onClick={() => onConnect(form)}
							disabled={!isValid || connecting}
						>
							{connecting ? "Connecting..." : "Connect"}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
