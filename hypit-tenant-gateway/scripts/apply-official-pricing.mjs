import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/database.mjs";
import {
  applyTenantPriceRules,
  PRICE_MARKUP_MULTIPLIER,
  PRICE_POLICY_ID,
} from "../src/pricing.mjs";

const apply = process.argv.includes("--apply");
const config = loadConfig();
const db = openDatabase(config.dbPath);

try {
  const before = db
    .prepare(
      `SELECT service, unit_size, unit_name, unit_price_microfen, updated_at
       FROM price_rules
       ORDER BY service`,
    )
    .all();

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        policyId: PRICE_POLICY_ID,
        multiplier: PRICE_MARKUP_MULTIPLIER,
        dbPath: config.dbPath,
        before,
      },
      null,
      2,
    ),
  );

  if (apply) {
    const after = applyTenantPriceRules(db);
    console.log(JSON.stringify({ applied: true, after }, null, 2));
  } else {
    console.log("No changes written. Re-run with --apply to update price_rules.");
  }
} finally {
  db.close();
}
