-- Hierarchy Schema Seed Data
-- Demonstrates self-referential employees with manager chain

-- Departments
INSERT INTO departments (id, name, budget) VALUES
  (1, 'Engineering', 500000.00),
  (2, 'Product', 300000.00),
  (3, 'Design', 200000.00);

-- Employees (hierarchical structure)
-- CEO (no manager)
INSERT INTO employees (id, name, email, title, department_id, manager_id, hire_date, salary) VALUES
  (1, 'Alice', 'alice@example.com', 'CEO', 1, NULL, '2020-01-15', 250000.00);

-- VPs report to CEO
INSERT INTO employees (id, name, email, title, department_id, manager_id, hire_date, salary) VALUES
  (2, 'Bob', 'bob@example.com', 'VP Engineering', 1, 1, '2020-03-01', 200000.00),
  (3, 'Carol', 'carol@example.com', 'VP Product', 2, 1, '2020-06-15', 190000.00);

-- Directors report to VPs
INSERT INTO employees (id, name, email, title, department_id, manager_id, hire_date, salary) VALUES
  (4, 'Dave', 'dave@example.com', 'Engineering Director', 1, 2, '2021-01-10', 170000.00),
  (5, 'Eve', 'eve@example.com', 'Product Director', 2, 3, '2021-04-20', 160000.00);

-- Engineers report to Director
INSERT INTO employees (id, name, email, title, department_id, manager_id, hire_date, salary) VALUES
  (6, 'Frank', 'frank@example.com', 'Senior Engineer', 1, 4, '2022-02-01', 140000.00),
  (7, 'Grace', 'grace@example.com', 'Engineer', 1, 4, '2022-08-15', 120000.00),
  (8, 'Heidi', 'heidi@example.com', 'Designer', 3, 5, '2023-01-10', 110000.00);

-- Projects
INSERT INTO projects (id, name, lead_id, department_id, status) VALUES
  (1, 'Query Planner v2', 6, 1, 'active'),
  (2, 'Mobile App', 7, 1, 'active'),
  (3, 'Brand Refresh', 8, 3, 'active');

--
-- Resulting hierarchy:
--
--   Alice (CEO)
--   ├── Bob (VP Engineering)
--   │   └── Dave (Engineering Director)
--   │       ├── Frank (Senior Engineer)
--   │       └── Grace (Engineer)
--   └── Carol (VP Product)
--       └── Eve (Product Director)
--           └── Heidi (Designer)
--
