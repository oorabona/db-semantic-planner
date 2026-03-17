import { Check, Database, FileCode, FolderOpen, Settings } from 'lucide-react';
import type { SchemaSelection } from './wizard-types';

// ── Props ────────────────────────────────────────────────────────

interface WizardReviewStepProps {
	readonly name: string;
	readonly folderPath: string;
	readonly connectionCount: number;
	readonly files: readonly string[];
	readonly schemaSelection: SchemaSelection;
	readonly generateSchema: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function schemaLabel(selection: SchemaSelection): string {
	if (selection === 'generate') return 'Generate from DB';
	if (selection === 'skip') return 'Skip (configure later)';
	return `Auto-detect (${selection})`;
}

// ── Component ────────────────────────────────────────────────────

export function WizardReviewStep({
	name,
	folderPath,
	connectionCount,
	files,
	schemaSelection,
	generateSchema,
}: WizardReviewStepProps) {
	return (
		<div className="space-y-5" data-testid="wizard-review">
			<div>
				<h3 className="text-base font-medium">Review</h3>
				<p className="mt-1 text-sm text-muted-foreground">
					Confirm your project settings before creating.
				</p>
			</div>

			<div className="space-y-3 rounded-md border p-4">
				{/* Name */}
				<div className="flex items-start gap-3">
					<Settings className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div>
						<div className="text-sm font-medium">Project name</div>
						<div
							className="text-sm text-muted-foreground"
							data-testid="review-name"
						>
							{name}
						</div>
					</div>
				</div>

				{/* Folder */}
				<div className="flex items-start gap-3">
					<FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div>
						<div className="text-sm font-medium">Location</div>
						<div
							className="truncate text-sm text-muted-foreground"
							data-testid="review-folder"
						>
							{folderPath}
						</div>
					</div>
				</div>

				{/* Connections */}
				<div className="flex items-start gap-3">
					<Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div>
						<div className="text-sm font-medium">Connections</div>
						<div
							className="text-sm text-muted-foreground"
							data-testid="review-connections"
						>
							{connectionCount === 0
								? 'None configured'
								: `${connectionCount} connection${connectionCount > 1 ? 's' : ''}`}
						</div>
					</div>
				</div>

				{/* Files */}
				<div className="flex items-start gap-3">
					<FileCode className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div>
						<div className="text-sm font-medium">Project files</div>
						<div className="text-sm text-muted-foreground">
							{files.length === 0
								? 'No files selected'
								: `${files.length} file${files.length > 1 ? 's' : ''}`}
						</div>
					</div>
				</div>

				{/* Schema */}
				<div className="flex items-start gap-3">
					<Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div>
						<div className="text-sm font-medium">Schema</div>
						<div className="text-sm text-muted-foreground">
							{schemaLabel(schemaSelection)}
						</div>
					</div>
				</div>

				{/* Generate schema.ts */}
				{generateSchema && (
					<div className="flex items-start gap-3">
						<Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
						<div className="text-sm text-muted-foreground">
							Will generate schema.ts on creation
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
