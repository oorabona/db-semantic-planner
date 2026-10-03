import { InvalidOperationError } from './errors.js';

export function validateLimit(count: number, option = 'limit'): void {
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new InvalidOperationError(
			option,
			`${option} must be a non-negative safe integer`,
		);
	}
}
