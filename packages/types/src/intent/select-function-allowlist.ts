/**
 * NQL-origin SELECT function allowlist.
 *
 * This is the shared security gate for function names that originated in NQL
 * SELECT text and later cross the IntentAST-to-SQL adapter boundary. Extend it
 * only after adding compiler and adapter coverage proving the function is
 * intentionally supported for NQL-origin SELECT projections.
 */
export const NQL_SELECT_AGGREGATE_FUNCTIONS = [
	'count',
	'sum',
	'avg',
	'min',
	'max',
] as const;

export const NQL_SELECT_JSON_FUNCTIONS = [
	'json_extract',
	'json_extract_text',
	'json_path',
	'json_path_text',
] as const;

export const NQL_SELECT_VALUE_FUNCTIONS = [
	'coalesce',
	'lower',
	'now',
	'round',
	'upper',
] as const;

export const NQL_SELECT_SCALAR_FUNCTIONS = [
	...NQL_SELECT_AGGREGATE_FUNCTIONS,
	...NQL_SELECT_JSON_FUNCTIONS,
	...NQL_SELECT_VALUE_FUNCTIONS,
] as const;

export const NQL_SELECT_WINDOW_ONLY_FUNCTIONS = [
	'row_number',
	'rank',
	'dense_rank',
	'lag',
	'lead',
] as const;

export const NQL_SELECT_WINDOW_FUNCTIONS = [
	...NQL_SELECT_WINDOW_ONLY_FUNCTIONS,
	'count',
	'sum',
	'avg',
	'min',
	'max',
] as const;

export const NQL_SELECT_SCALAR_FUNCTION_ALLOWLIST: ReadonlySet<string> =
	new Set(NQL_SELECT_SCALAR_FUNCTIONS);

export const NQL_SELECT_WINDOW_FUNCTION_ALLOWLIST: ReadonlySet<string> =
	new Set(NQL_SELECT_WINDOW_FUNCTIONS);

export const NQL_SELECT_FUNCTION_ALLOWLIST: ReadonlySet<string> = new Set([
	...NQL_SELECT_SCALAR_FUNCTIONS,
	...NQL_SELECT_WINDOW_FUNCTIONS,
]);

type NqlSelectScalarFunction = (typeof NQL_SELECT_SCALAR_FUNCTIONS)[number];
type NqlSelectWindowFunction = (typeof NQL_SELECT_WINDOW_FUNCTIONS)[number];

export function isNqlSelectScalarFunctionAllowed(
	name: string,
): name is NqlSelectScalarFunction {
	return NQL_SELECT_SCALAR_FUNCTION_ALLOWLIST.has(name.toLowerCase());
}

export function isNqlSelectFunctionAllowed(name: string): boolean {
	return NQL_SELECT_FUNCTION_ALLOWLIST.has(name.toLowerCase());
}

export function isNqlSelectWindowFunctionAllowed(
	name: string,
): name is NqlSelectWindowFunction {
	return NQL_SELECT_WINDOW_FUNCTION_ALLOWLIST.has(name.toLowerCase());
}
