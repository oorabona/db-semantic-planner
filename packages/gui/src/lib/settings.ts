import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

// ── Types ────────────────────────────────────────────────────────

export interface DbspConnectionRef {
	readonly name: string;
	readonly profile: string; // URI: file://, env://, store://
	readonly defaultSchema?: string;
	readonly readOnly?: boolean;
}

export interface DbspProjectSettings {
	readonly schemaPath?: string | 'auto';
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
}

export interface DbspEditorSettings {
	readonly tabSize?: number;
	readonly formatOnSave?: boolean;
	readonly maxResults?: number;
}

export interface DbspSettings {
	readonly $schema?: string;
	readonly version: 1; // SEC-04: required for future schema migration
	readonly connections?: readonly DbspConnectionRef[];
	readonly defaultConnection?: string;
	readonly project?: DbspProjectSettings;
	readonly editor?: DbspEditorSettings;
}

// ── Defaults ─────────────────────────────────────────────────────

export const SETTINGS_FILENAME = 'dbsp.settings.json';

export const DEFAULT_INCLUDE = ['**/*.dbsp', '**/*.assert.dbsp'] as const;
export const DEFAULT_EXCLUDE = ['node_modules', 'dist', '.git'] as const;

export const DEFAULT_EDITOR: Required<DbspEditorSettings> = {
	tabSize: 2,
	formatOnSave: false,
	maxResults: 1000,
};

/** Canonical paths searched in order when schemaPath = "auto" */
export const SCHEMA_SEARCH_PATHS = [
	'src/schema.ts',
	'schema.ts',
	'src/db/schema.ts',
	'db/schema.ts',
] as const;

// ── Validation ───────────────────────────────────────────────────

export interface SettingsError {
	readonly path: string;
	readonly message: string;
}

export function validateSettings(
	raw: unknown,
): { ok: true; settings: DbspSettings } | { ok: false; errors: SettingsError[] } {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, errors: [{ path: '', message: 'Settings must be a JSON object' }] };
	}

	const obj = raw as Record<string, unknown>;
	const errors: SettingsError[] = [];

	// version (SEC-04: required)
	if (obj.version !== 1) {
		errors.push({ path: 'version', message: 'version must be 1' });
	}

	// connections (optional array)
	if (obj.connections !== undefined) {
		if (!Array.isArray(obj.connections)) {
			errors.push({ path: 'connections', message: 'connections must be an array' });
		} else {
			for (let i = 0; i < obj.connections.length; i++) {
				const conn = obj.connections[i] as Record<string, unknown>;
				if (!conn || typeof conn !== 'object') {
					errors.push({ path: `connections[${i}]`, message: 'must be an object' });
					continue;
				}
				if (typeof conn.name !== 'string' || conn.name.length === 0) {
					errors.push({ path: `connections[${i}].name`, message: 'name is required and must be a non-empty string' });
				}
				if (typeof conn.profile !== 'string' || conn.profile.length === 0) {
					errors.push({ path: `connections[${i}].profile`, message: 'profile URI is required and must be a non-empty string' });
				} else if (!/^(file|env|store):\/\//.test(conn.profile as string)) {
					errors.push({ path: `connections[${i}].profile`, message: 'profile must use file://, env://, or store:// scheme' });
				}
				if (conn.readOnly !== undefined && typeof conn.readOnly !== 'boolean') {
					errors.push({ path: `connections[${i}].readOnly`, message: 'readOnly must be a boolean' });
				}
			}
		}
	}

	// defaultConnection (optional string)
	if (obj.defaultConnection !== undefined && typeof obj.defaultConnection !== 'string') {
		errors.push({ path: 'defaultConnection', message: 'defaultConnection must be a string' });
	}

	// project (optional object)
	if (obj.project !== undefined) {
		if (typeof obj.project !== 'object' || obj.project === null || Array.isArray(obj.project)) {
			errors.push({ path: 'project', message: 'project must be an object' });
		} else {
			const proj = obj.project as Record<string, unknown>;
			if (proj.schemaPath !== undefined && typeof proj.schemaPath !== 'string') {
				errors.push({ path: 'project.schemaPath', message: 'schemaPath must be a string or "auto"' });
			}
			if (proj.include !== undefined) {
				if (!Array.isArray(proj.include) || !proj.include.every((v: unknown) => typeof v === 'string')) {
					errors.push({ path: 'project.include', message: 'include must be an array of strings' });
				}
			}
			if (proj.exclude !== undefined) {
				if (!Array.isArray(proj.exclude) || !proj.exclude.every((v: unknown) => typeof v === 'string')) {
					errors.push({ path: 'project.exclude', message: 'exclude must be an array of strings' });
				}
			}
		}
	}

	// editor (optional object)
	if (obj.editor !== undefined) {
		if (typeof obj.editor !== 'object' || obj.editor === null || Array.isArray(obj.editor)) {
			errors.push({ path: 'editor', message: 'editor must be an object' });
		} else {
			const ed = obj.editor as Record<string, unknown>;
			if (ed.tabSize !== undefined && (typeof ed.tabSize !== 'number' || ed.tabSize < 1)) {
				errors.push({ path: 'editor.tabSize', message: 'tabSize must be a positive number' });
			}
			if (ed.formatOnSave !== undefined && typeof ed.formatOnSave !== 'boolean') {
				errors.push({ path: 'editor.formatOnSave', message: 'formatOnSave must be a boolean' });
			}
			if (ed.maxResults !== undefined && (typeof ed.maxResults !== 'number' || ed.maxResults < 1)) {
				errors.push({ path: 'editor.maxResults', message: 'maxResults must be a positive number' });
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, settings: obj as unknown as DbspSettings };
}

// ── Read / Write ─────────────────────────────────────────────────

/**
 * Read and validate dbsp.settings.json from a folder.
 * Returns null if the file does not exist.
 * Throws on invalid JSON or validation errors.
 */
export async function readSettings(
	folderPath: string,
): Promise<DbspSettings | null> {
	const filePath = await join(folderPath, SETTINGS_FILENAME);

	const fileExists = await exists(filePath);
	if (!fileExists) return null;

	const text = await readTextFile(filePath);

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new SettingsParseError(filePath, 'Invalid JSON');
	}

	const result = validateSettings(raw);
	if (!result.ok) {
		throw new SettingsValidationError(filePath, result.errors);
	}

	return result.settings;
}

