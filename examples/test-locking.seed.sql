INSERT INTO jobs (status, priority, payload, worker_id, created_at) VALUES
  ('pending',  10, '{"task":"send_email"}',   NULL,       '2026-01-01 08:00:00'),
  ('pending',   5, '{"task":"resize_image"}', NULL,       '2026-01-01 08:01:00'),
  ('pending',  20, '{"task":"generate_pdf"}', NULL,       '2026-01-01 08:02:00'),
  ('running',  10, '{"task":"sync_data"}',    'worker-1', '2026-01-01 07:55:00'),
  ('done',      5, '{"task":"send_sms"}',     'worker-2', '2026-01-01 07:50:00');
