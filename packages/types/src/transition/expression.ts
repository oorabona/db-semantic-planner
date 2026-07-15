import type { SemanticArtifactRef } from './artifact.js';
import type { JsonValue } from './json.js';
import type { AssumptionId } from './proof.js';

export interface PortableExpression {
	readonly kind: 'portable';
	readonly ast: JsonValue;
}

export interface VendorValidatedExpression {
	readonly kind: 'vendor-validated';
	readonly category: 'scalar' | 'predicate' | 'qualified-name';
	readonly validatedBy: SemanticArtifactRef;
	readonly text: string;
}

export interface UnsafeNativeFragment {
	readonly kind: 'unsafe-native';
	readonly category: 'scalar' | 'predicate' | 'qualified-name' | 'statement';
	readonly text: string;
	readonly assumption: AssumptionId;
}

export type ExpressionValue =
	| PortableExpression
	| VendorValidatedExpression
	| UnsafeNativeFragment;
