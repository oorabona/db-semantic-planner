import { createHash } from 'node:crypto';
import { resourceScopeCovers } from '@dbsp/core';
import type {
	Assumption,
	DurableIntentRecord,
	EvidenceObservation,
	ExecutableAssertion,
	FingerprintManifest,
	ObservationContext,
	OperationEffectAssessment,
	PhysicalOperation,
	Proposition,
	ResourceAddress,
	ResourceSelector,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionSessionClient,
	UnsafeNativeFragment,
} from '@dbsp/types';
import {
	DBSP_META_SCHEMA,
	MANUAL_SQL_OPERATION_KIND,
	PG_OPERATION_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
} from '../journal.js';
import { readPgObservationContextFromClient } from '../observation-issuer.js';
import { isPgGuardTimeout } from '../pg-guard-timeout.js';
import { stableJson } from '../stable-json.js';

export type ManualSqlPayload = {
	readonly statement: UnsafeNativeFragment;
	readonly blastRadius: readonly ResourceAddress[];
	readonly preconditions: readonly ExecutableAssertion[];
	readonly postconditions: readonly ExecutableAssertion[];
};

type QueryResultLike = {
	readonly rows: readonly Record<string, unknown>[];
};

type Queryable = {
	query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
};

type TransitionExecutionClient = {
	readonly opaqueClient: TransitionSessionClient;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function queryable(target: unknown): Queryable {
	if (isRecord(target) && typeof target.query === 'function') {
		return target as Queryable;
	}
	throw new Error(
		'PostgreSQL transition target must expose query(sql, params)',
	);
}

function clientQuery(client: TransitionExecutionClient): Queryable {
	return queryable(client.opaqueClient);
}

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function fact(key: string, value: unknown) {
	return {
		key,
		value: typeof value === 'string' ? value : stableJson(value),
	};
}

function operationPackSemanticsAssumption(
	payload: ManualSqlPayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#manual-sql:${digest([
				payload.statement.text,
				payload.blastRadius,
				context.databaseId,
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL ManualSql executes one author-attested unsafe-native statement and treats declared pre/postconditions and blast radius as assumptions, not verified facts.',
		scope: metadataAndBlastScope(payload, context),
	};
}

function databaseResource(context: ObservationContext): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context.databaseId,
		kind: 'database',
		name: context.databaseId,
	};
}

function schemaResource(
	schema: string,
	context: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context.databaseId,
		schema,
		kind: 'schema',
		name: schema,
	};
}

function resourceHasUnknownScope(resource: ResourceAddress): boolean {
	return (
		resource.database === 'unknown' ||
		resource.database.length === 0 ||
		resource.schema === 'unknown'
	);
}

function widenedManualScope(
	blastRadius: readonly ResourceAddress[],
	context: ObservationContext,
): readonly ResourceAddress[] {
	const schemas = [
		...new Set(
			blastRadius
				.map((resource) => resource.schema)
				.filter((schema): schema is string => !!schema && schema !== 'unknown'),
		),
	];
	if (schemas.length > 0) {
		return schemas.map((schema) => schemaResource(schema, context));
	}
	if (context.targetSchema) {
		return [schemaResource(context.targetSchema, context)];
	}
	return [databaseResource(context)];
}

function normalizeAssumptionScope(
	scope: readonly ResourceAddress[],
	blastRadius: readonly ResourceAddress[],
	context: ObservationContext,
): readonly ResourceAddress[] {
	if (scope.length === 0 || scope.some(resourceHasUnknownScope)) {
		return widenedManualScope(blastRadius, context);
	}
	return scope;
}

function metadataAndBlastScope(
	payload: ManualSqlPayload,
	context: ObservationContext,
): readonly ResourceAddress[] {
	return [
		...payload.blastRadius,
		{
			engine: 'postgresql',
			database: context.databaseId,
			schema: DBSP_META_SCHEMA,
			kind: 'schema',
			name: DBSP_META_SCHEMA,
		},
	];
}

