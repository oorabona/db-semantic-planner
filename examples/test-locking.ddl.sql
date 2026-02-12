CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  worker_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
