-- test-strategies seed data
-- Deterministic IDs for predictable db.* assertion results

-- Orgs (hierarchy: Corp → Engineering, Corp → Sales)
INSERT INTO "orgs" ("id", "name", "parent_id", "active") VALUES
  (1, 'Corp', NULL, true),
  (2, 'Engineering', 1, true),
  (3, 'Sales', 1, true);

-- Departments (spread across orgs)
INSERT INTO "departments" ("id", "name", "org_id", "budget") VALUES
  (1, 'Backend', 2, 500000),
  (2, 'Frontend', 2, 300000),
  (3, 'Outbound', 3, 200000);

-- Employees (6 total, varied salaries for BETWEEN/LIKE/IN testing)
-- dept 1: Alice (120k), Bob (85k)
-- dept 2: Carol (95k), Dave (45k)
-- dept 3: Eve (60k), Frank (30k)
INSERT INTO "employees" ("id", "name", "email", "department_id", "salary", "hire_date", "active") VALUES
  (1, 'Alice', 'alice@test.com', 1, 120000, '2022-01-15', true),
  (2, 'Bob', 'bob@test.com', 1, 85000, '2022-06-01', true),
  (3, 'Carol', 'carol@test.com', 2, 95000, '2023-01-10', true),
  (4, 'Dave', 'dave@test.com', 2, 45000, '2023-06-15', true),
  (5, 'Eve', 'eve@test.com', 3, 60000, '2024-01-01', true),
  (6, 'Frank', 'frank@test.com', 3, 30000, '2024-06-01', false);

-- Projects
INSERT INTO "projects" ("id", "name", "status", "start_date", "end_date") VALUES
  (1, 'Alpha', 'active', '2024-01-01', NULL),
  (2, 'Beta', 'active', '2024-06-01', '2025-01-01');

-- Assignments (M:N employees <-> projects)
-- Alpha: Alice (lead), Bob, Carol
-- Beta: Carol, Eve
INSERT INTO "assignments" ("id", "employee_id", "project_id", "role", "hours_per_week") VALUES
  (1, 1, 1, 'lead', 20),
  (2, 2, 1, 'member', 40),
  (3, 3, 1, 'member', 20),
  (4, 3, 2, 'lead', 20),
  (5, 5, 2, 'member', 40);

-- Tasks
INSERT INTO "tasks" ("id", "title", "project_id", "assignee_id", "priority", "completed") VALUES
  (1, 'Setup CI', 1, 1, 1, true),
  (2, 'Write tests', 1, 2, 2, false),
  (3, 'Design API', 1, 3, 1, false),
  (4, 'Build UI', 2, 3, 2, false),
  (5, 'Deploy', 2, NULL, 3, false);

-- Reset sequences after explicit ID inserts (PostgreSQL SERIAL pattern)
SELECT setval(pg_get_serial_sequence('"orgs"', 'id'), (SELECT MAX("id") FROM "orgs"));
SELECT setval(pg_get_serial_sequence('"departments"', 'id'), (SELECT MAX("id") FROM "departments"));
SELECT setval(pg_get_serial_sequence('"employees"', 'id'), (SELECT MAX("id") FROM "employees"));
SELECT setval(pg_get_serial_sequence('"projects"', 'id'), (SELECT MAX("id") FROM "projects"));
SELECT setval(pg_get_serial_sequence('"assignments"', 'id'), (SELECT MAX("id") FROM "assignments"));
SELECT setval(pg_get_serial_sequence('"tasks"', 'id'), (SELECT MAX("id") FROM "tasks"));

--
-- Summary for assertion reference:
--   orgs: 3 (1 root, 2 children)
--   departments: 3 (2 in Engineering, 1 in Sales)
--   employees: 6 (2 in dept 1, 2 in dept 2, 2 in dept 3; 5 active, 1 inactive)
--   projects: 2
--   assignments: 5 (Alpha=3, Beta=2)
--   tasks: 5 (3 in project 1, 2 in project 2; 1 completed)
--
-- Salary ranges:
--   between 50k-100k: Bob(85k), Carol(95k), Eve(60k) = 3
--   name like 'A%': Alice = 1
--   dept in (1,2,3): all 6; dept not in (4,5): all 6
--   salary > 80k: Alice(120k), Bob(85k), Carol(95k) = 3 (senior)
--   salary > 50k and <= 80k: Eve(60k) = 1 (mid)
--   salary <= 50k: Dave(45k), Frank(30k) = 2 (junior)
--
