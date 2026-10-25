import { formatFen } from "./money.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dateText(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function serviceName(service) {
  return {
    asr: "豆包语音识别",
    tts: "声音克隆合成",
    tos: "火山对象存储",
    recharge_code: "充值",
    wechat_recharge: "微信支付充值",
  }[service] ?? service;
}

function unitText(service) {
  return {
    asr: "秒",
    tts: "字符",
    tos: "MiB",
  }[service] ?? "单位";
}

function quantityText(row) {
  const value = Number(row.quantity ?? 0);
  if (row.service === "asr") return `${(value / 1000).toFixed(2)} 秒`;
  if (row.service === "tos") return `${(value / 1_048_576).toFixed(3)} MiB`;
  return `${value.toLocaleString("zh-CN")} 字符`;
}

function priceUnitText(unit) {
  return {
    hour: "小时",
    "1000_chars": "千字符",
    GB: "GB",
  }[unit] ?? unit;
}

function priceRateText(price) {
  const yuan = Number(price.unitPriceMicrofen ?? 0) / 100_000_000;
  const amount = yuan.toFixed(yuan < 0.01 ? 6 : 2);
  return `¥${amount} / ${priceUnitText(price.unitName)}`;
}

const styles = `
:root {
  --ink: #17201d;
  --muted: #62706a;
  --paper: #f3f1ea;
  --surface: #fffdf8;
  --line: #d9d6ca;
  --green: #1f6b4f;
  --green-soft: #dceadf;
  --gold: #b77b18;
  --red: #a33d33;
  --shadow: 0 10px 30px rgba(37, 43, 39, .07);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
}
a { color: var(--green); }
.shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
.topbar {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--line);
}
.brand { font-size: 20px; font-weight: 800; letter-spacing: 0; }
.brand span { color: var(--gold); }
.top-actions { display: flex; align-items: center; gap: 10px; }
.who { color: var(--muted); font-size: 14px; }
main { padding: 28px 0 56px; }
h1, h2, h3, p { margin-top: 0; }
h1 { font-size: 30px; margin-bottom: 8px; }
h2 { font-size: 20px; margin-bottom: 16px; }
h3 { font-size: 16px; margin-bottom: 8px; }
.lead { color: var(--muted); margin-bottom: 26px; }
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.metric {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 18px;
  box-shadow: var(--shadow);
}
.metric-label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
.metric-value { font-size: 25px; font-weight: 800; font-variant-numeric: tabular-nums; }
.metric-note { color: var(--muted); font-size: 12px; margin-top: 6px; }
.grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 18px; align-items: start; }
.grid > *, .split > * { min-width: 0; }
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 18px;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.panel-head h2 { margin: 0; }
.form-row { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
.field { display: grid; gap: 6px; flex: 1 1 150px; }
.field label { font-size: 12px; color: var(--muted); font-weight: 700; }
input, select {
  width: 100%;
  min-height: 40px;
  border: 1px solid #c9c5b8;
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  padding: 8px 10px;
  font: inherit;
}
button {
  min-height: 40px;
  border: 1px solid var(--green);
  border-radius: 6px;
  background: var(--green);
  color: #fff;
  padding: 8px 14px;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
button.secondary { background: transparent; color: var(--green); }
button.danger { background: var(--red); border-color: var(--red); }
button:disabled { opacity: .5; cursor: wait; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 700; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 18px 0; }
.pill { display: inline-flex; border-radius: 999px; padding: 3px 8px; font-size: 12px; background: var(--green-soft); color: var(--green); }
.pill.warn { background: #f5e6c9; color: #8a5d10; }
.pill.fail { background: #f3d9d4; color: var(--red); }
.code { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 12px; overflow-wrap: anywhere; }
.notice { border-left: 4px solid var(--gold); background: #faf3e3; padding: 12px 14px; margin-bottom: 18px; color: #6b511d; }
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.login { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 28px; box-shadow: var(--shadow); }
.login h1 { margin-bottom: 6px; }
.login .field { margin-bottom: 14px; }
.login button { width: 100%; }
.error { color: var(--red); min-height: 20px; font-size: 13px; }
.muted { color: var(--muted); }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.stack { display: grid; gap: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 860px) {
  .metrics { grid-template-columns: 1fr 1fr; }
  .grid, .split { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .metrics { grid-template-columns: 1fr; }
  .shell { width: min(100% - 20px, 1180px); }
  h1 { font-size: 25px; }
  th:nth-child(4), td:nth-child(4) { display: none; }
  .panel { overflow-x: auto; }
  .panel > table { white-space: nowrap; }
  .panel > table .code { white-space: normal; }
}
`;

