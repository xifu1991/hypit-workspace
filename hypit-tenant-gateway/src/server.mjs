import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { openDatabase } from "./database.mjs";
import { Store } from "./store.mjs";
import { createProvider } from "./providers.mjs";
import { GatewayService } from "./gateway.mjs";
import { parseCookies } from "./security.mjs";
import {
  badRequest,
  forbidden,
  HttpError,
  notFound,
  unauthorized,
} from "./errors.mjs";
import { renderAdmin, renderLogin, renderTenant } from "./ui.mjs";

const SESSION_COOKIE = "hypit_session";

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  };
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    ...securityHeaders(),
    Location: location,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, "Request body is too large", "body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON body must be an object");
    }
    return value;
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "Invalid JSON");
  }
}

function formObject(buffer) {
  return Object.fromEntries(new URLSearchParams(buffer.toString("utf8")));
}

function sessionCookie(token, maxAgeSeconds, secure) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearSessionCookie(secure) {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function configuredAppHost(config) {
  if (!config.appOrigin) return "";
  try {
    return new URL(config.appOrigin).host;
  } catch {
    return "";
  }
}

function requireSameOrigin(req, config, { allowConfiguredNullOrigin = false } = {}) {
  const origin = req.headers.origin;
  if (!origin) return;
  const requestHost = String(req.headers.host ?? "");
  if (
    origin === "null" &&
    config.allowNullOrigin &&
    /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/iu.test(requestHost)
  ) {
    return;
  }
  // Some embedded browser hosts submit the same-origin login form with a null origin.
  // Limit that exception to the configured host and to the login endpoint.
  if (origin === "null" && allowConfiguredNullOrigin && configuredAppHost(config) === requestHost) {
    return;
  }
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw forbidden("Invalid request origin");
  }
  if (originUrl.host !== requestHost) {
    if (!config.appOrigin || origin !== config.appOrigin) {
      throw forbidden("Cross-origin request rejected");
    }
  }
}

function authorizationToken(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  return match?.[1]?.trim() ?? "";
}

function requireSaasBridge(req, config) {
  const provided = String(req.headers["x-hypit-bridge-secret"] ?? "");
  const expected = String(config.saasBridgeSecret ?? "");
  if (!provided || !expected) throw unauthorized("SaaS bridge access required");
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw unauthorized("SaaS bridge access denied");
  }
}

function contentTypeFor(format) {
  return (
    {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      pcm: "audio/L16",
      ogg_opus: "audio/ogg",
    }[format] ?? "application/octet-stream"
  );
}

