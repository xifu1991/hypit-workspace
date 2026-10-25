import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'tenant_admin', 'viewer')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS wallets (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  balance_fen INTEGER NOT NULL DEFAULT 0 CHECK (balance_fen >= 0),
  reserved_fen INTEGER NOT NULL DEFAULT 0 CHECK (reserved_fen >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  service TEXT NOT NULL,
  amount_fen INTEGER NOT NULL,
  balance_after_fen INTEGER NOT NULL,
  reference TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_tenant_time
  ON ledger_entries(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS price_rules (
  service TEXT PRIMARY KEY CHECK (service IN ('asr', 'tts', 'tos')),
  unit_size INTEGER NOT NULL CHECK (unit_size > 0),
  unit_name TEXT NOT NULL,
  unit_price_microfen INTEGER NOT NULL CHECK (unit_price_microfen >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT,
  token_id TEXT,
  task_id TEXT,
  service TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_size INTEGER NOT NULL,
  unit_price_microfen INTEGER NOT NULL,
  amount_microfen INTEGER NOT NULL,
  amount_fen INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider_request_id TEXT,
  provider_log_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_tenant_time
  ON usage_events(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gateway_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tts', 'asr')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'processing', 'completed', 'failed')),
  reserved_fen INTEGER NOT NULL,
  actual_fen INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  output_path TEXT,
  response_json TEXT,
  error TEXT,
  provider_request_id TEXT,
  provider_log_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, idempotency_key)
);

CREATE INDEX IF NOT EXISTS gateway_tasks_time
  ON gateway_tasks(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider_speaker_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS recharge_codes (
  code TEXT PRIMARY KEY,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  redeemed_by TEXT REFERENCES users(id),
  redeemed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recharge_orders (
  out_trade_no TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('wechat_native')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'credited', 'failed', 'closed')),
  description TEXT NOT NULL,
  provider_trade_no TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  credited_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS recharge_orders_provider_trade
  ON recharge_orders(provider_trade_no)
  WHERE provider_trade_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS recharge_orders_tenant_time
  ON recharge_orders(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_tenant_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT
);
`;

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  return db;
}

export function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = action();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
