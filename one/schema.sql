CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  hostname TEXT UNIQUE,
  dns_record_ids TEXT,
  dns_record_id_ha TEXT,
  dns_record_id_ssh TEXT,
  dns_record_id_plc TEXT,
  tunnel_id TEXT,
  tunnel_token TEXT,
  access_app_id TEXT,
  run_command TEXT,
  created_at TEXT,
  updated_at TEXT
);