function layout({ title, user, body, script = "" }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">Hypit <span>租户网关</span></div>
      <div class="top-actions">
        <span class="who">${escapeHtml(user?.username ?? "")}</span>
        ${user ? '<button class="secondary" type="button" onclick="logout()">退出</button>' : ""}
      </div>
    </header>
    <main>${body}</main>
  </div>
  <script>
    async function api(path, options = {}) {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "请求失败");
      return data;
    }
    async function logout() {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      location.href = "/";
    }
    ${script}
  </script>
</body>
</html>`;
}

export function renderLogin(error = "", username = "") {
  return layout({
    title: "登录 · Hypit 租户网关",
    user: null,
    body: `<div class="login-wrap">
      <form class="login" method="post" action="/api/auth/login">
        <h1>账号登录</h1>
        <p class="lead">余额、授权和用量都在同一账户中管理。</p>
        <div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" value="${escapeHtml(username)}" required></div>
        <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <p class="error">${escapeHtml(error)}</p>
        <button type="submit">登录</button>
      </form>
    </div>`,
  });
}

function usageRows(rows, includeTenant = false) {
  if (rows.length === 0) return '<p class="empty">暂无用量记录</p>';
  return `<table>
    <thead><tr>
      <th>时间</th>${includeTenant ? "<th>租户</th>" : ""}<th>服务</th><th>用量</th>
      <th class="num">金额</th><th>状态</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          <td>${dateText(row.createdAt)}</td>
          ${includeTenant ? `<td>${escapeHtml(row.tenantName)}</td>` : ""}
          <td>${escapeHtml(serviceName(row.service))}</td>
          <td>${quantityText(row)}</td>
          <td class="num">¥${formatFen(row.amountFen)}</td>
          <td><span class="pill ${row.status === "failed" ? "fail" : ""}">${row.status === "failed" ? "失败" : "完成"}</span></td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

