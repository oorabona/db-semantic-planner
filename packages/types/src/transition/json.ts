export type JsonObject = { readonly [k: string]: JsonValue };

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
