/**
 * CLI Configuration Module
 *
 * Handles persistent configuration for the REPL, including table display settings.
 * Default config path: ~/.dbsp/config.json
 * Override with -c flag.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Table border style options */
export type BorderStyle =
	| 'all'
	| 'outline'
	| 'headers-only'
	| 'vertical'
	| 'horizontal'
	| 'none';

/** Table overflow handling options */
export type OverflowStyle =
	| 'wrap'
	| 'truncate'
	| 'truncate-middle'
	| 'truncate-start'
	| 'truncate-end';

/** Table header formatting options */
export type HeaderFormatter =
	| 'capitalCase'
	| 'none'
	| 'snakeCase'
	| 'camelCase';

/** Table display configuration */
export interface TableConfig {
	borderStyle: BorderStyle;
	overflow: OverflowStyle;
	headerFormatter: HeaderFormatter;
	padding: number;
}

/** Full CLI configuration */
export interface CliConfig {
	table: TableConfig;
}

/** Default table configuration */
const DEFAULT_TABLE_CONFIG: TableConfig = {
	borderStyle: 'all',
	overflow: 'wrap',
	headerFormatter: 'capitalCase',
	padding: 1,
};

/** Default CLI configuration */
const DEFAULT_CONFIG: CliConfig = {
	table: DEFAULT_TABLE_CONFIG,
};

/** Get default config directory path */
function getDefaultConfigDir(): string {
	return path.join(os.homedir(), '.dbsp');
}

/** Get default config file path */
function getDefaultConfigPath(): string {
	return path.join(getDefaultConfigDir(), 'config.json');
}

/** Configuration manager singleton */
class ConfigManager {
	private config: CliConfig = structuredClone(DEFAULT_CONFIG);
	private configPath: string = getDefaultConfigPath();
	private loaded = false;

	/** Set custom config path */
	setConfigPath(configPath: string): void {
		this.configPath = configPath;
		this.loaded = false;
	}

	/** Get current config path */
	getConfigPath(): string {
		return this.configPath;
	}

	/** Load configuration from file */
	load(): CliConfig {
		if (this.loaded) return this.config;

		try {
			if (fs.existsSync(this.configPath)) {
				const content = fs.readFileSync(this.configPath, 'utf-8');
				const parsed = JSON.parse(content) as Partial<CliConfig>;
				this.config = {
					table: {
						...DEFAULT_TABLE_CONFIG,
						...(parsed.table ?? {}),
					},
				};
			}
		} catch {
			// If config file is invalid, use defaults
			this.config = structuredClone(DEFAULT_CONFIG);
		}

		this.loaded = true;
		return this.config;
	}

	/** Save configuration to file */
	save(): void {
		try {
			const dir = path.dirname(this.configPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(
				this.configPath,
				JSON.stringify(this.config, null, 2),
				'utf-8',
			);
		} catch (error) {
			console.error(`Failed to save config: ${error}`);
		}
	}

	/** Get current configuration */
	get(): CliConfig {
		if (!this.loaded) this.load();
		return this.config;
	}

	/** Get table configuration */
	getTable(): TableConfig {
		return this.get().table;
	}

	/** Update table configuration */
	updateTable(updates: Partial<TableConfig>): void {
		this.config.table = { ...this.config.table, ...updates };
		this.save();
	}

	/** Reset table configuration to defaults */
	resetTable(): void {
		this.config.table = structuredClone(DEFAULT_TABLE_CONFIG);
		this.save();
	}

	/** Reset all configuration to defaults */
	reset(): void {
		this.config = structuredClone(DEFAULT_CONFIG);
		this.save();
	}
}

/** Global config manager instance */
export const config = new ConfigManager();

/** Valid values for each table option (for validation) */
export const TABLE_OPTIONS = {
	borderStyle: [
		'all',
		'outline',
		'headers-only',
		'vertical',
		'horizontal',
		'none',
	] as const,
	overflow: [
		'wrap',
		'truncate',
		'truncate-middle',
		'truncate-start',
		'truncate-end',
	] as const,
	headerFormatter: ['capitalCase', 'none', 'snakeCase', 'camelCase'] as const,
	padding: [0, 1, 2, 3, 4] as const,
};

/** Check if a value is valid for a given option */
export function isValidTableOption<K extends keyof typeof TABLE_OPTIONS>(
	option: K,
	value: unknown,
): value is (typeof TABLE_OPTIONS)[K][number] {
	return TABLE_OPTIONS[option].includes(value as never);
}