export function createApplication(config = loadConfig()) {
  const db = openDatabase(config.dbPath);
  const store = new Store(db);
  store.initialise(config);
  const provider = createProvider(config);
  const gateway = new GatewayService({ config, store, provider });

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (method === "GET" && path === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          provider: await provider.health(),
          time: new Date().toISOString(),
        });
        return;
      }

      if (path.startsWith("/saas/v1/")) {
        requireSaasBridge(req, config);
        const actorId = store.integrationActorId();

        if (method === "GET" && path === "/saas/v1/overview") {
          const overview = store.adminOverview();
          overview.usage = store.globalUsage(100);
          sendJson(res, 200, overview);
          return;
        }

        if (method === "POST" && path === "/saas/v1/tenants") {
          const body = await readJson(req, 64 * 1024);
          const tenant = store.createTenant(
            {
              name: body.name,
              username: body.username,
              password: body.password,
            },
            actorId,
          );
          sendJson(res, 201, { tenant });
          return;
        }

        const bridgeTenantMatch = /^\/saas\/v1\/tenants\/([^/]+)(?:\/(.*))?$/u.exec(path);
        if (bridgeTenantMatch) {
          const tenantId = bridgeTenantMatch[1];
          const action = bridgeTenantMatch[2] ?? "";

          if (method === "GET" && action === "dashboard") {
            sendJson(res, 200, store.tenantDashboard(tenantId));
            return;
          }

          if (method === "POST" && action === "recharge") {
            const body = await readJson(req, 64 * 1024);
            const wallet = store.recharge(
              tenantId,
              Number(body.amountFen),
              actorId,
              String(body.description ?? "SaaS platform recharge"),
            );
            sendJson(res, 200, { ok: true, wallet });
            return;
          }

          if (method === "POST" && action === "payment-orders") {
            const body = await readJson(req, 64 * 1024);
            const order = store.createRechargeOrder(
              tenantId,
              Number(body.amountFen),
              String(body.description ?? "AI gateway recharge"),
              actorId,
              String(body.channel ?? "wechat_native"),
            );
            sendJson(res, 201, { order });
            return;
          }

          if (method === "POST" && action === "status") {
            const body = await readJson(req, 64 * 1024);
            store.setTenantStatus(tenantId, body.status, actorId);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (method === "POST" && action === "voices") {
            const body = await readJson(req, 64 * 1024);
            const voice = store.addVoice(
              tenantId,
              { name: body.name, providerSpeakerId: body.speakerId },
              actorId,
            );
            sendJson(res, 201, { voice });
            return;
          }

          if (method === "GET" && action === "tokens") {
            sendJson(res, 200, { tokens: store.listApiTokens(tenantId) });
            return;
          }

          if (method === "POST" && action === "tokens") {
            const body = await readJson(req, 64 * 1024);
            sendJson(
              res,
              201,
              store.createApiToken(tenantId, actorId, body.name),
            );
            return;
          }

          const bridgeTokenMatch = /^tokens\/([^/]+)$/u.exec(action);
          if (method === "DELETE" && bridgeTokenMatch) {
            store.disableApiToken(tenantId, bridgeTokenMatch[1], actorId);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (method === "POST" && action === "redeem") {
            const body = await readJson(req, 64 * 1024);
            const wallet = store.redeemRechargeCode(
              tenantId,
              body.code,
              actorId,
            );
            sendJson(res, 200, { ok: true, wallet });
            return;
          }
        }

        const paymentOrderMatch =
          /^\/saas\/v1\/payment-orders\/([^/]+)(?:\/(credit|fail))?$/u.exec(path);
        if (paymentOrderMatch) {
          const outTradeNo = decodeURIComponent(paymentOrderMatch[1]);
          const action = paymentOrderMatch[2] ?? "";
          if (method === "GET" && !action) {
            sendJson(res, 200, { order: store.rechargeOrder(outTradeNo) });
            return;
          }
          if (method === "POST" && action === "credit") {
            const body = await readJson(req, 64 * 1024);
            const result = store.creditRechargeOrder(
              outTradeNo,
              String(body.providerTradeNo ?? ""),
              String(body.paidAt ?? ""),
              actorId,
            );
            sendJson(res, 200, { ok: true, ...result });
            return;
          }
          if (method === "POST" && action === "fail") {
            const body = await readJson(req, 64 * 1024);
            const order = store.failRechargeOrder(
              outTradeNo,
              String(body.reason ?? ""),
              actorId,
            );
            sendJson(res, 200, { ok: true, order });
            return;
          }
        }

        if (method === "PUT" && /^\/saas\/v1\/prices\/(asr|tts|tos)$/u.test(path)) {
          const service = path.split("/").pop();
          const body = await readJson(req, 64 * 1024);
          store.updatePrice(service, Number(body.unitPriceMicrofen), actorId);
          sendJson(res, 200, { ok: true, prices: store.listPrices() });
          return;
        }

        if (method === "GET" && path === "/saas/v1/recharge-codes") {
          sendJson(res, 200, { codes: store.listRechargeCodes(200) });
          return;
        }

        if (method === "POST" && path === "/saas/v1/recharge-codes") {
          const body = await readJson(req, 64 * 1024);
          const code = store.createRechargeCode(
            Number(body.amountFen),
            body.tenantId ? String(body.tenantId) : null,
            actorId,
          );
          sendJson(res, 201, code);
          return;
        }

        if (method === "GET" && path === "/saas/v1/usage") {
          sendJson(res, 200, {
            usage: store.globalUsage(url.searchParams.get("limit")),
          });
          return;
        }

        throw notFound("SaaS bridge route not found");
      }

      if (method === "POST" && path === "/gateway/v1/tts") {
        const auth = authorizationToken(req);
        const apiToken = store.authenticateApiToken(auth);
        const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
        if (!idempotencyKey) throw badRequest("Idempotency-Key header is required");
        const body = await readJson(req, config.maxBodyBytes);
        const result = await gateway.synthesizeTts({
          tenantId: apiToken.tenantId,
          tokenId: apiToken.id,
          idempotencyKey,
          text: body.text,
          speaker: body.speaker,
        });
        const audio = result.audio;
        res.writeHead(200, {
          ...securityHeaders(),
          "Content-Type": contentTypeFor(result.format),
          "Content-Length": audio.length,
          "Cache-Control": "no-store",
          "X-Hypit-Task-Id": result.task.id,
          "X-Hypit-Cost-Fen": String(result.task.actualFen),
          "X-Hypit-Balance-Fen": String(result.wallet?.availableFen ?? ""),
          "X-Hypit-Format": result.format,
          "X-Hypit-Idempotent-Replay": result.replay ? "1" : "0",
        });
        res.end(audio);
        return;
      }

      if (method === "POST" && path === "/gateway/v1/asr") {
        const auth = authorizationToken(req);
        const apiToken = store.authenticateApiToken(auth);
        const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
        if (!idempotencyKey) throw badRequest("Idempotency-Key header is required");
        const audio = await readBody(req, config.maxBodyBytes);
        const result = await gateway.transcribeAsr({
          tenantId: apiToken.tenantId,
          tokenId: apiToken.id,
          idempotencyKey,
          audio,
        });
        sendJson(
          res,
          200,
          {
            result: result.response,
            taskId: result.task.id,
            costFen: result.task.actualFen,
            balanceFen: result.wallet?.availableFen ?? null,
            replay: result.replay,
          },
          { "X-Hypit-Idempotent-Replay": result.replay ? "1" : "0" },
        );
        return;
      }

      if (method === "GET" && path === "/gateway/v1/me") {
        const apiToken = store.authenticateApiToken(authorizationToken(req));
        const dashboard = store.tenantDashboard(apiToken.tenantId);
        sendJson(res, 200, {
          tenant: dashboard.tenant,
          wallet: dashboard.wallet,
          summary: dashboard.summary,
          voices: dashboard.voices,
          prices: store.listPrices(),
        });
        return;
      }

      if (method === "POST" && path === "/api/auth/login") {
        requireSameOrigin(req, config, { allowConfiguredNullOrigin: true });
        const contentType = String(req.headers["content-type"] ?? "");
        const body = contentType.includes("application/json")
          ? await readJson(req, 64 * 1024)
          : formObject(await readBody(req, 64 * 1024));
        const user = store.login(
          body.username,
          body.password,
          req.socket.remoteAddress ?? "",
        );
        const session = store.createSession(user, config.sessionTtlSeconds);
        const cookie = sessionCookie(
          session.token,
          config.sessionTtlSeconds,
          config.cookieSecure,
        );
        if (contentType.includes("application/json")) {
          sendJson(res, 200, { ok: true, user }, { "Set-Cookie": cookie });
        } else {
          redirect(res, "/", { "Set-Cookie": cookie });
        }
        return;
      }

      if (method === "POST" && path === "/api/auth/logout") {
        requireSameOrigin(req, config);
        const cookies = parseCookies(req.headers.cookie);
        store.deleteSession(cookies[SESSION_COOKIE]);
        sendJson(
          res,
          200,
          { ok: true },
          { "Set-Cookie": clearSessionCookie(config.cookieSecure) },
        );
        return;
      }

      const cookies = parseCookies(req.headers.cookie);
      let user = null;
      try {
        user = store.sessionUser(cookies[SESSION_COOKIE]);
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          sendHtml(res, 403, renderLogin(error.message));
          return;
        }
        throw error;
      }

      if (method === "GET" && path === "/") {
        if (!user) {
          sendHtml(res, 200, renderLogin());
        } else if (user.role === "admin") {
          redirect(res, "/admin");
        } else {
          redirect(res, "/tenant");
        }
        return;
      }

      if (method === "GET" && path === "/admin") {
        if (!user) {
          redirect(res, "/");
          return;
        }
        if (user.role !== "admin") {
          sendHtml(res, 200, renderLogin("请使用管理员账号登录", "admin"));
          return;
        }
        store.requireAdmin(user);
        const overview = store.adminOverview();
        overview.usage = store.globalUsage(40);
        sendHtml(res, 200, renderAdmin(user, overview));
        return;
      }

      if (method === "GET" && path === "/tenant") {
        if (!user) {
          redirect(res, "/");
          return;
        }
        if (user.role === "admin") {
          sendHtml(res, 200, renderLogin("请使用租户账号登录"));
          return;
        }
        const tenantId = store.requireTenantUser(user);
        sendHtml(res, 200, renderTenant(user, store.tenantDashboard(tenantId)));
        return;
      }

      if (method === "GET" && path === "/api/auth/me") {
        if (!user) throw unauthorized();
        sendJson(res, 200, { user });
        return;
      }

      if (method === "GET" && path === "/api/tenant/summary") {
        const tenantId = store.requireTenantUser(user);
        sendJson(res, 200, store.tenantDashboard(tenantId));
        return;
      }

      if (method === "GET" && path === "/api/tenant/usage") {
        const tenantId = store.requireTenantUser(user);
        sendJson(res, 200, {
          usage: store.usage(tenantId, {
            limit: url.searchParams.get("limit"),
            service: url.searchParams.get("service") || undefined,
          }),
          summary: store.usageSummary(tenantId),
        });
        return;
      }

      if (method === "POST" && path === "/api/tenant/redeem") {
        requireSameOrigin(req, config);
        const tenantId = store.requireTenantManager(user);
        const body = await readJson(req, 64 * 1024);
        const wallet = store.redeemRechargeCode(tenantId, body.code, user.id);
        sendJson(res, 200, { ok: true, wallet });
        return;
      }

      if (method === "GET" && path === "/api/tenant/tokens") {
        const tenantId = store.requireTenantUser(user);
        sendJson(res, 200, { tokens: store.listApiTokens(tenantId) });
        return;
      }

      if (method === "POST" && path === "/api/tenant/tokens") {
        requireSameOrigin(req, config);
        const tenantId = store.requireTenantManager(user);
        const body = await readJson(req, 64 * 1024);
        sendJson(res, 201, store.createApiToken(tenantId, user.id, body.name));
        return;
      }

      const tokenMatch = /^\/api\/tenant\/tokens\/([^/]+)$/u.exec(path);
      if (method === "DELETE" && tokenMatch) {
        requireSameOrigin(req, config);
        const tenantId = store.requireTenantManager(user);
        store.disableApiToken(tenantId, tokenMatch[1], user.id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && path === "/api/tenant/voices") {
        const tenantId = store.requireTenantUser(user);
        sendJson(res, 200, { voices: store.listVoices(tenantId) });
        return;
      }

      if (method === "GET" && path === "/api/admin/overview") {
        store.requireAdmin(user);
        const overview = store.adminOverview();
        overview.usage = store.globalUsage(100);
        sendJson(res, 200, overview);
        return;
      }

      if (method === "POST" && path === "/api/admin/tenants") {
        requireSameOrigin(req, config);
        store.requireAdmin(user);
        const body = await readJson(req, 64 * 1024);
        const tenant = store.createTenant(
          {
            name: body.name,
            username: body.username,
            password: body.password,
          },
          user.id,
        );
        sendJson(res, 201, { tenant });
        return;
      }

      const tenantActionMatch =
        /^\/api\/admin\/tenants\/([^/]+)\/(recharge|status|voices)$/u.exec(path);
      if (method === "POST" && tenantActionMatch) {
        requireSameOrigin(req, config);
        store.requireAdmin(user);
        const tenantId = tenantActionMatch[1];
        const action = tenantActionMatch[2];
        const body = await readJson(req, 64 * 1024);
        if (action === "recharge") {
          const wallet = store.recharge(
            tenantId,
            Number(body.amountFen),
            user.id,
            String(body.description ?? "Manual recharge"),
          );
          sendJson(res, 200, { ok: true, wallet });
        } else if (action === "status") {
          store.setTenantStatus(tenantId, body.status, user.id);
          sendJson(res, 200, { ok: true });
        } else {
          const voice = store.addVoice(
            tenantId,
            { name: body.name, providerSpeakerId: body.speakerId },
            user.id,
          );
          sendJson(res, 201, { voice });
        }
        return;
      }

      if (method === "POST" && path === "/api/admin/recharge-codes") {
        requireSameOrigin(req, config);
        store.requireAdmin(user);
        const body = await readJson(req, 64 * 1024);
        const code = store.createRechargeCode(
          Number(body.amountFen),
          body.tenantId ? String(body.tenantId) : null,
          user.id,
        );
        sendJson(res, 201, code);
        return;
      }

      if (method === "GET" && path === "/api/admin/recharge-codes") {
        store.requireAdmin(user);
        sendJson(res, 200, { codes: store.listRechargeCodes(200) });
        return;
      }

      const priceMatch = /^\/api\/admin\/prices\/(asr|tts|tos)$/u.exec(path);
      if (method === "PUT" && priceMatch) {
        requireSameOrigin(req, config);
        store.requireAdmin(user);
        const body = await readJson(req, 64 * 1024);
        store.updatePrice(
          priceMatch[1],
          Number(body.unitPriceMicrofen),
          user.id,
        );
        sendJson(res, 200, { ok: true, prices: store.listPrices() });
        return;
      }

      if (method === "GET" && path === "/api/admin/usage") {
        store.requireAdmin(user);
        sendJson(res, 200, {
          usage: store.globalUsage(url.searchParams.get("limit")),
        });
        return;
      }

      throw notFound("Route not found");
    } catch (error) {
      const failure =
        error instanceof HttpError
          ? error
          : new HttpError(500, "Internal server error", "internal_error");
      if (!(error instanceof HttpError)) {
        console.error(error);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, failure.status, {
        ok: false,
        code: failure.code,
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      });
    }
  });

  return { server, db, store, provider, gateway, config };
}

export async function startServer(config = loadConfig()) {
  await mkdir(config.outputDir, { recursive: true });
  const app = createApplication(config);
  await new Promise((resolveListen, rejectListen) => {
    app.server.once("error", rejectListen);
    app.server.listen(config.port, config.host, () => {
      app.server.off("error", rejectListen);
      resolveListen();
    });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await startServer();
    console.log(
      `Hypit tenant gateway listening on http://${app.config.host}:${app.config.port} (${app.config.providerMode})`,
    );
    const shutdown = () => {
      app.server.close(() => {
        app.db.close();
        process.exit(0);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
