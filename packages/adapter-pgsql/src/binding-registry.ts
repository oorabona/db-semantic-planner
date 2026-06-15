/**
 * Internal registry of NQL `| bind name` CTE names visible to a compile pass.
 *
 * Binding names are query-local identifiers, not physical tables. When an active
 * schema is present, real table FROM sources must be schema-qualified, while CTE
 * binding names must remain unqualified.
 */
import type { NamingPlugin } from './naming-plugin.js';

export type BindingNameRegistry = ReadonlySet<string>;

export function emittedBindName(name: string, naming: NamingPlugin): string {
	return naming.toDatabase(name);
}

export function hasBindingName(
	bindingNames: BindingNameRegistry | undefined,
	name: string,
	naming: NamingPlugin,
): boolean {
	return bindingNames?.has(emittedBindName(name, naming)) ?? false;
}

export function schemaForFromName(
	schemaName: string | undefined,
	fromName: string,
	bindingNames: BindingNameRegistry | undefined,
	naming: NamingPlugin,
): string | undefined {
	return hasBindingName(bindingNames, fromName, naming)
		? undefined
		: schemaName;
}

export function withBindingName(
	bindingNames: BindingNameRegistry | undefined,
	name: string,
	naming: NamingPlugin,
): BindingNameRegistry {
	const next = new Set(bindingNames ?? []);
	next.add(emittedBindName(name, naming));
	return next;
}
