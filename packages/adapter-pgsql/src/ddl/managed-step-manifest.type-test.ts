import * as adapterPublic from '../index.js';
import * as adapterDdl from './index.js';
import type {
	GeneratedColumnDefaultState,
	GeneratedPostconditionDeclarationV3,
} from './managed-step-manifest.js';

const noDefault: GeneratedColumnDefaultState = {
	defaultKind: 'none',
	hasDefault: false,
	identity: null,
};

const authoredDefault: GeneratedColumnDefaultState = {
	defaultKind: 'authored',
	hasDefault: true,
	identity: null,
	defaultExpression: { canonicalFormVersion: 1, sql: '0' },
};

const identityDefault: GeneratedColumnDefaultState = {
	defaultKind: 'identity',
	hasDefault: false,
	identity: 'always',
};

void noDefault;
void authoredDefault;
void identityDefault;

// @ts-expect-error O4: an authored default cannot say that no default exists.
const contradictoryAuthoredDefault: GeneratedColumnDefaultState = {
	defaultKind: 'authored',
	hasDefault: false,
	identity: null,
	defaultExpression: { canonicalFormVersion: 1, sql: '0' },
};

const contradictoryIdentityDefault: GeneratedColumnDefaultState = {
	defaultKind: 'identity',
	hasDefault: false,
	identity: 'byDefault',
	// @ts-expect-error O4: identity is its own state and cannot carry a default expression.
	defaultExpression: { canonicalFormVersion: 1, sql: '0' },
};

const addressedColumnDeclaration: GeneratedPostconditionDeclarationV3 = {
	canonicalFormVersion: 1,
	kind: 'column',
	column: {
		// @ts-expect-error O2: the standalone column target name belongs in TargetBinding, never its declaration.
		name: 'id',
	},
};

void contradictoryAuthoredDefault;
void contradictoryIdentityDefault;
void addressedColumnDeclaration;

// @ts-expect-error The raw rollback-only proof bracket is module-private.
void adapterDdl.withGeneratedPostconditionProof;
// @ts-expect-error The adapter root barrel must not reopen the raw proof bracket.
void adapterPublic.withGeneratedPostconditionProof;
