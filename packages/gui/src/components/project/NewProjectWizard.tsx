/**
 * New Project Wizard — 6-step sidebar dialog.
 *
 * Steps: Introduction → Name & Location → Connections → Files & Schema → Options → Review
 *
 * On completion: creates dbsp.settings.json, saves connections to project DB,
 * optionally generates schema.ts via sidecar introspection, and opens the project.
 */
import { Check } from 'lucide-react';

import type { ConnectionFormData } from '@/components/connection/ConnectionDialog';
import { Button } from '@/components/ui/button';
import type { SslMode } from '@/stores/connection-store';
import { useWizardState } from './useWizardState';
import { WizardConnectionsStep } from './WizardConnectionsStep';
import { WizardFilesStep } from './WizardFilesStep';
import { WizardIntroStep } from './WizardIntroStep';
import { WizardNameStep } from './WizardNameStep';
import { WizardOptionsStep } from './WizardOptionsStep';
import { WizardReviewStep } from './WizardReviewStep';
import type { WizardData, WizardStep } from './wizard-types';
import { WIZARD_STEPS } from './wizard-types';

// ── Props ────────────────────────────────────────────────────────

interface NewProjectWizardProps {
	open: boolean;
	onClose: () => void;
	/** Called when the wizard completes — parent handles project creation. */
	onCreate: (data: WizardData) => void;
	/** Pre-populated connection for "Convert to Project" flow. */
	initialConnection?: ConnectionFormData;
	/** Callbacks for ConnectionDialog in step 3. */
	onDiscover: (params: {
		host: string;
		port: number;
		user: string;
		password: string;
		sslMode: SslMode;
	}) => Promise<{ databases: string[] }>;
	onListSchemas: (params: {
		host: string;
		port: number;
		user: string;
		password: string;
		sslMode: SslMode;
		database: string;
	}) => Promise<{ schemas: string[] }>;
	onTestConnection: (data: ConnectionFormData) => void;
	testing?: boolean;
	testResult?: { ok: boolean; message: string } | null;
	creating?: boolean;
}

// ── Component ────────────────────────────────────────────────────

