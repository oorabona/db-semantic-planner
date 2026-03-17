import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnectFlow } from '@/hooks/useConnectFlow';
import { sortProfiles } from '@/lib/connect-utils';
import { useConnectionStore } from '@/stores/connection-store';
import { useProjectStore } from '@/stores/project-store';
import { PasswordPrompt } from './PasswordPrompt';
import { ProfileListItem } from './ProfileListItem';

export { sortProfiles } from '@/lib/connect-utils';

export interface SidebarConnectionPanelProps {
	readonly onNewConnection: () => void;
}

export function SidebarConnectionPanel({
	onNewConnection,
}: SidebarConnectionPanelProps) {
	const profiles = useConnectionStore((s) => s.profiles);
	const active = useConnectionStore((s) => s.active);
	const mode = useProjectStore((s) => s.mode);
	const settings = useProjectStore((s) => s.settings);
	const defaultName =
		mode === 'project' ? settings?.defaultConnection : undefined;

	const {
		quickConnect,
		submitPassword,
		cancelPassword,
		promptOpen,
		promptProfile,
		promptError,
		connecting,
	} = useConnectFlow();

	const sorted = sortProfiles(profiles, defaultName);

	return (
		<div className="flex flex-col">
			{sorted.length === 0 ? (
				<div className="px-2 py-3 text-center">
					<p className="text-xs text-muted-foreground mb-2">No connections</p>
					<Button
						variant="outline"
						size="sm"
						className="w-full"
						onClick={onNewConnection}
					>
						<Plus className="h-3.5 w-3.5 mr-1" />
						New Connection...
					</Button>
				</div>
			) : (
				<>
					<div className="px-1 py-1">
						{sorted.map((profile) => (
							<ProfileListItem
								key={profile.id}
								profile={profile}
								isActive={active?.profileId === profile.id}
								isDefault={profile.name === defaultName}
								onClick={() => quickConnect(profile)}
							/>
						))}
					</div>
					<div className="border-t px-2 py-1.5">
						<Button
							variant="ghost"
							size="sm"
							className="w-full justify-start text-xs"
							onClick={onNewConnection}
						>
							<Plus className="h-3.5 w-3.5 mr-1" />
							New Connection...
						</Button>
					</div>
				</>
			)}
			<PasswordPrompt
				open={promptOpen}
				profileName={promptProfile?.name ?? ''}
				onSubmit={submitPassword}
				onCancel={cancelPassword}
				error={promptError}
				connecting={connecting}
			/>
		</div>
	);
}
