import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayClient, synthesizeNarration } from "../src/client.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

async function jsonRequest(base, path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    response,
    data: await response.json().catch(() => ({})),
  };
}

test("gateway client renders a narration document through the tenant gateway", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-gateway-client-test-"));
  const config = loadConfig({
    dataDir: directory,
    dbPath: join(directory, "test.sqlite"),
    host: "127.0.0.1",
    port: 0,
    cookieSecure: false,
    providerMode: "mock",
    adminUsername: "admin",
    adminPassword: "admin-password",
    ttsMicrofen: 1_000,
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
  const adminCookie = login.response.headers.get("set-cookie").split(";")[0];
  const tenant = await jsonRequest(base, "/api/admin/tenants", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "客户端租户",
      username: "client-tenant",
      password: "client-password",
    },
  });
  const tenantId = tenant.data.tenant.tenantId;
  await jsonRequest(base, `/api/admin/tenants/${tenantId}/recharge`, {
    method: "POST",
    cookie: adminCookie,
    body: { amountFen: 100 },
  });
  await jsonRequest(base, `/api/admin/tenants/${tenantId}/voices`, {
    method: "POST",
    cookie: adminCookie,
    body: { name: "主角", speakerId: "S_CLIENT" },
  });

  const tenantLogin = await jsonRequest(base, "/api/auth/login", {
    method: "POST",
    body: { username: "client-tenant", password: "client-password" },
  });
  const tenantCookie = tenantLogin.response.headers.get("set-cookie").split(";")[0];
  const tokenResult = await jsonRequest(base, "/api/tenant/tokens", {
    method: "POST",
    cookie: tenantCookie,
    body: { name: "client test" },
  });
  const client = new GatewayClient({
    baseUrl: base,
    token: tokenResult.data.token,
  });

  const narrationPath = join(directory, "narration.json");
  const outputDir = join(directory, "audio");
  await writeFile(
    narrationPath,
    JSON.stringify({
      lines: [
        { id: "n01", text: "第一句" },
        { id: "n02", text: "第二句" },
      ],
    }),
  );

  const first = await synthesizeNarration(client, {
    narrationPath,
    outputDir,
    speaker: "主角",
  });
  assert.equal(first.lines.length, 2);
  assert.equal(first.costFen, 2);
  assert.ok((await readFile(join(outputDir, "n01.wav"))).length > 44);
  assert.ok((await readFile(join(outputDir, "n02.wav"))).length > 44);
  const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  assert.equal(manifest.completed, 2);
  assert.deepEqual(manifest.lines.map((line) => line.id), ["n01", "n02"]);
  assert.ok(manifest.lines.every((line) => line.costFen === 1));

  const replay = await synthesizeNarration(client, {
    narrationPath,
    outputDir,
    speaker: "主角",
  });
  assert.ok(replay.lines.every((line) => line.replay));
  assert.equal(replay.chargedFen, 0);
  assert.equal(replay.replayedLines, 2);
  assert.equal(typeof replay.lines[0].balanceFen, "number");
});

test("gateway client retries once when the original idempotent task failed", async () => {
  const keys = [];
  const client = new GatewayClient({
    baseUrl: "https://gateway.example.com",
    token: "hgt_test",
    fetchImpl: async (_url, options) => {
      keys.push(options.headers["Idempotency-Key"]);
      if (keys.length === 1) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: "previous_request_failed",
            message: "The original request failed",
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(Buffer.alloc(48), {
        status: 200,
        headers: {
          "X-Hypit-Cost-Fen": "1",
          "X-Hypit-Format": "wav",
          "X-Hypit-Idempotent-Replay": "0",
        },
      });
    },
  });
  const result = await client.synthesize({
    text: "重试",
    idempotencyKey: "narration:failed-once",
  });
  assert.equal(result.costFen, 1);
  assert.equal(keys.length, 2);
  assert.match(keys[1], /^narration:failed-once:retry:/u);
});
