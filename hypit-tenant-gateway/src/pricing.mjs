import { makeId, nowIso, transaction } from "./database.mjs";

export const PRICE_MARKUP_MULTIPLIER = 3;
export const PRICE_POLICY_ID = "volc-official-3x-v1";

// Official list prices: ASR 0.8 CNY/hour, TTS 0.0003 CNY/char, TOS 0.5 CNY/GB.
export const TENANT_PRICE_RULES = Object.freeze({
  asr: Object.freeze({
    unitSize: 3_600_000,
    unit: "hour",
    officialMicrofen: 80_000_000,
    microfen: 240_000_000,
    envName: "DEFAULT_ASR_MICROFEN_PER_HOUR",
  }),
  tts: Object.freeze({
    unitSize: 1_000,
    unit: "1000_chars",
    officialMicrofen: 30_000_000,
    microfen: 90_000_000,
    envName: "DEFAULT_TTS_MICROFEN_PER_1000_CHARS",
  }),
  tos: Object.freeze({
    unitSize: 1_000_000_000,
    unit: "GB",
    officialMicrofen: 50_000_000,
    microfen: 150_000_000,
    envName: "DEFAULT_TOS_MICROFEN_PER_GB",
  }),
});

export function applyTenantPriceRules(db, { actorUserId = null } = {}) {
  return transaction(db, () => {
    const updatedAt = nowIso();
    const update = db.prepare(
      `INSERT INTO price_rules
        (service, unit_size, unit_name, unit_price_microfen, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET
         unit_size = excluded.unit_size,
         unit_name = excluded.unit_name,
         unit_price_microfen = excluded.unit_price_microfen,
         updated_at = excluded.updated_at`,
    );

    for (const [service, rule] of Object.entries(TENANT_PRICE_RULES)) {
      update.run(service, rule.unitSize, rule.unit, rule.microfen, updatedAt);
    }

    db.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, target_tenant_id, details_json, created_at)
       VALUES (?, ?, 'pricing.official_markup_applied', NULL, ?, ?)`,
    ).run(
      makeId("aud"),
      actorUserId,
      JSON.stringify({
        policyId: PRICE_POLICY_ID,
        multiplier: PRICE_MARKUP_MULTIPLIER,
        prices: TENANT_PRICE_RULES,
      }),
      updatedAt,
    );

    return db
      .prepare(
        `SELECT service, unit_size, unit_name, unit_price_microfen, updated_at
         FROM price_rules
         ORDER BY service`,
      )
      .all();
  });
}
