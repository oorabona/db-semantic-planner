-- Hierarchy Schema DDL
-- Self-referential employees with manager/reports roles

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  budget DECIMAL(12,2)
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  hire_date DATE NOT NULL DEFAULT CURRENT_DATE,
  salary DECIMAL(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  lead_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'active'
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_projects_lead ON projects(lead_id);
CREATE INDEX IF NOT EXISTS idx_projects_department ON projects(department_id);
