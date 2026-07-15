import type {
	ApplyGuard,
	DurableIntentRecord,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	ObservationContext,
	ObservationIssuer,
	OperationEffectAssessment,
	OperationKindRef,
	OperationSemantics,
	PhysicalOperation,
	RecoveryArtefact,
	RuleRef,
	SemanticArtifactRef,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionConnectionPool,
	TransitionQueryClient,
	TransitionRule,
} from '@dbsp/types';

export interface OperationFingerprints {
	readonly expectedBefore: FingerprintManifest;
	readonly expectedAfter: FingerprintManifest;
}

export interface RegisteredOperationSemantics extends OperationSemantics {
	readonly operationKind?: OperationKindRef;
	supportsOperation?(operation: PhysicalOperation): boolean;
	buildFingerprints(
		operation: PhysicalOperation,
		evidence: readonly EvidenceObservation[],
		context: ObservationContext,
	): OperationFingerprints;
}

export interface OperationObservation {
	readonly observations: readonly IssuedObservation[];
	readonly fingerprint: FingerprintManifest;
}

export interface ComparatorNameNormalizer {
	/**
	 * Normalize identifiers from the observed/current model into the namespace
	 * used by authored desired models before comparator matching runs.
	 */
	normalizeCurrentIdentifier(identifier: string): string;
}

export interface GuardExecutionResult {
	readonly passed: boolean;
	readonly observations: readonly IssuedObservation[];
	readonly recovery: readonly RecoveryArtefact[];
}

export interface TransitionExecutionClient {
	readonly opaqueClient: unknown;
}

export interface OperationRuntime extends RegisteredOperationSemantics {
	checkout(
		target: TransitionConnectionPool,
	): Promise<TransitionExecutionClient>;
	release(
		client: TransitionExecutionClient,
		error?: unknown,
	): Promise<void> | void;
	writeIntentJournal(
		client: TransitionExecutionClient,
		record: DurableIntentRecord,
	): Promise<void>;
	begin(client: TransitionExecutionClient): Promise<void>;
	setLockTimeout(
		client: TransitionExecutionClient,
		maxWaitMs: number,
	): Promise<void>;
	acquireLocks(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		effects: OperationEffectAssessment,
		context: ObservationContext,
	): Promise<void>;
	observeContext(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		proofContext: ObservationContext,
	): Promise<ObservationContext>;
	observeOperation(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		context: ObservationContext,
		phase: 'before' | 'after',
		issuer: ObservationIssuer,
	): Promise<OperationObservation>;
	checkGuard(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		guard: ApplyGuard,
		context: ObservationContext,
	): Promise<GuardExecutionResult>;
	executeOperation(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		context: ObservationContext,
		duringGuards?: readonly ApplyGuard[],
	): Promise<void>;
	writeCompletionJournal(
		client: TransitionExecutionClient,
		operation: PhysicalOperation,
		record: TransactionalCompletionRecord,
	): Promise<void>;
	commit(client: TransitionExecutionClient): Promise<void>;
	rollback(client: TransitionExecutionClient): Promise<void>;
	writeObservedJournal(
		client: TransitionExecutionClient,
		journal: StepJournal,
	): Promise<void>;
	isLockTimeout(error: unknown): boolean;
}

export interface TransitionPack {
	readonly rules: readonly TransitionRule[];
	readonly operationSemantics: readonly RegisteredOperationSemantics[];
	readonly issuer: ObservationIssuer;
	readonly comparatorNameNormalizer?: ComparatorNameNormalizer;
}

export type OperationResolution =
	| {
			readonly ok: true;
			readonly semantics: RegisteredOperationSemantics;
	  }
	| {
			readonly ok: false;
			readonly detail: string;
	  };

function artifactKey(ref: SemanticArtifactRef): string {
	return `${ref.id}@${ref.version}`;
}

function operationKey(kind: OperationKindRef): string {
	return `${artifactKey(kind.artifact)}#${kind.name}`;
}

function ruleKey(rule: TransitionRule): string {
	return `${artifactKey(rule.artifact)}#${rule.id}`;
}

function sameArtifact(
	left: SemanticArtifactRef,
	right: SemanticArtifactRef,
): boolean {
	return left.id === right.id && left.version === right.version;
}

export function isOperationRuntime(
	semantics: RegisteredOperationSemantics,
): semantics is OperationRuntime {
	return (
		'checkout' in semantics &&
		'release' in semantics &&
		'writeIntentJournal' in semantics &&
		'begin' in semantics &&
		'setLockTimeout' in semantics &&
		'acquireLocks' in semantics &&
		'observeContext' in semantics &&
		'observeOperation' in semantics &&
		'checkGuard' in semantics &&
		'executeOperation' in semantics &&
		'writeCompletionJournal' in semantics &&
		'commit' in semantics &&
		'rollback' in semantics &&
		'writeObservedJournal' in semantics &&
		'isLockTimeout' in semantics
	);
}

