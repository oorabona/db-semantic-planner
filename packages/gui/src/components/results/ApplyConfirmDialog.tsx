/**
 * Apply confirmation dialog with SQL preview and destructive warning.
 */

import { AlertTriangle } from 'lucide-react';

interface ApplyConfirmDialogProps {
	open: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	statements: readonly string[];
	hasDestructive: boolean;
	applying: boolean;
}

export function ApplyConfirmDialog({
	open,
	onConfirm,
	onCancel,
	statements,
	hasDestructive,
	applying,
}: ApplyConfirmDialogProps) {
	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			data-testid="apply-confirm-dialog"
		>
			<div className="mx-4 max-h-[80vh] w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-xl">
				{/* Header */}
				<div className="border-b border-border px-4 py-3">
					<h3 className="text-sm font-semibold">Apply Schema Changes</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						{statements.length} statement
						{statements.length !== 1 ? 's' : ''} will be executed
					</p>
				</div>

				{/* Destructive changes are displayed but intentionally excluded. */}
				{hasDestructive && (
					<div
						className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30"
						data-testid="destructive-warning"
					>
						<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
						<p className="text-xs text-red-700 dark:text-red-300">
							Destructive changes in this diff are excluded from this Apply.
						</p>
					</div>
				)}

				{/* SQL preview */}
				<div className="mx-4 mt-3 max-h-48 overflow-auto rounded border border-border bg-muted/20 p-2">
					<pre
						className="whitespace-pre-wrap font-mono text-xs leading-relaxed"
						data-testid="apply-sql-preview"
					>
						{statements.join('\n\n')}
					</pre>
				</div>

				{/* Actions */}
				<div className="mt-3 flex justify-end gap-2 border-t border-border px-4 py-3">
					<button
						type="button"
						className="rounded px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
						onClick={onCancel}
						disabled={applying}
						data-testid="apply-cancel-btn"
					>
						Cancel
					</button>
					<button
						type="button"
						className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
						onClick={onConfirm}
						disabled={applying}
						data-testid="apply-confirm-btn"
					>
						{applying ? 'Applying...' : 'Apply'}
					</button>
				</div>
			</div>
		</div>
	);
}
