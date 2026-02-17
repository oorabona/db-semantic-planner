import type { ConnectionFormData } from '@/components/connection/ConnectionDialog';

// ── Wizard Types ─────────────────────────────────────────────────

export type WizardStep = 0 | 1 | 2 | 3;

export const WIZARD_STEPS = [
	{ label: 'Introduction', description: 'What is project mode?' },
	{ label: 'Name & Location', description: 'Choose a name and folder' },
	{ label: 'Connections', description: 'Configure database connections' },
	{ label: 'Options', description: 'Schema and project options' },
] as const;

export interface WizardConnection {
	readonly id: string;
	readonly formData: ConnectionFormData;
	readonly environment: string;
}

export interface WizardData {
	readonly name: string;
	readonly folderPath: string;
	readonly connections: readonly WizardConnection[];
	readonly generateSchema: boolean;
}
