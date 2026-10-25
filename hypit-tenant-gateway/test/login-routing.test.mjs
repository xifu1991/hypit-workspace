import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

test("dashboard entry points send signed-out visitors to the login page", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-login-routing-test-"));
  const config = loadConfig({
    dataDir: directory,
    dbPath: join(directory, "test.sqlite"),
    host: "127.0.0.1",
    port: 0,
    cookieSecure: false,
    providerMode: "mock",
    adminUsername: "admin",
    adminPassword: "admin-password",
  });
  const app = await startServer(config);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.appOrigin = base;

  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    await rm(directory, { recursive: true, force: true });
  });

  for (const path of ["/admin", "/tenant"]) {
    const redirect = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get("location"), "/");

    const loginPage = await fetch(`${base}${path}`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /账号登录/u);
  }

  const embeddedLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "null",
    },
    body: "username=admin&password=admin-password",
  });
  assert.equal(embeddedLogin.status, 303);
  assert.equal(embeddedLogin.headers.get("location"), "/");
  const adminCookie = embeddedLogin.headers.get("set-cookie").split(";")[0];

  const tenantLoginPage = await fetch(`${base}/tenant`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(tenantLoginPage.status, 200);
  assert.match(await tenantLoginPage.text(), /请使用租户账号登录/u);

  const tenant = await fetch(`${base}/api/admin/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": adminCookie,
    },
    body: JSON.stringify({
      name: "角色测试租户",
      username: "role-user",
      password: "role-password",
    }),
  });
  assert.equal(tenant.status, 201);

  const tenantSession = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "role-user", password: "role-password" }),
  });
  assert.equal(tenantSession.status, 200);
  const tenantCookie = tenantSession.headers.get("set-cookie").split(";")[0];

  const adminLoginPage = await fetch(`${base}/admin`, {
    headers: { Cookie: tenantCookie },
  });
  assert.equal(adminLoginPage.status, 200);
  const adminLoginHtml = await adminLoginPage.text();
  assert.match(adminLoginHtml, /请使用管理员账号登录/u);
  assert.match(adminLoginHtml, /name="username"[^>]*value="admin"/u);

  config.appOrigin = "https://another.example";
  const rejected = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "null",
    },
    body: JSON.stringify({ username: "admin", password: "admin-password" }),
  });
  assert.equal(rejected.status, 403);
});
