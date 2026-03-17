import { LogOut, Plus } from 'lucide-react';
import { useState } from 'react';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@/components/ui/popover';
import { useConnectFlow } from '@/hooks/useConnectFlow';
import { useConnection } from '@/hooks/useConnection';
import { sortProfiles } from '@/lib/connect-utils';
import type { ConnectionProfile } from '@/stores/connection-store';
import { pgConfig, useConnectionStore } from '@/stores/connection-store';
import { useProjectStore } from '@/stores/project-store';
import { ConnectionStatus } from './ConnectionStatus';
import { PasswordPrompt } from './PasswordPrompt';
import { ProfileListItem } from './ProfileListItem';

export interface ConnectionQuickPickProps {
	readonly onNewConnection: () => void;
}

export function ConnectionQuickPick({
	onNewConnection,
}: ConnectionQuickPickProps) {
	const [open, setOpen] = useState(false);

	// Connection state
	const profiles = useConnectionStore((s) => s.profiles);
	const active = useConnectionStore((s) => s.active);
	const status = useConnectionStore((s) => s.status);
	const error = useConnectionStore((s) => s.error);

	// Project state for default profile
	const mode = useProjectStore((s) => s.mode);
	const settings = useProjectStore((s) => s.settings);
	const defaultName =
		mode === 'project' ? settings?.defaultConnection : undefined;

	// Hooks
	const { disconnect } = useConnection();
	const {
		quickConnect,
		submitPassword,
		cancelPassword,
		promptOpen,
		promptProfile,
		promptError,
		connecting,
	} = useConnectFlow();

	// Derive display info from active profile
	const activeProfile = profiles.find((p) => p.id === active?.profileId);
	const cfg = activeProfile ? pgConfig(activeProfile) : null;

	const sorted = sortProfiles(profiles, defaultName);

	const handleSelect = (profile: ConnectionProfile) => {
		setOpen(false);
		quickConnect(profile);
	};

	const handleDisconnect = () => {
		setOpen(false);
		disconnect();
	};

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="flex items-center rounded px-1 -mx-1 hover:bg-[var(--accent)]/50"
					>
						<ConnectionStatus
							status={status}
							database={cfg?.database}
							schema={cfg?.schema}
							host={cfg?.host}
							error={error}
						/>
					</button>
				</PopoverTrigger>
				<PopoverContent align="start" side="top" className="w-64 p-0">
					{sorted.length === 0 ? (
						<div className="px-3 py-3 text-xs text-muted-foreground text-center">
							No profiles
						</div>
					) : (
						<div className="py-1">
							{sorted.map((profile) => (
								<ProfileListItem
									key={profile.id}
									profile={profile}
									isActive={active?.profileId === profile.id}
									isDefault={profile.name === defaultName}
									onClick={() => handleSelect(profile)}
								/>
							))}
						</div>
					)}

					{status === 'connected' && (
						<div className="border-t">
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-[var(--accent)]"
								onClick={handleDisconnect}
							>
								<LogOut className="h-3.5 w-3.5" />
								Disconnect
							</button>
						</div>
					)}

					<div className="border-t">
						<button
							type="button"
							className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--accent)]"
							onClick={() => {
								setOpen(false);
								onNewConnection();
							}}
						>
							<Plus className="h-3.5 w-3.5" />
							New Connection...
						</button>
					</div>
				</PopoverContent>
			</Popover>

			<PasswordPrompt
				open={promptOpen}
				profileName={promptProfile?.name ?? ''}
				onSubmit={submitPassword}
				onCancel={cancelPassword}
				error={promptError}
				connecting={connecting}
			/>
		</>
	);
}
