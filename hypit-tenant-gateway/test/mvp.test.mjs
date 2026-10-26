import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

function silenceWav(milliseconds = 500, sampleRate = 16_000) {
  const sampleCount = Math.round((sampleRate * milliseconds) / 1000);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function jsonRequest(base, path, { method = "GET", body, cookie, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

test("tenant gateway keeps balances, usage, replay and isolation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-gateway-test-"));
  const config = loadConfig({
    dataDir: directory,
    dbPath: join(directory, "test.sqlite"),
    host: "127.0.0.1",
    port: 0,
    cookieSecure: false,
    providerMode: "mock",
    adminUsername: "admin",
    adminPassword: "admin-password",
    asrMicrofen: 1_000,
    ttsMicrofen: 1_000,
    tosMicrofen: 1_000,
  });
  const app = await startServer(config);
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const login = await jsonRequest(base, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "admin-password" },
  });
  assert.equal(login.response.status, 200);
  const adminCookie = login.response.headers.get("set-cookie").split(";")[0];

  const firstTenant = await jsonRequest(base, "/api/admin/tenants", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "客户甲",
      username: "tenant-a",
      password: "tenant-password-a",
    },
  });
  assert.equal(firstTenant.response.status, 201);
  const tenantA = firstTenant.data.tenant;

  const secondTenant = await jsonRequest(base, "/api/admin/tenants", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "客户乙",
      username: "tenant-b",
      password: "tenant-password-b",
    },
  });
  assert.equal(secondTenant.response.status, 201);
  const tenantB = secondTenant.data.tenant;

  const recharge = await jsonRequest(
    base,
    `/api/admin/tenants/${tenantA.tenantId}/recharge`,
    {
      method: "POST",
      cookie: adminCookie,
      body: { amountFen: 1_000 },
    },
  );
  assert.equal(recharge.response.status, 200);
  assert.equal(recharge.data.wallet.availableFen, 1_000);

  for (const tenant of [tenantA, tenantB]) {
    const voice = await jsonRequest(
      base,
      `/api/admin/tenants/${tenant.tenantId}/voices`,
      {
        method: "POST",
        cookie: adminCookie,
        body: { name: "默认", speakerId: `S_${tenant.tenantId}` },
      },
    );
    assert.equal(voice.response.status, 201);
  }

  const disposableVoice = await jsonRequest(
    base,
    `/api/admin/tenants/${tenantA.tenantId}/voices`,
    {
      method: "POST",
      cookie: adminCookie,
      body: { name: "待删除", speakerId: "S_DELETE_ME" },
    },
  );
  assert.equal(disposableVoice.response.status, 201);

  const disabledVoice = await jsonRequest(
    base,
    `/api/admin/tenants/${tenantA.tenantId}/voices/${disposableVoice.data.voice.id}`,
    { method: "DELETE", cookie: adminCookie },
  );
  assert.equal(disabledVoice.response.status, 200);

  const afterDeleteOverview = await jsonRequest(base, "/api/admin/overview", {
    cookie: adminCookie,
  });
  const tenantAfterDelete = afterDeleteOverview.data.tenants.find(
    (item) => item.id === tenantA.tenantId,
  );
  assert.ok(
    tenantAfterDelete.voices.every((item) => item.name !== "待删除"),
  );
  assert.equal(tenantAfterDelete.voices[0].speakerId, `S_${tenantA.tenantId}`);

  const restoredVoice = await jsonRequest(
    base,
    `/api/admin/tenants/${tenantA.tenantId}/voices`,
    {
      method: "POST",
      cookie: adminCookie,
      body: { name: "待删除", speakerId: "S_DELETE_ME_2" },
    },
  );
  assert.equal(restoredVoice.response.status, 201);
  assert.equal(restoredVoice.data.voice.id, disposableVoice.data.voice.id);
  await jsonRequest(
    base,
    `/api/admin/tenants/${tenantA.tenantId}/voices/${disposableVoice.data.voice.id}`,
    { method: "DELETE", cookie: adminCookie },
  );

  const tenantLogin = await jsonRequest(base, "/api/auth/login", {
    method: "POST",
    body: { username: "tenant-a", password: "tenant-password-a" },
  });
  assert.equal(tenantLogin.response.status, 200);
  const tenantCookie = tenantLogin.response.headers.get("set-cookie").split(";")[0];

  const tenantManagedVoice = await jsonRequest(
    base,
    `/api/admin/tenants/${tenantA.tenantId}/voices`,
    {
      method: "POST",
      cookie: adminCookie,
      body: { name: "租户删除", speakerId: "S_TENANT_DELETE" },
    },
  );
  const tenantVoicesBefore = await jsonRequest(base, "/api/tenant/voices", {
    cookie: tenantCookie,
  });
  assert.ok(
    tenantVoicesBefore.data.voices.some(
      (item) => item.id === tenantManagedVoice.data.voice.id,
    ),
  );
  const tenantVoiceDelete = await jsonRequest(
    base,
    `/api/tenant/voices/${tenantManagedVoice.data.voice.id}`,
    { method: "DELETE", cookie: tenantCookie },
  );
  assert.equal(tenantVoiceDelete.response.status, 200);
  const tenantVoicesAfter = await jsonRequest(base, "/api/tenant/voices", {
    cookie: tenantCookie,
  });
  assert.ok(
    tenantVoicesAfter.data.voices.every(
      (item) => item.id !== tenantManagedVoice.data.voice.id,
    ),
  );

  const tokenResult = await jsonRequest(base, "/api/tenant/tokens", {
    method: "POST",
    cookie: tenantCookie,
    body: { name: "Acceptance token" },
  });
  assert.equal(tokenResult.response.status, 201);
  const tenantToken = tokenResult.data.token;
  assert.match(tenantToken, /^hgt_/u);

  const deletedVoiceTts = await fetch(`${base}/gateway/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "tts-voice-deleted",
    },
    body: JSON.stringify({ text: "不可使用", speaker: "待删除" }),
  });
  assert.equal(deletedVoiceTts.status, 404);

  const firstTts = await fetch(`${base}/gateway/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "tts-replay-1",
    },
    body: JSON.stringify({ text: "魔道子", speaker: "默认" }),
  });
  assert.equal(firstTts.status, 200);
  assert.equal(firstTts.headers.get("x-hypit-cost-fen"), "1");
  const firstAudio = Buffer.from(await firstTts.arrayBuffer());
  assert.ok(firstAudio.length > 44);

  const replay = await fetch(`${base}/gateway/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "tts-replay-1",
    },
    body: JSON.stringify({ text: "魔道子", speaker: "默认" }),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-hypit-idempotent-replay"), "1");
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()), firstAudio);

  const summary = await jsonRequest(base, "/api/tenant/summary", {
    cookie: tenantCookie,
  });
  assert.equal(summary.response.status, 200);
  assert.equal(summary.data.wallet.availableFen, 999);
  assert.equal(summary.data.summary.calls, 1);
  assert.equal(summary.data.usage.length, 1);
  assert.equal(summary.data.dailyUsage.amountFen, 1);
  assert.equal(summary.data.dailyUsage.apiRequests, 1);
  assert.equal(summary.data.dailyUsage.tokens, 3);
  assert.equal(summary.data.dailyUsage.hourly.length, 24);

  const asr = await fetch(`${base}/gateway/v1/asr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "audio/wav",
      "Idempotency-Key": "asr-1",
    },
    body: silenceWav(),
  });
  assert.equal(asr.status, 200);
  const asrData = await asr.json();
  assert.equal(asrData.costFen, 2);
  assert.ok(asrData.result.utterances.length > 0);

  const afterAsr = await jsonRequest(base, "/api/tenant/summary", {
    cookie: tenantCookie,
  });
  assert.equal(afterAsr.data.wallet.availableFen, 997);
  assert.equal(afterAsr.data.wallet.reservedFen, 0);
  assert.equal(afterAsr.data.summary.calls, 3);
  assert.equal(afterAsr.data.summary.apiRequests, 2);
  assert.equal(afterAsr.data.dailyUsage.amountFen, 3);
  assert.equal(afterAsr.data.dailyUsage.apiRequests, 2);
  assert.equal(afterAsr.data.dailyUsage.tokens, 3);
  assert.deepEqual(
    afterAsr.data.summary.byService.map((item) => item.service),
    ["asr", "tos", "tts"],
  );

  const failed = await fetch(`${base}/gateway/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "tts-fail-1",
    },
    body: JSON.stringify({ text: "[FAIL_PROVIDER]", speaker: "默认" }),
  });
  assert.equal(failed.status, 502);
  const afterFailure = await jsonRequest(base, "/api/tenant/summary", {
    cookie: tenantCookie,
  });
  assert.equal(afterFailure.data.wallet.availableFen, 997);
  assert.equal(afterFailure.data.wallet.reservedFen, 0);
  assert.equal(afterFailure.data.summary.calls, 3);

  const tenantBLogin = await jsonRequest(base, "/api/auth/login", {
    method: "POST",
    body: { username: "tenant-b", password: "tenant-password-b" },
  });
  const tenantBCookie = tenantBLogin.response.headers.get("set-cookie").split(";")[0];
  const tenantBToken = await jsonRequest(base, "/api/tenant/tokens", {
    method: "POST",
    cookie: tenantBCookie,
    body: { name: "B token" },
  });
  const insufficient = await fetch(`${base}/gateway/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantBToken.data.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "b-no-balance",
    },
    body: JSON.stringify({ text: "余额不足", speaker: "默认" }),
  });
  assert.equal(insufficient.status, 402);

  const tenantBSummary = await jsonRequest(base, "/api/tenant/summary", {
    cookie: tenantBCookie,
  });
  assert.equal(tenantBSummary.data.summary.calls, 0);
  assert.equal(tenantBSummary.data.wallet.availableFen, 0);

  const code = await jsonRequest(base, "/api/admin/recharge-codes", {
    method: "POST",
    cookie: adminCookie,
    body: { amountFen: 500 },
  });
  assert.equal(code.response.status, 201);
  const redeemed = await jsonRequest(base, "/api/tenant/redeem", {
    method: "POST",
    cookie: tenantBCookie,
    body: { code: code.data.code },
  });
  assert.equal(redeemed.response.status, 200);
  assert.equal(redeemed.data.wallet.availableFen, 500);
  const reused = await jsonRequest(base, "/api/tenant/redeem", {
    method: "POST",
    cookie: tenantBCookie,
    body: { code: code.data.code },
  });
  assert.equal(reused.response.status, 409);

  const globalUsage = await jsonRequest(base, "/api/admin/usage", {
    cookie: adminCookie,
  });
  assert.equal(globalUsage.response.status, 200);
  assert.ok(globalUsage.data.usage.every((item) => item.tenantId === tenantA.tenantId || item.tenantId === tenantB.tenantId));
});
