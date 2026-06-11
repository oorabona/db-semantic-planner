/**
 * NQL-origin SELECT function allowlist.
 *
 * This is the security gate for function names parsed from NQL SELECT text.
 * Extend it only after adding parser/compiler/adapter coverage that proves the
 * function is intentionally supported for NQL-origin SELECT projections.
 */
export const NQL_SELECT_AGGREGATE_FUNCTIONS = [
	'count',
	'sum',
	'avg',
	'min',
	'max',
	'array_agg',
	'string_agg',
] as const;

export const NQL_SELECT_JSON_FUNCTIONS = [
	'json_extract',
	'json_extract_text',
	'json_path',
	'json_path_text',
] as const;

export const NQL_SELECT_SCALAR_FUNCTIONS = [
	'coalesce',
	'lower',
	'now',
	'round',
	'upper',
] as const;

export const NQL_SELECT_WINDOW_FUNCTIONS = [
	'row_number',
	'rank',
	'dense_rank',
	'lag',
	'lead',
	'count',
	'sum',
	'avg',
	'min',
	'max',
] as const;

export const NQL_SELECT_FUNCTION_ALLOWLIST: ReadonlySet<string> = new Set([
	...NQL_SELECT_AGGREGATE_FUNCTIONS,
	...NQL_SELECT_JSON_FUNCTIONS,
	...NQL_SELECT_SCALAR_FUNCTIONS,
	...NQL_SELECT_WINDOW_FUNCTIONS,
]);

type NqlSelectWindowFunction = (typeof NQL_SELECT_WINDOW_FUNCTIONS)[number];

export function isNqlSelectFunctionAllowed(name: string): boolean {
	return NQL_SELECT_FUNCTION_ALLOWLIST.has(name.toLowerCase());
}

export function isNqlSelectWindowFunctionAllowed(
	name: string,
): name is NqlSelectWindowFunction {
	return (NQL_SELECT_WINDOW_FUNCTIONS as readonly string[]).includes(
		name.toLowerCase(),
	);
}
