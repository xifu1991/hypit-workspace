import { transaction, makeId, nowIso } from "./database.mjs";
import {
  hashPassword,
  hashToken,
  rechargeCode,
  randomToken,
  tokenPrefix,
  verifyPassword,
} from "./security.mjs";
import { costMicrofen, fenFromMicrofen } from "./money.mjs";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
  HttpError,
} from "./errors.mjs";

function number(value) {
  return Number(value ?? 0);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shanghaiDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function shanghaiDayRange(date = shanghaiDate()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(date));
  if (!match) throw badRequest("date must use YYYY-MM-DD");
  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || shanghaiDate(start) !== date) {
    throw badRequest("date is not a valid calendar day");
  }
  return {
    date,
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function shanghaiMonthRange(month = shanghaiDate().slice(0, 7)) {
  const match = /^(\d{4})-(\d{2})$/u.exec(String(month));
  if (!match) throw badRequest("month must use YYYY-MM");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    throw badRequest("month is not a valid calendar month");
  }
  const monthText = String(monthNumber).padStart(2, "0");
  const start = new Date(`${String(year).padStart(4, "0")}-${monthText}-01T00:00:00+08:00`);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  const nextMonthText = String(nextMonthNumber).padStart(2, "0");
  const end = new Date(
    `${String(nextYear).padStart(4, "0")}-${nextMonthText}-01T00:00:00+08:00`,
  );
  return {
    month: `${String(year).padStart(4, "0")}-${monthText}`,
    start: start.toISOString(),
    end: end.toISOString(),
    startDate: `${String(year).padStart(4, "0")}-${monthText}-01`,
    endDate: new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10),
    dayCount: Math.round((end.getTime() - start.getTime()) / 86_400_000),
  };
}

