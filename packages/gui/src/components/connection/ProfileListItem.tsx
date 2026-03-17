import { Check, PlugZap, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ConnectionProfile } from '@/stores/connection-store';
import { pgConfig } from '@/stores/connection-store';

export interface ProfileListItemProps {
	readonly profile: ConnectionProfile;
	readonly isActive?: boolean;
	readonly isDefault?: boolean;
	readonly compact?: boolean;
	readonly onClick?: () => void;
}

export function ProfileListItem({
	profile,
	isActive,
	isDefault,
	compact,
	onClick,
}: ProfileListItemProps) {
	const config = pgConfig(profile);
	const hostPort = `${config.host}:${config.port}`;

	return (
		<button
			type="button"
			className={cn(
				'flex items-center gap-2 w-full px-2 py-1.5 text-left text-sm rounded-md transition-colors',
				'hover:bg-accent hover:text-accent-foreground',
				isActive && 'bg-accent/50',
			)}
			onClick={onClick}
		>
			{isActive ? (
				<Check className="h-4 w-4 text-green-500 shrink-0" />
			) : (
				<PlugZap className="h-4 w-4 text-muted-foreground shrink-0" />
			)}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5">
					<span className="font-medium truncate">{profile.name}</span>
					{isDefault && <Star className="h-3 w-3 text-amber-500 shrink-0" />}
					{profile.environment && (
						<Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
							{profile.environment}
						</Badge>
					)}
				</div>
				{!compact && (
					<div className="text-xs text-muted-foreground truncate">
						{hostPort}/{config.database}
					</div>
				)}
			</div>
		</button>
	);
}
