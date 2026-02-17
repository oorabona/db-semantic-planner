/**
 * Step 1 — Introduction: brief explanation of project mode.
 */
export function WizardIntroStep() {
	return (
		<div className="space-y-4">
			<h3 className="text-lg font-semibold">Welcome to Project Mode</h3>
			<p className="text-muted-foreground text-sm">
				A project groups your database connections, query history, and
				configuration in one place. Everything is scoped to this project — your
				history and logs stay organised.
			</p>

			<div className="space-y-3 pt-2">
				<Feature
					title="Persistent connections"
					description="Save and manage multiple database connections with environment labels (dev, staging, prod)."
				/>
				<Feature
					title="Scoped history"
					description="Query history and IPC logs are stored per project — no more mixing data from different databases."
				/>
				<Feature
					title="Schema file support"
					description="Load a schema.ts file for type-aware NQL features and schema diffing."
				/>
				<Feature
					title="Settings file"
					description="A dbsp.settings.json is created in your folder so the project is recognised on future opens."
				/>
			</div>

			<p className="text-muted-foreground pt-2 text-xs">
				Click <strong>Next</strong> to get started.
			</p>
		</div>
	);
}

function Feature({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="rounded-md border p-3">
			<p className="text-sm font-medium">{title}</p>
			<p className="text-muted-foreground text-xs">{description}</p>
		</div>
	);
}
