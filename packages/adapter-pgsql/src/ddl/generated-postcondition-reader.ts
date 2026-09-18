import { canonicalJson, canonicalJsonDigest } from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerPayload,
	NormalizedManagedStep,
} from '@dbsp/types';
import { readPgCatalogueIdentity } from '../transition/catalogue-identity.js';
import {
	assertGeneratedPostconditionSession,
	decodeGeneratedPostconditionPayload,
	type GeneratedPostconditionBindingAddress,
	type GeneratedPostconditionSession,
	toGeneratedPostconditionBindingAddress,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedIdentityPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
} from './generated-postcondition-verifier.js';
import type { GeneratedPostcondition } from './managed-step-manifest.js';

/** Durable payload roles are disjoint before the outcome protocol serializes them. */
export type GeneratedIdentityObservation = LedgerPayload & {
	readonly payloadKind: 'generated-identity-observation';
};
export type GeneratedStructuralObservation = LedgerPayload & {
	readonly payloadKind: 'generated-structural-observation';
};
export type GeneratedPostconditionObservation =
	| GeneratedIdentityObservation
	| GeneratedStructuralObservation;

export type GeneratedPostconditionReadBack = {
	readonly observed: GeneratedPostconditionObservation;
	readonly catalogueIdentity?: NonNullable<LedgerAddress['catalogueIdentity']>;
};

function generatedPayload(value: unknown): GeneratedStructuralObservation {
	const encoded = canonicalJson(value);
	const normalized = JSON.parse(encoded) as LedgerPayload['value'];
	return {
		value: normalized,
		digest: canonicalJsonDigest(normalized),
		payloadKind: 'generated-structural-observation',
	} satisfies GeneratedStructuralObservation;
}

/** An identity-only existence and catalogue-identity read-back for the four #597 kinds. */
async function identityObserved(
	executor: GeneratedPostconditionSession,
	postcondition: GeneratedPostcondition,
	address: GeneratedPostconditionBindingAddress,
	kind: 'constraint' | 'enum' | 'sequence' | 'extension',
): Promise<{
	readonly observed: GeneratedIdentityObservation;
	readonly catalogueIdentity: NonNullable<LedgerAddress['catalogueIdentity']>;
}> {
	const verified = await verifyGeneratedIdentityPostcondition({
		session: executor,
		postcondition,
		address,
		kind,
	});
	const value = JSON.parse(
		canonicalJson({
			kind: 'identity-observed',
			observedKind: verified.kind,
			address: {
				scope: address.scope,
				...(address.schema === undefined ? {} : { schema: address.schema }),
				name: address.name,
			},
			identity: verified.identity,
			structuralSemantics: 'unverified',
		}),
	) as LedgerPayload['value'];
	return {
		catalogueIdentity: verified.catalogueIdentity,
		observed: {
			value,
			digest: canonicalJsonDigest(value),
			payloadKind: 'generated-identity-observation',
		} satisfies GeneratedIdentityObservation,
	};
}

function generatedPostcondition(
	step: NormalizedManagedStep,
	address: LedgerAddress,
): GeneratedPostcondition {
	const declaration = step.expectedDeclaration;
	if (
		!declaration?.value ||
		typeof declaration.value !== 'object' ||
		Array.isArray(declaration.value)
	)
		throw new Error(
			`generated ${address.kind} step ${step.stepKey} has no decodable generated declaration`,
		);
	return decodeGeneratedPostconditionPayload(declaration, step.stepKey);
}

/**
 * Version 3 binds its address separately from its structural declaration. The
 * adapter owns binding resolution, structural proof and the dispatch itself:
 * `readGeneratedPostconditionReadBack` decodes the step and selects the
 * supported version, this function dispatches the decoded v3 declaration, and
 * the caller supplies only the step and its address.
 */
