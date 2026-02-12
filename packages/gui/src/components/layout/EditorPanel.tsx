import { Code } from "lucide-react";

export function EditorPanel() {
	return (
		<div className="flex h-full flex-col bg-[var(--background)]">
			{/* Tab bar placeholder */}
			<div className="flex items-center gap-1 border-b border-[var(--border)] px-2">
				<div className="flex items-center gap-1.5 border-b-2 border-[var(--primary)] px-3 py-1.5">
					<Code className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
					<span className="text-xs font-medium">Untitled.sql</span>
				</div>
			</div>

			{/* Editor placeholder */}
			<div className="flex flex-1 items-center justify-center">
				<p className="text-sm text-[var(--muted-foreground)]">
					Editor will appear here
				</p>
			</div>
		</div>
	);
}
