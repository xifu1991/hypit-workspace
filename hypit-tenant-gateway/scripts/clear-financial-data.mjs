import {
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve(process.argv[2] || "data/gateway.sqlite");
const apply = process.argv.includes("--apply");

if (!existsSync(dbPath)) {
  throw new Error(`Database not found: ${dbPath}`);
}

const db = new DatabaseSync(dbPath, { readOnly: !apply });

function scalar(sql) {
  return Number(Object.values(db.prepare(sql).get())[0] || 0);
}

function snapshot() {
  return {
    tenants: scalar("SELECT COUNT(*) FROM tenants"),
    apiTokens: scalar("SELECT COUNT(*) FROM api_tokens"),
    voices: scalar("SELECT COUNT(*) FROM voices"),
    walletBalanceFen: scalar("SELECT COALESCE(SUM(balance_fen), 0) FROM wallets"),
    walletReservedFen: scalar("SELECT COALESCE(SUM(reserved_fen), 0) FROM wallets"),
    ledgerEntries: scalar("SELECT COUNT(*) FROM ledger_entries"),
    usageEvents: scalar("SELECT COUNT(*) FROM usage_events"),
    usageAmountFen: scalar("SELECT COALESCE(SUM(amount_fen), 0) FROM usage_events"),
    gatewayTasks: scalar("SELECT COUNT(*) FROM gateway_tasks"),
    taskReservedFen: scalar("SELECT COALESCE(SUM(reserved_fen), 0) FROM gateway_tasks"),
    taskActualFen: scalar("SELECT COALESCE(SUM(actual_fen), 0) FROM gateway_tasks"),
    rechargeCodes: scalar("SELECT COUNT(*) FROM recharge_codes"),
    rechargeOrders: scalar("SELECT COUNT(*) FROM recharge_orders"),
    pendingRechargeOrders: scalar(
      "SELECT COUNT(*) FROM recharge_orders WHERE status = 'pending'",
    ),
    recentPendingRechargeOrders: scalar(
      `SELECT COUNT(*) FROM recharge_orders
       WHERE status = 'pending'
         AND julianday(created_at) >= julianday('now', '-30 minutes')`,
    ),
    activeGatewayTasks: scalar(
      "SELECT COUNT(*) FROM gateway_tasks WHERE status IN ('reserved', 'processing')",
    ),
  };
}

const before = snapshot();
if (!apply) {
  const pendingRechargeOrderDetails = db.prepare(
    `SELECT out_trade_no, amount_fen, status, created_at, updated_at
     FROM recharge_orders
     WHERE status = 'pending'
     ORDER BY created_at`,
  ).all();
  console.log(JSON.stringify({
    mode: "audit",
    dbPath,
    before,
    pendingRechargeOrderDetails,
  }, null, 2));
  db.close();
  process.exit(0);
}

if (before.walletReservedFen > 0 || before.activeGatewayTasks > 0) {
  db.close();
  throw new Error("Refusing to clear while gateway tasks still reserve funds");
}
if (before.recentPendingRechargeOrders > 0) {
  db.close();
  throw new Error("Refusing to clear while a recharge order was created in the last 30 minutes");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(dirname(dbPath), "financial-backups");
mkdirSync(backupDir, { recursive: true });
const backupBase = join(backupDir, `gateway-${stamp}`);
for (const suffix of ["", "-wal", "-shm"]) {
  const source = dbPath + suffix;
  if (existsSync(source)) copyFileSync(source, backupBase + ".sqlite" + suffix);
}

db.exec("PRAGMA foreign_keys = ON;");
db.exec("BEGIN IMMEDIATE;");
try {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE wallets SET balance_fen = 0, reserved_fen = 0, updated_at = ?",
  ).run(now);
  db.prepare(
    `UPDATE usage_events
     SET amount_microfen = 0, amount_fen = 0`,
  ).run();
  db.prepare(
    `UPDATE gateway_tasks
     SET reserved_fen = 0, actual_fen = 0`,
  ).run();
  db.exec("DELETE FROM ledger_entries;");
  db.exec("DELETE FROM recharge_codes;");
  db.exec("DELETE FROM recharge_orders;");
  db.exec("COMMIT;");
} catch (error) {
  try {
    db.exec("ROLLBACK;");
  } catch {
    // Preserve the original transaction error.
  }
  db.close();
  throw error;
}

const after = snapshot();
db.close();
console.log(JSON.stringify({
  mode: "apply",
  dbPath,
  backup: backupBase + ".sqlite",
  before,
  after,
}, null, 2));
