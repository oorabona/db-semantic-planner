import type { EnumIR } from '@dbsp/types';
import { escapeDiagnosticText } from './diagnostic-text.js';

export class EnumNameMapKeyMismatchError extends Error {
	constructor(
		public readonly mapKey: string,
		public readonly enumName: string,
	) {
		super(
			`Declared enum map key "${escapeDiagnosticText(mapKey)}" differs from EnumIR.name ` +
				`"${escapeDiagnosticText(enumName)}". Use the same declared physical name for both.`,
		);
		this.name = 'EnumNameMapKeyMismatchError';
	}
}

export function assertDeclaredEnumMapIdentity(
	enums: ReadonlyMap<string, EnumIR> | undefined,
): void {
	for (const [key, enumDef] of enums ?? []) {
		if (key !== enumDef.name)
			throw new EnumNameMapKeyMismatchError(key, enumDef.name);
	}
}
