import { Code, FileText, Plus, X } from 'lucide-react';
import { type EditorTab, useEditorStore } from '@/stores/editor-store';

export function EditorTabs() {
	const tabs = useEditorStore((s) => s.tabs);
	const activeTabId = useEditorStore((s) => s.activeTabId);
	const setActiveTab = useEditorStore((s) => s.setActiveTab);
	const closeTab = useEditorStore((s) => s.closeTab);
	const addTab = useEditorStore((s) => s.addTab);

	return (
		<div className="flex items-center border-b bg-muted/30">
			{/* Tab list */}
			<div className="flex flex-1 items-center gap-0 overflow-x-auto">
				{tabs.map((tab) => (
					<TabItem
						key={tab.id}
						tab={tab}
						active={tab.id === activeTabId}
						onSelect={() => setActiveTab(tab.id)}
						onClose={() => closeTab(tab.id)}
					/>
				))}
			</div>

			{/* Add tab buttons */}
			<button
				type="button"
				className="shrink-0 px-2 py-1.5 text-muted-foreground hover:text-foreground"
				onClick={() => addTab('sql')}
				title="New SQL tab"
			>
				<Plus className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				className="shrink-0 px-1 py-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
				onClick={() => addTab('nql')}
				title="New NQL tab (.dbsp)"
			>
				<FileText className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

function TabItem({
	tab,
	active,
	onSelect,
	onClose,
}: {
	tab: EditorTab;
	active: boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	const Icon = tab.language === 'sql' ? Code : FileText;

	return (
		<div
			role="tab"
			tabIndex={0}
			aria-selected={active}
			className={`group flex cursor-pointer items-center gap-1.5 border-r px-3 py-1.5 text-xs ${
				active
					? 'border-b-2 border-b-primary bg-background'
					: 'text-muted-foreground hover:bg-accent/50'
			}`}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') onSelect();
			}}
		>
			<Icon className="h-3 w-3 shrink-0" />
			<span className="max-w-[120px] truncate">
				{tab.dirty ? `${tab.title} *` : tab.title}
			</span>
			<button
				type="button"
				className="ml-1 shrink-0 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				title="Close tab"
			>
				<X className="h-3 w-3" />
			</button>
		</div>
	);
}
