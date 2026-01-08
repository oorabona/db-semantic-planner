---
doc-meta:
  status: canonical
  scope: e2e
  type: specification
  created: 2026-01-08
  updated: 2026-01-08
---

# Specification: E2E-003 IAM/RBAC Recursive CTE Validation

## 1. User Stories

### US-001: Effective Permissions via Role Hierarchy

```
AS A developer building an IAM/RBAC system
I WANT to compute a user's effective permissions through role inheritance
SO THAT I can implement NIST-compliant RBAC with hierarchical roles
```

**ACCEPTANCE:** Given a user with role "admin", all permissions from admin and inherited roles (manager, employee) are returned.

### US-002: Separation of Duty Detection

```
AS A security officer
I WANT to detect users with incompatible role combinations
SO THAT I can enforce separation of duty (SoD) policies
```

**ACCEPTANCE:** Given SoD rules defining incompatible pairs, users violating SoD are identified.

---

## 2. Business Rules

### Invariants

| Rule | Description |
|------|-------------|
| INV-001 | A user's effective permissions = union of all permissions from all roles (direct + inherited) |
| INV-002 | Role inheritance is transitive: if A → B → C, then A inherits from C |
| INV-003 | Permissions are deduplicated (same permission from multiple paths = one entry) |

### Preconditions

| Rule | Description |
|------|-------------|
| PRE-001 | User must exist in users table |
| PRE-002 | Role hierarchy must not exceed maxDepth (cycle safety) |

### Effects

| Rule | Description |
|------|-------------|
| EFF-001 | effectivePermissions(user) returns Set<Permission> |
| EFF-002 | sodViolations(user, rules) returns conflicting role pairs |

### Errors

| Rule | Description |
|------|-------------|
| ERR-001 | User not found → empty result (not error) |
| ERR-002 | Cycle in hierarchy → truncated at maxDepth |

---

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| E2E Testkit | `iam.ddl.ts`, `iam.seed.ts`, `iam.model.ts` | Schema creates successfully |
| E2E Tests | `iam.recursive.test.ts` | All scenarios pass |
| Adapter | None (uses existing RecursiveIntent) | Existing tests still pass |
| Core | None | Existing tests still pass |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Scenario 1: Effective permissions for admin user

```gherkin
Scenario: Compute effective permissions for admin
  Given an IAM schema with role hierarchy:
    | role      | inherits_from |
    | admin     | manager       |
    | manager   | employee      |
    | employee  | -             |
  And permissions assigned:
    | role     | permission       |
    | admin    | users:delete     |
    | manager  | users:edit       |
    | employee | users:read       |
  And user "alice" has direct role "admin"
  When I compute effective permissions for "alice"
  Then the result contains:
    | permission    |
    | users:delete  |
    | users:edit    |
    | users:read    |
```

### Scenario 2: Effective permissions with multiple inheritance paths

```gherkin
Scenario: Permissions from multiple paths are deduplicated
  Given user "bob" has roles "manager" and "auditor"
  And both "manager" and "auditor" inherit "users:read" permission
  When I compute effective permissions for "bob"
  Then "users:read" appears exactly once in the result
```

### Scenario 3: Role hierarchy traversal with depth tracking

```gherkin
Scenario: Traverse role descendants with depth
  Given role "admin" at the top of hierarchy
  When I traverse descendants of "admin" with path tracking
  Then the result includes:
    | role     | depth | path                      |
    | manager  | 1     | admin > manager           |
    | employee | 2     | admin > manager > employee|
```

### Scenario 4: Separation of Duty detection

```gherkin
Scenario: Detect SoD violation
  Given SoD rule: "approver" and "requester" are incompatible
  And user "charlie" has roles "approver" and "requester"
  When I check SoD violations for "charlie"
  Then the result contains conflict: ("approver", "requester")
```

### Scenario 5: User with no roles

```gherkin
Scenario: User with no roles has empty permissions
  Given user "dave" exists but has no roles
  When I compute effective permissions for "dave"
  Then the result is empty
```

### Scenario 6: Bidirectional traversal (ancestors)

```gherkin
Scenario: Find all ancestor roles
  Given role "employee" at the bottom of hierarchy
  When I traverse ancestors of "employee"
  Then the result includes: "manager", "admin"
```

---

## 5. Implementation Plan

### Block 1: IAM Schema DDL + Seed (Vertical Slice)

