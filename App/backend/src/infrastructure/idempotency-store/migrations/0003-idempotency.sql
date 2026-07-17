CREATE TABLE idempotency_keys (
  adapter_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  body_hash      TEXT NOT NULL,
  response_json  TEXT NOT NULL,
  status_code    INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (adapter_id, request_id)
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
