import type { CheckConstraintIR } from '@dbsp/types';

const CHECK_NOT_VALID_SUFFIX =
	/^(?<clause>\s*CHECK\s*\(.*\))\s+NOT\s+VALID\s*$/isu;

function toCheckConstraintClause(expression: string): string {
	const trimmed = stripNotValidSuffix(expression.trim()).trim();
	if (/^CHECK\s*\(/iu.test(trimmed)) {
		return trimmed;
	}
	return `CHECK (${trimmed})`;
}

export interface SplitCheckConstraintState {
	readonly expression: string;
	readonly notValid: boolean;
}

export function splitCheckConstraintState(
	check: Pick<CheckConstraintIR, 'expression' | 'notValid'>,
): SplitCheckConstraintState {
	return {
		expression: toCheckConstraintClause(check.expression),
		notValid:
			check.notValid !== undefined
				? check.notValid
				: hasNotValidSuffix(check.expression),
	};
}

export function renderCheckConstraintClause(
	check: Pick<CheckConstraintIR, 'expression' | 'notValid'>,
): string {
	const state = splitCheckConstraintState(check);
	return state.notValid ? `${state.expression} NOT VALID` : state.expression;
}

export function isCheckConstraintNotValid(
	check: Pick<CheckConstraintIR, 'expression' | 'notValid'>,
): boolean {
	return splitCheckConstraintState(check).notValid;
}

export function stripNotValidSuffix(expression: string): string {
	return expression.replace(CHECK_NOT_VALID_SUFFIX, '$<clause>');
}

function hasNotValidSuffix(expression: string): boolean {
	return CHECK_NOT_VALID_SUFFIX.test(expression);
}
