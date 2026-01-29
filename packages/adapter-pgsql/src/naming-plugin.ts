/**
 * NamingPlugin - Identifier transformation between model and database naming conventions
 *
 * Inspired by Kysely's CamelCasePlugin architecture.
 * The plugin transforms identifiers bidirectionally:
 * - toDatabase: model name (camelCase) → database name (snake_case)
 * - toModel: database name (snake_case) → model name (camelCase)
 */

/**
 * Interface for naming convention transformation plugins
 */
export interface NamingPlugin {
	/**
	 * Transform a model identifier to database format
	 * Example: "createdAt" → "created_at"
	 */
	toDatabase(identifier: string): string;

	/**
	 * Transform a database identifier to model format
	 * Example: "created_at" → "createdAt"
	 */
	toModel(identifier: string): string;
}

/**
 * Identity plugin - no transformation
 * Use this when model and database naming conventions match
 */
export class IdentityNamingPlugin implements NamingPlugin {
	toDatabase(identifier: string): string {
		return identifier;
	}

	toModel(identifier: string): string {
		return identifier;
	}
}

/**
 * CamelCase ↔ snake_case transformation plugin
 *
 * Follows the same logic as Kysely's CamelCasePlugin:
 * - Handles consecutive uppercase letters (e.g., "parseJSON" → "parse_json")
 * - Handles numbers (e.g., "field1Name" → "field1_name")
 * - Preserves leading underscores
 */
export class CamelCaseNamingPlugin implements NamingPlugin {
	/**
	 * camelCase → snake_case
	 */
	toDatabase(identifier: string): string {
		// Handle empty strings
		if (!identifier) return identifier;

		// Preserve leading underscores
		const leadingUnderscores = identifier.match(/^_+/)?.[0] ?? '';
		const rest = identifier.slice(leadingUnderscores.length);

		if (!rest) return identifier;

		// Convert camelCase to snake_case
		// Handles: wordWord, wordWORD, word123Word
		const snakeCase = rest
			// Insert underscore before uppercase letters that follow lowercase/numbers
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			// Insert underscore before the last uppercase in a sequence followed by lowercase
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
			.toLowerCase();

		return leadingUnderscores + snakeCase;
	}

	/**
	 * snake_case → camelCase
	 */
	toModel(identifier: string): string {
		// Handle empty strings
		if (!identifier) return identifier;

		// Preserve leading underscores
		const leadingUnderscores = identifier.match(/^_+/)?.[0] ?? '';
		const rest = identifier.slice(leadingUnderscores.length);

		if (!rest) return identifier;

		// Convert snake_case to camelCase
		// First character stays lowercase, subsequent segments are capitalized
		const camelCase = rest.replace(/_([a-z0-9])/gi, (_, char: string) =>
			char.toUpperCase(),
		);

		return leadingUnderscores + camelCase;
	}
}

/**
 * Singleton instances for convenience
 */
export const identityNaming = new IdentityNamingPlugin();
export const camelCaseNaming = new CamelCaseNamingPlugin();

/**
 * Get a naming plugin by convention name
 */
export function getNamingPlugin(
	convention: 'identity' | 'camelCase',
): NamingPlugin {
	switch (convention) {
		case 'identity':
			return identityNaming;
		case 'camelCase':
			return camelCaseNaming;
		default:
			return identityNaming;
	}
}