function resourceSelector(resource: ResourceAddress): ResourceSelector {
	return {
		kind: resource.kind,
		...(resource.schema ? { schema: resource.schema } : {}),
		name: resource.name,
	};
}

function assertResource(value: unknown, field: string): ResourceAddress {
	if (!isRecord(value)) {
		throw new Error(`${field} must be a resource address`);
	}
	const { engine, database, schema, kind, name, qualifiedBy } = value;
	if (
		typeof engine !== 'string' ||
		typeof database !== 'string' ||
		(schema !== undefined && typeof schema !== 'string') ||
		typeof kind !== 'string' ||
		typeof name !== 'string' ||
		(qualifiedBy !== undefined &&
			(!Array.isArray(qualifiedBy) ||
				!qualifiedBy.every((item) => typeof item === 'string')))
	) {
		throw new Error(`${field} must be a resource address`);
	}
	return {
		engine,
		database,
		...(schema !== undefined ? { schema } : {}),
		kind,
		name,
		...(qualifiedBy !== undefined ? { qualifiedBy } : {}),
	};
}

function assertNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function assertUserBlastRadiusAttestation(
	value: unknown,
	statementAssumption: string,
): Assumption {
	if (!isRecord(value)) {
		throw new Error(
			'ManualSql statement attestation must be a human user-blast-radius assumption',
		);
	}
	const id = assertNonEmptyString(value.id, 'ManualSql attestation id');
	if (statementAssumption !== id) {
		throw new Error(
			'ManualSql statement assumption must match its attestation id',
		);
	}
	const statement = assertNonEmptyString(
		value.statement,
		'ManualSql attestation statement',
	);
	if (
		value.class !== 'user-blast-radius' ||
		!isRecord(value.asserter) ||
		value.asserter.kind !== 'human' ||
		typeof value.asserter.identity !== 'string' ||
		!Array.isArray(value.scope)
	) {
		throw new Error(
			'ManualSql statement attestation must be a human user-blast-radius assumption',
		);
	}
	return {
		id: id as Assumption['id'],
		class: 'user-blast-radius',
		asserter: { kind: 'human', identity: value.asserter.identity },
		statement,
		scope: value.scope.map((resource, index) =>
			assertResource(resource, `ManualSql attestation scope[${index}]`),
		),
	};
}

function assertProposition(value: unknown, field: string): Proposition {
	if (!isRecord(value)) {
		throw new Error(`${field} must be a proposition`);
	}
	const kind = assertNonEmptyString(value.kind, `${field}.kind`);
	if (kind === 'unknown') {
		throw new Error(`${field}.kind must be a known proposition kind`);
	}
	if (!Array.isArray(value.scope)) {
		throw new Error(`${field}.scope must be an array of resource addresses`);
	}
	const scope = value.scope.map((resource, index) =>
		assertResource(resource, `${field}.scope[${index}]`),
	);
	if (value.detail === undefined) {
		return { kind, scope };
	}
	return {
		kind,
		scope,
		detail: value.detail as Exclude<Proposition['detail'], undefined>,
	};
}

function assertAssertion(value: unknown, field: string): ExecutableAssertion {
	if (!isRecord(value) || !Array.isArray(value.scope)) {
		throw new Error(`${field} must be an executable assertion`);
	}
	return {
		proposition: assertProposition(value.proposition, `${field}.proposition`),
		scope: value.scope.map((resource, index) =>
			assertResource(resource, `${field}.scope[${index}]`),
		),
	};
}

type SqlScanState =
	| { readonly kind: 'code' }
	| { readonly kind: 'single-quote'; readonly backslashEscapes: boolean }
	| { readonly kind: 'quoted-identifier' }
	| { readonly kind: 'line-comment' }
	| { readonly kind: 'block-comment'; readonly depth: number }
	| { readonly kind: 'dollar-quote'; readonly delimiter: string };

