import { ChevronDown, Loader2, Play } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';
import type { TabLanguage } from '@/stores/editor-store';

interface EditorToolbarProps {
	onRun: () => void;
	onRunSelection?: () => void;
	running: boolean;
	language: TabLanguage;
}

export function EditorToolbar({
	onRun,
	onRunSelection,
	running,
	language,
}: EditorToolbarProps) {
	return (
		<div className="flex items-center gap-2 border-b px-2 py-1">
			{/* Split Run button */}
			<div className="flex items-center">
				<Button
					variant="ghost"
					size="sm"
					className="h-6 gap-1 rounded-r-none px-2 text-xs"
					onClick={onRun}
					disabled={running}
					title="Run query (Cmd/Ctrl+Enter)"
				>
					{running ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Play className="h-3.5 w-3.5" />
					)}
					Run
				</Button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 rounded-l-none border-l px-1 text-xs"
							disabled={running}
						>
							<ChevronDown className="h-3 w-3" />
						</Button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							className="z-50 min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
							sideOffset={4}
							align="start"
						>
							<DropdownMenu.Item
								className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent focus:bg-accent"
								onSelect={() => onRunSelection?.()}
							>
								<Play className="h-3.5 w-3.5" />
								Run Selection
								<span className="ml-auto text-[10px] text-muted-foreground">
									Shift+Ctrl+Enter
								</span>
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
			<span className="text-xs text-muted-foreground">
				{language === 'sql' ? 'SQL' : language === 'assert' ? 'Assert' : 'NQL'}{' '}
				· Cmd+Enter
			</span>
		</div>
	);
}