async function readGeneratedV3Postcondition(
	executor: GeneratedPostconditionSession,
	postcondition: Extract<
		GeneratedPostcondition,
		{ readonly postconditionVersion: 3 }
	>,
	address: LedgerAddress,
): Promise<GeneratedPostconditionReadBack> {
	executor = assertGeneratedPostconditionSession(executor);
	const bindingAddress = toGeneratedPostconditionBindingAddress(address);
	switch (postcondition.declaration.kind) {
		case 'column': {
			const verified = await verifyGeneratedColumnPostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return {
				catalogueIdentity: verified.catalogueIdentity,
				observed: generatedPayload({
					kind: 'column',
					type: verified.projection.type,
					nullable: verified.projection.nullable,
					...(verified.projection.default === undefined
						? {}
						: { default: verified.projection.default }),
					...(verified.projection.collation === undefined
						? {}
						: { collation: verified.projection.collation }),
					...(verified.projection.identity === undefined
						? {}
						: { identity: verified.projection.identity }),
				}),
			};
		}
		case 'check': {
			const verified = await verifyGeneratedCheckPostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return {
				catalogueIdentity: verified.catalogueIdentity,
				observed: generatedPayload({
					kind: verified.kind,
					type: 'c',
					expression: verified.projection.expression,
					validated: verified.projection.validated,
					noInherit: verified.projection.noInherit,
					enforced: verified.projection.enforced,
					isLocal: verified.projection.isLocal,
					inheritanceCount: verified.projection.inheritanceCount,
					parentId: verified.projection.parentId,
				}),
			};
		}
		case 'constraint': {
			return identityObserved(
				executor,
				postcondition,
				bindingAddress,
				'constraint',
			);
		}
		case 'index': {
			const verified = await verifyGeneratedIndexPostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return {
				catalogueIdentity: verified.catalogueIdentity,
				observed: generatedPayload({
					kind: verified.kind,
					projection: verified.projection,
				}),
			};
		}
		case 'table': {
			const verified = await verifyGeneratedTablePostcondition({
				session: executor,
				postcondition,
				address: bindingAddress,
			});
			return {
				catalogueIdentity: verified.catalogueIdentity,
				observed: generatedPayload({
					kind: verified.kind,
					columns: verified.projection.columns.map((column) => ({
						name: column.name,
						type: column.type,
						nullable: column.nullable,
						...(column.default === undefined
							? {}
							: { default: column.default }),
						...(column.collation === undefined
							? {}
							: { collation: column.collation }),
						...(column.identity === undefined
							? {}
							: { identity: column.identity }),
					})),
				}),
			};
		}
		case 'enum': {
			return identityObserved(executor, postcondition, bindingAddress, 'enum');
		}
		case 'sequence': {
			return identityObserved(
				executor,
				postcondition,
				bindingAddress,
				'sequence',
			);
		}
		case 'extension': {
			return identityObserved(
				executor,
				postcondition,
				bindingAddress,
				'extension',
			);
		}
		case 'absent': {
			// Removal admission owns the destructive absence read-back.  Consume it
			// explicitly if this dispatcher is used for a terminal absence fact.
			const live = await readPgCatalogueIdentity(executor, bindingAddress);
			if (live)
				throw new Error(
					`generated ${bindingAddress.kind} absence postcondition differs: ${bindingAddress.name} is still present`,
				);
			return { observed: generatedPayload({ kind: 'absent' }) };
		}
		default:
			throw new Error('generated v3 postcondition has no declarable read-back');
	}
}

/**
 * Reads a generated declaration's terminal observation and catalogue identity.
 * The decoded declaration remains module-private so every public path enters
 * through the versioned decoder before it can dispatch on a declaration kind.
 */
export async function readGeneratedPostconditionReadBack(
	executor: GeneratedPostconditionSession,
	step: NormalizedManagedStep,
	address: LedgerAddress,
): Promise<GeneratedPostconditionReadBack> {
	executor = assertGeneratedPostconditionSession(executor);
	const decodedPostcondition = generatedPostcondition(step, address);
	if (decodedPostcondition.postconditionVersion === 3)
		return readGeneratedV3Postcondition(
			executor,
			decodedPostcondition,
			address,
		);
	throw new Error(
		'generated postcondition decoder returned no supported version',
	);
}

/**
 * Generated DDL has no operation runtime to supply an observation. Structural
 * declarations read the precise catalogue fields they change; the four #597
 * identity-only declarations prove existence and catalogue identity, not shape.
 * A same-named object is never enough to write an `observed` terminal.
 */
export async function readGeneratedPostcondition(
	executor: GeneratedPostconditionSession,
	step: NormalizedManagedStep,
	address: LedgerAddress,
): Promise<GeneratedPostconditionObservation> {
	return (await readGeneratedPostconditionReadBack(executor, step, address))
		.observed;
}