const IDENTIFIER_START_RE = /[A-Za-z_]/u;
const IDENTIFIER_CONTINUE_RE = /[A-Za-z0-9_$]/u;
const DOLLAR_QUOTE_RE = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u;

function isSqlWhitespace(ch: string): boolean {
	return /\s/u.test(ch);
}

function dollarQuoteDelimiterAt(
	text: string,
	index: number,
): string | undefined {
	const match = DOLLAR_QUOTE_RE.exec(text.slice(index));
	return match?.[0];
}

function singleQuoteUsesBackslashEscapes(
	text: string,
	quoteIndex: number,
): boolean {
	let index = quoteIndex - 1;
	while (index >= 0 && isSqlWhitespace(text[index] ?? '')) {
		index -= 1;
	}
	return (
		index >= 0 &&
		(text[index] === 'E' || text[index] === 'e') &&
		(index === 0 || !IDENTIFIER_CONTINUE_RE.test(text[index - 1] ?? ''))
	);
}

function assertSingleSqlStatement(text: string): void {
	let state: SqlScanState = { kind: 'code' };
	let hasStatementContent = false;
	let statements = 0;
	let sawEmptyStatement = false;

	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index] ?? '';
		const next = text[index + 1] ?? '';

		switch (state.kind) {
			case 'line-comment':
				if (ch === '\n' || ch === '\r') {
					state = { kind: 'code' };
				}
				continue;
			case 'block-comment':
				if (ch === '/' && next === '*') {
					state = { kind: 'block-comment', depth: state.depth + 1 };
					index += 1;
					continue;
				}
				if (ch === '*' && next === '/') {
					const depth: number = state.depth - 1;
					state =
						depth === 0 ? { kind: 'code' } : { kind: 'block-comment', depth };
					index += 1;
				}
				continue;
			case 'single-quote':
				if (state.backslashEscapes && ch === '\\') {
					index += 1;
					continue;
				}
				if (ch === "'" && next === "'") {
					index += 1;
					continue;
				}
				if (ch === "'") {
					state = { kind: 'code' };
				}
				continue;
			case 'quoted-identifier':
				if (ch === '"' && next === '"') {
					index += 1;
					continue;
				}
				if (ch === '"') {
					state = { kind: 'code' };
				}
				continue;
			case 'dollar-quote':
				if (text.startsWith(state.delimiter, index)) {
					index += state.delimiter.length - 1;
					state = { kind: 'code' };
				}
				continue;
			case 'code':
				break;
		}

		if (ch === '-' && next === '-') {
			state = { kind: 'line-comment' };
			index += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			state = { kind: 'block-comment', depth: 1 };
			index += 1;
			continue;
		}
		if (ch === "'") {
			hasStatementContent = true;
			state = {
				kind: 'single-quote',
				backslashEscapes: singleQuoteUsesBackslashEscapes(text, index),
			};
			continue;
		}
		if (ch === '"') {
			hasStatementContent = true;
			state = { kind: 'quoted-identifier' };
			continue;
		}
		if (ch === '$') {
			const delimiter = dollarQuoteDelimiterAt(text, index);
			if (delimiter) {
				hasStatementContent = true;
				state = { kind: 'dollar-quote', delimiter };
				index += delimiter.length - 1;
				continue;
			}
		}
		if (ch === ';') {
			if (!hasStatementContent) {
				sawEmptyStatement = true;
				continue;
			}
			statements += 1;
			hasStatementContent = false;
			continue;
		}
		if (!isSqlWhitespace(ch)) {
			hasStatementContent = true;
		}
	}

	if (state.kind !== 'code' && state.kind !== 'line-comment') {
		throw new Error(
			'ManualSql statement must be a single complete PostgreSQL statement',
		);
	}
	if (hasStatementContent) {
		statements += 1;
	}
	if (sawEmptyStatement || statements !== 1) {
		throw new Error('ManualSql requires exactly one PostgreSQL statement');
	}
}