export class PackRegistry {
	private readonly rules: readonly TransitionRule[];
	private readonly operationSemantics: readonly RegisteredOperationSemantics[];
	private readonly issuers: readonly ObservationIssuer[];
	private readonly issuerByArtifact: ReadonlyMap<string, ObservationIssuer>;
	private readonly nameNormalizer: ComparatorNameNormalizer | undefined;

	constructor(packs: readonly TransitionPack[]) {
		this.rules = packs.flatMap((pack) => [...pack.rules]);
		this.operationSemantics = packs.flatMap((pack) => [
			...pack.operationSemantics,
		]);
		this.issuers = packs.map((pack) => pack.issuer);
		const normalizers = packs.flatMap((pack) =>
			pack.comparatorNameNormalizer ? [pack.comparatorNameNormalizer] : [],
		);
		const distinctNormalizers = new Set(normalizers);
		if (distinctNormalizers.size > 1) {
			throw new Error('ambiguous transition comparator name normalizer');
		}
		this.nameNormalizer = normalizers[0];
		const ruleKeys = new Set<string>();
		for (const rule of this.rules) {
			const key = ruleKey(rule);
			if (ruleKeys.has(key)) {
				throw new Error(`duplicate transition rule registration for ${key}`);
			}
			ruleKeys.add(key);
		}
		const issuerArtifactKeys = new Set<string>();
		for (const issuer of this.issuers) {
			const key = artifactKey(issuer.artifact);
			if (issuerArtifactKeys.has(key)) {
				throw new Error(`duplicate transition issuer registration for ${key}`);
			}
			issuerArtifactKeys.add(key);
		}
		const issuerByArtifact = new Map<string, ObservationIssuer>();
		const bindIssuer = (key: string, issuer: ObservationIssuer) => {
			const prior = issuerByArtifact.get(key);
			if (prior && prior !== issuer) {
				throw new Error(`ambiguous transition issuer registration for ${key}`);
			}
			issuerByArtifact.set(key, issuer);
		};
		for (const pack of packs) {
			bindIssuer(artifactKey(pack.issuer.artifact), pack.issuer);
			for (const rule of pack.rules) {
				bindIssuer(artifactKey(rule.artifact), pack.issuer);
			}
			for (const semantics of pack.operationSemantics) {
				bindIssuer(artifactKey(semantics.artifact), pack.issuer);
				if (semantics.operationKind) {
					bindIssuer(
						artifactKey(semantics.operationKind.artifact),
						pack.issuer,
					);
				}
			}
		}
		this.issuerByArtifact = issuerByArtifact;
	}

	allRules(): readonly TransitionRule[] {
		return this.rules;
	}

	defaultIssuer(): ObservationIssuer | undefined {
		return this.issuers[0];
	}

	comparatorNameNormalizer(): ComparatorNameNormalizer | undefined {
		return this.nameNormalizer;
	}

	resolveRule(ref: RuleRef): TransitionRule | undefined {
		return this.rules.find(
			(rule) => rule.id === ref.id && sameArtifact(rule.artifact, ref.pack),
		);
	}

	resolveIssuer(ref?: SemanticArtifactRef): ObservationIssuer | undefined {
		if (!ref) {
			return this.defaultIssuer();
		}
		return this.issuerByArtifact.get(artifactKey(ref));
	}

	resolveOperation(operation: PhysicalOperation): OperationResolution {
		const key = operationKey(operation.operationKind);
		const matches = this.operationSemantics.filter((semantics) => {
			if (semantics.operationKind) {
				if (operationKey(semantics.operationKind) !== key) {
					return false;
				}
				return semantics.supportsOperation?.(operation) ?? true;
			}
			if (
				artifactKey(semantics.artifact) !==
				artifactKey(operation.operationKind.artifact)
			) {
				return false;
			}
			return semantics.supportsOperation?.(operation) ?? false;
		});
		const match = matches[0];
		if (matches.length === 1 && match) {
			return { ok: true, semantics: match };
		}
		if (matches.length > 1) {
			return {
				ok: false,
				detail: `ambiguous operation runtime for ${key}`,
			};
		}
		return {
			ok: false,
			detail: `operation runtime missing for ${key}`,
		};
	}
}

export function createPackRegistry(
	packs: readonly TransitionPack[],
): PackRegistry {
	return new PackRegistry(packs);
}

export type { TransitionConnectionPool, TransitionQueryClient };
