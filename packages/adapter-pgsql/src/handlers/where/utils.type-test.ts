import type { RelationBinding } from '../../binding-registry.js';
import { resolvedWhereColumnRef } from './utils.js';

declare const binding: RelationBinding;

// @ts-expect-error WHERE emission refuses an unclassified SQL identifier.
resolvedWhereColumnRef('forged_column', binding);
