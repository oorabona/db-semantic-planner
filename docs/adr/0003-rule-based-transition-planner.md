# ADR 0003: Rule-Based Transition Planner

## Status

Accepted for the planning-only release.

## Decision

`dbsp plan` compares an explicit desired schema with a live observation, selects
versioned rule and operation packs, and produces either a blocked assessment,
an inapplicable assessment, no drift, or a proven transition plan. The command
does not modify the target.

A proven plan is a review artifact. It contains its evidence, claims,
assumptions, guarded steps, rule-pack references, and a canonical execution
contract. The complete plan, including that contract, is protected by
`planDigest`; the command prints that digest for review.

The PostgreSQL contract records the physical target as a cluster system
identifier, database OID, and canonically ordered namespace/OID set. It also
records canonical requirement clauses with explicit comparison modes. Unknown
or malformed clauses, unsupported modes, and non-canonical ordering are
refused. Namespace, policy, and selector ordering use code-unit ordering.

Every PostgreSQL planning lease establishes and verifies UTF-8 before catalog
text or supplied identifiers are read. This applies equally to the direct pool
paths used by introspection, context observation, and target identity
collection.

Planning records a durable run and its plan in the transition journal. Journal
creation is distinct from shape verification: verification runs on every
planning use and validates the run, plan, and event relations. The schema has
no authorization relation because planning neither writes nor consumes an
authorization record.

## Consequences

The release offers a reviewable, durable, fail-closed plan artifact but no
transition execution or recovery command. The execution contract remains in
the artifact so it precisely states the target and conditions the plan was
prepared against; its construction and validation remain tested.

Future execution work must be introduced as a new decision, with its own
admission, authorization, journal, locking, and recovery design. It must not
silently reinterpret an artifact made by this release.