**Files:**
- `tests/e2e/testkit/iam.ddl.ts` - CREATE TABLE statements
- `tests/e2e/testkit/iam.seed.ts` - Seed data
- `tests/e2e/testkit/iam.model.ts` - ModelIR definition
- `tests/e2e/testkit/index.ts` - Export additions

**Schema:**
```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL
);

-- Roles
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT
);

-- Permissions
CREATE TABLE permissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT
);

-- User-Role junction (many-to-many)
CREATE TABLE user_roles (
  user_id INTEGER REFERENCES users(id),
  role_id INTEGER REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

-- Role-Permission junction (many-to-many)
CREATE TABLE role_permissions (
  role_id INTEGER REFERENCES roles(id),
  permission_id INTEGER REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

-- Role hierarchy edges (edge-table for recursive CTE)
CREATE TABLE role_edges (
  id SERIAL PRIMARY KEY,
  parent_role_id INTEGER REFERENCES roles(id),
  child_role_id INTEGER REFERENCES roles(id),
  UNIQUE (parent_role_id, child_role_id)
);

-- SoD rules (incompatible role pairs)
CREATE TABLE sod_rules (
  id SERIAL PRIMARY KEY,
  role_a_id INTEGER REFERENCES roles(id),
  role_b_id INTEGER REFERENCES roles(id),
  reason TEXT,
  UNIQUE (role_a_id, role_b_id)
);
```

**Seed Data:**
```
Roles: admin, manager, employee, auditor, approver, requester
Hierarchy: admin → manager → employee, admin → auditor
Permissions: users:read, users:edit, users:delete, reports:view, reports:export
Users: alice (admin), bob (manager + auditor), charlie (approver + requester), dave (no roles)
SoD Rule: approver + requester = conflict
```

**Complexity:** M
**Acceptance criteria covered:** Schema foundation for all scenarios

---

### Block 2: Effective Permissions E2E Test

**Files:**
- `tests/e2e/iam.recursive.test.ts` - Main test file

**Tests:**
1. Scenario 1: Admin effective permissions (3 permissions via hierarchy)
2. Scenario 2: Multiple paths deduplication
3. Scenario 5: User with no roles

**Implementation:**
- Use `RecursiveIntent` with `edge-table` traversal on `role_edges`
- Join with `role_permissions` and `permissions` to get permission names
- Use `dedupe: 'final'` to ensure each permission appears once

**Complexity:** M
**Acceptance criteria covered:** #1, #2

---

### Block 3: Role Hierarchy Traversal E2E Test

**Files:**
- `tests/e2e/iam.recursive.test.ts` - Add tests

**Tests:**
1. Scenario 3: Descendants with depth and path tracking
2. Scenario 6: Ancestors traversal

**Implementation:**
- Test `direction: 'out'` for descendants
- Test `direction: 'in'` for ancestors
- Enable `track.depth` and `track.path` options

**Complexity:** S
**Acceptance criteria covered:** #3

---

### Block 4: Separation of Duty E2E Test

**Files:**
- `tests/e2e/iam.recursive.test.ts` - Add tests

**Tests:**
1. Scenario 4: SoD violation detection

**Implementation:**
- Query user's direct roles
- Cross-check against `sod_rules` table
- Return conflicting pairs

**Complexity:** S
**Acceptance criteria covered:** #4

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| Effective permissions | - | - | Yes |
| Multiple paths dedupe | - | - | Yes |
| Hierarchy traversal | Yes (adapter) | - | Yes |
| SoD detection | - | - | Yes |
| User with no roles | - | - | Yes |
| Ancestors traversal | Yes (adapter) | - | Yes |

### Test Data Strategy

- **Fixtures:** IAM schema with deterministic seed
- **Tenant:** Use `iam_test` schema for isolation
- **Cleanup:** DROP SCHEMA CASCADE in afterAll

### Test Commands

```bash
# Run IAM E2E tests only
pnpm test:e2e -- --grep "IAM/RBAC"

# Run all E2E tests
pnpm test:e2e
```

---

## Definition of Done

- [ ] All blocks implemented
- [ ] All 6 BDD scenarios have passing tests
- [ ] All E2E tests pass (including existing)
- [ ] Lint/typecheck pass
- [ ] TODO_E2E.md updated
- [ ] Documentation updated (this spec → canonical)
