CREATE TABLE "orgs" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL,
  "parent_id" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT 'true',
  CONSTRAINT "pk_orgs" PRIMARY KEY ("id")
);

CREATE TABLE "departments" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL,
  "org_id" INTEGER NOT NULL,
  "budget" NUMERIC,
  CONSTRAINT "pk_departments" PRIMARY KEY ("id")
);

CREATE TABLE "employees" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "department_id" INTEGER NOT NULL,
  "salary" NUMERIC NOT NULL,
  "hire_date" DATE NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT 'true',
  CONSTRAINT "pk_employees" PRIMARY KEY ("id")
);

CREATE TABLE "projects" (
  "id" SERIAL,
  "name" VARCHAR(255) NOT NULL,
  "status" VARCHAR(255) NOT NULL DEFAULT '''active''',
  "start_date" DATE NOT NULL,
  "end_date" DATE,
  CONSTRAINT "pk_projects" PRIMARY KEY ("id")
);

CREATE TABLE "assignments" (
  "id" SERIAL,
  "employee_id" INTEGER NOT NULL,
  "project_id" INTEGER NOT NULL,
  "role" VARCHAR(255) NOT NULL DEFAULT '''member''',
  "hours_per_week" INTEGER NOT NULL DEFAULT '40',
  CONSTRAINT "pk_assignments" PRIMARY KEY ("id")
);

CREATE TABLE "tasks" (
  "id" SERIAL,
  "title" VARCHAR(255) NOT NULL,
  "project_id" INTEGER NOT NULL,
  "assignee_id" INTEGER,
  "priority" INTEGER NOT NULL DEFAULT '3',
  "completed" BOOLEAN NOT NULL DEFAULT 'false',
  CONSTRAINT "pk_tasks" PRIMARY KEY ("id")
);

ALTER TABLE "orgs" ADD CONSTRAINT "fk_orgs_parentId" FOREIGN KEY ("parent_id") REFERENCES "orgs" ("id") ON DELETE SET NULL;

ALTER TABLE "departments" ADD CONSTRAINT "fk_departments_orgId" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id") ON DELETE CASCADE;

ALTER TABLE "employees" ADD CONSTRAINT "fk_employees_departmentId" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE CASCADE;

ALTER TABLE "assignments" ADD CONSTRAINT "fk_assignments_employeeId" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE CASCADE;

ALTER TABLE "assignments" ADD CONSTRAINT "fk_assignments_projectId" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_projectId" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_assigneeId" FOREIGN KEY ("assignee_id") REFERENCES "employees" ("id") ON DELETE SET NULL;

CREATE INDEX "idx_orgs_parentId" ON "orgs" ("parent_id");

CREATE INDEX "idx_departments_orgId" ON "departments" ("org_id");

CREATE INDEX "idx_employees_departmentId" ON "employees" ("department_id");

CREATE INDEX "idx_assignments_employeeId" ON "assignments" ("employee_id");

CREATE INDEX "idx_assignments_projectId" ON "assignments" ("project_id");

CREATE INDEX "idx_tasks_projectId" ON "tasks" ("project_id");

CREATE INDEX "idx_tasks_assigneeId" ON "tasks" ("assignee_id");