/**
 * Write settings to dbsp.settings.json with pretty formatting.
 */
export async function writeSettings(
	folderPath: string,
	settings: DbspSettings,
): Promise<void> {
	const filePath = await join(folderPath, SETTINGS_FILENAME);
	const text = `${JSON.stringify(settings, null, 2)}\n`;
	await writeTextFile(filePath, text);
}

// ── Schema Auto-Detection ────────────────────────────────────────

/**
 * Resolve schemaPath setting.
 * If "auto", searches SCHEMA_SEARCH_PATHS in order and returns the first existing file.
 * Returns null if no schema found.
 */
export async function resolveSchemaPath(
	folderPath: string,
	schemaPath: string | undefined,
): Promise<string | null> {
	if (!schemaPath) return null;

	if (schemaPath !== 'auto') {
		// Explicit path — verify it exists
		const fullPath = await join(folderPath, schemaPath);
		return (await exists(fullPath)) ? schemaPath : null;
	}

	// Auto-detect: search canonical paths in order
	for (const candidate of SCHEMA_SEARCH_PATHS) {
		const fullPath = await join(folderPath, candidate);
		if (await exists(fullPath)) {
			return candidate;
		}
	}

	return null;
}

// ── Errors ───────────────────────────────────────────────────────

export class SettingsParseError extends Error {
	constructor(
		public readonly filePath: string,
		public readonly reason: string,
	) {
		super(`Failed to parse ${SETTINGS_FILENAME}: ${reason}`);
		this.name = 'SettingsParseError';
	}
}

export class SettingsValidationError extends Error {
	constructor(
		public readonly filePath: string,
		public readonly errors: readonly SettingsError[],
	) {
		super(`Invalid ${SETTINGS_FILENAME}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
		this.name = 'SettingsValidationError';
	}
}
