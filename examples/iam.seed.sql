-- =============================================================================
-- IAM Example: Seed Data
-- =============================================================================
-- Role Hierarchy (via roleEdges):
--   super_admin
--     +-> admin
--     |    +-> manager
--     |    |    +-> editor
--     |    |         +-> viewer
--     |    +-> auditor
--     +-> support_admin
--
-- Users:
--   alice  = super_admin
--   bob    = admin
--   carol  = manager + auditor (dual roles, permission dedup)
--   dave   = editor
--   eve    = viewer (leaf)
--   frank  = approver + requester (SoD violation)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLES (9)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "roles" ("id", "name", "description", "active") VALUES
  (1, 'super_admin', 'Super administrator with all access', true),
  (2, 'admin', 'System administrator', true),
  (3, 'manager', 'Team manager with edit access', true),
  (4, 'editor', 'Content editor', true),
  (5, 'viewer', 'Read-only access', true),
  (6, 'auditor', 'Audit and compliance', true),
  (7, 'support_admin', 'Support team administrator', true),
  (8, 'approver', 'Can approve requests', true),
  (9, 'requester', 'Can create requests', true);
SELECT setval('"roles_id_seq"', 9);

-- ─────────────────────────────────────────────────────────────────────────────
-- PERMISSIONS (13)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id", "name", "resource", "action", "description") VALUES
  (1,  'users:read',       'users',     'read',    'View user profiles'),
  (2,  'users:write',      'users',     'write',   'Create/edit users'),
  (3,  'users:delete',     'users',     'delete',  'Delete users'),
  (4,  'users:admin',      'users',     'admin',   'Full user administration'),
  (5,  'documents:read',   'documents', 'read',    'View documents'),
  (6,  'documents:write',  'documents', 'write',   'Create/edit documents'),
  (7,  'documents:delete', 'documents', 'delete',  'Delete documents'),
  (8,  'reports:read',     'reports',   'read',    'View reports'),
  (9,  'reports:export',   'reports',   'export',  'Export reports'),
  (10, 'system:config',    'system',    'config',  'System configuration'),
  (11, 'system:audit',     'system',    'audit',   'View audit logs'),
  (12, 'requests:create',  'requests',  'create',  'Create new requests'),
  (13, 'requests:approve', 'requests',  'approve', 'Approve pending requests');
SELECT setval('"permissions_id_seq"', 13);

-- ─────────────────────────────────────────────────────────────────────────────
-- RESOURCES (8) — self-ref hierarchy
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "resources" ("id", "name", "type", "parent_id") VALUES
  (1, 'Root',       'folder', NULL),
  (2, 'Documents',  'folder', 1),
  (3, 'Reports',    'folder', 1),
  (4, 'Templates',  'folder', 2),
  (5, 'Archives',   'folder', 2),
  (6, 'Q1 Report',  'file',   3),
  (7, 'Q2 Report',  'file',   3),
  (8, 'Invoice Template', 'file', 4);
SELECT setval('"resources_id_seq"', 8);

-- ─────────────────────────────────────────────────────────────────────────────
-- USERS (6)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "users" ("id", "username", "email", "active") VALUES
  (1, 'alice', 'alice@example.com', true),
  (2, 'bob',   'bob@example.com',   true),
  (3, 'carol', 'carol@example.com', true),
  (4, 'dave',  'dave@example.com',  true),
  (5, 'eve',   'eve@example.com',   true),
  (6, 'frank', 'frank@example.com', false);
SELECT setval('"users_id_seq"', 6);

-- ─────────────────────────────────────────────────────────────────────────────
-- USER ROLES (8)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "user_roles" ("user_id", "role_id", "granted_at") VALUES
  (1, 1, '2025-01-01 00:00:00+00'),  -- alice = super_admin
  (2, 2, '2025-01-15 00:00:00+00'),  -- bob = admin
  (3, 3, '2025-02-01 00:00:00+00'),  -- carol = manager
  (3, 6, '2025-02-01 00:00:00+00'),  -- carol = auditor (dual role)
  (4, 4, '2025-03-01 00:00:00+00'),  -- dave = editor
  (5, 5, '2025-03-15 00:00:00+00'),  -- eve = viewer
  (6, 8, '2025-04-01 00:00:00+00'),  -- frank = approver
  (6, 9, '2025-04-01 00:00:00+00');  -- frank = requester (SoD violation!)

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLE PERMISSIONS (20)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "role_permissions" ("role_id", "permission_id") VALUES
  -- super_admin: users:admin, system:config
  (1, 4),
  (1, 10),
  -- admin: users:delete, system:audit
  (2, 3),
  (2, 11),
  -- manager: users:write, documents:delete, reports:export
  (3, 2),
  (3, 7),
  (3, 9),
  -- editor: documents:read, documents:write
  (4, 5),
  (4, 6),
  -- viewer: users:read, documents:read, reports:read
  (5, 1),
  (5, 5),
  (5, 8),
  -- auditor: reports:read, reports:export, system:audit
  (6, 8),
  (6, 9),
  (6, 11),
  -- support_admin: users:read, users:write
  (7, 1),
  (7, 2),
  -- approver: requests:approve
  (8, 13),
  -- requester: requests:create
  (9, 12);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLE EDGES (7) — hierarchy
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "role_edges" ("id", "parent_role_id", "child_role_id") VALUES
  (1, 1, 2),  -- super_admin -> admin
  (2, 2, 3),  -- admin -> manager
  (3, 3, 4),  -- manager -> editor
  (4, 4, 5),  -- editor -> viewer
  (5, 2, 6),  -- admin -> auditor
  (6, 1, 7),  -- super_admin -> support_admin
  (7, 8, 9);  -- approver -> requester (for testing)
SELECT setval('"role_edges_id_seq"', 7);

-- ─────────────────────────────────────────────────────────────────────────────
-- SOD RULES (2) — Separation of Duty
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "sod_rules" ("id", "role_a_id", "role_b_id", "reason") VALUES
  (1, 8, 9, 'Segregation: requester cannot approve own requests'),
  (2, 2, 6, 'Admin and auditor roles must be separate for compliance');
SELECT setval('"sod_rules_id_seq"', 2);

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT LOG (10)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "audit_log" ("id", "user_id", "action", "resource", "timestamp", "details") VALUES
  (1,  1, 'login',          'system',    '2025-06-01 08:00:00+00', '{"ip": "10.0.0.1"}'),
  (2,  2, 'login',          'system',    '2025-06-01 08:30:00+00', '{"ip": "10.0.0.2"}'),
  (3,  1, 'create_user',    'users',     '2025-06-01 09:00:00+00', '{"target": "dave"}'),
  (4,  2, 'update_role',    'roles',     '2025-06-01 09:15:00+00', '{"role": "editor", "change": "activate"}'),
  (5,  3, 'login',          'system',    '2025-06-01 10:00:00+00', '{"ip": "10.0.0.3"}'),
  (6,  3, 'export_report',  'reports',   '2025-06-01 10:30:00+00', '{"report": "Q1"}'),
  (7,  4, 'edit_document',  'documents', '2025-06-01 11:00:00+00', '{"doc": "spec.md"}'),
  (8,  5, 'login',          'system',    '2025-06-01 11:30:00+00', '{"ip": "10.0.0.5"}'),
  (9,  6, 'create_request', 'requests',  '2025-06-01 12:00:00+00', '{"type": "purchase"}'),
  (10, 6, 'approve_request','requests',  '2025-06-01 12:05:00+00', '{"type": "purchase", "violation": true}');
SELECT setval('"audit_log_id_seq"', 10);
