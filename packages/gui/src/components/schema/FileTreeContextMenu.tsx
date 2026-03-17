import { FileX, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// ── Types ────────────────────────────────────────────────────────

interface ContextMenuAction {
	readonly label: string;
	readonly icon: typeof FileX;
	readonly danger?: boolean;
	readonly onClick: () => void;
}

interface FileTreeContextMenuProps {
	readonly position: { readonly x: number; readonly y: number };
	readonly actions: readonly ContextMenuAction[];
	readonly onClose: () => void;
}

// ── Action factories ─────────────────────────────────────────────

export function fileActions(
	path: string,
	handlers: {
		onRenameFile?: (path: string) => void;
		onRemoveFile?: (path: string) => void;
		onDeleteFile?: (path: string) => void;
	},
): ContextMenuAction[] {
	const actions: ContextMenuAction[] = [];
	if (handlers.onRenameFile) {
		const onRenameFile = handlers.onRenameFile;
		actions.push({
			label: 'Rename',
			icon: Pencil,
			onClick: () => onRenameFile(path),
		});
	}
	if (handlers.onRemoveFile) {
		const onRemoveFile = handlers.onRemoveFile;
		actions.push({
			label: 'Remove from project',
			icon: FileX,
			onClick: () => onRemoveFile(path),
		});
	}
	if (handlers.onDeleteFile) {
		const onDeleteFile = handlers.onDeleteFile;
		actions.push({
			label: 'Delete from disk',
			icon: Trash2,
			danger: true,
			onClick: () => onDeleteFile(path),
		});
	}
	return actions;
}

// ── Component ────────────────────────────────────────────────────

export function FileTreeContextMenu({
	position,
	actions,
	onClose,
}: FileTreeContextMenuProps) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		}
		function handleEscape(e: KeyboardEvent) {
			if (e.key === 'Escape') onClose();
		}
		document.addEventListener('mousedown', handleClick);
		document.addEventListener('keydown', handleEscape);
		return () => {
			document.removeEventListener('mousedown', handleClick);
			document.removeEventListener('keydown', handleEscape);
		};
	}, [onClose]);

	if (actions.length === 0) return null;

	return createPortal(
		<div
			ref={ref}
			className="fixed z-50 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--popover)] p-1 shadow-md"
			style={{ top: position.y, left: position.x }}
			role="menu"
		>
			{actions.map((action) => {
				const Icon = action.icon;
				return (
					<button
						key={action.label}
						type="button"
						role="menuitem"
						className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-[var(--accent)] ${
							action.danger ? 'text-red-500' : ''
						}`}
						onClick={() => {
							action.onClick();
							onClose();
						}}
					>
						<Icon className="h-4 w-4" />
						{action.label}
					</button>
				);
			})}
		</div>,
		document.body,
	);
}