function sqlCodeTokens(text: string, maxTokens: number): readonly string[] {
	let state: SqlScanState = { kind: 'code' };
	const tokens: string[] = [];
	for (
		let index = 0;
		index < text.length && tokens.length < maxTokens;
		index += 1
	) {
		const ch = text[index] ?? '';
		const next = text[index + 1] ?? '';

		switch (state.kind) {
			case 'line-comment':
				if (ch === '\n' || ch === '\r') {
					state = { kind: 'code' };
				}
				continue;
			case 'block-comment':
				if (ch === '/' && next === '*') {
					state = { kind: 'block-comment', depth: state.depth + 1 };
					index += 1;
					continue;
				}
				if (ch === '*' && next === '/') {
					const depth: number = state.depth - 1;
					state =
						depth === 0 ? { kind: 'code' } : { kind: 'block-comment', depth };
					index += 1;
				}
				continue;
			case 'single-quote':
				if (state.backslashEscapes && ch === '\\') {
					index += 1;
					continue;
				}
				if (ch === "'" && next === "'") {
					index += 1;
					continue;
				}
				if (ch === "'") {
					state = { kind: 'code' };
				}
				continue;
			case 'quoted-identifier':
				if (ch === '"' && next === '"') {
					index += 1;
					continue;
				}
				if (ch === '"') {
					state = { kind: 'code' };
				}
				continue;
			case 'dollar-quote':
				if (text.startsWith(state.delimiter, index)) {
					index += state.delimiter.length - 1;
					state = { kind: 'code' };
				}
				continue;
			case 'code':
				break;
		}

		if (ch === '-' && next === '-') {
			state = { kind: 'line-comment' };
			index += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			state = { kind: 'block-comment', depth: 1 };
			index += 1;
			continue;
		}
		if (ch === "'") {
			state = {
				kind: 'single-quote',
				backslashEscapes: singleQuoteUsesBackslashEscapes(text, index),
			};
			continue;
		}
		if (ch === '"') {
			state = { kind: 'quoted-identifier' };
			continue;
		}
		if (ch === '$') {
			const delimiter = dollarQuoteDelimiterAt(text, index);
			if (delimiter) {
				state = { kind: 'dollar-quote', delimiter };
				index += delimiter.length - 1;
				continue;
			}
		}
		if (!IDENTIFIER_START_RE.test(ch)) {
			continue;
		}
		let end = index + 1;
		while (end < text.length && IDENTIFIER_CONTINUE_RE.test(text[end] ?? '')) {
			end += 1;
		}
		tokens.push(text.slice(index, end).toUpperCase());
		index = end - 1;
	}
	return tokens;
}

function assertNotTransactionControlStatement(text: string): void {
	const tokens = sqlCodeTokens(text, 3);
	const first = tokens[0];
	const second = tokens[1];
	if (
		first === 'BEGIN' ||
		first === 'COMMIT' ||
		first === 'END' ||
		first === 'ROLLBACK' ||
		first === 'ABORT' ||
		first === 'SAVEPOINT' ||
		(first === 'RELEASE' && second === 'SAVEPOINT') ||
		(first === 'SET' && second === 'TRANSACTION') ||
		(first === 'START' && second === 'TRANSACTION') ||
		(first === 'PREPARE' && second === 'TRANSACTION')
	) {
		throw new Error(
			'ManualSql must not execute transaction-control statements',
		);
	}
}

function assertUnsafeStatement(value: unknown): UnsafeNativeFragment {
	if (
		!isRecord(value) ||
		value.kind !== 'unsafe-native' ||
		value.category !== 'statement' ||
		typeof value.text !== 'string' ||
		value.text.trim().length === 0 ||
		typeof value.assumption !== 'string'
	) {
		throw new Error(
			'ManualSql requires one unsafe-native statement fragment with a user-blast-radius attestation',
		);
	}
	const attestation = assertUserBlastRadiusAttestation(
		value.attestation,
		value.assumption,
	);
	assertSingleSqlStatement(value.text);
	assertNotTransactionControlStatement(value.text);
	return {
		kind: 'unsafe-native',
		category: 'statement',
		text: value.text,
		assumption: value.assumption as UnsafeNativeFragment['assumption'],
		attestation,
	};
}

