# Hypit 租户网关

这是给本地 Hypit Studio 配套的线上控制面。火山引擎仍使用你的主账号付费，客户只拿到平台签发的租户令牌；客户余额、冻结额度、调用记录和账单都在平台内结算。

```text
本地 Studio / 脚本 --Bearer 租户令牌--> 租户网关 --> 火山 TTS / ASR / TOS
                                         |
                          /admin 总后台   /tenant 客户后台
```

## 当前能力

- 总管理员和租户账户分离，客户不能看到火山主密钥。
- 人民币余额钱包、任务预扣、成功结算、失败释放冻结额度。
- `mock` 与 `volc` 双模式，默认 `mock`，不会误花真实费用。
- 豆包声音克隆 TTS、豆包录音识别 ASR、火山 TOS 临时对象。
- 租户隔离、API 令牌、充值码、音色分配、租户停用。
- `Idempotency-Key` 幂等：同一请求重试复用任务，不重复扣款。
- 单价快照：以后改价不会改动历史账单。
- 本地客户端读取 `narration.json`，逐句合成并生成音频清单。

## 秒创云 SaaS 集成

秒创云现在是推荐的管理入口：

- 平台管理员：`https://xhscdn.cn/apps/gateway`
- 商户后台：`https://xhscdn.cn/tenant/apps/gateway`

网关仍是余额、定价和用量的唯一数据源。秒创云通过 `/saas/v1/*` 内部接口调用网关，使用双方服务器共有的 `SAAS_BRIDGE_SECRET`，不会把网关管理员密码或桥接密钥发送到浏览器。独立网关页面继续保留作为故障排查入口。

### 商户开通顺序（秒创云优先）

1. 平台管理员打开 `https://xhscdn.cn/apps/gateway`，创建网关租户，或在“商户绑定”里把已有的秒创云商户绑定到该网关租户。绑定成功后，商户的应用中心才会出现“AI 网关”卡片。
2. 商户管理员登录 `https://xhscdn.cn/tenant/login`，进入“应用中心 → AI 网关”。页面里的余额、账单、用量和音色都来自网关，不需要再登录独立网关。
3. 商户管理员在该页面的“API 令牌”面板创建令牌。令牌只在创建时显示一次，格式为 `hgt_...`；只有商户管理员角色可以创建，普通子账号不能。
4. 拿到令牌后，在本地 Studio 的“服务配置 → Hypit 平台网关”里填写网关地址、令牌和逻辑音色名称，再点“检查网关连接”。

如果商户打开后提示“当前商户尚未绑定网关账户”，说明第 1 步的绑定还没完成；应用中心没有“AI 网关”卡片也是同一原因。`https://gateway.xhscdn.cn/tenant` 是独立的网关账号入口，只在秒创云桥接故障或排查账单时使用，客户日常不需要它。

## 本地验收

需要 Node.js 22.15 或更高版本。

```powershell
cd C:\Users\admin\Documents\视频制作\hypit-tenant-gateway
Copy-Item .env.example .env
```

本机先用 Mock 模式，编辑 `.env`：

```dotenv
HOST=127.0.0.1
PORT=8787
DATA_DIR=./data
APP_ORIGIN=http://127.0.0.1:8787
COOKIE_SECURE=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成一个很长的随机密码
PROVIDER_MODE=mock
```

启动：

```powershell
npm start
```

访问 `http://127.0.0.1:8787/`：

1. 管理员登录后创建租户、充值、分配火山音色 ID。
2. 租户登录 `/tenant`，创建 API 令牌。
3. 令牌只在创建时显示一次，立即放进本机环境变量。

测试：

```powershell
npm test
npm run check
```

## 本地客户端

```powershell
$env:HYPIT_GATEWAY_URL = "http://127.0.0.1:8787"
$env:HYPIT_GATEWAY_TOKEN = "hgt_..."

node .\bin\hypit-gateway.mjs me
node .\bin\hypit-gateway.mjs tts .\overlay\narration.json --out .\overlay\remote --speaker "默认音色"
node .\bin\hypit-gateway.mjs asr .\speech.wav --out .\speech.json
```

`narration.json` 使用现有格式：

```json
{
  "lines": [
    { "id": "n01", "text": "第一句解说" },
    { "id": "n02", "text": "第二句解说", "speaker": "另一音色" }
  ]
}
```

TTS 输出目录包含逐句音频和 `manifest.json`。相同的文件、文本、音色再次执行时，会复用网关已有结果，不会重复收费。ASR 必须上传 16 kHz、单声道、16-bit PCM WAV；网关只保留识别结果，火山 TOS 临时对象会删除。

## Studio 服务配置

Studio 的 Provider 设置页已提供“Hypit 平台网关”分组。填写并保存后，豆包 TTS 与 ASR 自动改走网关，
本机不再需要火山语音和 TOS 密钥：

```json
{
  "hypit_gateway": {
    "enabled": true,
    "url": "https://gateway.example.com",
    "token": "hgt_...",
    "speaker": "旁白"
  }
}
```

`speaker` 填写租户后台分配的逻辑音色名称。设置页的“检查网关连接”会调用 `/gateway/v1/me`，
显示当前租户、可用余额和音色数量；令牌不会回显到浏览器。关闭 `enabled` 后立即恢复原有火山直连模式。

## 正式服务器

推荐一台独立的 Linux 云服务器，绑定域名，Nginx 终止 HTTPS，Node 服务只监听 `127.0.0.1:8787`。

### 1. 安装

