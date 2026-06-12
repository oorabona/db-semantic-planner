import { NqlLexer } from './tokens.js';

export * from './tokens.js';

/**
 * Tokenize NQL source with the public lexer.
 */
export function tokenize(input: string): ReturnType<typeof NqlLexer.tokenize> {
	return NqlLexer.tokenize(input);
}
