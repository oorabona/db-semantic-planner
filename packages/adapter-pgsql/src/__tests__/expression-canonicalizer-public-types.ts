import type { ModelIR } from '@dbsp/types';
import { canonicalizeCheckConstraints } from '../expression-canonicalizer.js';
import { engineCanonicalSqlDefault } from '../expression-provenance.js';
import type { PgsqlAdapter } from '../pgsql-adapter.js';

declare const ordinaryAdapter: PgsqlAdapter;
declare const model: ModelIR;

// @ts-expect-error canonicalisation only accepts a withScratchScope-minted scope.
void canonicalizeCheckConstraints(ordinaryAdapter, model, model);

// @ts-expect-error a plain authored string cannot enter the unlexed deparse path.
void engineCanonicalSqlDefault("'back\\slash'::text");
