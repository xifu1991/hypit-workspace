import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

async function jsonRequest(
  base,
  path,
  { method = "GET", body, secret, headers = {} } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(secret ? { "X-Hypit-Bridge-Secret": secret } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

test("SaaS bridge manages a tenant without exposing the browser session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-saas-bridge-test-"));
  const config = loadConfig({
    dataDir: directory,
    dbPath: join(directory, "test.sqlite"),
    host: "127.0.0.1",
    port: 0,
    cookieSecure: false,
    providerMode: "mock",
    adminUsername: "admin",
    adminPassword: "admin-password",
    saasBridgeSecret: "bridge-test-secret",
  });
  const app = await startServer(config);
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const denied = await jsonRequest(base, "/saas/v1/overview");
  assert.equal(denied.response.status, 401);

  const wrongSecret = await jsonRequest(base, "/saas/v1/overview", {
    secret: "wrong-secret",
  });
  assert.equal(wrongSecret.response.status, 401);

  const created = await jsonRequest(base, "/saas/v1/tenants", {
    method: "POST",
    secret: "bridge-test-secret",
    body: {
      name: "秒创云商户",
      username: "saas-tenant",
      password: "tenant-password",
    },
  });
  assert.equal(created.response.status, 201);
  const tenantId = created.data.tenant.tenantId;

  const recharged = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/recharge`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: { amountFen: 1200 },
    },
  );
  assert.equal(recharged.response.status, 200);
  assert.equal(recharged.data.wallet.availableFen, 1200);

  const paymentOrder = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/payment-orders`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: { amountFen: 800, description: "AI 网关余额充值" },
    },
  );
  assert.equal(paymentOrder.response.status, 201);
  assert.equal(paymentOrder.data.order.status, "pending");
  assert.match(paymentOrder.data.order.outTradeNo, /^GW[A-Z0-9]+$/u);

  const pending = await jsonRequest(
    base,
    `/saas/v1/payment-orders/${paymentOrder.data.order.outTradeNo}`,
    { secret: "bridge-test-secret" },
  );
  assert.equal(pending.response.status, 200);
  assert.equal(pending.data.order.amountFen, 800);

  const stillPending = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/dashboard`,
    { secret: "bridge-test-secret" },
  );
  assert.equal(stillPending.data.wallet.availableFen, 1200);

  const credited = await jsonRequest(
    base,
    `/saas/v1/payment-orders/${paymentOrder.data.order.outTradeNo}/credit`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: {
        providerTradeNo: "wx-test-transaction-1",
        paidAt: "2026-10-20T00:00:00Z",
      },
    },
  );
  assert.equal(credited.response.status, 200);
  assert.equal(credited.data.credited, true);
  assert.equal(credited.data.wallet.availableFen, 2000);

  const replayed = await jsonRequest(
    base,
    `/saas/v1/payment-orders/${paymentOrder.data.order.outTradeNo}/credit`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: {
        providerTradeNo: "wx-test-transaction-1",
        paidAt: "2026-10-20T00:00:00Z",
      },
    },
  );
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.data.credited, false);
  assert.equal(replayed.data.wallet.availableFen, 2000);

  const failedOrder = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/payment-orders`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: { amountFen: 100, description: "Unpaid Native order" },
    },
  );
  assert.equal(failedOrder.response.status, 201);

  const failed = await jsonRequest(
    base,
    `/saas/v1/payment-orders/${failedOrder.data.order.outTradeNo}/fail`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: { reason: "Native product is not enabled" },
    },
  );
  assert.equal(failed.response.status, 200);
  assert.equal(failed.data.order.status, "failed");

  const voice = await jsonRequest(base, `/saas/v1/tenants/${tenantId}/voices`, {
    method: "POST",
    secret: "bridge-test-secret",
    body: { name: "平台音色", speakerId: "S_SAAS_BRIDGE" },
  });
  assert.equal(voice.response.status, 201);

  const voices = await jsonRequest(base, `/saas/v1/tenants/${tenantId}/voices`, {
    secret: "bridge-test-secret",
  });
  assert.equal(voices.response.status, 200);
  assert.equal(voices.data.voices.length, 1);
  assert.equal(voices.data.voices[0].name, "平台音色");
  assert.equal(voices.data.voices[0].speakerId, undefined);

  const deletedVoice = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/voices/${voice.data.voice.id}`,
    { method: "DELETE", secret: "bridge-test-secret" },
  );
  assert.equal(deletedVoice.response.status, 200);
  const afterVoiceDelete = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/voices`,
    { secret: "bridge-test-secret" },
  );
  assert.deepEqual(afterVoiceDelete.data.voices, []);

  const afterPayment = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/dashboard`,
    { secret: "bridge-test-secret" },
  );
  assert.equal(afterPayment.data.wallet.availableFen, 2000);
  assert.ok(
    afterPayment.data.ledger.some(
      (item) =>
        item.service === "wechat_recharge" &&
        item.amountFen === 800 &&
        item.reference === paymentOrder.data.order.outTradeNo,
    ),
  );

  const token = await jsonRequest(base, `/saas/v1/tenants/${tenantId}/tokens`, {
    method: "POST",
    secret: "bridge-test-secret",
    body: { name: "秒创云 Studio" },
  });
  assert.equal(token.response.status, 201);
  assert.match(token.data.token, /^hgt_/u);

  const dashboard = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/dashboard`,
    { secret: "bridge-test-secret" },
  );
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.data.wallet.availableFen, 2000);
  assert.equal(dashboard.data.tokens.length, 1);
  assert.equal(dashboard.data.dailyUsage.hourly.length, 24);

  const datedDashboard = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/dashboard?date=2026-10-20`,
    { secret: "bridge-test-secret" },
  );
  assert.equal(datedDashboard.response.status, 200);
  assert.equal(datedDashboard.data.dailyUsage.date, "2026-10-20");
  assert.equal(datedDashboard.data.dailyUsage.amountFen, 0);

  const invalidDate = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/dashboard?date=2026-02-31`,
    { secret: "bridge-test-secret" },
  );
  assert.equal(invalidDate.response.status, 400);

  const code = await jsonRequest(base, "/saas/v1/recharge-codes", {
    method: "POST",
    secret: "bridge-test-secret",
    body: { amountFen: 500, tenantId },
  });
  assert.equal(code.response.status, 201);

  const redeemed = await jsonRequest(
    base,
    `/saas/v1/tenants/${tenantId}/redeem`,
    {
      method: "POST",
      secret: "bridge-test-secret",
      body: { code: code.data.code },
    },
  );
  assert.equal(redeemed.response.status, 200);
  assert.equal(redeemed.data.wallet.availableFen, 2500);
});