export function renderTenant(user, data) {
  const available = data.wallet.availableFen;
  const serviceRows = data.summary.byService.length
    ? `<table><thead><tr><th>服务</th><th class="num">调用</th><th class="num">用量</th><th class="num">消费</th></tr></thead>
      <tbody>${data.summary.byService
        .map(
          (row) => `<tr>
            <td>${escapeHtml(serviceName(row.service))}</td>
            <td class="num">${row.calls}</td>
            <td class="num">${row.service === "asr" ? `${(row.quantity / 1000).toFixed(2)} 秒` : row.service === "tos" ? `${(row.quantity / 1_048_576).toFixed(3)} MiB` : `${row.quantity.toLocaleString("zh-CN")} 字符`}</td>
            <td class="num">¥${formatFen(row.amountFen)}</td>
          </tr>`,
        )
        .join("")}</tbody></table>`
    : '<p class="empty">暂无已结算用量</p>';

  const tokens = data.tokens.length
    ? data.tokens
        .map(
          (item) => `<tr>
            <td>${escapeHtml(item.name)}</td>
            <td class="code">${escapeHtml(item.prefix)}…</td>
            <td>${item.enabled ? '<span class="pill">启用</span>' : '<span class="pill fail">停用</span>'}</td>
            <td>${dateText(item.createdAt)}</td>
            <td>${item.enabled ? `<button class="danger" type="button" onclick="disableToken('${escapeHtml(item.id)}')">停用</button>` : ""}</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="muted">尚未创建令牌</td></tr>';

  const voices = data.voices.length
    ? data.voices.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.enabled ? "启用" : "停用"}</td><td>${dateText(item.createdAt)}</td></tr>`).join("")
    : '<tr><td colspan="3" class="muted">管理员尚未分配音色</td></tr>';

  const ledger = data.ledger.length
    ? data.ledger
        .map(
          (item) => `<tr>
            <td>${dateText(item.createdAt)}</td>
            <td>${escapeHtml(serviceName(item.service))}</td>
            <td>${escapeHtml(item.description)}</td>
            <td class="num">${item.amountFen >= 0 ? "+" : "-"}¥${formatFen(Math.abs(item.amountFen))}</td>
            <td class="num">¥${formatFen(item.balanceAfterFen)}</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="muted">暂无账单流水</td></tr>';

  return layout({
    title: `${data.tenant.name} · Hypit 租户中心`,
    user,
    body: `
      <h1>${escapeHtml(data.tenant.name)}</h1>
      <p class="lead">租户编号 <span class="code">${escapeHtml(data.tenant.id)}</span></p>
      <section class="metrics">
        <div class="metric"><div class="metric-label">可用余额</div><div class="metric-value">¥${formatFen(available)}</div><div class="metric-note">冻结 ¥${formatFen(data.wallet.reservedFen)}</div></div>
        <div class="metric"><div class="metric-label">累计消费</div><div class="metric-value">¥${formatFen(data.summary.spentFen)}</div><div class="metric-note">已结算调用</div></div>
        <div class="metric"><div class="metric-label">调用次数</div><div class="metric-value">${data.summary.calls}</div><div class="metric-note">ASR、TTS、TOS</div></div>
        <div class="metric"><div class="metric-label">账户余额</div><div class="metric-value">¥${formatFen(data.wallet.balanceFen)}</div><div class="metric-note">含冻结额度</div></div>
      </section>
      <div class="grid">
        <div>
          <section class="panel">
            <div class="panel-head"><h2>服务用量</h2></div>
            ${serviceRows}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>最近用量</h2></div>
            ${usageRows(data.usage)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>账单流水</h2></div>
            <table><thead><tr><th>时间</th><th>项目</th><th>说明</th><th class="num">变动</th><th class="num">余额</th></tr></thead><tbody>${ledger}</tbody></table>
          </section>
        </div>
        <aside>
          <section class="panel">
            <div class="panel-head"><h2>充值</h2></div>
            <form class="stack" onsubmit="redeem(event)">
              <div class="field"><label for="redeem-code">充值码</label><input id="redeem-code" required placeholder="HG-XXXXX-XXXXX-XXXXX-XXXXX"></div>
              <button type="submit">充值到余额</button>
              <p id="redeem-status" class="muted"></p>
            </form>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>API 令牌</h2></div>
            <form class="form-row" onsubmit="createToken(event)">
              <div class="field"><label for="token-name">名称</label><input id="token-name" value="本地 Studio" required></div>
              <button type="submit">创建</button>
            </form>
            <div id="token-result" class="code"></div>
            <table><thead><tr><th>名称</th><th>前缀</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>${tokens}</tbody></table>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>声音</h2></div>
            <table><thead><tr><th>名称</th><th>状态</th><th>分配时间</th></tr></thead><tbody>${voices}</tbody></table>
          </section>
        </aside>
      </div>`,
    script: `
      async function redeem(event) {
        event.preventDefault();
        const code = document.getElementById("redeem-code");
        const status = document.getElementById("redeem-status");
        status.textContent = "处理中";
        try {
          const result = await api("/api/tenant/redeem", { method: "POST", body: JSON.stringify({ code: code.value }) });
          status.textContent = "充值成功，余额 ¥" + (result.wallet.availableFen / 100).toFixed(2);
          setTimeout(() => location.reload(), 600);
        } catch (error) {
          status.textContent = error.message;
        }
      }
      async function createToken(event) {
        event.preventDefault();
        const name = document.getElementById("token-name");
        try {
          const result = await api("/api/tenant/tokens", { method: "POST", body: JSON.stringify({ name: name.value }) });
          document.getElementById("token-result").textContent = "新令牌（仅显示一次）：" + result.token;
          setTimeout(() => location.reload(), 12000);
        } catch (error) {
          document.getElementById("token-result").textContent = error.message;
        }
      }
      async function disableToken(id) {
        if (!confirm("停用这个令牌？")) return;
        try {
          await api("/api/tenant/tokens/" + encodeURIComponent(id), { method: "DELETE" });
          location.reload();
        } catch (error) { alert(error.message); }
      }
    `,
  });
}

export function renderAdmin(user, data) {
  const tenantRows = data.tenants.length
    ? data.tenants
        .map(
          (tenant) => `<tr>
            <td><strong>${escapeHtml(tenant.name)}</strong><div class="code muted">${escapeHtml(tenant.id)}</div></td>
            <td>${tenant.status === "active" ? '<span class="pill">正常</span>' : '<span class="pill fail">停用</span>'}</td>
            <td class="num">¥${formatFen(tenant.balanceFen)}</td>
            <td class="num">¥${formatFen(tenant.spentFen)}</td>
            <td class="num">${tenant.usageCount}</td>
            <td>
              <form class="actions" onsubmit="recharge(event, '${escapeHtml(tenant.id)}')">
                <input name="amount" type="number" min="0.01" step="0.01" style="width:100px" required placeholder="金额">
                <button type="submit">充值</button>
              </form>
            </td>
            <td>
              <details>
                <summary>设置</summary>
                <form class="stack" onsubmit="addVoice(event, '${escapeHtml(tenant.id)}')">
                  <input name="name" required placeholder="音色名称">
                  <input name="speakerId" required placeholder="S_ 音色 ID">
                  <button type="submit">添加音色</button>
                </form>
                <button class="${tenant.status === "active" ? "danger" : "secondary"}" type="button" onclick="toggleTenant('${escapeHtml(tenant.id)}', '${tenant.status === "active" ? "suspended" : "active"}')">${tenant.status === "active" ? "停用租户" : "恢复租户"}</button>
              </details>
            </td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="7" class="muted">尚未创建租户</td></tr>';

  const priceRows = data.prices
    .map(
      (price) => `<tr>
        <td>${escapeHtml(serviceName(price.service))}</td>
        <td>${escapeHtml(priceUnitText(price.unitName))}</td>
        <td class="num">
          <strong>${escapeHtml(priceRateText(price))}</strong><br>
          <span class="muted">${price.unitPriceMicrofen} 微元</span>
        </td>
        <td>
          <form class="actions" onsubmit="updatePrice(event, '${escapeHtml(price.service)}')">
            <input name="microfen" type="number" min="0" step="1" style="width:130px" value="${price.unitPriceMicrofen}" required>
            <button type="submit">保存</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  const codes = data.rechargeCodes.length
    ? data.rechargeCodes
        .map(
          (item) => `<tr>
            <td class="code">${escapeHtml(item.code)}</td>
            <td class="num">¥${formatFen(item.amountFen)}</td>
            <td>${item.redeemedAt ? "已使用" : "未使用"}</td>
            <td>${dateText(item.createdAt)}</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="muted">尚未生成充值码</td></tr>';

  return layout({
    title: "总管理后台 · Hypit 租户网关",
    user,
    body: `
      <h1>平台管理</h1>
      <p class="lead">租户、定价、余额和服务调用</p>
      <section class="metrics">
        <div class="metric"><div class="metric-label">租户</div><div class="metric-value">${data.totals.tenants}</div><div class="metric-note">${data.totals.activeTenants} 个正常</div></div>
        <div class="metric"><div class="metric-label">客户余额</div><div class="metric-value">¥${formatFen(data.totals.balanceFen)}</div><div class="metric-note">冻结 ¥${formatFen(data.totals.reservedFen)}</div></div>
        <div class="metric"><div class="metric-label">平台消费</div><div class="metric-value">¥${formatFen(data.totals.spentFen)}</div><div class="metric-note">已结算</div></div>
        <div class="metric"><div class="metric-label">充值码</div><div class="metric-value">${data.rechargeCodes.length}</div><div class="metric-note">最近生成</div></div>
      </section>
      <div class="split">
        <section class="panel">
          <div class="panel-head"><h2>创建租户</h2></div>
          <form class="stack" onsubmit="createTenant(event)">
            <div class="field"><label for="tenant-name">租户名称</label><input id="tenant-name" required></div>
            <div class="field"><label for="tenant-user">登录用户名</label><input id="tenant-user" required></div>
            <div class="field"><label for="tenant-password">初始密码</label><input id="tenant-password" type="password" minlength="8" required></div>
            <button type="submit">创建</button>
            <p id="tenant-result" class="muted"></p>
          </form>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>生成充值码</h2></div>
          <form class="stack" onsubmit="createCode(event)">
            <div class="field"><label for="code-amount">金额（元）</label><input id="code-amount" type="number" min="0.01" step="0.01" required></div>
            <button type="submit">生成</button>
            <p id="code-result" class="code"></p>
          </form>
          <table><thead><tr><th>充值码</th><th class="num">金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${codes}</tbody></table>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>租户</h2></div>
        <table><thead><tr><th>租户</th><th>状态</th><th class="num">余额</th><th class="num">消费</th><th class="num">调用</th><th>充值</th><th></th></tr></thead><tbody>${tenantRows}</tbody></table>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>计费单价</h2></div>
        <table><thead><tr><th>服务</th><th>计费单位</th><th class="num">租户执行价 / 微元</th><th></th></tr></thead><tbody>${priceRows}</tbody></table>
        <p class="muted">租户执行价按火山官方标准 ×3。1 元 = 1,000,000 微元，调整只影响之后的调用。</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>最新用量</h2></div>
        ${usageRows(data.usage, true)}
      </section>`,
    script: `
      async function createTenant(event) {
        event.preventDefault();
        const result = document.getElementById("tenant-result");
        try {
          const data = await api("/api/admin/tenants", {
            method: "POST",
            body: JSON.stringify({
              name: document.getElementById("tenant-name").value,
              username: document.getElementById("tenant-user").value,
              password: document.getElementById("tenant-password").value
            })
          });
          result.textContent = "租户已创建：" + data.tenant.id;
          setTimeout(() => location.reload(), 900);
        } catch (error) { result.textContent = error.message; }
      }
      async function recharge(event, tenantId) {
        event.preventDefault();
        const input = event.currentTarget.elements.amount;
        try {
          await api("/api/admin/tenants/" + encodeURIComponent(tenantId) + "/recharge", {
            method: "POST",
            body: JSON.stringify({ amountFen: Math.round(Number(input.value) * 100) })
          });
          location.reload();
        } catch (error) { alert(error.message); }
      }
      async function addVoice(event, tenantId) {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await api("/api/admin/tenants/" + encodeURIComponent(tenantId) + "/voices", {
            method: "POST",
            body: JSON.stringify({ name: form.elements.name.value, speakerId: form.elements.speakerId.value })
          });
          location.reload();
        } catch (error) { alert(error.message); }
      }
      async function toggleTenant(tenantId, status) {
        try {
          await api("/api/admin/tenants/" + encodeURIComponent(tenantId) + "/status", {
            method: "POST",
            body: JSON.stringify({ status })
          });
          location.reload();
        } catch (error) { alert(error.message); }
      }
      async function updatePrice(event, service) {
        event.preventDefault();
        try {
          await api("/api/admin/prices/" + encodeURIComponent(service), {
            method: "PUT",
            body: JSON.stringify({ unitPriceMicrofen: Number(event.currentTarget.elements.microfen.value) })
          });
          location.reload();
        } catch (error) { alert(error.message); }
      }
      async function createCode(event) {
        event.preventDefault();
        const result = document.getElementById("code-result");
        try {
          const data = await api("/api/admin/recharge-codes", {
            method: "POST",
            body: JSON.stringify({ amountFen: Math.round(Number(document.getElementById("code-amount").value) * 100) })
          });
          result.textContent = data.code;
        } catch (error) { result.textContent = error.message; }
      }
    `,
  });
}