```bash
sudo useradd --system --home /opt/hypit-tenant-gateway --shell /usr/sbin/nologin hypit
sudo mkdir -p /opt/hypit-tenant-gateway /var/lib/hypit-tenant-gateway
sudo cp -a . /opt/hypit-tenant-gateway/
sudo chown -R hypit:hypit /opt/hypit-tenant-gateway /var/lib/hypit-tenant-gateway
```

服务器 `.env` 建议放在 `/etc/hypit-tenant-gateway.env`，权限设为 `600`：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/hypit-tenant-gateway
APP_ORIGIN=https://studio.example.com
COOKIE_SECURE=true
ALLOW_NULL_ORIGIN=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成长随机密码
PROVIDER_MODE=volc

VOLC_TTS_ENDPOINT=https://openspeech.bytedance.com
VOLC_TTS_API_KEY=
VOLC_TTS_RESOURCE_ID=seed-icl-2.0
VOLC_TTS_DEFAULT_SPEAKER=
VOLC_TTS_FORMAT=mp3
VOLC_TTS_SAMPLE_RATE=24000

VOLC_ASR_ENDPOINT=https://openspeech.bytedance.com
VOLC_ASR_API_KEY=
VOLC_ASR_RESOURCE_ID=volc.seedasr.auc
VOLC_ASR_ENABLE_SPEAKER=true

VOLC_TOS_ENDPOINT=https://tos-cn-shanghai.volces.com
VOLC_TOS_REGION=cn-shanghai
VOLC_TOS_BUCKET=
VOLC_TOS_ACCESS_KEY=
VOLC_TOS_SECRET_KEY=
VOLC_TOS_PREFIX=hypit-tenant-gateway/asr
VOLC_TOS_PRESIGN_SECONDS=3600
```

### 2. systemd

```bash
sudo cp deploy/hypit-tenant-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hypit-tenant-gateway
sudo systemctl status hypit-tenant-gateway
curl http://127.0.0.1:8787/healthz
```

如果 Node 不在 `/usr/bin/node`，修改 service 中的 `ExecStart`。

### 3. Nginx

复制 [deploy/nginx.conf.example](deploy/nginx.conf.example)，替换域名和证书路径后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

把 `client_max_body_size` 和 `proxy_read_timeout` 保留为至少 `64m`、`600s`，否则长音频或 TTS 可能被反代提前断开。

### 4. Docker

```bash
docker compose up -d --build
docker compose logs -f gateway
```

Compose 默认只把端口映射到宿主机 `127.0.0.1`，公网入口仍交给 Nginx。

## 真实火山模式

1. 把豆包语音识别、声音复刻、对象存储的密钥只写入服务器环境变量，绝不放进客户前端或客户 `config.json`。
2. 在总后台为每个租户添加一个或多个音色 ID；`speaker` 请求使用后台显示的逻辑名称。
3. TOS 使用私有桶。ASR 上传的临时 WAV 会在识别完成后删除。
4. 首次上线先充少量余额，依次验证一条短 TTS、一条短 WAV ASR，核对后台的字符数、秒数、MiB 和扣费。
5. `PROVIDER_MODE=mock` 与 `volc` 切换后必须重启服务。

如果 TTS 返回 `45000030`，通常是主账号未开通对应合成商品，或音色不属于该 API Key 所在账号；这不是网关计费错误。

## 计费规则

- 钱包单位是“分”，接口对外显示 `costFen`。
- 单价配置单位是“微元”，`1 元 = 1,000,000 微元`。
- TTS 按字符计费，ASR 按音频秒数计费，TOS 按上传 MiB 计费。
- 调用开始时冻结预估费用，完成后按任务快照扣款；供应商失败会释放冻结额度。
- 服务重启时会回收遗留的 `reserved/processing` 任务，避免余额永久冻结。

## 备份与恢复

SQLite 与输出音频都在 `DATA_DIR`。建议每天做一次一致性备份：

```bash
sudo systemctl stop hypit-tenant-gateway
sudo cp /var/lib/hypit-tenant-gateway/gateway.sqlite /backup/gateway-$(date +%F).sqlite
sudo cp -a /var/lib/hypit-tenant-gateway/outputs /backup/outputs-$(date +%F)
sudo systemctl start hypit-tenant-gateway
```

恢复时停服务，把备份放回 `DATA_DIR`，确认 `hypit` 用户有写权限后再启动。正式并发量上来后应迁移 PostgreSQL，并增加任务队列。

## 上线前检查

- 已轮换曾经写进本地 `config.json` 的长期火山密钥。
- `.env` 未提交版本库，权限不是 `0644`。
- 已启用 HTTPS 和 `COOKIE_SECURE=true`。
- `ALLOW_NULL_ORIGIN=false`。
- 管理员密码足够长，客户令牌各自独立。
- 价格表已按自己的成本与毛利重新填写，不使用示例默认值。
- 已验证失败退款、租户停用和删除/停用令牌。

首次启动后修改 `ADMIN_PASSWORD` 不会自动改已有管理员密码。需要轮换时：

```bash
sudo systemctl stop hypit-tenant-gateway
sudo -u hypit env DATA_DIR=/var/lib/hypit-tenant-gateway ADMIN_USERNAME=admin \
  NEW_ADMIN_PASSWORD='新的长随机密码' \
  /usr/bin/node /opt/hypit-tenant-gateway/scripts/reset-admin-password.mjs
sudo systemctl start hypit-tenant-gateway
```

脚本会立即撤销该管理员的旧会话。

## 当前边界

这一阶段解决“客户调用统一计费”和“客户查看自己的用量”，不把完整 Studio 变成多人网页版。在线支付、自动对账、PostgreSQL、多实例队列和每租户并发上限属于下一阶段。当前 SQLite 方案按单实例部署设计，不要让多个进程共同写同一个数据库文件。
