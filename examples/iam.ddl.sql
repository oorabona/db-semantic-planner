CREATE TABLE "users" (
  "id" SERIAL,
  "username" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "active" BOOLEAN NOT NULL DEFAULT 'true',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "pk_users" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT 'true',
  CONSTRAINT "pk_roles" PRIMARY KEY ("id")
);

CREATE TABLE "permissions" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "resource" VARCHAR(255) NOT NULL,
  "action" VARCHAR(255) NOT NULL,
  "description" TEXT,
  CONSTRAINT "pk_permissions" PRIMARY KEY ("id")
);

CREATE TABLE "resources" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL,
  "type" VARCHAR(255) NOT NULL,
  "parent_id" INTEGER,
  CONSTRAINT "pk_resources" PRIMARY KEY ("id")
);

CREATE TABLE "user_roles" (
  "id" SERIAL,
  "user_id" INTEGER NOT NULL,
  "role_id" INTEGER NOT NULL,
  "granted_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "pk_userRoles" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
  "id" SERIAL,
  "role_id" INTEGER NOT NULL,
  "permission_id" INTEGER NOT NULL,
  CONSTRAINT "pk_rolePermissions" PRIMARY KEY ("id")
);

CREATE TABLE "role_edges" (
  "id" SERIAL,
  "parent_role_id" INTEGER NOT NULL,
  "child_role_id" INTEGER NOT NULL,
  CONSTRAINT "pk_roleEdges" PRIMARY KEY ("id")
);

CREATE TABLE "sod_rules" (
  "id" SERIAL,
  "role_a_id" INTEGER NOT NULL,
  "role_b_id" INTEGER NOT NULL,
  "reason" VARCHAR(255) NOT NULL,
  CONSTRAINT "pk_sodRules" PRIMARY KEY ("id")
);

CREATE TABLE "audit_log" (
  "id" SERIAL,
  "user_id" INTEGER,
  "action" VARCHAR(255) NOT NULL,
  "resource" VARCHAR(255) NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "details" JSONB,
  CONSTRAINT "pk_auditLog" PRIMARY KEY ("id")
);

ALTER TABLE "resources" ADD CONSTRAINT "fk_resources_parentId" FOREIGN KEY ("parent_id") REFERENCES "resources" ("id");

ALTER TABLE "user_roles" ADD CONSTRAINT "fk_userRoles_userId" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;

ALTER TABLE "user_roles" ADD CONSTRAINT "fk_userRoles_roleId" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE CASCADE;

ALTER TABLE "role_permissions" ADD CONSTRAINT "fk_rolePermissions_roleId" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE CASCADE;

ALTER TABLE "role_permissions" ADD CONSTRAINT "fk_rolePermissions_permissionId" FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id") ON DELETE CASCADE;

ALTER TABLE "role_edges" ADD CONSTRAINT "fk_roleEdges_parentRoleId" FOREIGN KEY ("parent_role_id") REFERENCES "roles" ("id") ON DELETE CASCADE;

ALTER TABLE "role_edges" ADD CONSTRAINT "fk_roleEdges_childRoleId" FOREIGN KEY ("child_role_id") REFERENCES "roles" ("id") ON DELETE CASCADE;

ALTER TABLE "sod_rules" ADD CONSTRAINT "fk_sodRules_roleAId" FOREIGN KEY ("role_a_id") REFERENCES "roles" ("id");

ALTER TABLE "sod_rules" ADD CONSTRAINT "fk_sodRules_roleBId" FOREIGN KEY ("role_b_id") REFERENCES "roles" ("id");

ALTER TABLE "audit_log" ADD CONSTRAINT "fk_auditLog_userId" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL;

CREATE INDEX "idx_users_active" ON "users" ("active");

CREATE INDEX "idx_resources_parentId" ON "resources" ("parent_id");

CREATE INDEX "idx_userRoles_userId" ON "user_roles" ("user_id");

CREATE INDEX "idx_userRoles_roleId" ON "user_roles" ("role_id");

CREATE INDEX "idx_rolePermissions_roleId" ON "role_permissions" ("role_id");

CREATE INDEX "idx_rolePermissions_permissionId" ON "role_permissions" ("permission_id");

CREATE INDEX "idx_roleEdges_parentRoleId" ON "role_edges" ("parent_role_id");

CREATE INDEX "idx_roleEdges_childRoleId" ON "role_edges" ("child_role_id");

CREATE INDEX "idx_sodRules_roleAId" ON "sod_rules" ("role_a_id");

CREATE INDEX "idx_sodRules_roleBId" ON "sod_rules" ("role_b_id");

CREATE INDEX "idx_auditLog_timestamp" ON "audit_log" ("timestamp");

CREATE INDEX "idx_auditLog_userId" ON "audit_log" ("user_id");