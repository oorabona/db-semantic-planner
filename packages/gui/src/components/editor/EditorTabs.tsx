import { AlertTriangle, Code, Database, FileText, Plus, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { closeTabWithConfirm } from '@/lib/file-io';
import { type EditorTab, useEditorStore } from '@/stores/editor-store';

export function EditorTabs() {
	const tabs = useEditorStore((s) => s.tabs);
	const activeTabId = useEditorStore((s) => s.activeTabId);
	const setActiveTab = useEditorStore((s) => s.setActiveTab);
	const addTab = useEditorStore((s) => s.addTab);

	const handleCloseTab = useCallback((tab: EditorTab) => {
		closeTabWithConfirm(tab, useEditorStore.getState());
	}, []);

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
						onClose={() => handleCloseTab(tab)}
					/>
				))}
			</div>

			{/* Unified add-tab dropdown */}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="shrink-0 px-2 py-1.5 text-muted-foreground hover:text-foreground"
						title="New tab"
					>
						<Plus className="h-3.5 w-3.5" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						className="z-50 min-w-[140px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
						sideOffset={4}
						align="end"
					>
						<DropdownMenu.Item
							className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent focus:bg-accent"
							onSelect={() => addTab('sql')}
						>
							<Database className="h-3.5 w-3.5" />
							New SQL file
						</DropdownMenu.Item>
						<DropdownMenu.Item
							className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent focus:bg-accent"
							onSelect={() => addTab('nql')}
						>
							<FileText className="h-3.5 w-3.5" />
							New NQL file
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
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
	const renameTab = useEditorStore((s) => s.renameTab);
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	const startEditing = useCallback(() => {
		setEditValue(tab.title);
		setEditing(true);
	}, [tab.title]);

	useEffect(() => {
		if (editing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editing]);

	const commitRename = useCallback(() => {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== tab.title) {
			renameTab(tab.id, trimmed);
		}
		setEditing(false);
	}, [editValue, tab.id, tab.title, renameTab]);

	const cancelRename = useCallback(() => {
		setEditing(false);
	}, []);

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
			onDoubleClick={(e) => {
				e.stopPropagation();
				startEditing();
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') onSelect();
			}}
		>
			<Icon className="h-3 w-3 shrink-0" />
			{tab.outOfRoot && (
				<AlertTriangle
					className="h-3 w-3 shrink-0 text-yellow-500"
					data-testid="out-of-root-warning"
					aria-label="File is outside project roots"
				/>
			)}
			{editing ? (
				<input
					ref={inputRef}
					value={editValue}
					onChange={(e) => setEditValue(e.target.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							commitRename();
						} else if (e.key === 'Escape') {
							cancelRename();
						}
						e.stopPropagation();
					}}
					onClick={(e) => e.stopPropagation()}
					className="max-w-[120px] bg-transparent text-xs outline-none border-b border-primary"
				/>
			) : (
				<span className="max-w-[120px] truncate">
					{tab.dirty ? `${tab.title} *` : tab.title}
				</span>
			)}
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
