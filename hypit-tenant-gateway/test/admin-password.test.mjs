import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

async function login(base, username, password) {
  return fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

test("administrator password reset updates the existing account and revokes sessions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-admin-reset-test-"));
  let second;
  t.after(async () => {
    if (second) {
      await new Promise((resolve) => second.server.close(resolve));
      second.db.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  const config = () =>
    loadConfig({
      dataDir: directory,
      host: "127.0.0.1",
      port: 0,
      cookieSecure: false,
      providerMode: "mock",
      adminUsername: "admin",
      adminPassword: "old-admin-password",
    });

  const first = await startServer(config());
  const firstBase = `http://127.0.0.1:${first.server.address().port}`;
  const loginResponse = await login(firstBase, "admin", "old-admin-password");
  assert.equal(loginResponse.status, 200);
  const oldCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  await new Promise((resolve) => first.server.close(resolve));
  first.db.close();

  const reset = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "scripts", "reset-admin-password.mjs")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATA_DIR: directory,
        ADMIN_USERNAME: "admin",
        NEW_ADMIN_PASSWORD: "new-admin-password-2026",
      },
    },
  );
  assert.equal(reset.status, 0, reset.stderr);

  second = await startServer(config());
  const secondBase = `http://127.0.0.1:${second.server.address().port}`;

  assert.equal((await login(secondBase, "admin", "old-admin-password")).status, 401);
  assert.equal((await login(secondBase, "admin", "new-admin-password-2026")).status, 200);
  const stale = await fetch(`${secondBase}/api/admin/overview`, {
    headers: { Cookie: oldCookie },
  });
  assert.equal(stale.status, 403);
});
