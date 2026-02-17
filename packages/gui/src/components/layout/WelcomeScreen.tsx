import { Database, FileCode2, FolderOpen, Plus, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnectionStore } from '@/stores/connection-store';
import { useEditorStore } from '@/stores/editor-store';

const SAMPLE_QUERIES = [
	{
		label: 'Select all users',
		language: 'sql' as const,
		code: 'SELECT * FROM users LIMIT 100;',
	},
	{
		label: 'NQL pipe query',
		language: 'nql' as const,
		code: 'from users | where active = true | select name, email | limit 10',
	},
	{
		label: 'Join with filtering',
		language: 'sql' as const,
		code: `SELECT u.name, o.total
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE o.total > 100
ORDER BY o.total DESC;`,
	},
];

interface WelcomeScreenProps {
	onConnect: () => void;
	onNewProject?: () => void;
	onOpenProject?: () => void;
}

export function WelcomeScreen({
	onConnect,
	onNewProject,
	onOpenProject,
}: WelcomeScreenProps) {
	const status = useConnectionStore((s) => s.status);
	const addTab = useEditorStore((s) => s.addTab);

	return (
		<div className="flex h-full items-center justify-center bg-background p-8">
			<div className="flex max-w-md flex-col items-center gap-6 text-center">
				{/* Logo / Title */}
				<div className="flex flex-col items-center gap-2">
					<Database className="h-12 w-12 text-muted-foreground/50" />
					<h1 className="text-2xl font-semibold text-foreground">
						db-semantic-planner
					</h1>
					<p className="text-sm text-muted-foreground">
						Intent-first database query explorer
					</p>
				</div>

				{/* Actions */}
				<div className="flex gap-3">
					{status !== 'connected' && (
						<Button onClick={onConnect} variant="default">
							<Database className="mr-2 h-4 w-4" />
							Connect to Database
						</Button>
					)}
					<Button
						onClick={() => addTab('sql')}
						variant={status === 'connected' ? 'default' : 'outline'}
					>
						<Plus className="mr-2 h-4 w-4" />
						New SQL Query
					</Button>
					<Button onClick={() => addTab('nql')} variant="outline">
						<Terminal className="mr-2 h-4 w-4" />
						New NQL Query
					</Button>
				</div>

				{/* Project actions */}
				{(onNewProject || onOpenProject) && (
					<div className="flex gap-3">
						{onNewProject && (
							<Button
								onClick={onNewProject}
								variant="outline"
								data-testid="welcome-new-project"
							>
								<Plus className="mr-2 h-4 w-4" />
								New Project
							</Button>
						)}
						{onOpenProject && (
							<Button
								onClick={onOpenProject}
								variant="outline"
								data-testid="welcome-open-project"
							>
								<FolderOpen className="mr-2 h-4 w-4" />
								Open Project
							</Button>
						)}
					</div>
				)}

				{/* Sample queries */}
				<div className="w-full pt-4">
					<p className="mb-3 text-xs font-medium text-muted-foreground uppercase">
						Quick Start
					</p>
					<div className="flex flex-col gap-2">
						{SAMPLE_QUERIES.map((sample) => (
							<button
								key={sample.label}
								type="button"
								className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-accent"
								onClick={() => addTab(sample.language, sample.code)}
							>
								<FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0">
									<div className="text-sm font-medium text-foreground">
										{sample.label}
									</div>
									<pre className="mt-1 truncate text-xs text-muted-foreground">
										{sample.code.split('\n')[0]}
									</pre>
								</div>
							</button>
						))}
					</div>
				</div>

				{/* Keyboard shortcut hint */}
				<p className="text-xs text-muted-foreground">
					<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
						⌘K
					</kbd>{' '}
					Command Palette &middot;{' '}
					<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
						⌘O
					</kbd>{' '}
					Open File
				</p>
			</div>
		</div>
	);
}
