/**
 * Step 4 — Options: schema.ts generation and final review.
 */

interface WizardOptionsStepProps {
	name: string;
	folderPath: string;
	connectionCount: number;
	generateSchema: boolean;
	onGenerateSchemaChange: (value: boolean) => void;
}

export function WizardOptionsStep({
	name,
	folderPath,
	connectionCount,
	generateSchema,
	onGenerateSchemaChange,
}: WizardOptionsStepProps) {
	const canGenerate = connectionCount > 0;

	return (
		<div className="space-y-4">
			<h3 className="text-lg font-semibold">Options</h3>
			<p className="text-muted-foreground text-sm">
				Review your project settings and configure optional features.
			</p>

			{/* Summary */}
			<div className="space-y-2 rounded-md border p-3 pt-2">
				<h4 className="text-sm font-medium">Summary</h4>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt className="text-muted-foreground">Name:</dt>
					<dd className="font-medium" data-testid="summary-name">
						{name}
					</dd>
					<dt className="text-muted-foreground">Folder:</dt>
					<dd
						className="truncate font-mono"
						title={folderPath}
						data-testid="summary-folder"
					>
						{folderPath}
					</dd>
					<dt className="text-muted-foreground">Connections:</dt>
					<dd data-testid="summary-connections">{connectionCount}</dd>
				</dl>
			</div>

			{/* Schema generation option */}
			<div className="space-y-2 pt-2">
				<label
					className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
						!canGenerate ? 'cursor-not-allowed opacity-50' : ''
					}`}
				>
					<input
						type="checkbox"
						checked={generateSchema && canGenerate}
						onChange={(e) => onGenerateSchemaChange(e.target.checked)}
						disabled={!canGenerate}
						className="mt-0.5"
						data-testid="generate-schema-checkbox"
					/>
					<div>
						<p className="text-sm font-medium">Generate schema.ts</p>
						<p className="text-muted-foreground text-xs">
							Introspect the first connection's database to generate a typed
							schema file. Credentials will not be stored in the generated file.
						</p>
						{!canGenerate && (
							<p className="mt-1 text-xs text-yellow-500">
								Requires at least one connection.
							</p>
						)}
					</div>
				</label>
			</div>

			{/* Settings file info */}
			<div className="text-muted-foreground rounded-md border p-3 text-xs">
				<p>
					A <code>dbsp.settings.json</code> will be created in{' '}
					<code>{folderPath}</code>.{' '}
					{generateSchema && canGenerate
						? 'A schema.ts will also be generated.'
						: ''}
				</p>
			</div>
		</div>
	);
}