function payloadOf(
	operation: PhysicalOperation,
	context: ObservationContext,
): ManualSqlPayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !== MANUAL_SQL_OPERATION_KIND.name
	) {
		throw new Error('unsupported operation kind for ManualSql');
	}
	if (!isRecord(operation.payload)) {
		throw new Error('ManualSql payload must be an object');
	}
	const { statement, blastRadius, preconditions, postconditions } =
		operation.payload;
	if (!Array.isArray(blastRadius) || blastRadius.length === 0) {
		throw new Error('ManualSql requires a non-empty declared blastRadius');
	}
	if (!Array.isArray(preconditions) || !Array.isArray(postconditions)) {
		throw new Error(
			'ManualSql requires declared preconditions and postconditions',
		);
	}
	return normalizedValidatedPayload(
		{
			statement: assertUnsafeStatement(statement),
			blastRadius: blastRadius.map((resource, index) =>
				assertResource(resource, `blastRadius[${index}]`),
			),
			preconditions: preconditions.map((assertion, index) =>
				assertAssertion(assertion, `preconditions[${index}]`),
			),
			postconditions: postconditions.map((assertion, index) =>
				assertAssertion(assertion, `postconditions[${index}]`),
			),
		},
		context,
	);
}

function userBlastRadiusAssumption(
	payload: ManualSqlPayload,
	context: ObservationContext,
): Assumption {
	const attestation = payload.statement.attestation;
	if (!attestation) {
		throw new Error(
			'ManualSql statement is missing its user-blast-radius assumption',
		);
	}
	return {
		...attestation,
		scope: normalizeAssumptionScope(
			attestation.scope,
			payload.blastRadius,
			context,
		),
	};
}

function assertUserBlastRadiusCoversPayload(
	assumption: Assumption,
	blastRadius: readonly ResourceAddress[],
): void {
	if (!resourceScopeCovers(assumption.scope, blastRadius)) {
		throw new Error(
			'ManualSql user-blast-radius attestation scope must cover the declared blastRadius',
		);
	}
}

function normalizedValidatedPayload(
	payload: ManualSqlPayload,
	context: ObservationContext,
): ManualSqlPayload {
	const statement = assertUnsafeStatement(payload.statement);
	const blastRadius = payload.blastRadius.map((resource, index) =>
		assertResource(resource, `blastRadius[${index}]`),
	);
	const preconditions = payload.preconditions.map((assertion, index) =>
		assertAssertion(assertion, `preconditions[${index}]`),
	);
	const postconditions = payload.postconditions.map((assertion, index) =>
		assertAssertion(assertion, `postconditions[${index}]`),
	);
	const validated = { statement, blastRadius, preconditions, postconditions };
	const attestation = userBlastRadiusAssumption(validated, context);
	assertUserBlastRadiusCoversPayload(attestation, blastRadius);
	return {
		statement: {
			...statement,
			attestation,
		},
		blastRadius,
		preconditions,
		postconditions,
	};
}

export function normalizeManualSqlPayload(
	payload: ManualSqlPayload,
	context: ObservationContext,
): ManualSqlPayload {
	return normalizedValidatedPayload(payload, context);
}

