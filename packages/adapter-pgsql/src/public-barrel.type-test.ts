// These execution primitives are deliberately reachable only through the
// internal subpath (or the admitted-operation façade), never the public API.
import type {
	PgCompileOnlyAdapterOptions,
	PgConvergeRefusalChange,
} from '@dbsp/adapter-pgsql';

const compileOnlyOptions: PgCompileOnlyAdapterOptions = {};
void compileOnlyOptions;

const refusalChange: PgConvergeRefusalChange = {
	kind: 'drop_index',
	table: 'users',
	details: 'Drop index users_email_index',
};
void refusalChange;

// @ts-expect-error destructive compatibility bridge is not public
import { executePgDestructiveOutcome } from '@dbsp/adapter-pgsql';

void executePgDestructiveOutcome;

// @ts-expect-error ordinary callers cannot mint a locked run from the package root
import { lockPgJournalRun } from '@dbsp/adapter-pgsql';

void lockPgJournalRun;

// @ts-expect-error recovery primitive is not public
import { recoverPgOutcomeClaim } from '@dbsp/adapter-pgsql';

void recoverPgOutcomeClaim;

// @ts-expect-error raw non-transactional runner is not public
import { runPgNonTransactionalOutcome } from '@dbsp/adapter-pgsql';

void runPgNonTransactionalOutcome;

// @ts-expect-error raw destructive resolution is not public
import { resolvePgDestructiveOutcome } from '@dbsp/adapter-pgsql';

void resolvePgDestructiveOutcome;

// @ts-expect-error raw re-address runner is not public
import { executePgTableReaddress } from '@dbsp/adapter-pgsql';

void executePgTableReaddress;

// @ts-expect-error decision lowering is internal only
import { compilePlan } from '@dbsp/adapter-pgsql';

void compilePlan;

// The decision compiler and its decision types are not exported from the internal subpath either.
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalBatchValuesJoinDecision = import('@dbsp/adapter-pgsql/internal').BatchValuesJoinDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalCompiledResult = import('@dbsp/adapter-pgsql/internal').CompiledResult;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalCompilePlan = typeof import('@dbsp/adapter-pgsql/internal').compilePlan;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalCompilerOptions = import('@dbsp/adapter-pgsql/internal').CompilerOptions;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalIsBatchValuesJoinDecision = typeof import('@dbsp/adapter-pgsql/internal').isBatchValuesJoinDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalIsJoinDecision = typeof import('@dbsp/adapter-pgsql/internal').isJoinDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalIsPrecompiledJoinDecision = typeof import('@dbsp/adapter-pgsql/internal').isPrecompiledJoinDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalJoinDecision = import('@dbsp/adapter-pgsql/internal').JoinDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalPlanCompiler = typeof import('@dbsp/adapter-pgsql/internal').PlanCompiler;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalPlanDecision = import('@dbsp/adapter-pgsql/internal').PlanDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalPrecompiledJoinDecision = import('@dbsp/adapter-pgsql/internal').PrecompiledJoinDecision;
// biome-ignore format: the expected error must stay on the line after the directive
// @ts-expect-error decision lowering is not exported from the internal subpath
export type RemovedInternalSimplifiedPlanReport = import('@dbsp/adapter-pgsql/internal').SimplifiedPlanReport;
