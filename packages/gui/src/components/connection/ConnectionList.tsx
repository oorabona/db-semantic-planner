import { Database, Plug, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConnectionProfile } from '@/stores/connection-store';

interface ConnectionListProps {
	profiles: readonly ConnectionProfile[];
	activeProfileId?: string;
	onSelect: (profile: ConnectionProfile) => void;
	onDelete: (id: string) => void;
}

export function ConnectionList({
	profiles,
	activeProfileId,
	onSelect,
	onDelete,
}: ConnectionListProps) {
	if (profiles.length === 0) {
		return (
			<div className="p-4 text-center text-sm text-muted-foreground">
				No saved connections.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 p-1">
			{profiles.map((profile) => (
				<div
					key={profile.id}
					role="option"
					tabIndex={0}
					aria-selected={profile.id === activeProfileId}
					className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer ${
						profile.id === activeProfileId
							? 'bg-accent text-accent-foreground'
							: ''
					}`}
					onClick={() => onSelect(profile)}
					onKeyDown={(e) => e.key === 'Enter' && onSelect(profile)}
				>
					<Database className="h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="flex-1 truncate">
						<div className="font-medium">{profile.name}</div>
						<div className="text-xs text-muted-foreground">
							{profile.user}@{profile.host}:{profile.port}/{profile.database}
						</div>
					</div>
					{profile.id === activeProfileId && (
						<Plug className="h-3 w-3 text-green-500" />
					)}
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 opacity-0 group-hover:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							onDelete(profile.id);
						}}
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>
			))}
		</div>
	);
}