function fingerprintFor(
	payload: ManualSqlPayload,
	context: ObservationContext,
	phase: 'before' | 'after',
): FingerprintManifest {
	const assertions =
		phase === 'before' ? payload.preconditions : payload.postconditions;
	const includedFacts = [
		fact('manual-sql.statement.sha256', digest(payload.statement.text)),
		fact('manual-sql.phase', phase),
		fact('manual-sql.declared-blast-radius', payload.blastRadius),
		fact('manual-sql.declared-assertions', assertions),
		fact(
			'manual-sql.user-blast-radius',
			userBlastRadiusAssumption(payload, context),
		),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts: [
			{
				key: 'manual-sql.semantic-safety',
				reason:
					'ManualSql is an explicit escape hatch; dbsp does not parse or prove the statement beyond its declared statement category and accepted user-blast-radius assumption.',
			},
		],
		digest: digest(includedFacts),
	};
}

function beforeAfterFingerprints(
	operation: PhysicalOperation,
	_evidence: readonly EvidenceObservation[],
	context: ObservationContext,
) {
	const payload = payloadOf(operation, context);
	return {
		expectedBefore: fingerprintFor(payload, context, 'before'),
		expectedAfter: fingerprintFor(payload, context, 'after'),
	};
}

export function createManualSqlOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		operationKind: MANUAL_SQL_OPERATION_KIND,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name === MANUAL_SQL_OPERATION_KIND.name
			);
		},
		effectsOf(
			operation: PhysicalOperation,
			context: ObservationContext,
		): OperationEffectAssessment {
			const payload = payloadOf(operation, context);
			const selectors = payload.blastRadius.map(resourceSelector);
			return {
				effects: {
					reads: selectors,
					writes: selectors,
					locks: [],
					invalidates: selectors.map((scope) => ({ scope })),
					contextMutations: [],
					externalEffects: {
						accountedFor: selectors,
						couldNotAccountFor: [],
					},
					execution: {
						transaction: 'joins-current',
						commitBoundary: 'none',
					},
				},
				restsOn: [
					operationPackSemanticsAssumption(payload, context),
					userBlastRadiusAssumption(payload, context),
				],
			};
		},
		buildFingerprints: beforeAfterFingerprints,
		async writeIntentJournal(
			client: TransitionExecutionClient,
			record: DurableIntentRecord,
		) {
			await appendIntentJournal(clientQuery(client), record);
		},
		async begin(client: TransitionExecutionClient) {
			await clientQuery(client).query('BEGIN');
		},
		async setLockTimeout(
			_client: TransitionExecutionClient,
			_maxWaitMs: number,
		) {
			// ManualSql does not infer object locks from opaque SQL text.
		},
		async acquireLocks() {
			// ManualSql has only declared blast radius; the human attestation is policy gated.
		},
		async observeContext(
			client: TransitionExecutionClient,
			_operation: PhysicalOperation,
			proofContext: ObservationContext,
		) {
			return readPgObservationContextFromClient(
				client.opaqueClient,
				proofContext.targetSchema ?? proofContext.searchPath?.[0] ?? 'public',
			);
		},
		async observeOperation(
			_client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
			phase: 'before' | 'after',
		) {
			return {
				observations: [],
				fingerprint: fingerprintFor(
					payloadOf(operation, context),
					context,
					phase,
				),
			};
		},
		async checkGuard() {
			return { passed: true, observations: [], recovery: [] };
		},
		async executeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
		) {
			await clientQuery(client).query(
				payloadOf(operation, context).statement.text,
			);
			return { kind: 'completed' as const };
		},
		async writeCompletionJournal(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			record: TransactionalCompletionRecord,
		) {
			await appendCompletionJournal(clientQuery(client), operation, record);
		},
		async commit(client: TransitionExecutionClient) {
			await clientQuery(client).query('COMMIT');
		},
		async rollback(client: TransitionExecutionClient) {
			await clientQuery(client).query('ROLLBACK');
		},
		async writeObservedJournal(
			client: TransitionExecutionClient,
			journal: StepJournal,
		) {
			await appendObservedJournal(clientQuery(client), journal);
		},
		isLockTimeout(error: unknown) {
			return isPgGuardTimeout(error);
		},
	};
}
