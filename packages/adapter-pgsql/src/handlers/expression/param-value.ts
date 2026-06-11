import type { Node } from '@pgsql/types';
import { createParamRef } from '../../param-ref.js';
import type { CompilerState } from '../types.js';

export function bindParameter(value: unknown, state: CompilerState): Node {
	const idx = ++state.paramIndex;
	state.parameters.push(value);
	return createParamRef(idx);
}
