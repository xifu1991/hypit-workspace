import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/database.mjs";
import { costMicrofen, fenFromMicrofen } from "../src/money.mjs";
import {
  applyTenantPriceRules,
  PRICE_MARKUP_MULTIPLIER,
  TENANT_PRICE_RULES,
} from "../src/pricing.mjs";

test("tenant prices are Volcano official rates multiplied by three", () => {
  assert.equal(PRICE_MARKUP_MULTIPLIER, 3);

  const expectedFen = {
    asr: 240,
    tts: 90,
    tos: 150,
  };

  for (const [service, rule] of Object.entries(TENANT_PRICE_RULES)) {
    assert.equal(
      rule.microfen,
      rule.officialMicrofen * PRICE_MARKUP_MULTIPLIER,
    );
    assert.equal(
      fenFromMicrofen(
        costMicrofen(rule.unitSize, rule.unitSize, rule.microfen),
      ),
      expectedFen[service],
    );
  }
});

test("existing databases can apply the official pricing policy safely", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      `INSERT INTO price_rules
        (service, unit_size, unit_name, unit_price_microfen, updated_at)
       VALUES ('asr', 1000, 'second', 1000000, '2026-01-01T00:00:00.000Z')`,
    ).run();

    const prices = applyTenantPriceRules(db);
    const asr = prices.find((item) => item.service === "asr");
    assert.deepEqual({ ...asr }, {
      service: "asr",
      unit_size: 3_600_000,
      unit_name: "hour",
      unit_price_microfen: 240_000_000,
      updated_at: asr.updated_at,
    });
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'pricing.official_markup_applied'",
        )
        .get().count,
      1,
    );
  } finally {
    db.close();
  }
});