export function NewProjectWizard({
	open,
	onClose,
	onCreate,
	initialConnection,
	onDiscover,
	onListSchemas,
	onTestConnection,
	testing = false,
	testResult = null,
	creating = false,
}: NewProjectWizardProps) {
	const wizard = useWizardState({ initialConnection });

	if (!open) return null;

	const handleCreate = () => {
		onCreate({
			name: wizard.name,
			folderPath: wizard.folderPath,
			connections: wizard.connections,
			generateSchema: wizard.generateSchema,
			files: wizard.files,
			schemaSelection: wizard.schemaSelection,
		});
	};

	const isLastStep = wizard.step === 5;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			data-testid="new-project-wizard"
		>
			<div
				className="flex h-[520px] w-[700px] overflow-hidden rounded-lg border shadow-lg"
				style={{ backgroundColor: 'var(--background, #fff)' }}
			>
				{/* Sidebar — step indicators */}
				<Sidebar currentStep={wizard.step} onStepClick={wizard.goToStep} />

				{/* Main area */}
				<div className="flex flex-1 flex-col">
					{/* Content */}
					<div className="flex-1 overflow-y-auto p-6">
						<StepContent
							step={wizard.step}
							wizard={wizard}
							onDiscover={onDiscover}
							onListSchemas={onListSchemas}
							onTest={onTestConnection}
							testing={testing}
							testResult={testResult}
						/>
					</div>

					{/* Footer — navigation */}
					<div className="flex items-center justify-between border-t px-6 py-3">
						<Button
							type="button"
							variant="ghost"
							onClick={onClose}
							disabled={creating}
						>
							Cancel
						</Button>
						<div className="flex gap-2">
							{wizard.step > 0 && (
								<Button
									type="button"
									variant="outline"
									onClick={wizard.goBack}
									disabled={creating}
									data-testid="wizard-back"
								>
									Back
								</Button>
							)}
							{isLastStep ? (
								<Button
									type="button"
									onClick={handleCreate}
									disabled={creating}
									data-testid="wizard-create"
								>
									{creating ? 'Creating...' : 'Create Project'}
								</Button>
							) : (
								<Button
									type="button"
									onClick={wizard.goNext}
									disabled={!wizard.canGoNext()}
									data-testid="wizard-next"
								>
									Next
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ── Sidebar ──────────────────────────────────────────────────────

function Sidebar({
	currentStep,
	onStepClick,
}: {
	currentStep: WizardStep;
	onStepClick: (step: WizardStep) => void;
}) {
	return (
		<div className="w-[200px] border-r bg-muted/30 p-4">
			<h2 className="mb-4 text-sm font-semibold">New Project</h2>
			<nav className="space-y-1">
				{WIZARD_STEPS.map((s, i) => {
					const stepIndex = i as WizardStep;
					const isCurrent = stepIndex === currentStep;
					const isCompleted = stepIndex < currentStep;

					return (
						<button
							key={s.label}
							type="button"
							onClick={() => onStepClick(stepIndex)}
							className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
								isCurrent
									? 'bg-primary/10 text-primary font-medium'
									: isCompleted
										? 'text-muted-foreground hover:text-foreground'
										: 'text-muted-foreground/60'
							}`}
							data-testid={`step-indicator-${i}`}
						>
							<StepBadge
								index={stepIndex}
								isCurrent={isCurrent}
								isCompleted={isCompleted}
							/>
							<span>{s.label}</span>
						</button>
					);
				})}
			</nav>
		</div>
	);
}

function StepBadge({
	index,
	isCurrent,
	isCompleted,
}: {
	index: number;
	isCurrent: boolean;
	isCompleted: boolean;
}) {
	if (isCompleted) {
		return (
			<span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
				<Check className="h-3 w-3" />
			</span>
		);
	}
	return (
		<span
			className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
				isCurrent
					? 'bg-primary text-primary-foreground'
					: 'bg-muted text-muted-foreground'
			}`}
		>
			{index + 1}
		</span>
	);
}

// ── Step Content Router ──────────────────────────────────────────

function StepContent({
	step,
	wizard,
	onDiscover,
	onListSchemas,
	onTest,
	testing,
	testResult,
}: {
	step: WizardStep;
	wizard: ReturnType<typeof useWizardState>;
	onDiscover: NewProjectWizardProps['onDiscover'];
	onListSchemas: NewProjectWizardProps['onListSchemas'];
	onTest: (data: ConnectionFormData) => void;
	testing: boolean;
	testResult: { ok: boolean; message: string } | null;
}) {
	switch (step) {
		case 0:
			return <WizardIntroStep />;
		case 1:
			return (
				<WizardNameStep
					name={wizard.name}
					folderPath={wizard.folderPath}
					onNameChange={wizard.setName}
					onFolderPathChange={wizard.setFolderPath}
				/>
			);
		case 2:
			return (
				<WizardConnectionsStep
					connections={wizard.connections}
					onAdd={wizard.addConnection}
					onRemove={wizard.removeConnection}
					onUpdateEnvironment={wizard.updateEnvironment}
					onDiscover={onDiscover}
					onListSchemas={onListSchemas}
					onTest={onTest}
					testing={testing}
					testResult={testResult}
				/>
			);
		case 3:
			return (
				<WizardFilesStep
					folderPath={wizard.folderPath}
					files={wizard.files}
					schemaSelection={wizard.schemaSelection}
					onToggleFile={wizard.toggleFile}
					onSetFiles={wizard.setFilesAll}
					onSchemaSelectionChange={wizard.setSchemaSelection}
				/>
			);
		case 4:
			return (
				<WizardOptionsStep
					name={wizard.name}
					folderPath={wizard.folderPath}
					connectionCount={wizard.connections.length}
					generateSchema={wizard.generateSchema}
					onGenerateSchemaChange={wizard.setGenerateSchema}
				/>
			);
		case 5:
			return (
				<WizardReviewStep
					name={wizard.name}
					folderPath={wizard.folderPath}
					connectionCount={wizard.connections.length}
					files={wizard.files}
					schemaSelection={wizard.schemaSelection}
					generateSchema={wizard.generateSchema}
				/>
			);
	}
}
