import { ask } from '@tauri-apps/plugin-dialog';
import { Pencil, Plus, Star, StarOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
	ConnectionDialog,
	type ConnectionFormData,
} from '@/components/connection/ConnectionDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConnection } from '@/hooks/useConnection';
import { sidecarApi } from '@/lib/ipc';
import { writeSettings } from '@/lib/settings';
import type { ConnectionProfile } from '@/stores/connection-store';
import { pgConfig, useConnectionStore } from '@/stores/connection-store';
import { useProjectStore } from '@/stores/project-store';

/** Convert a ConnectionProfile into ConnectionDialog initial data */
function profileToFormData(profile: ConnectionProfile) {
	const cfg = pgConfig(profile);
	return {
		name: profile.name,
		type: profile.type,
		host: cfg.host,
		port: cfg.port,
		database: cfg.database,
		user: cfg.user,
		password: '',
		schema: cfg.schema,
		sslMode: cfg.sslMode,
	};
}

export function ProfileManager() {
	const profiles = useConnectionStore((s) => s.profiles);
	const active = useConnectionStore((s) => s.active);
	const { updateProfile } = useConnectionStore.getState();
	const mode = useProjectStore((s) => s.mode);
	const settings = useProjectStore((s) => s.settings);
	const folderPath = useProjectStore((s) => s.folderPath);
	const { disconnect, testConnection, testResult, saveProfile, deleteProfile } =
		useConnection();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingProfile, setEditingProfile] =
		useState<ConnectionProfile | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);

	const defaultName =
		mode === 'project' ? settings?.defaultConnection : undefined;

	// ── Handlers ──────────────────────────────────────────────

	const handleAdd = () => {
		setEditingProfile(null);
		setDialogOpen(true);
	};

	const handleEdit = (profile: ConnectionProfile) => {
		setEditingProfile(profile);
		setDialogOpen(true);
	};

	const handleDelete = async (profile: ConnectionProfile) => {
		if (deletingId) return; // ERR-06: double-click guard
		// SC-13: confirmation dialog before deletion
		const confirmed = await ask(
			`Delete profile "${profile.name}"? This cannot be undone.`,
			{ kind: 'warning', title: 'Delete Profile' },
		);
		if (!confirmed) return;
		setDeletingId(profile.id);
		try {
			// ERR-05: disconnect if active
			if (active?.profileId === profile.id) {
				await disconnect();
			}
			await deleteProfile(profile.id);

			// EFF-05: if deleted profile was default, clear defaultConnection
			if (
				mode === 'project' &&
				folderPath &&
				settings?.defaultConnection === profile.name
			) {
				const { defaultConnection: _, ...rest } = settings;
				await writeSettings(folderPath, rest);
				useProjectStore.setState({ settings: rest });
			}
		} finally {
			setDeletingId(null);
		}
	};

	const handleSetDefault = async (profile: ConnectionProfile) => {
		if (mode !== 'project' || !folderPath) return;
		const updated = {
			...(settings ?? { version: 1 as const }),
			defaultConnection: profile.name,
		};
		await writeSettings(folderPath, updated);
		useProjectStore.setState({ settings: updated }); // EFF-06
	};

	const handleClearDefault = async () => {
		if (mode !== 'project' || !folderPath || !settings) return;
		const { defaultConnection: _, ...rest } = settings;
		await writeSettings(folderPath, rest);
		useProjectStore.setState({ settings: rest }); // EFF-06
	};

	const handleSave = async (data: ConnectionFormData) => {
		// INV-05: profile names must be unique
		const duplicate = profiles.find(
			(p) => p.name === data.name && p.id !== (editingProfile?.id ?? ''),
		);
		if (duplicate) {
			toast.error(`A profile named "${data.name}" already exists`);
			return;
		}
		if (editingProfile) {
			const oldName = editingProfile.name;
			const newName = data.name;

			updateProfile(editingProfile.id, {
				name: newName,
				type: data.type,
				config: {
					host: data.host,
					port: data.port,
					database: data.database,
					user: data.user,
					schema: data.schema,
					sslMode: data.sslMode,
				},
			});

			// EFF-05: rename default if profile was default
			if (
				mode === 'project' &&
				folderPath &&
				settings?.defaultConnection === oldName &&
				oldName !== newName
			) {
				const updated = { ...settings, defaultConnection: newName };
				await writeSettings(folderPath, updated);
				useProjectStore.setState({ settings: updated });
			}
		} else {
			saveProfile({
				id: crypto.randomUUID(),
				name: data.name,
				type: data.type,
				config: {
					host: data.host,
					port: data.port,
					database: data.database,
					user: data.user,
					schema: data.schema,
					sslMode: data.sslMode,
				},
				environment: null,
				createdAt: Date.now(),
				lastUsedAt: null,
			});
		}
		setDialogOpen(false);
		setEditingProfile(null);
	};

	const handleTest = async (data: ConnectionFormData) => {
		setTesting(true);
		try {
			await testConnection(data);
		} finally {
			setTesting(false);
		}
	};

	// ── Render ────────────────────────────────────────────────

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium">Connection Profiles</h3>
				<Button variant="outline" size="sm" onClick={handleAdd}>
					<Plus className="h-3.5 w-3.5 mr-1" />
					Add Profile
				</Button>
			</div>

			{profiles.length === 0 ? (
				<p className="text-xs text-muted-foreground py-4 text-center">
					No connection profiles yet. Click "Add Profile" to create one.
				</p>
			) : (
				<div className="space-y-1">
					{profiles.map((profile) => {
						const cfg = pgConfig(profile);
						const isActive = active?.profileId === profile.id;
						const isDefault = profile.name === defaultName;
						const isDeleting = deletingId === profile.id;

						return (
							<div
								key={profile.id}
								className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
							>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-1.5">
										<span className="font-medium truncate">{profile.name}</span>
										{isDefault && (
											<Star className="h-3 w-3 text-amber-500 shrink-0 fill-amber-500" />
										)}
										{isActive && (
											<Badge
												variant="outline"
												className="text-[10px] px-1 py-0 text-green-600"
											>
												connected
											</Badge>
										)}
										{profile.environment && (
											<Badge
												variant="outline"
												className="text-[10px] px-1 py-0"
											>
												{profile.environment}
											</Badge>
										)}
									</div>
									<div className="text-xs text-muted-foreground">
										{cfg.host}:{cfg.port}/{cfg.database} &middot; {cfg.user}
									</div>
								</div>

								<div className="flex items-center gap-1 shrink-0">
									{mode === 'project' &&
										(isDefault ? (
											<Button
												variant="ghost"
												size="sm"
												className="h-7 w-7 p-0"
												title="Clear default"
												onClick={handleClearDefault}
											>
												<StarOff className="h-3.5 w-3.5" />
											</Button>
										) : (
											<Button
												variant="ghost"
												size="sm"
												className="h-7 w-7 p-0"
												title="Set as default"
												onClick={() => handleSetDefault(profile)}
											>
												<Star className="h-3.5 w-3.5" />
											</Button>
										))}
									<Button
										variant="ghost"
										size="sm"
										className="h-7 w-7 p-0"
										title="Edit profile"
										onClick={() => handleEdit(profile)}
									>
										<Pencil className="h-3.5 w-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 w-7 p-0 text-destructive hover:text-destructive"
										title="Delete profile"
										disabled={isDeleting}
										onClick={() => handleDelete(profile)}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			)}

			<ConnectionDialog
				open={dialogOpen}
				onClose={() => {
					setDialogOpen(false);
					setEditingProfile(null);
				}}
				onConnect={() => {}} // Not used in profile manager context
				onTest={handleTest}
				onSave={handleSave}
				onDiscover={(params) =>
					sidecarApi.listDatabases(params).catch(() => ({ databases: [] }))
				}
				onListSchemas={(params) =>
					sidecarApi.listSchemas(params).catch(() => ({ schemas: [] }))
				}
				initial={editingProfile ? profileToFormData(editingProfile) : undefined}
				testing={testing}
				testResult={testResult}
			/>
		</div>
	);
}