function usageTokenCount(metadata) {
  const providerUsage = metadata?.providerUsage ?? {};
  const candidates = [
    providerUsage.tokens,
    providerUsage.total_tokens,
    providerUsage.text_tokens,
    metadata?.tokens,
    metadata?.tokenCount,
    metadata?.chars,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return 0;
}

function rechargeOrderId() {
  return `GW${Date.now().toString(36).toUpperCase()}${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 19)
    .toUpperCase()}`;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  initialise(config) {
    const createdAt = nowIso();
    for (const [service, rule] of Object.entries(config.prices)) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO price_rules
            (service, unit_size, unit_name, unit_price_microfen, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(service, rule.unitSize, rule.unit, rule.microfen, createdAt);
    }

    const admin = this.db
      .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")
      .get();
    if (!admin) {
      if (!config.admin.username || !config.admin.password) {
        throw new Error(
          "ADMIN_USERNAME and ADMIN_PASSWORD are required on first startup",
        );
      }
      this.db
        .prepare(
          `INSERT INTO users
            (id, tenant_id, username, password_hash, role, created_at)
           VALUES (?, NULL, ?, ?, 'admin', ?)`,
        )
        .run(
          makeId("usr"),
          config.admin.username,
          hashPassword(config.admin.password),
          createdAt,
        );
      this.audit(null, "admin.bootstrap", null, { username: config.admin.username });
    }

    const interrupted = this.db
      .prepare(
        `SELECT tenant_id, SUM(reserved_fen) AS reserved_fen
         FROM gateway_tasks
         WHERE status IN ('reserved', 'processing')
         GROUP BY tenant_id`,
      )
      .all();
    if (interrupted.length > 0) {
      transaction(this.db, () => {
        const recoveredAt = nowIso();
        for (const row of interrupted) {
          this.db
            .prepare(
              `UPDATE wallets
               SET reserved_fen = MAX(0, reserved_fen - ?), updated_at = ?
               WHERE tenant_id = ?`,
            )
            .run(number(row.reserved_fen), recoveredAt, row.tenant_id);
        }
        const result = this.db
          .prepare(
            `UPDATE gateway_tasks
             SET status = 'failed',
                 error = 'Gateway restarted before the provider request completed',
                 updated_at = ?
             WHERE status IN ('reserved', 'processing')`,
          )
          .run(recoveredAt);
        this.audit(null, "gateway.recover_interrupted", null, {
          tasks: Number(result.changes),
        });
      });
    }
  }

  audit(actorUserId, action, targetTenantId, details = {}) {
    this.db
      .prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, target_tenant_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        makeId("aud"),
        actorUserId ?? null,
        action,
        targetTenantId ?? null,
        JSON.stringify(details),
        nowIso(),
      );
  }

  login(username, password, remoteAddress = "") {
    const key = `${String(username).trim().toLowerCase()}|${remoteAddress}`;
    const failure = this.db
      .prepare("SELECT failures, blocked_until FROM login_failures WHERE key = ?")
      .get(key);
    if (failure?.blocked_until && failure.blocked_until > nowIso()) {
      throw new HttpError(429, "Too many login attempts. Try again later.", "rate_limited");
    }

    const user = this.db
      .prepare(
        `SELECT id, tenant_id, username, password_hash, role
         FROM users WHERE lower(username) = lower(?)`,
      )
      .get(String(username).trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      const failures = number(failure?.failures) + 1;
      const blockedUntil =
        failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      this.db
        .prepare(
          `INSERT INTO login_failures(key, failures, blocked_until) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
             blocked_until = excluded.blocked_until`,
        )
        .run(key, failures, blockedUntil);
      throw unauthorized("Invalid username or password");
    }

    this.db.prepare("DELETE FROM login_failures WHERE key = ?").run(key);
    return {
      id: user.id,
      tenantId: user.tenant_id,
      username: user.username,
      role: user.role,
    };
  }

  createSession(user, ttlSeconds) {
    const token = randomToken("hgs_");
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(makeId("ses"), user.id, hashToken(token), expiresAt, createdAt);
    return { token, expiresAt };
  }

  sessionUser(token) {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT s.expires_at, u.id, u.tenant_id, u.username, u.role, t.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN tenants t ON t.id = u.tenant_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token));
    if (!row || row.expires_at <= nowIso()) return null;
    if (row.tenant_id && row.status !== "active") {
      throw forbidden("Tenant is suspended");
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      username: row.username,
      role: row.role,
    };
  }

  deleteSession(token) {
    if (!token) return;
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  requireTenantUser(user) {
    if (!user?.tenantId || !["tenant_admin", "viewer"].includes(user.role)) {
      throw forbidden("A tenant account is required");
    }
    return user.tenantId;
  }

  requireTenantManager(user) {
    const tenantId = this.requireTenantUser(user);
    if (user.role !== "tenant_admin") {
      throw forbidden("Tenant administrator access required");
    }
    return tenantId;
  }

  requireAdmin(user) {
    if (!user || user.role !== "admin") throw forbidden("Administrator access required");
  }

  createTenant({ name, username, password }, actorUserId) {
    const cleanName = String(name ?? "").trim();
    const cleanUsername = String(username ?? "").trim();
    if (cleanName.length < 2) throw badRequest("Tenant name is too short");
    if (cleanUsername.length < 3) throw badRequest("Username is too short");

    return transaction(this.db, () => {
      const tenantId = makeId("ten");
      const createdAt = nowIso();
      this.db
        .prepare("INSERT INTO tenants(id, name, status, created_at) VALUES (?, ?, 'active', ?)")
        .run(tenantId, cleanName, createdAt);
      this.db
        .prepare(
          `INSERT INTO wallets(tenant_id, balance_fen, reserved_fen, updated_at)
           VALUES (?, 0, 0, ?)`,
        )
        .run(tenantId, createdAt);
      this.db
        .prepare(
          `INSERT INTO users
            (id, tenant_id, username, password_hash, role, created_at)
           VALUES (?, ?, ?, ?, 'tenant_admin', ?)`,
        )
        .run(makeId("usr"), tenantId, cleanUsername, hashPassword(password), createdAt);
      this.audit(actorUserId, "tenant.create", tenantId, {
        name: cleanName,
        username: cleanUsername,
      });
      return { tenantId, name: cleanName, username: cleanUsername };
    });
  }

  integrationActorId() {
    const row = this.db
      .prepare(
        "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1",
      )
      .get();
    if (!row) throw notFound("Gateway administrator is not configured");
    return row.id;
  }

  listTenants() {
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.status, t.created_at,
                COALESCE(w.balance_fen, 0) AS balance_fen,
                COALESCE(w.reserved_fen, 0) AS reserved_fen,
                COALESCE((SELECT SUM(-amount_fen) FROM ledger_entries l
                  WHERE l.tenant_id = t.id AND l.amount_fen < 0), 0) AS spent_fen,
                COALESCE((SELECT COUNT(*) FROM usage_events u
                  WHERE u.tenant_id = t.id), 0) AS usage_count,
                COALESCE((SELECT COUNT(*) FROM api_tokens p
                  WHERE p.tenant_id = t.id AND p.enabled = 1), 0) AS api_key_count,
                (SELECT MAX(created_at) FROM usage_events u
                  WHERE u.tenant_id = t.id) AS last_usage_at
         FROM tenants t
         LEFT JOIN wallets w ON w.tenant_id = t.id
         ORDER BY t.created_at ASC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        balanceFen: number(row.balance_fen),
        reservedFen: number(row.reserved_fen),
        spentFen: number(row.spent_fen),
        usageCount: number(row.usage_count),
        apiKeyCount: number(row.api_key_count),
        lastUsageAt: row.last_usage_at,
      }));
  }

  setTenantStatus(tenantId, status, actorUserId) {
    if (!["active", "suspended"].includes(status)) {
      throw badRequest("status must be active or suspended");
    }
    const result = this.db
      .prepare("UPDATE tenants SET status = ? WHERE id = ?")
      .run(status, tenantId);
    if (result.changes === 0) throw notFound("Tenant not found");
    this.audit(actorUserId, "tenant.status", tenantId, { status });
  }

  createApiToken(tenantId, actorUserId, name) {
    const cleanName = String(name ?? "").trim() || "Default token";
    const token = randomToken("hgt_");
    this.db
      .prepare(
        `INSERT INTO api_tokens
          (id, tenant_id, created_by, name, token_hash, prefix, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        makeId("tok"),
        tenantId,
        actorUserId,
        cleanName,
        hashToken(token),
        tokenPrefix(token),
        nowIso(),
      );
    this.audit(actorUserId, "token.create", tenantId, { name: cleanName });
    return { token, name: cleanName };
  }

  listApiTokens(tenantId) {
    return this.db
      .prepare(
        `SELECT id, name, prefix, enabled, created_at, last_used_at
         FROM api_tokens WHERE tenant_id = ? ORDER BY created_at DESC`,
      )
      .all(tenantId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }));
  }

  disableApiToken(tenantId, tokenId, actorUserId) {
    const result = this.db
      .prepare("UPDATE api_tokens SET enabled = 0 WHERE id = ? AND tenant_id = ?")
      .run(tokenId, tenantId);
    if (result.changes === 0) throw notFound("Token not found");
    this.audit(actorUserId, "token.disable", tenantId, { tokenId });
  }

  authenticateApiToken(token) {
    if (!token) throw unauthorized("Gateway token required");
    const row = this.db
      .prepare(
        `SELECT p.id, p.tenant_id, p.enabled, t.status
         FROM api_tokens p JOIN tenants t ON t.id = p.tenant_id
         WHERE p.token_hash = ?`,
      )
      .get(hashToken(token));
    if (!row || !row.enabled) throw unauthorized("Invalid gateway token");
    if (row.status !== "active") throw forbidden("Tenant is suspended");
    this.db
      .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .run(nowIso(), row.id);
    return { id: row.id, tenantId: row.tenant_id };
  }

  addVoice(tenantId, { name, providerSpeakerId }, actorUserId) {
    const cleanName = String(name ?? "").trim();
    const speakerId = String(providerSpeakerId ?? "").trim();
    if (!cleanName || !speakerId) throw badRequest("Voice name and speaker ID are required");
    const existing = this.db
      .prepare(
        `SELECT id, enabled FROM voices
         WHERE tenant_id = ? AND name = ?`,
      )
      .get(tenantId, cleanName);
    if (existing?.enabled) {
      throw conflict("Voice name already exists");
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE voices
           SET provider_speaker_id = ?, enabled = 1, created_at = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .run(speakerId, nowIso(), existing.id, tenantId);
      this.audit(actorUserId, "voice.restore", tenantId, {
        name: cleanName,
        voiceId: existing.id,
      });
      return { id: existing.id, name: cleanName };
    }
    try {
      const id = makeId("voi");
      this.db
        .prepare(
          `INSERT INTO voices
            (id, tenant_id, name, provider_speaker_id, enabled, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(id, tenantId, cleanName, speakerId, nowIso());
      this.audit(actorUserId, "voice.create", tenantId, { name: cleanName });
      return { id, name: cleanName };
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw conflict("Voice name already exists");
      }
      throw error;
    }
  }

  listVoices(tenantId, { includeSpeakerId = false } = {}) {
    return this.db
      .prepare(
        `SELECT id, name, provider_speaker_id, enabled, created_at FROM voices
         WHERE tenant_id = ? AND enabled = 1 ORDER BY created_at ASC`,
      )
      .all(tenantId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        ...(includeSpeakerId ? { speakerId: row.provider_speaker_id } : {}),
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
      }));
  }

  disableVoice(tenantId, voiceId, actorUserId) {
    const result = this.db
      .prepare(
        `UPDATE voices SET enabled = 0
         WHERE id = ? AND tenant_id = ? AND enabled = 1`,
      )
      .run(String(voiceId ?? "").trim(), tenantId);
    if (Number(result.changes) !== 1) throw notFound("Voice not found");
    this.audit(actorUserId, "voice.disable", tenantId, { voiceId });
    return { ok: true };
  }

  resolveVoice(tenantId, name) {
    const voices = this.db
      .prepare(
        `SELECT name, provider_speaker_id FROM voices
         WHERE tenant_id = ? AND enabled = 1 ORDER BY created_at ASC`,
      )
      .all(tenantId);
    if (voices.length === 0) {
      throw conflict("No voice is assigned to this tenant", "voice_not_configured");
    }
    const requested = String(name ?? "").trim();
    const voice =
      requested.length === 0
        ? voices[0]
        : voices.find((item) => item.name === requested);
    if (!voice) throw notFound(`Unknown voice: ${requested}`);
    return { name: voice.name, speakerId: voice.provider_speaker_id };
  }

  price(service) {
    const row = this.db.prepare("SELECT * FROM price_rules WHERE service = ?").get(service);
    if (!row) throw notFound(`Missing price for ${service}`);
    return {
      service,
      unitSize: number(row.unit_size),
      unitName: row.unit_name,
      unitPriceMicrofen: number(row.unit_price_microfen),
    };
  }

  listPrices() {
    return ["asr", "tts", "tos"].map((service) => this.price(service));
  }

  updatePrice(service, unitPriceMicrofen, actorUserId) {
    if (!Number.isSafeInteger(unitPriceMicrofen) || unitPriceMicrofen < 0) {
      throw badRequest("Unit price must be a non-negative integer in microfen");
    }
    const result = this.db
      .prepare("UPDATE price_rules SET unit_price_microfen = ?, updated_at = ? WHERE service = ?")
      .run(unitPriceMicrofen, nowIso(), service);
    if (result.changes === 0) throw notFound("Price rule not found");
    this.audit(actorUserId, "price.update", null, { service, unitPriceMicrofen });
  }

  quoteService(service, quantity) {
    const rule = this.price(service);
    const amountMicrofen = costMicrofen(
      quantity,
      rule.unitSize,
      rule.unitPriceMicrofen,
    );
    return {
      service,
      quantity,
      unitSize: rule.unitSize,
      unitName: rule.unitName,
      unitPriceMicrofen: rule.unitPriceMicrofen,
      amountMicrofen,
      amountFen: fenFromMicrofen(amountMicrofen),
    };
  }

  wallet(tenantId) {
    const row = this.db
      .prepare("SELECT tenant_id, balance_fen, reserved_fen, updated_at FROM wallets WHERE tenant_id = ?")
      .get(tenantId);
    if (!row) throw notFound("Wallet not found");
    return {
      tenantId: row.tenant_id,
      balanceFen: number(row.balance_fen),
      reservedFen: number(row.reserved_fen),
      availableFen: number(row.balance_fen) - number(row.reserved_fen),
      updatedAt: row.updated_at,
    };
  }

  existingTask(tenantId, kind, idempotencyKey) {
    const row = this.db
      .prepare(
        `SELECT * FROM gateway_tasks
         WHERE tenant_id = ? AND kind = ? AND idempotency_key = ?`,
      )
      .get(tenantId, kind, idempotencyKey);
    return row ? this.mapTask(row) : null;
  }

  mapTask(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tokenId: row.token_id,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      reservedFen: number(row.reserved_fen),
      actualFen: number(row.actual_fen),
      input: parseJson(row.input_json, {}),
      outputPath: row.output_path,
      response: parseJson(row.response_json, null),
      error: row.error,
      providerRequestId: row.provider_request_id,
      providerLogId: row.provider_log_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  reserveTask({ tenantId, tokenId, kind, idempotencyKey, reservedFen, input }) {
    if (!idempotencyKey) throw badRequest("Idempotency-Key is required");
    if (String(idempotencyKey).length > 200) {
      throw badRequest("Idempotency-Key must not exceed 200 characters");
    }
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT * FROM gateway_tasks
           WHERE tenant_id = ? AND kind = ? AND idempotency_key = ?`,
        )
        .get(tenantId, kind, idempotencyKey);
      if (existing) return { existing: true, task: this.mapTask(existing) };

      const wallet = this.db
        .prepare("SELECT balance_fen, reserved_fen FROM wallets WHERE tenant_id = ?")
        .get(tenantId);
      if (!wallet) throw notFound("Wallet not found");
      if (number(wallet.balance_fen) - number(wallet.reserved_fen) < reservedFen) {
        throw new HttpError(402, "Insufficient balance", "insufficient_balance", {
          requiredFen: reservedFen,
          availableFen: number(wallet.balance_fen) - number(wallet.reserved_fen),
        });
      }

      const id = makeId("job");
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO gateway_tasks
            (id, tenant_id, token_id, kind, idempotency_key, status, reserved_fen,
             actual_fen, input_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          tenantId,
          tokenId,
          kind,
          idempotencyKey,
          reservedFen,
          JSON.stringify(input),
          createdAt,
          createdAt,
        );
      this.db
        .prepare("UPDATE wallets SET reserved_fen = reserved_fen + ?, updated_at = ? WHERE tenant_id = ?")
        .run(reservedFen, createdAt, tenantId);
      return {
        existing: false,
        task: this.mapTask(
          this.db.prepare("SELECT * FROM gateway_tasks WHERE id = ?").get(id),
        ),
      };
    });
  }

  markTaskProcessing(taskId) {
    const result = this.db
      .prepare(
        `UPDATE gateway_tasks SET status = 'processing', updated_at = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .run(nowIso(), taskId);
    if (result.changes === 0) throw conflict("Task is not reservable");
  }

  completeTask({
    taskId,
    actualFen,
    usageEvents,
    outputPath = null,
    response = null,
    providerRequestId = null,
    providerLogId = null,
  }) {
    return transaction(this.db, () => {
      const task = this.db.prepare("SELECT * FROM gateway_tasks WHERE id = ?").get(taskId);
      if (!task) throw notFound("Task not found");
      if (task.status === "completed") return this.mapTask(task);
      if (!["reserved", "processing"].includes(task.status)) {
        throw conflict("Task cannot be completed");
      }
      const wallet = this.db
        .prepare("SELECT balance_fen, reserved_fen FROM wallets WHERE tenant_id = ?")
        .get(task.tenant_id);
      const eventTotal = usageEvents.reduce((sum, item) => sum + item.amountFen, 0);
      if (eventTotal !== actualFen) {
        throw new Error(`Usage event total ${eventTotal} does not match ${actualFen}`);
      }
      let balance = number(wallet.balance_fen);
      const reserved = number(wallet.reserved_fen);
      if (balance < actualFen) {
        throw new HttpError(402, "Insufficient balance at settlement", "insufficient_balance");
      }
      const createdAt = nowIso();

      for (const event of usageEvents) {
        balance -= event.amountFen;
        this.db
          .prepare(
            `INSERT INTO usage_events
              (id, tenant_id, user_id, token_id, task_id, service, quantity,
               unit_size, unit_price_microfen, amount_microfen, amount_fen,
               status, provider_request_id, provider_log_id, metadata_json, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
          )
          .run(
            makeId("use"),
            task.tenant_id,
            task.token_id,
            task.id,
            event.service,
            event.quantity,
            event.unitSize,
            event.unitPriceMicrofen,
            event.amountMicrofen,
            event.amountFen,
            providerRequestId,
            providerLogId,
            JSON.stringify(event.metadata ?? {}),
            createdAt,
          );
        this.db
          .prepare(
            `INSERT INTO ledger_entries
              (id, tenant_id, kind, service, amount_fen, balance_after_fen,
               reference, description, created_by, created_at)
             VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            makeId("led"),
            task.tenant_id,
            event.service,
            -event.amountFen,
            balance,
            task.id,
            `${event.service} usage ${event.quantity}`,
            createdAt,
          );
      }

      this.db
        .prepare(
          `UPDATE wallets
           SET balance_fen = ?, reserved_fen = ?, updated_at = ?
           WHERE tenant_id = ?`,
        )
        .run(balance, Math.max(0, reserved - number(task.reserved_fen)), createdAt, task.tenant_id);
      this.db
        .prepare(
          `UPDATE gateway_tasks
           SET status = 'completed', actual_fen = ?, output_path = ?,
               response_json = ?, provider_request_id = ?, provider_log_id = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          actualFen,
          outputPath,
          response === null ? null : JSON.stringify(response),
          providerRequestId,
          providerLogId,
          createdAt,
          taskId,
        );
      return this.mapTask(
        this.db.prepare("SELECT * FROM gateway_tasks WHERE id = ?").get(taskId),
      );
    });
  }

  failTask({
    taskId,
    error,
    usageEvents = [],
    providerRequestId = null,
    providerLogId = null,
  }) {
    return transaction(this.db, () => {
      const task = this.db.prepare("SELECT * FROM gateway_tasks WHERE id = ?").get(taskId);
      if (!task) throw notFound("Task not found");
      if (task.status === "completed") return this.mapTask(task);
      const createdAt = nowIso();
      for (const event of usageEvents) {
        this.db
          .prepare(
            `INSERT INTO usage_events
              (id, tenant_id, user_id, token_id, task_id, service, quantity,
               unit_size, unit_price_microfen, amount_microfen, amount_fen,
               status, provider_request_id, provider_log_id, metadata_json, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 'failed', ?, ?, ?, ?)`,
          )
          .run(
            makeId("use"),
            task.tenant_id,
            task.token_id,
            task.id,
            event.service,
            event.quantity,
            event.unitSize,
            event.unitPriceMicrofen,
            providerRequestId,
            providerLogId,
            JSON.stringify(event.metadata ?? {}),
            createdAt,
          );
      }
      this.db
        .prepare(
          `UPDATE wallets
           SET reserved_fen = MAX(0, reserved_fen - ?), updated_at = ?
           WHERE tenant_id = ?`,
        )
        .run(number(task.reserved_fen), createdAt, task.tenant_id);
      this.db
        .prepare(
          `UPDATE gateway_tasks SET status = 'failed', error = ?,
             provider_request_id = ?, provider_log_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(error, providerRequestId, providerLogId, createdAt, taskId);
      return this.mapTask(
        this.db.prepare("SELECT * FROM gateway_tasks WHERE id = ?").get(taskId),
      );
    });
  }

  recharge(tenantId, amountFen, actorUserId, description, service = "recharge") {
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      throw badRequest("Recharge amount must be a positive integer in fen");
    }
    return transaction(this.db, () => {
      const wallet = this.db
        .prepare("SELECT balance_fen FROM wallets WHERE tenant_id = ?")
        .get(tenantId);
      if (!wallet) throw notFound("Wallet not found");
      const balance = number(wallet.balance_fen) + amountFen;
      const createdAt = nowIso();
      this.db
        .prepare("UPDATE wallets SET balance_fen = ?, updated_at = ? WHERE tenant_id = ?")
        .run(balance, createdAt, tenantId);
      this.db
        .prepare(
          `INSERT INTO ledger_entries
            (id, tenant_id, kind, service, amount_fen, balance_after_fen,
             reference, description, created_by, created_at)
           VALUES (?, ?, 'credit', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          makeId("led"),
          tenantId,
          service,
          amountFen,
          balance,
          makeId("manual"),
          description,
          actorUserId ?? null,
          createdAt,
        );
      this.audit(actorUserId, "wallet.recharge", tenantId, { amountFen, description });
      return this.wallet(tenantId);
    });
  }

  createRechargeOrder(
    tenantId,
    amountFen,
    description,
    actorUserId,
    channel = "wechat_native",
  ) {
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      throw badRequest("Recharge amount must be a positive integer in fen");
    }
    if (channel !== "wechat_native") {
      throw badRequest("Unsupported recharge channel");
    }
    return transaction(this.db, () => {
      const wallet = this.db
        .prepare("SELECT tenant_id FROM wallets WHERE tenant_id = ?")
        .get(tenantId);
      if (!wallet) throw notFound("Wallet not found");

      const outTradeNo = rechargeOrderId();
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO recharge_orders
            (out_trade_no, tenant_id, channel, amount_fen, status, description,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          outTradeNo,
          tenantId,
          channel,
          amountFen,
          String(description ?? "AI gateway recharge").slice(0, 127),
          createdAt,
          createdAt,
        );
      this.audit(actorUserId, "recharge_order.create", tenantId, {
        outTradeNo,
        amountFen,
        channel,
      });
      return this.rechargeOrder(outTradeNo);
    });
  }

  rechargeOrder(outTradeNo) {
    const row = this.db
      .prepare("SELECT * FROM recharge_orders WHERE out_trade_no = ?")
      .get(String(outTradeNo ?? "").trim());
    if (!row) throw notFound("Recharge order not found");
    return {
      outTradeNo: row.out_trade_no,
      tenantId: row.tenant_id,
      channel: row.channel,
      amountFen: number(row.amount_fen),
      status: row.status,
      description: row.description,
      providerTradeNo: row.provider_trade_no,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      paidAt: row.paid_at,
      creditedAt: row.credited_at,
    };
  }

  creditRechargeOrder(
    outTradeNo,
    providerTradeNo,
    paidAt,
    actorUserId,
  ) {
    const providerId = String(providerTradeNo ?? "").trim();
    if (!providerId) throw badRequest("Provider trade number is required");

    return transaction(this.db, () => {
      const order = this.db
        .prepare("SELECT * FROM recharge_orders WHERE out_trade_no = ?")
        .get(String(outTradeNo ?? "").trim());
      if (!order) throw notFound("Recharge order not found");

      if (order.status === "credited") {
        if (order.provider_trade_no && order.provider_trade_no !== providerId) {
          throw conflict("Recharge order was credited with another payment");
        }
        return {
          credited: false,
          order: this.rechargeOrder(order.out_trade_no),
          wallet: this.wallet(order.tenant_id),
        };
      }
      if (order.status !== "pending") {
        throw conflict(`Recharge order is ${order.status}`);
      }

      const duplicate = this.db
        .prepare(
          `SELECT out_trade_no FROM recharge_orders
           WHERE provider_trade_no = ? AND out_trade_no <> ?`,
        )
        .get(providerId, order.out_trade_no);
      if (duplicate) throw conflict("WeChat transaction is already linked to another order");

      const wallet = this.db
        .prepare("SELECT balance_fen FROM wallets WHERE tenant_id = ?")
        .get(order.tenant_id);
      if (!wallet) throw notFound("Wallet not found");

      const creditedAt = nowIso();
      const finalPaidAt = String(paidAt ?? creditedAt);
      const balance = number(wallet.balance_fen) + number(order.amount_fen);
      this.db
        .prepare(
          `UPDATE wallets SET balance_fen = ?, updated_at = ? WHERE tenant_id = ?`,
        )
        .run(balance, creditedAt, order.tenant_id);
      this.db
        .prepare(
          `INSERT INTO ledger_entries
            (id, tenant_id, kind, service, amount_fen, balance_after_fen,
             reference, description, created_by, created_at)
           VALUES (?, ?, 'credit', 'wechat_recharge', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          makeId("led"),
          order.tenant_id,
          number(order.amount_fen),
          balance,
          order.out_trade_no,
          order.description,
          actorUserId ?? null,
          creditedAt,
        );
      this.db
        .prepare(
          `UPDATE recharge_orders
           SET status = 'credited', provider_trade_no = ?, paid_at = ?,
               credited_at = ?, updated_at = ?
           WHERE out_trade_no = ? AND status = 'pending'`,
        )
        .run(
          providerId,
          finalPaidAt,
          creditedAt,
          creditedAt,
          order.out_trade_no,
        );
      this.audit(actorUserId, "recharge_order.credit", order.tenant_id, {
        outTradeNo: order.out_trade_no,
        providerTradeNo: providerId,
        amountFen: number(order.amount_fen),
      });
      return {
        credited: true,
        order: this.rechargeOrder(order.out_trade_no),
        wallet: this.wallet(order.tenant_id),
      };
    });
  }

  failRechargeOrder(outTradeNo, reason, actorUserId) {
    return transaction(this.db, () => {
      const order = this.db
        .prepare("SELECT * FROM recharge_orders WHERE out_trade_no = ?")
        .get(String(outTradeNo ?? "").trim());
      if (!order) throw notFound("Recharge order not found");
      if (order.status === "credited") {
        return this.rechargeOrder(order.out_trade_no);
      }
      if (order.status === "pending") {
        this.db
          .prepare(
            `UPDATE recharge_orders SET status = 'failed', updated_at = ?
             WHERE out_trade_no = ? AND status = 'pending'`,
          )
          .run(nowIso(), order.out_trade_no);
        this.audit(actorUserId, "recharge_order.fail", order.tenant_id, {
          outTradeNo: order.out_trade_no,
          reason: String(reason ?? "").slice(0, 200),
        });
      }
      return this.rechargeOrder(order.out_trade_no);
    });
  }

  createRechargeCode(amountFen, tenantId, actorUserId) {
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      throw badRequest("Recharge code amount must be a positive integer in fen");
    }
    const code = rechargeCode();
    this.db
      .prepare(
        `INSERT INTO recharge_codes
          (code, amount_fen, tenant_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(code, amountFen, tenantId || null, actorUserId, nowIso());
    this.audit(actorUserId, "recharge_code.create", tenantId || null, { code, amountFen });
    return { code, amountFen, tenantId: tenantId || null };
  }

  listRechargeCodes(limit = 100) {
    return this.db
      .prepare(
        `SELECT code, amount_fen, tenant_id, redeemed_at, created_at
         FROM recharge_codes ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        code: row.code,
        amountFen: number(row.amount_fen),
        tenantId: row.tenant_id,
        redeemedAt: row.redeemed_at,
        createdAt: row.created_at,
      }));
  }

  redeemRechargeCode(tenantId, code, userId) {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM recharge_codes WHERE code = ?")
        .get(String(code).trim().toUpperCase());
      if (!row) throw notFound("Recharge code not found");
      if (row.redeemed_at) throw conflict("Recharge code has already been used");
      if (row.tenant_id && row.tenant_id !== tenantId) {
        throw forbidden("Recharge code belongs to another tenant");
      }
      const wallet = this.db
        .prepare("SELECT balance_fen FROM wallets WHERE tenant_id = ?")
        .get(tenantId);
      const balance = number(wallet.balance_fen) + number(row.amount_fen);
      const createdAt = nowIso();
      const redeemed = this.db
        .prepare(
          `UPDATE recharge_codes SET redeemed_by = ?, redeemed_at = ?
           WHERE code = ? AND redeemed_at IS NULL`,
        )
        .run(userId, createdAt, row.code);
      if (redeemed.changes === 0) throw conflict("Recharge code has already been used");
      this.db
        .prepare("UPDATE wallets SET balance_fen = ?, updated_at = ? WHERE tenant_id = ?")
        .run(balance, createdAt, tenantId);
      this.db
        .prepare(
          `INSERT INTO ledger_entries
            (id, tenant_id, kind, service, amount_fen, balance_after_fen,
             reference, description, created_by, created_at)
           VALUES (?, ?, 'credit', 'recharge_code', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          makeId("led"),
          tenantId,
          number(row.amount_fen),
          balance,
          row.code,
          "Recharge code redeemed",
          userId,
          createdAt,
        );
      this.audit(userId, "recharge_code.redeem", tenantId, {
        code: row.code,
        amountFen: number(row.amount_fen),
      });
      return this.wallet(tenantId);
    });
  }

  usage(tenantId, { limit = 100, service, date } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const conditions = ["tenant_id = ?"];
    const parameters = [tenantId];
    if (service) {
      conditions.push("service = ?");
      parameters.push(service);
    }
    if (date) {
      const range = shanghaiDayRange(date);
      conditions.push("created_at >= ? AND created_at < ?");
      parameters.push(range.start, range.end);
    }
    parameters.push(safeLimit);
    const rows = this.db
      .prepare(
        `SELECT * FROM usage_events WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...parameters);
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      service: row.service,
      quantity: number(row.quantity),
      unitSize: number(row.unit_size),
      unitPriceMicrofen: number(row.unit_price_microfen),
      amountMicrofen: number(row.amount_microfen),
      amountFen: number(row.amount_fen),
      status: row.status,
      providerRequestId: row.provider_request_id,
      providerLogId: row.provider_log_id,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
    }));
  }

  dailyUsage(tenantId, date = shanghaiDate()) {
    const range = shanghaiDayRange(date);
    const rows = this.db
      .prepare(
        `SELECT id, task_id, amount_fen, metadata_json, created_at
         FROM usage_events
         WHERE tenant_id = ? AND status = 'completed'
           AND created_at >= ? AND created_at < ?
         ORDER BY created_at`,
      )
      .all(tenantId, range.start, range.end);
    const hourlyTasks = Array.from({ length: 24 }, () => new Set());
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      amountFen: 0,
      apiRequests: 0,
      tokens: 0,
    }));
    const dayTasks = new Set();
    let amountFen = 0;
    let tokens = 0;

    for (const row of rows) {
      const createdAt = new Date(row.created_at);
      if (Number.isNaN(createdAt.getTime())) continue;
      const hour = (createdAt.getUTCHours() + 8) % 24;
      const taskId = row.task_id || row.id;
      const rowAmountFen = number(row.amount_fen);
      const rowTokens = usageTokenCount(parseJson(row.metadata_json, {}));
      hourly[hour].amountFen += rowAmountFen;
      hourly[hour].tokens += rowTokens;
      hourlyTasks[hour].add(taskId);
      dayTasks.add(taskId);
      amountFen += rowAmountFen;
      tokens += rowTokens;
    }

    for (let hour = 0; hour < 24; hour += 1) {
      hourly[hour].apiRequests = hourlyTasks[hour].size;
    }

    return {
      date: range.date,
      currency: "CNY",
      amountFen,
      apiRequests: dayTasks.size,
      calls: rows.length,
      tokens,
      hourly,
    };
  }

  usageSummary(tenantId) {
    const byService = this.db
      .prepare(
        `SELECT service, COUNT(*) AS calls, SUM(quantity) AS quantity,
                SUM(amount_fen) AS amount_fen
         FROM usage_events
         WHERE tenant_id = ? AND status = 'completed'
         GROUP BY service ORDER BY service`,
      )
      .all(tenantId)
      .map((row) => ({
        service: row.service,
        calls: number(row.calls),
        quantity: number(row.quantity),
        amountFen: number(row.amount_fen),
      }));
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COUNT(DISTINCT COALESCE(task_id, id)) AS api_requests,
                COALESCE(SUM(amount_fen), 0) AS amount_fen
         FROM usage_events WHERE tenant_id = ? AND status = 'completed'`,
      )
      .get(tenantId);
    return {
      calls: number(totals.calls),
      apiRequests: number(totals.api_requests),
      spentFen: number(totals.amount_fen),
      byService,
    };
  }

  ledger(tenantId, limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db
      .prepare(
        `SELECT id, kind, service, amount_fen, balance_after_fen,
                reference, description, created_at
         FROM ledger_entries WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tenantId, safeLimit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        service: row.service,
        amountFen: number(row.amount_fen),
        balanceAfterFen: number(row.balance_after_fen),
        reference: row.reference,
        description: row.description,
        createdAt: row.created_at,
      }));
  }

  tenantDashboard(tenantId, { date } = {}) {
    const tenant = this.db
      .prepare("SELECT id, name, status, created_at FROM tenants WHERE id = ?")
      .get(tenantId);
    if (!tenant) throw notFound("Tenant not found");
    const usageDate = date || shanghaiDate();
    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        createdAt: tenant.created_at,
      },
      wallet: this.wallet(tenantId),
      summary: this.usageSummary(tenantId),
      dailyUsage: this.dailyUsage(tenantId, usageDate),
      usage: this.usage(tenantId, { limit: 25, date: usageDate }),
      ledger: this.ledger(tenantId, 25),
      voices: this.listVoices(tenantId),
      tokens: this.listApiTokens(tenantId),
    };
  }

  deleteTenant(tenantId, { force = false } = {}, actorUserId) {
    const tenant = this.db
      .prepare(
        `SELECT t.id, t.name, t.status,
                COALESCE(w.balance_fen, 0) AS balance_fen,
                COALESCE((SELECT COUNT(*) FROM usage_events u
                  WHERE u.tenant_id = t.id), 0) AS usage_count,
                COALESCE((SELECT COUNT(*) FROM api_tokens p
                  WHERE p.tenant_id = t.id AND p.enabled = 1), 0) AS api_key_count,
                COALESCE((SELECT COUNT(*) FROM voices v
                  WHERE v.tenant_id = t.id AND v.enabled = 1), 0) AS voice_count,
                COALESCE((SELECT COUNT(*) FROM gateway_tasks g
                  WHERE g.tenant_id = t.id AND g.status IN ('reserved', 'processing')), 0)
                  AS pending_task_count
         FROM tenants t
         LEFT JOIN wallets w ON w.tenant_id = t.id
         WHERE t.id = ?`,
      )
      .get(tenantId);
    if (!tenant) throw notFound("Tenant not found");
    const details = {
      name: tenant.name,
      status: tenant.status,
      balanceFen: number(tenant.balance_fen),
      usageCount: number(tenant.usage_count),
      apiKeyCount: number(tenant.api_key_count),
      voiceCount: number(tenant.voice_count),
      pendingTaskCount: number(tenant.pending_task_count),
    };
    const inUse =
      details.balanceFen > 0 ||
      details.usageCount > 0 ||
      details.apiKeyCount > 0 ||
      details.voiceCount > 0 ||
      details.pendingTaskCount > 0;
    if (inUse && !force) {
      throw conflict(
        "Gateway tenant is in use",
        "tenant_in_use",
        {
          ...details,
          inUse: true,
          requiresForce: true,
        },
      );
    }
    transaction(this.db, () => {
      this.audit(actorUserId, "tenant.delete", tenantId, {
        ...details,
        forced: Boolean(force && inUse),
      });
      const result = this.db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
      if (Number(result.changes) !== 1) throw notFound("Tenant not found");
    });
    return {
      ok: true,
      deletedTenant: {
        id: tenantId,
        ...details,
        forced: Boolean(force && inUse),
      },
    };
  }

  monthlyAdminUsage(month = shanghaiDate().slice(0, 7)) {
    const range = shanghaiMonthRange(month);
    const rows = this.db
      .prepare(
        `SELECT tenant_id,
                substr(datetime(created_at, '+8 hours'), 1, 10) AS usage_date,
                SUM(amount_fen) AS amount_fen
         FROM usage_events
         WHERE status = 'completed'
           AND created_at >= ? AND created_at < ?
         GROUP BY tenant_id, usage_date
         ORDER BY usage_date`,
      )
      .all(range.start, range.end);
    const dailyFen = new Map();
    const byTenantFen = {};
    let revenueFen = 0;
    for (const row of rows) {
      const amountFen = number(row.amount_fen);
      const day = Number(String(row.usage_date).slice(8, 10));
      dailyFen.set(day, number(dailyFen.get(day)) + amountFen);
      byTenantFen[row.tenant_id] = number(byTenantFen[row.tenant_id]) + amountFen;
      revenueFen += amountFen;
    }

    const today = shanghaiDate();
    const currentMonth = today.slice(0, 7);
    const throughDay =
      range.month === currentMonth
        ? Number(today.slice(8, 10))
        : range.month < currentMonth
          ? range.dayCount
          : 0;
    const points = [];
    let cumulativeRevenueFen = 0;
    for (let day = 1; day <= throughDay; day += 1) {
      cumulativeRevenueFen += number(dailyFen.get(day));
      const cumulativeCostFen = Math.round(cumulativeRevenueFen / 3);
      points.push({
        day,
        date: `${range.month}-${String(day).padStart(2, "0")}`,
        revenueFen: cumulativeRevenueFen,
        costFen: cumulativeCostFen,
        profitFen: cumulativeRevenueFen - cumulativeCostFen,
      });
    }

    const costFen = Math.round(revenueFen / 3);
    const profitFen = revenueFen - costFen;
    return {
      month: range.month,
      startDate: range.startDate,
      endDate: range.endDate,
      throughDate:
        throughDay > 0
          ? `${range.month}-${String(throughDay).padStart(2, "0")}`
          : null,
      dayCount: range.dayCount,
      revenueFen,
      costFen,
      profitFen,
      marginBps: revenueFen > 0 ? Math.round((profitFen / revenueFen) * 10_000) : 0,
      costBasis: "official_price_x3",
      points,
      byTenantFen,
    };
  }

  adminOverview() {
    const monthly = this.monthlyAdminUsage();
    const monthlyByTenantFen = monthly.byTenantFen;
    delete monthly.byTenantFen;
    const tenants = this.listTenants().map((tenant) => ({
      ...tenant,
      monthlySpentFen: number(monthlyByTenantFen[tenant.id]),
      voices: this.listVoices(tenant.id, { includeSpeakerId: true }),
    }));
    return {
      tenants,
      monthly,
      totals: {
        tenants: tenants.length,
        activeTenants: tenants.filter((item) => item.status === "active").length,
        balanceFen: tenants.reduce((sum, item) => sum + item.balanceFen, 0),
        reservedFen: tenants.reduce((sum, item) => sum + item.reservedFen, 0),
        spentFen: tenants.reduce((sum, item) => sum + item.spentFen, 0),
      },
      prices: this.listPrices(),
      rechargeCodes: this.listRechargeCodes(25),
    };
  }

  globalUsage(limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db
      .prepare(
        `SELECT u.id, u.tenant_id, t.name AS tenant_name, u.service,
                u.quantity, u.amount_fen, u.status, u.created_at
         FROM usage_events u JOIN tenants t ON t.id = u.tenant_id
         ORDER BY u.created_at DESC LIMIT ?`,
      )
      .all(safeLimit)
      .map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        service: row.service,
        quantity: number(row.quantity),
        amountFen: number(row.amount_fen),
        status: row.status,
        createdAt: row.created_at,
      }));
  }
}
