# ADR 0005: Durable Transition Execution

## Status

Accepted. It is the execution decision ADR 0003 deferred.

> ADR 0006 (Accepted) replaces this ADR's transactional-only admission rule,
> intent-after-observation ordering rule, and separate direct/file-based DDL
> execution rule.

## Decision

`dbsp apply <run-id>` executes a plan that `dbsp plan` proved and recorded.
`dbsp recover <run-id>` observes a recorded run and classifies it against live
state. Neither takes a schema and neither re-plans: what executes is the durable
run, not a fresh comparison.

Both require `--plan-digest`. The digest is supplied from outside the database,
so replacing the stored plan and its recorded digest together under one run
identifier does not produce an authorized apply. Recovery loads, snapshots and
freezes the complete journal evidence set (plan, events and authorizations)
once, verifies that digest against that snapshot, and classifies or appends
only from the same verified handle. What the code proves is that the caller
supplied a digest matching the loaded plan; that a human read it is the
operator's discipline, not an enforced property.

Durable apply is **transactional only**. A plan whose segment forbids a
transaction — `CREATE UNIQUE INDEX CONCURRENTLY` is the case that exists — is
plannable, reviewable and recorded, and then refused at admission. Durable
atomicity is claimed per run, and a segment that cannot be wrapped cannot carry
that claim.

> Superseded by ADR 0006: admitted execution now owns both transactional and
> non-transactional outcome protocols. This paragraph is historical only.

Admission decides before authorization, before intent, and before any planned
DDL: the loaded plan must hash to the supplied digest and to the recorded one,
the recorded core version must be executable by this runtime, structural and
semantic invariants must hold, every assumption must be accepted, and the run
must carry no step-attempt events. A run with events is not pristine and the
operator is sent to `recover`. Admission is not, however, before every lease —
the run lock and the journal read each take one first.

Adoption is all-or-nothing. Execution mints the recorded sequence unchanged or
refuses. It does not retain steps judged unaffected, drop steps whose
`expectedAfter` already matches live state, or reorder; each of those is a
different plan needing its own proof.

Whether a step still applies is decided against the live database under that
step's locks, immediately before its DDL — never from the stored artifact alone.
The supplied digest answers whether the artifact is intact; the per-step
`expectedBefore` fingerprint answers whether the target is unchanged. Intent is
written *after* lock timeout setup, locking, live-context observation and the
`expectedBefore` check. A moved fingerprint in the first uncommitted segment is
therefore refused with no per-step event and the run remains pristine for
re-planning. If an earlier segment committed, its journals remain: the result is
`partially-applied` with `resume-possible`, even though the later moved step has
no event. This boundary rests on a pack obligation: `setLockTimeout`,
`acquireLocks`, `observeContext`, `observeOperation`, and fingerprint construction
must perform no DDL or external effect; `executeOperation` is the first callback
allowed to do so. Physical

> Superseded by ADR 0006: a durable claim is appended before managed DDL under
> the outcome protocol; failed live admission resolves through `refused`.

identity is compared as cluster system identifier, database OID and namespace
OIDs, because a database answering to the same name is not the same database,
and the apply preflight additionally re-derives the contract's requirements and
checks engine version, privileges and session settings on the executing session.

Acceptance is an authorization boundary, not a warning channel. `ApplyPolicy`
requires its `accepts` list explicitly, so a plan resting on an unverified
assumption refuses until an operator accepts it by class or by a policy file
naming trust roots and scope. Before the first planned DDL, an authorization
record is appended durably carrying the policy, the assumption-to-grant mapping,
the actor, a timestamp, and a digest binding all of them to the run and plan. If
that append fails, execution refuses. An exact matching prior approval on a still
pristine run is reused rather than duplicated, so a crash between authorization
and intent does not require a second approval.

A run-level exclusion is held across load, admission, execution and recovery.
It is keyed by run identifier only: two runs touching the same objects are not
mutually excluded. For trusted pack code and trusted plan SQL, a run-id
advisory lock is held while dbsp owns the callback session. Queries made
through the operation-query channel are checked immediately before and after
for that lock and for `client_encoding = UTF8`; a persistent observable
violation fails execution and the session is discarded rather than returned to
the pool. This detects accidental session mutation. It is not continuous
enforcement, does not prove no transient mutation occurred, and does not
contain hostile pack code — a compound statement or a re-entrant lock evades
it.

`recover` reconciles; it does not resume. It verifies the persisted plan and
journal, classifies each attempted step against observed state, and reports
completed, re-plan required, or human intervention required. It is not
read-only: where live state proves a step completed but its observed record is
missing, it appends that record. A pristine, valid event stream returns
immediately: a zero-step plan is completed, otherwise the remaining work needs
a new proof. It performs no target admission, authorization reconstruction,
live read or append in that branch. Its admission is deliberately narrower than
apply's — it proves it is reading the planned cluster, database and namespaces,
since target state may legitimately have moved and revoked DDL authority is
irrelevant to classification — but an attempted run still requires a valid prior
authorization record before any observation.

Applier outcomes reach the operator distinctly. `operation-failed-not-applied`,
`partially-applied` and an uncertain commit carry different continuation advice.
At the durable boundary only, a committed segment whose post-commit
observed-journal write fails becomes `outcome-unknown`: the durable record is
incomplete, and reporting completion would assert what was not written. An
in-process apply still reports completion with a warning, because it makes no
durable claim.

## Consequences

`dbsp migrate apply` is unchanged and stays file-based. A `_dbsp_migrations` row
asserts a file and checksum applied transactionally; a planner run records a
different provenance, and its ledger tracks runs, authorizations and per-step
outcomes rather than files. Writing a legacy row for planner work would be false
provenance, and mapping planner steps onto legacy rows would begin the
recorded-state decision silently. The two ledgers coexist and, by convention
rather than by construction, do not claim the same operation.

> Superseded by ADR 0006: direct `push` and file-based managed execution are
> deleted. This paragraph remains as historical migration-tracker provenance.

An operator must run `plan`, keep its digest, and pass that digest to `apply`.
That is deliberate friction: it is what ties the artifact that was read to the
artifact that runs.

The transactional-only restriction means the concurrent-index path is currently
plannable but not applicable through this command. Lifting it is a decision about
what durable atomicity means for a segment that cannot be wrapped, not an
implementation gap to fill quietly.

> Superseded by ADR 0006's non-transactional `executing` and recovery protocol.

What is claimed here is bounded. `restsOnAssumptions` records which step relies
on an external-DDL exclusion and its scope, and `excludedOrUnknownFacts` carries
a key and a reason — not a prior value, not an epoch. The machinery attributes an
assumption; it does not prove no prohibited DDL occurred between plan and apply.
That remains operator policy, and proving it needs an independent DDL-isolation
or epoch mechanism.

Refusing to converge on an object that already exists, or is already gone, is a
property of each operation's fingerprint rather than of this boundary. It holds
for the create-like operations that exist today; no drop operation is mapped at
all. A future operation could weaken it without this decision noticing.

No cardinality fact is recorded in any transition fingerprint, so a step strategy
chosen by table size could not be proven applicable. Introducing one requires
recording the deciding value or threshold, and its observation validity, first.

Planning and application are not bound to one session configuration (#473):
canonicalization runs on a leased client and execution on another. The recorded
contract narrows this by pinning physical identity and per-step engine
requirements rather than a session fingerprint, but it does not close it.

The recorded-state model — snapshot versus deltas, and the atomicity of the
change/record couple — is not decided here. This decision writes an execution
journal and an authorization record; it does not define how schema state is
represented durably.
