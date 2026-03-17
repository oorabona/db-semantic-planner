import { useCallback, useState } from 'react';
import type { ConnectionFormData } from '@/components/connection/ConnectionDialog';
import type {
	SchemaSelection,
	WizardConnection,
	WizardStep,
} from './wizard-types';

// ── Wizard State Hook ────────────────────────────────────────────

function genId(): string {
	return `wiz-conn-${crypto.randomUUID().slice(0, 8)}`;
}

export interface UseWizardStateOptions {
	/** Pre-populated connection (e.g., from "Convert to Project" flow). */
	readonly initialConnection?: ConnectionFormData;
}

export function useWizardState(options: UseWizardStateOptions = {}) {
	const [step, setStep] = useState<WizardStep>(0);
	const [name, setName] = useState('');
	const [folderPath, setFolderPath] = useState('');
	const [connections, setConnections] = useState<WizardConnection[]>(() => {
		if (!options.initialConnection) return [];
		return [
			{
				id: genId(),
				formData: options.initialConnection,
				environment:
					options.initialConnection.name || options.initialConnection.database,
			},
		];
	});
	const [generateSchema, setGenerateSchema] = useState(false);
	const [files, setFiles] = useState<string[]>([]);
	const [schemaSelection, setSchemaSelection] =
		useState<SchemaSelection>('skip');

	// ── Navigation ──

	const canGoNext = useCallback((): boolean => {
		switch (step) {
			case 0:
				return true;
			case 1:
				return name.trim().length > 0 && folderPath.trim().length > 0;
			case 2:
				return true; // 0..N connections allowed
			case 3:
				return true; // files are optional
			case 4:
				return true;
			case 5:
				return true;
		}
	}, [step, name, folderPath]);

	const goNext = useCallback(() => {
		if (step < 5 && canGoNext()) {
			setStep((s) => (s + 1) as WizardStep);
		}
	}, [step, canGoNext]);

	const goBack = useCallback(() => {
		if (step > 0) {
			setStep((s) => (s - 1) as WizardStep);
		}
	}, [step]);

	const goToStep = useCallback(
		(target: WizardStep) => {
			// Only allow going back to completed steps or forward if current is valid
			if (target < step) {
				setStep(target);
			} else if (target === step) {
				// no-op
			} else if (canGoNext()) {
				setStep(target);
			}
		},
		[step, canGoNext],
	);

	// ── Connections ──

	const addConnection = useCallback(
		(formData: ConnectionFormData, environment?: string) => {
			const conn: WizardConnection = {
				id: genId(),
				formData,
				environment:
					environment ?? (formData.name || formData.database || 'default'),
			};
			setConnections((prev) => [...prev, conn]);
			return conn.id;
		},
		[],
	);

	const removeConnection = useCallback((id: string) => {
		setConnections((prev) => prev.filter((c) => c.id !== id));
	}, []);

	const updateEnvironment = useCallback((id: string, env: string) => {
		setConnections((prev) =>
			prev.map((c) => (c.id === id ? { ...c, environment: env } : c)),
		);
	}, []);

	// ── Files ──

	const toggleFile = useCallback((path: string) => {
		setFiles((prev) =>
			prev.includes(path) ? prev.filter((f) => f !== path) : [...prev, path],
		);
	}, []);

	const setFilesAll = useCallback((paths: string[]) => {
		setFiles(paths);
	}, []);

	return {
		// State
		step,
		name,
		folderPath,
		connections,
		generateSchema,
		files,
		schemaSelection,

		// Setters
		setName,
		setFolderPath,
		setGenerateSchema,
		setSchemaSelection,

		// Navigation
		canGoNext,
		goNext,
		goBack,
		goToStep,

		// Connections
		addConnection,
		removeConnection,
		updateEnvironment,

		// Files
		toggleFile,
		setFilesAll,
	};
}

export type WizardStateReturn = ReturnType<typeof useWizardState>;
